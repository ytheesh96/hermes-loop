"""Post-commit Kanban progress without a polling-sized delay.

The normal dispatcher remains the repair/reconciliation loop. Mutation paths
call this module with the exact tasks they made eligible so canonical
decomposition and dispatch can run immediately without sweeping unrelated
ready work.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from hermes_cli import kanban_db as kb


logger = logging.getLogger(__name__)

_DEFAULT_SPECIFICATION_CONCURRENCY = 2
_MAX_SPECIFICATION_CONCURRENCY = 3


def _task_ids(values: Optional[Iterable[str]]) -> list[str]:
    if values is None:
        return []
    if isinstance(values, str):
        values = (values,)
    return list(
        dict.fromkeys(
            task_id
            for value in values
            if value is not None and (task_id := str(value).strip())
        )
    )


def _positive_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 1 else None


def _load_kanban_config() -> tuple[dict[str, Any], str | None]:
    try:
        from hermes_cli.config import load_config

        config = load_config()
    except Exception as exc:
        return {}, f"could not read kanban config: {type(exc).__name__}: {exc}"
    if not isinstance(config, dict):
        return {}, (
            "could not read kanban config: expected the root config to be a mapping"
        )
    if "kanban" not in config:
        return {}, None
    kanban = config["kanban"]
    if not isinstance(kanban, dict):
        return {}, (
            "could not read kanban config: expected the kanban section to be a mapping"
        )
    return kanban, None


@dataclass(frozen=True)
class ProgressPolicy:
    """One config snapshot shared by causal promotion and dispatch."""

    kanban: dict[str, Any]
    warning: str | None = None

    @property
    def available(self) -> bool:
        return self.warning is None

    @property
    def failure_limit(self) -> int:
        return (
            _positive_int(self.kanban.get("failure_limit"))
            or kb.DEFAULT_FAILURE_LIMIT
        )

    @property
    def specification_concurrency(self) -> int:
        configured = (
            _positive_int(self.kanban.get("specification_concurrency"))
            or _DEFAULT_SPECIFICATION_CONCURRENCY
        )
        return min(configured, _MAX_SPECIFICATION_CONCURRENCY)


def load_progress_policy() -> ProgressPolicy:
    """Load one fail-closed policy snapshot for a mutation boundary."""

    kanban, warning = _load_kanban_config()
    return ProgressPolicy(kanban=kanban, warning=warning)


def _dispatch_config(kanban: dict[str, Any]) -> dict[str, Any]:
    return {
        "default_assignee": (
            str(kanban.get("default_assignee") or "").strip() or None
        ),
        # Candidate scoping makes an implicit one-worker cap unnecessary:
        # only the mutation-produced frontier is eligible for this nudge.
        "max_spawn": _positive_int(kanban.get("max_spawn")),
        "max_in_progress": _positive_int(kanban.get("max_in_progress")),
        "max_in_progress_per_profile": _positive_int(
            kanban.get("max_in_progress_per_profile")
        ),
        "failure_limit": (
            _positive_int(kanban.get("failure_limit"))
            or kb.DEFAULT_FAILURE_LIMIT
        ),
    }


def _dispatch_payload(result: Any) -> dict[str, Any]:
    return {
        "spawned": [
            task_id for task_id, _assignee, _workspace in result.spawned
        ],
        "skipped_locked": bool(getattr(result, "skipped_locked", False)),
        "skipped_nonspawnable": list(
            getattr(result, "skipped_nonspawnable", []) or []
        ),
        "skipped_unassigned": list(
            getattr(result, "skipped_unassigned", []) or []
        ),
        "skipped_per_profile_capped": [
            task_id
            for task_id, _assignee, _current in (
                getattr(result, "skipped_per_profile_capped", []) or []
            )
        ],
        "auto_blocked": list(getattr(result, "auto_blocked", []) or []),
    }


def dispatch_candidates(
    task_ids: Optional[Iterable[str]],
    *,
    board: Optional[str] = None,
    conn: Any = None,
    policy: ProgressPolicy | None = None,
) -> dict[str, Any]:
    """Dispatch only the supplied ready/review tasks with configured limits."""

    candidates = _task_ids(task_ids)
    policy = policy or load_progress_policy()
    if not candidates:
        dispatch = _dispatch_payload(kb.DispatchResult())
        warnings = [policy.warning] if policy.warning else []
        if policy.warning:
            dispatch["skipped_config_unavailable"] = True
        return {
            "candidate_task_ids": [],
            "dispatch": dispatch,
            "warnings": warnings,
        }

    warnings = [policy.warning] if policy.warning else []
    if policy.warning:
        return {
            "candidate_task_ids": candidates,
            "dispatch": {
                **_dispatch_payload(kb.DispatchResult()),
                "skipped_config_unavailable": True,
            },
            "warnings": warnings,
        }
    owned_connection = conn is None
    try:
        try:
            if owned_connection:
                conn = kb.connect(board=board)
            result = kb.dispatch_once(
                conn,
                board=board,
                candidate_task_ids=candidates,
                **_dispatch_config(policy.kanban),
            )
        except Exception as exc:
            message = (
                f"inline dispatch failed: {type(exc).__name__}: {exc}"
            )
            warnings.append(message)
            return {
                "candidate_task_ids": candidates,
                "dispatch": {
                    **_dispatch_payload(kb.DispatchResult()),
                    "error": message,
                },
                "warnings": warnings,
            }
        return {
            "candidate_task_ids": candidates,
            "dispatch": _dispatch_payload(result),
            "warnings": warnings,
        }
    finally:
        if owned_connection and conn is not None:
            conn.close()


def decompose_and_dispatch(
    specification_task_ids: Optional[Iterable[str]],
    *,
    ready_task_ids: Optional[Iterable[str]] = None,
    board: Optional[str] = None,
    conn: Any = None,
    author: str = "auto-decomposer",
    policy: ProgressPolicy | None = None,
) -> dict[str, Any]:
    """Compile exact eligible skeletons, then dispatch their ready frontier."""

    started_at = time.perf_counter()
    specification_started_at: float | None = None
    specification_finished_at: float | None = None
    specification_ids = _task_ids(specification_task_ids)
    candidates = _task_ids(ready_task_ids)
    outcomes: list[dict[str, Any]] = []
    warnings: list[str] = []

    policy = policy or load_progress_policy()
    if policy.warning:
        warnings.append(policy.warning)
    # Config is a policy boundary for model work. If it cannot be read, keep
    # the durable skeleton in triage and let the reconciliation watcher retry
    # after configuration is readable again.
    auto_decompose = policy.available and bool(
        policy.kanban.get("auto_decompose", True)
    )
    if specification_ids and policy.warning:
        warnings.append(
            "automatic decomposition was skipped because kanban config is "
            "unavailable; committed skeletons remain in triage for recovery"
        )
    elif specification_ids and not auto_decompose:
        warnings.append(
            "automatic decomposition is disabled; committed skeletons remain "
            "in triage for the recovery watcher after it is re-enabled"
        )
    elif specification_ids:
        from hermes_cli import kanban_decompose

        specification_started_at = time.perf_counter()
        scoped_board = str(board or kb.get_current_board()).strip()

        def decompose_one(task_id: str) -> Any:
            # Context variables do not implicitly cross executor threads.
            # Pin the board inside each worker so decompose_task's independent
            # lease/apply connections cannot fall back to another board.
            try:
                with kb.scoped_current_board(scoped_board):
                    return kanban_decompose.decompose_task(
                        task_id,
                        author=author,
                        loop_safe=False,
                    )
            except Exception as exc:
                return exc

        max_workers = min(
            len(specification_ids),
            policy.specification_concurrency,
        )
        if max_workers == 1:
            completed = [
                (specification_ids[0], decompose_one(specification_ids[0]))
            ]
        else:
            with ThreadPoolExecutor(
                max_workers=max_workers,
                thread_name_prefix="kanban-specification",
            ) as executor:
                # Resolve in input order even when model calls finish out of
                # order. This keeps output and exact candidate ordering stable.
                completed = list(
                    zip(
                        specification_ids,
                        executor.map(decompose_one, specification_ids),
                    )
                )

        for task_id, outcome_or_error in completed:
            if isinstance(outcome_or_error, Exception):
                exc = outcome_or_error
                message = (
                    f"inline decomposition failed for {task_id}: "
                    f"{type(exc).__name__}: {exc}"
                )
                warnings.append(message)
                outcomes.append(
                    {
                        "task_id": task_id,
                        "ok": False,
                        "reason": message,
                        "fanout": False,
                        "child_ids": [],
                        "new_title": None,
                    }
                )
                continue
            outcome = outcome_or_error
            payload = {
                "task_id": outcome.task_id,
                "ok": bool(outcome.ok),
                "reason": outcome.reason,
                "fanout": bool(outcome.fanout),
                "child_ids": list(outcome.child_ids or []),
                "new_title": outcome.new_title,
            }
            outcomes.append(payload)
            if outcome.ok:
                candidates.append(outcome.task_id)
                candidates.extend(outcome.child_ids or [])
        specification_finished_at = time.perf_counter()

    dispatch_started_at = time.perf_counter()
    dispatched = dispatch_candidates(
        candidates,
        board=board,
        conn=conn,
        policy=policy,
    )
    finished_at = time.perf_counter()
    warnings.extend(dispatched["warnings"])
    # This is synchronous coordinator setup, not time waiting on the recovery
    # watcher: config/policy work before model specification starts.
    setup_finished_at = (
        specification_started_at
        if specification_started_at is not None
        else dispatch_started_at
    )
    specification_ms = (
        (specification_finished_at - specification_started_at) * 1000
        if specification_started_at is not None
        and specification_finished_at is not None
        else 0.0
    )
    dispatch_payload = dispatched["dispatch"]
    logger.info(
        "kanban progress timing: board=%s specification_tasks=%d "
        "candidate_tasks=%d spawned=%d warnings=%d setup_ms=%.3f "
        "specification_ms=%.3f dispatch_ms=%.3f total_ms=%.3f",
        str(board or "<current>").strip(),
        len(specification_ids),
        len(dispatched["candidate_task_ids"]),
        len(dispatch_payload.get("spawned") or []),
        len(warnings),
        (setup_finished_at - started_at) * 1000,
        specification_ms,
        (finished_at - dispatch_started_at) * 1000,
        (finished_at - started_at) * 1000,
    )
    return {
        "specification_task_ids": specification_ids,
        "decomposition": outcomes,
        "candidate_task_ids": dispatched["candidate_task_ids"],
        "dispatch": dispatch_payload,
        "warnings": list(dict.fromkeys(warnings)),
    }


def capture_completion_transitions(
    completed_task_ids: Optional[Iterable[str]],
    *,
    transitions: Any,
    board: Optional[str] = None,
    conn: Any = None,
    policy: ProgressPolicy | None = None,
) -> list[str]:
    """Safely capture exact descendants unlocked by durable completions.

    Completion is already committed when this runs. Any policy, connection,
    or recompute failure therefore becomes a recovery warning instead of
    changing the completion result.
    """

    completed_ids = _task_ids(completed_task_ids)
    if not completed_ids:
        return []
    policy = policy or load_progress_policy()
    if policy.warning:
        return [
            policy.warning,
            "dependent advancement was skipped because kanban config is "
            "unavailable; the reconciliation watcher will recover it",
        ]
    effective_board = str(board or kb.get_current_board()).strip()
    owned_connection = conn is None
    try:
        if owned_connection:
            conn = kb.connect(board=effective_board)
        with kb.scoped_current_board(effective_board):
            kb.recompute_ready(
                conn,
                failure_limit=policy.failure_limit,
                transitions=transitions,
                caused_by_task_ids=completed_ids,
            )
        return []
    except Exception as exc:
        return [
            "inline dependent advancement failed after completion: "
            f"{type(exc).__name__}: {exc}; the reconciliation watcher will "
            "recover it"
        ]
    finally:
        if owned_connection and conn is not None:
            conn.close()


def advance_transitions(
    transitions: Any,
    *,
    board: Optional[str] = None,
    conn: Any = None,
    author: str = "completion-auto-decomposer",
    policy: ProgressPolicy | None = None,
    recovery_warnings: Optional[Iterable[str]] = None,
) -> dict[str, Any]:
    """Advance only the dependency transitions captured by a completion."""

    effective_board = str(board or kb.get_current_board()).strip()
    owned_connection = conn is None
    carried_warnings = [
        str(warning)
        for warning in (recovery_warnings or ())
        if warning is not None and str(warning).strip()
    ]
    try:
        if owned_connection:
            conn = kb.connect(board=effective_board)
        specification_ids = []
        for task_id in _task_ids(
            getattr(transitions, "newly_specifiable", ()) or ()
        ):
            task = kb.get_task(conn, task_id)
            if (
                task is not None
                and task.status == "triage"
                and bool(task.needs_specification)
            ):
                specification_ids.append(task_id)
        ready_ids = []
        for task_id in _task_ids(
            getattr(transitions, "newly_ready", ()) or ()
        ):
            task = kb.get_task(conn, task_id)
            if task is not None and task.status in {"ready", "review"}:
                ready_ids.append(task_id)
        result = decompose_and_dispatch(
            specification_ids,
            ready_task_ids=ready_ids,
            board=effective_board,
            conn=conn,
            author=author,
            policy=policy,
        )
        result["warnings"] = list(
            dict.fromkeys([*carried_warnings, *result["warnings"]])
        )
        return result
    except Exception as exc:
        warning = (
            "inline transition dispatch failed after completion: "
            f"{type(exc).__name__}: {exc}; the reconciliation watcher will "
            "recover it"
        )
        return {
            "specification_task_ids": [],
            "decomposition": [],
            "candidate_task_ids": [],
            "dispatch": {
                **_dispatch_payload(kb.DispatchResult()),
                "error": warning,
            },
            "warnings": list(
                dict.fromkeys([*carried_warnings, warning])
            ),
        }
    finally:
        if owned_connection and conn is not None:
            conn.close()
