"""Kanban decomposer — fan a triage task out into a graph of child tasks.

Invoked by ``hermes kanban decompose [task_id | --all]`` and the
auto-decompose path in the gateway dispatcher loop. Reads the user's
profile roster (with descriptions) and asks the auxiliary LLM to
return a task graph in JSON. Then atomically creates the children,
links them under the root, and flips the root ``triage -> todo``.

For ordinary/manual triage, the root task stays alive and becomes the parent
of every leaf child, then wakes its orchestrator after the graph completes.
For a workflow-backed live Loop skeleton, the generated graph collectively
owns the full objective: the stable source node auto-settles from its exits
without a redundant orchestrator worker run. The foreground receives the
workflow boundary batch and decides whether to add follow-up work.

Design notes
------------

* Mirrors the shape of ``hermes_cli/kanban_specify.py``: lazy aux
  client import inside the function, lenient response parse, never
  raises on expected failure modes.

* The system prompt sees the *configured* profile roster — names plus
  descriptions plus the default fallback. Profiles without a
  description are still listed (with a note) so the decomposer can
  match on name as a fallback, but the user has an obvious incentive
  to describe them.

* ``fanout=false`` collapses to the same effect as ``kanban specify``:
  we tighten the body and flip ``triage -> todo`` as a single task,
  no children created. This makes ``decompose`` a strict superset of
  ``specify`` from the user's perspective.

* If the LLM picks an assignee that doesn't exist as a profile, we
  rewrite it to the configured ``default_assignee`` (or the default
  profile if unset). A child task NEVER ends up with ``assignee=None``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

from hermes_cli import kanban_db as kb
from hermes_cli import profiles as profiles_mod

logger = logging.getLogger(__name__)


_SYSTEM_PROMPT = """You are the Kanban decomposer for the Hermes Agent board.

A user dropped a rough idea into the Triage column. Your job is to break it
into a small graph of concrete child tasks and route each one to the best-
matching profile from the available roster.

You will be given:
  - The original task title and body
  - The list of available profiles (each with name + description)
  - The fallback "default_assignee" used when no profile fits

Output a single JSON object with this exact shape:

  {
    "fanout": true,
    "rationale": "<one sentence on why this decomposition>",
    "tasks": [
      {
        "title": "<concrete task title, imperative voice, <= 80 chars>",
        "body":  "<detailed spec for the worker on this child task>",
        "assignee": "<profile name from the roster, or null for default>",
        "parents": [<int>, ...]
      },
      ...
    ]
  }

Rules:
  - "parents" is a list of INDICES (0-based) into this same "tasks" list,
    expressing actual data dependencies. Tasks with no parents run in
    PARALLEL. Tasks with parents wait until every parent completes.
  - Prefer parallelism. If two tasks can be done independently, give
    them no parents so the dispatcher fans them out at once.
  - Use 2-6 tasks for normal work. Don't create 20 tiny tasks. Don't
    cram everything into 1 task.
  - Preserve dynamic Loop workflows: do NOT pre-materialize every possible
    decision subgraph up front. If the task body names unresolved decisions,
    create a minimal execution scaffold and include on-demand expansion
    instructions in the relevant child body. The origin/orchestrator can
    delegate durable Loop subtasks when uncertainty actually blocks safe
    progress.
  - When live Loop graph context is present, treat completed prerequisite
    summaries as input and keep this task distinct from its named downstream
    work. Do not recreate work already represented by adjacent graph nodes.
  - When a live Loop task fans out, its generated child graph must collectively
    complete the original objective because the source task will not run as a
    second worker. If parallel outputs require synthesis, validation, or review,
    include an explicit terminal child that depends on the relevant producers.
  - Pick assignees from the roster by matching the task to the profile's
    DESCRIPTION (not just the name). When nothing matches well, use null
    and the system will route to the default_assignee.
  - Each child task body is what a fresh worker will read with no other
    context — be specific about goal, approach, and acceptance criteria.

When the task is genuinely a single unit of work (no useful decomposition),
return:

  {
    "fanout": false,
    "rationale": "<one sentence>",
    "title": "<tightened title>",
    "body":  "<concrete spec for a single worker>",
    "assignee": "<profile name from the roster, or null for default>"
  }

In that case the task stays as one work item, just with a tightened spec and
a concrete assignee. If no profile fits, use null and the system will route to
the default_assignee.

No preamble, no closing remarks, no code fences. Output only the JSON object.
"""


_USER_TEMPLATE = """Task id: {task_id}
Title: {title}
Body:
{body}
{graph_context}

Available profiles (assignees you may pick from):
{roster}

Default assignee (used when no profile fits a task): {default_assignee}
"""


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_DEFAULT_MAX_TOKENS = 4000
_RETRY_MAX_TOKENS = 12000
_DEFAULT_SPECIFICATION_RETRY_SECONDS = 60
_DEFAULT_SPECIFICATION_LEASE_SECONDS = 300


@dataclass
class DecomposeOutcome:
    """Result of decomposing a single triage task."""

    task_id: str
    ok: bool
    reason: str = ""
    fanout: bool = False
    child_ids: list[str] | None = None
    new_title: Optional[str] = None


class _DecomposePhaseTiming:
    """Exclusive wall-clock phase timings for one specification attempt."""

    _PHASES = ("preflight", "model", "parse", "apply")

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.started_at = time.perf_counter()
        self.phase_started_at = self.started_at
        self.phase = "preflight"
        self.durations = {name: 0.0 for name in self._PHASES}
        self.model_attempts = 0
        self.json_valid: bool | None = None

    def switch(self, phase: str) -> None:
        now = time.perf_counter()
        self.durations[self.phase] += now - self.phase_started_at
        self.phase = phase
        self.phase_started_at = now

    def start_model_attempt(self) -> None:
        self.model_attempts += 1
        self.switch("model")

    def emit(self, outcome: DecomposeOutcome | None) -> None:
        finished_at = time.perf_counter()
        self.durations[self.phase] += finished_at - self.phase_started_at
        result = (
            "error"
            if outcome is None
            else ("ok" if outcome.ok else "failed")
        )
        json_valid = (
            "na"
            if self.json_valid is None
            else str(self.json_valid).lower()
        )
        logger.info(
            "decompose timing: task_id=%s result=%s fanout=%s "
            "model_attempts=%d json_valid=%s preflight_ms=%.3f "
            "model_ms=%.3f parse_ms=%.3f apply_ms=%.3f total_ms=%.3f",
            self.task_id,
            result,
            bool(outcome.fanout) if outcome is not None else False,
            self.model_attempts,
            json_valid,
            self.durations["preflight"] * 1000,
            self.durations["model"] * 1000,
            self.durations["parse"] * 1000,
            self.durations["apply"] * 1000,
            (finished_at - self.started_at) * 1000,
        )


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("decompose: ignoring invalid %s=%r", name, raw)
        return default
    return max(1, value)


def _max_token_attempts() -> list[int]:
    """Return completion budgets for initial call and length retry."""
    first = _positive_int_env(
        "HERMES_KANBAN_DECOMPOSE_MAX_TOKENS",
        _DEFAULT_MAX_TOKENS,
    )
    retry = _positive_int_env(
        "HERMES_KANBAN_DECOMPOSE_RETRY_MAX_TOKENS",
        _RETRY_MAX_TOKENS,
    )
    if retry <= first:
        return [first]
    return [first, retry]


def _response_content_and_finish_reason(resp: Any) -> tuple[str, str | None]:
    try:
        choice = resp.choices[0]
    except Exception:
        return "", None
    try:
        raw = choice.message.content or ""
    except Exception:
        raw = ""
    finish_reason = getattr(choice, "finish_reason", None)
    return raw, finish_reason if isinstance(finish_reason, str) else None


def _extract_json_blob(raw: str) -> Optional[dict]:
    if not raw:
        return None
    stripped = _FENCE_RE.sub("", raw.strip())
    first = stripped.find("{")
    last = stripped.rfind("}")
    if first == -1 or last == -1 or last <= first:
        return None
    candidate = stripped[first : last + 1]
    try:
        val = json.loads(candidate)
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(val, dict):
        return None
    return val


def _profile_author() -> str:
    """Mirror of ``hermes_cli.kanban._profile_author``."""
    return (
        os.environ.get("HERMES_PROFILE")
        or os.environ.get("USER")
        or "decomposer"
    )


def _load_config() -> dict:
    try:
        from hermes_cli.config import load_config
        return load_config() or {}
    except Exception:
        return {}


def _loop_seconds(cfg: dict, key: str, default: int, maximum: int) -> int:
    loop_cfg = cfg.get("loop", {}) if isinstance(cfg, dict) else {}
    try:
        value = int(loop_cfg.get(key, default))
    except (AttributeError, TypeError, ValueError):
        value = default
    return max(1, min(value, maximum))


def _failure_outcome(
    task_id: str,
    reason: str,
    *,
    retry_after_seconds: int,
    author: str,
    expected_fingerprint: Optional[str] = None,
) -> DecomposeOutcome:
    """Persist a failed compiler attempt and leave the task untouched."""
    try:
        with kb.connect_closing() as conn:
            kb.record_specification_failure(
                conn,
                task_id,
                reason=reason,
                retry_after_seconds=retry_after_seconds,
                author=author,
                expected_fingerprint=expected_fingerprint,
            )
    except Exception:
        logger.exception("decompose: could not persist specification failure for %s", task_id)
    return DecomposeOutcome(task_id, False, reason)


def _resolve_orchestrator_profile(cfg: dict) -> str:
    """Resolve which profile owns the original decomposition shell after fan-out.

    Falls back to the active default profile when ``kanban.orchestrator_profile``
    is unset, so a task is never stranded for lack of an orchestrator.
    """
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    explicit = (kanban_cfg.get("orchestrator_profile") or "").strip()
    if explicit:
        try:
            if profiles_mod.profile_exists(explicit):
                return explicit
        except Exception:
            pass
    # Fall back to the active default profile.
    try:
        return profiles_mod.get_active_profile_name() or "default"
    except Exception:
        return "default"


def _resolve_default_assignee(cfg: dict) -> str:
    """Resolve which profile catches child tasks the orchestrator can't route."""
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    explicit = (kanban_cfg.get("default_assignee") or "").strip()
    if explicit:
        try:
            if profiles_mod.profile_exists(explicit):
                return explicit
        except Exception:
            pass
    try:
        return profiles_mod.get_active_profile_name() or "default"
    except Exception:
        return "default"


def _build_roster() -> tuple[list[dict], set[str]]:
    """Return (roster_for_prompt, valid_assignee_names).

    Each roster entry is ``{name, description, has_description}``. The
    valid-set is used after the LLM responds to rewrite invalid
    assignees to the default fallback.
    """
    roster: list[dict] = []
    valid: set[str] = set()
    try:
        all_profiles = profiles_mod.list_profiles()
    except Exception as exc:
        logger.warning("decompose: failed to list profiles: %s", exc)
        return roster, valid
    for p in all_profiles:
        desc = (p.description or "").strip()
        roster.append({
            "name": p.name,
            "description": desc or f"(no description; profile named {p.name!r})",
            "has_description": bool(desc),
        })
        valid.add(p.name)
    return roster, valid


def _format_roster(roster: list[dict]) -> str:
    if not roster:
        return "  (no profiles installed — decomposer cannot route work)"
    lines = []
    for entry in roster:
        tag = "" if entry["has_description"] else " ⚠ undescribed"
        lines.append(f"  - {entry['name']}{tag}: {entry['description']}")
    return "\n".join(lines)


def _normalize_assignee_choice(
    assignee: object,
    *,
    default_assignee: str,
    valid_names: set[str],
) -> str:
    """Return a valid assignee, falling back to ``default_assignee``.

    Fan-out children and the single-task fallback should share the same
    routing guarantee: promoted work must not be left unassigned.
    """
    if not isinstance(assignee, str) or not assignee.strip():
        return default_assignee
    chosen = assignee.strip()
    if chosen not in valid_names:
        return default_assignee
    return chosen


def _live_graph_context(conn: Any, task: Any, workflow_id: str | None) -> str:
    """Render only the nearby durable graph facts needed to compile a skeleton."""
    lines: list[str] = []
    remaining_parent_comments = 12
    if workflow_id:
        workflow = kb.get_workflow(conn, workflow_id)
        if workflow:
            lines.extend(
                [
                    "Workflow context:",
                    *([f"- {workflow.title}"] if workflow.title else []),
                    *(
                        [_truncate(workflow.shared_context.strip(), 2000)]
                        if workflow.shared_context
                        and workflow.shared_context.strip()
                        else []
                    ),
                ]
            )

    parent_rows = conn.execute(
        "SELECT p.id, p.title, p.status, p.result FROM tasks p "
        "JOIN task_links l ON l.parent_id = p.id WHERE l.child_id = ? "
        "ORDER BY p.created_at, p.id",
        (task.id,),
    ).fetchall()
    if parent_rows:
        lines.append("Direct prerequisites:")
        for parent in parent_rows:
            summary = kb.latest_summary(conn, parent["id"]) or parent["result"]
            detail = f" — result: {_truncate(str(summary).strip(), 1200)}" if summary else ""
            lines.append(f"- [{parent['status']}] {parent['title']}{detail}")
            comments = kb.list_comments(conn, parent["id"])
            take = min(3, remaining_parent_comments)
            shown_comments = comments[-take:] if take else []
            remaining_parent_comments -= len(shown_comments)
            for comment in shown_comments:
                author = str(comment.author or "worker").replace("`", "")[:80]
                body = " ".join(str(comment.body or "").split())
                if body:
                    lines.append(
                        f"  comment/review from `{author}`: "
                        f"{_truncate(body, 800)}"
                    )

    child_rows = conn.execute(
        "SELECT c.title, c.status FROM tasks c "
        "JOIN task_links l ON l.child_id = c.id WHERE l.parent_id = ? "
        "ORDER BY c.created_at, c.id",
        (task.id,),
    ).fetchall()
    if child_rows:
        lines.append("Immediate downstream work (avoid overlapping its scope):")
        lines.extend(f"- [{child['status']}] {child['title']}" for child in child_rows)

    return "\nLive Loop graph context:\n" + "\n".join(lines) if lines else ""


_LOOP_SAFE_STATUSES = {"triage", "scheduled"}
_LOOP_INTAKE_EVENT_KIND = "loop_intake_state"


def _latest_event_payload(conn: Any, task_id: str, kind: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT payload FROM task_events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        (task_id, kind),
    ).fetchone()
    if not row:
        return {}
    try:
        payload = json.loads(row["payload"] or "{}")
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _existing_loop_plan(conn: Any, task_id: str) -> DecomposeOutcome | None:
    intake = _latest_event_payload(conn, task_id, _LOOP_INTAKE_EVENT_KIND)
    if str(intake.get("state") or "").strip().lower() != "planned":
        return None
    decomposition = _latest_event_payload(conn, task_id, "decomposed")
    raw_child_ids = intake.get("child_ids") or decomposition.get("child_ids") or []
    child_ids = [str(child_id) for child_id in raw_child_ids if str(child_id).strip()]
    return DecomposeOutcome(
        task_id,
        True,
        "already planned",
        fanout=bool(child_ids),
        child_ids=child_ids,
    )


def _loop_planned_payload(*, author: str, fanout: bool) -> dict[str, Any]:
    return {
        "needed": True,
        "state": "planned",
        "source": "foreground_triage",
        "dispatchable": False,
        "fanout": fanout,
        "child_ids": [],
        "author": author,
    }


def decompose_task(
    task_id: str,
    *,
    author: Optional[str] = None,
    timeout: Optional[int] = None,
    loop_safe: bool = False,
) -> DecomposeOutcome:
    """Decompose a planning task into a graph of child tasks.

    Returns an outcome describing what happened. Never raises for
    expected failure modes (task not in an accepted planning status, no aux
    client configured, API error, malformed response, decomposer returned
    fanout=true with empty task list) — those surface via ``ok=False``.
    """
    timing = _DecomposePhaseTiming(task_id)
    outcome: DecomposeOutcome | None = None
    try:
        outcome = _decompose_task_impl(
            task_id,
            author=author,
            timeout=timeout,
            loop_safe=loop_safe,
            timing=timing,
        )
        return outcome
    finally:
        timing.emit(outcome)


def _decompose_task_impl(
    task_id: str,
    *,
    author: Optional[str],
    timeout: Optional[int],
    loop_safe: bool,
    timing: _DecomposePhaseTiming,
) -> DecomposeOutcome:
    with kb.connect_closing() as conn:
        task = kb.get_task(conn, task_id)
        workflow_id = task.workflow_id if task is not None else None
        existing_plan = _existing_loop_plan(conn, task_id) if loop_safe and task is not None else None
    if task is None:
        return DecomposeOutcome(task_id, False, "unknown task id")
    if existing_plan is not None:
        return existing_plan
    if loop_safe:
        if task.status not in _LOOP_SAFE_STATUSES:
            return DecomposeOutcome(
                task_id, False, f"task is not in Loop planning status (status={task.status!r})"
            )
        if not workflow_id:
            return DecomposeOutcome(task_id, False, "loop_safe decomposition requires a Loop task")
    elif task.status != "triage":
        return DecomposeOutcome(
            task_id, False, f"task is not in triage (status={task.status!r})"
        )

    cfg = _load_config()
    retry_after_seconds = _loop_seconds(
        cfg,
        "specification_retry_seconds",
        _DEFAULT_SPECIFICATION_RETRY_SECONDS,
        3600,
    )
    lease_seconds = _loop_seconds(
        cfg,
        "specification_lease_seconds",
        _DEFAULT_SPECIFICATION_LEASE_SECONDS,
        3600,
    )
    audit_author = author or _profile_author()
    orchestrator = _resolve_orchestrator_profile(cfg)
    default_assignee = _resolve_default_assignee(cfg)
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    auto_promote = False if loop_safe else bool(kanban_cfg.get("auto_promote_children", True))
    roster, valid_names = _build_roster()

    # Acquire a durable attempt lease immediately before any external work.
    # The returned fingerprint is the CAS token used by both apply paths.
    with kb.connect_closing() as conn:
        specification_fingerprint = kb.begin_specification_attempt(
            conn,
            task_id,
            lease_seconds=lease_seconds,
            allowed_statuses=_LOOP_SAFE_STATUSES if loop_safe else None,
            author=audit_author,
        )
        if specification_fingerprint is not None:
            task = kb.get_task(conn, task_id)
            workflow_id = task.workflow_id if task is not None else None
            graph_context = (
                _live_graph_context(conn, task, workflow_id)
                if task is not None and bool(getattr(task, "needs_specification", False))
                else ""
            )
    if specification_fingerprint is None or task is None:
        return DecomposeOutcome(
            task_id,
            False,
            "specification attempt deferred (task changed, leased, or backing off)",
        )
    is_live_loop_skeleton = bool(
        task.needs_specification
        and task.workflow_id
    )

    def failed(reason: str) -> DecomposeOutcome:
        timing.switch("apply")
        return _failure_outcome(
            task_id,
            reason,
            retry_after_seconds=retry_after_seconds,
            author=audit_author,
            expected_fingerprint=specification_fingerprint,
        )

    try:
        from agent.auxiliary_client import call_llm  # type: ignore
    except Exception as exc:
        logger.debug("decompose: auxiliary client import failed: %s", exc)
        return failed("auxiliary client unavailable")

    user_msg = _USER_TEMPLATE.format(
        task_id=task.id,
        title=_truncate(task.title or "", 400),
        body=_truncate(task.body or "(no body)", 4000),
        graph_context=graph_context,
        roster=_format_roster(roster),
        default_assignee=default_assignee,
    )
    parsed = None
    raw = ""
    finish_reason: str | None = None
    for max_tokens in _max_token_attempts():
        timing.start_model_attempt()
        try:
            # Route through call_llm so auxiliary.kanban_decomposer.* config
            # (provider/model/base_url, extra_body, reasoning_effort, retries)
            # applies while retaining the fork's bounded retry for truncated
            # JSON responses.
            resp = call_llm(
                task="kanban_decomposer",
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.3,
                max_tokens=max_tokens,
                timeout=timeout or 180,
            )
        except Exception as exc:
            logger.info(
                "decompose: API call failed for %s (%s)", task_id, exc,
            )
            return failed(f"LLM error: {type(exc).__name__}")

        timing.switch("parse")
        raw, finish_reason = _response_content_and_finish_reason(resp)
        parsed = _extract_json_blob(raw)
        if parsed is not None:
            timing.json_valid = True
            break
        if finish_reason != "length" and raw.strip():
            break
        logger.info(
            "decompose: empty/truncated LLM output for %s "
            "(finish_reason=%r, max_tokens=%s)",
            task_id,
            finish_reason,
            max_tokens,
        )

    if parsed is None:
        timing.json_valid = False
        if finish_reason == "length" or not raw.strip():
            return failed("LLM returned empty/truncated output before JSON")
        return failed("LLM returned malformed JSON")

    fanout = bool(parsed.get("fanout"))

    if not fanout:
        # Fall back to single-task spec promotion (same effect as specify).
        new_title = parsed.get("title")
        new_body = parsed.get("body")
        title_val = new_title.strip() if isinstance(new_title, str) and new_title.strip() else None
        body_val = new_body if isinstance(new_body, str) and new_body.strip() else None
        # A live Loop skeleton is the foreground-authored graph node. The
        # decomposer may enrich its body and routing, but renaming the durable
        # shell would break the foreground's stable graph identity. Legacy
        # triage cards retain the historical title-tightening behavior.
        applied_title = task.title if is_live_loop_skeleton else title_val
        assignee_val = None
        if not task.assignee:
            assignee_val = _normalize_assignee_choice(
                parsed.get("assignee"),
                default_assignee=default_assignee,
                valid_names=valid_names,
            )
        if is_live_loop_skeleton and body_val is None:
            return failed(
                "live skeleton specification requires a nonempty worker-ready body"
            )
        if title_val is None and body_val is None:
            return failed("decomposer returned fanout=false with no title/body")
        timing.switch("apply")
        with kb.connect_closing() as conn:
            ok = kb.specify_triage_task(
                conn,
                task_id,
                title=applied_title,
                body=body_val,
                assignee=assignee_val,
                author=audit_author,
                allowed_statuses=_LOOP_SAFE_STATUSES if loop_safe else None,
                next_status="scheduled" if loop_safe else "todo",
                recompute=not loop_safe,
                loop_intake_payload=(
                    _loop_planned_payload(author=audit_author, fanout=False)
                    if loop_safe
                    else None
                ),
                expected_specification_fingerprint=specification_fingerprint,
            )
        if not ok:
            reason = "task moved out of Loop planning before promotion" if loop_safe else "task moved out of triage before promotion"
            return failed(f"stale decomposer output rejected: {reason}")
        outcome = DecomposeOutcome(
            task_id, True, "single task (no fanout)",
            fanout=False, new_title=applied_title,
        )
        return outcome

    raw_tasks = parsed.get("tasks") or []
    if not isinstance(raw_tasks, list) or not raw_tasks:
        return failed("decomposer returned fanout=true with empty tasks list")
    max_graph_nodes = _loop_seconds(cfg, "max_graph_nodes", 32, 1000)
    if len(raw_tasks) > max_graph_nodes:
        return failed(
            f"decomposer returned {len(raw_tasks)} tasks; maximum is "
            f"{max_graph_nodes} (loop.max_graph_nodes)"
        )

    # Rewrite invalid assignees to the default fallback. Never leave a
    # task with assignee=None — the user explicitly does not want that.
    children: list[dict] = []
    for idx, entry in enumerate(raw_tasks):
        if not isinstance(entry, dict):
            return failed(f"tasks[{idx}] is not an object")
        title = entry.get("title")
        if not isinstance(title, str) or not title.strip():
            return failed(f"tasks[{idx}].title is missing or empty")
        body = entry.get("body")
        if is_live_loop_skeleton and (
            not isinstance(body, str) or not body.strip()
        ):
            return failed(
                f"tasks[{idx}].body must be a nonempty worker-ready specification"
            )
        if not isinstance(body, str):
            body = ""
        assignee = entry.get("assignee")
        chosen = _normalize_assignee_choice(
            assignee,
            default_assignee=default_assignee,
            valid_names=valid_names,
        )
        if (
            isinstance(assignee, str)
            and assignee.strip()
            and assignee.strip() not in valid_names
        ):
            logger.info(
                "decompose: task %s child %d picked unknown assignee %r — "
                "routing to default_assignee %r",
                task_id, idx, assignee, default_assignee,
            )
        parents = entry.get("parents")
        if is_live_loop_skeleton:
            if not isinstance(parents, list):
                return failed(f"tasks[{idx}].parents must be a list")
            for parent_index, parent in enumerate(parents):
                if not isinstance(parent, int) or isinstance(parent, bool):
                    return failed(
                        f"tasks[{idx}].parents[{parent_index}] must be an integer index"
                    )
                if parent < 0 or parent >= len(raw_tasks) or parent == idx:
                    return failed(
                        f"tasks[{idx}].parents[{parent_index}] is not a valid dependency index"
                    )
            clean_parents = list(dict.fromkeys(parents))
        else:
            if not isinstance(parents, list):
                parents = []
            # Preserve historical leniency for ordinary manually-triaged cards.
            clean_parents = [
                parent
                for parent in parents
                if isinstance(parent, int)
                and not isinstance(parent, bool)
                and 0 <= parent < len(raw_tasks)
                and parent != idx
            ]
        children.append({
            "title": title.strip()[:200],
            "body": body.strip(),
            "assignee": chosen,
            "parents": clean_parents,
        })

    timing.switch("apply")
    try:
        with kb.connect_closing() as conn:
            child_ids = kb.decompose_triage_task(
                conn,
                task_id,
                root_assignee=(
                    None if is_live_loop_skeleton else orchestrator
                ),
                children=children,
                author=audit_author,
                auto_promote=auto_promote,
                allowed_root_statuses=_LOOP_SAFE_STATUSES if loop_safe else None,
                root_next_status="scheduled" if loop_safe else "todo",
                auto_complete_shell=is_live_loop_skeleton,
                loop_intake_payload=(
                    _loop_planned_payload(author=audit_author, fanout=True)
                    if loop_safe
                    else None
                ),
                expected_specification_fingerprint=specification_fingerprint,
            )
    except ValueError as exc:
        return failed(f"DB rejected graph: {exc}")
    except Exception as exc:
        logger.exception("decompose: DB error on task %s", task_id)
        return failed(f"DB error: {type(exc).__name__}")

    if child_ids is None:
        reason = "task moved out of Loop planning before decomposition" if loop_safe else "task moved out of triage before decomposition"
        return failed(f"stale decomposer output rejected: {reason}")

    outcome = DecomposeOutcome(
        task_id, True, f"decomposed into {len(child_ids)} children",
        fanout=True, child_ids=child_ids,
    )
    return outcome


def list_triage_ids(*, tenant: Optional[str] = None) -> list[str]:
    """Return triage tasks that are not leased or in retry backoff."""
    with kb.connect_closing() as conn:
        rows = kb.list_tasks(
            conn,
            status="triage",
            tenant=tenant,
            limit=1000,
        )
        return [row.id for row in rows if kb.specification_retry_eligible(conn, row.id)]
