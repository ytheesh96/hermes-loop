"""Kanban dashboard plugin — backend API routes.

Mounted at /api/plugins/kanban/ by the dashboard plugin system.

This layer is intentionally thin: every handler is a small wrapper around
``hermes_cli.kanban_db`` or a direct SQL query. Writes use the same code
paths the CLI and gateway ``/kanban`` command use, so the three surfaces
cannot drift.

Live updates arrive via the ``/events`` WebSocket, which tails the
append-only ``task_events`` table on a short poll interval (WAL mode lets
reads run alongside the dispatcher's IMMEDIATE write transactions).

Security note
-------------
Plugin HTTP routes go through the dashboard's session-token auth middleware
(``web_server.auth_middleware``) just like core API routes — every
``/api/plugins/...`` request must present the session bearer token (or the
session cookie set when you load the dashboard HTML). The token is the
random per-process ``_SESSION_TOKEN`` printed at startup; the dashboard's
own pages inject it via ``window.__HERMES_SESSION_TOKEN__`` so logged-in
browsers don't have to handle it manually.

For the ``/events`` WebSocket we still require the session token as a
``?token=`` query parameter (browsers cannot set the ``Authorization``
header on an upgrade request), matching the established pattern used by
the in-browser PTY bridge in ``hermes_cli/web_server.py``.

This means ``hermes dashboard --host 0.0.0.0`` is safe to run on a LAN:
plugin routes are no longer an unauthenticated exception. The auth still
isn't multi-user — anyone who can read the printed URL+token gets full
dashboard access — but they can't ride along just because they can reach
the port.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status as http_status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from hermes_cli import kanban_db
from hermes_cli import kanban_diagnostics as kd

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Auth helper — WebSocket only (HTTP routes live behind the dashboard's
# existing plugin-bypass; this is documented above).
# ---------------------------------------------------------------------------

def _ws_upgrade_authorized(ws: "WebSocket") -> bool:
    """Authorize a WebSocket upgrade by delegating to the dashboard's canonical
    WS auth gate (``hermes_cli.web_server._ws_auth_ok``).

    Delegating (rather than re-implementing a ``_SESSION_TOKEN``-only check)
    means this endpoint transparently accepts whatever the core gate accepts
    in each mode:

      * loopback / ``--insecure``: legacy ``?token=<_SESSION_TOKEN>``
      * gated OAuth: single-use ``?ticket=`` (the browser SDK's
        ``buildWsUrl`` mints one per connect)
      * server-internal: the process-lifetime ``?internal=`` credential

    The previous bespoke check only understood ``_SESSION_TOKEN``, so the
    kanban live-events WS was rejected on every OAuth-gated deployment even
    though the rest of the dashboard worked. Routing through the shared gate
    also means this can never drift from core auth again.

    Imported lazily so the plugin still loads in test contexts where the
    dashboard ``web_server`` module isn't importable (e.g. the bare-FastAPI
    test harness); there we accept so the tail loop stays testable, matching
    the prior behaviour.
    """
    try:
        from hermes_cli import web_server as _ws
    except Exception:
        # No dashboard context (tests). Accept so the tail loop is still
        # testable; in production the dashboard module always imports
        # cleanly because it's the caller.
        return True
    return bool(_ws._ws_auth_ok(ws))


def _resolve_board(board: Optional[str]) -> Optional[str]:
    """Validate and normalise a board slug from a query param.

    Raises :class:`HTTPException` 400 on malformed slugs so the browser
    sees a clean error instead of a 500. Returns the normalised slug,
    or ``None`` when the caller omitted the param (which then falls
    through to the active board inside ``kb.connect()``).
    """
    if board is None or board == "":
        return None
    try:
        normed = kanban_db._normalize_board_slug(board)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if normed and normed != kanban_db.DEFAULT_BOARD and not kanban_db.board_exists(normed):
        raise HTTPException(
            status_code=404,
            detail=f"board {normed!r} does not exist",
        )
    return normed


def _conn(board: Optional[str] = None):
    """Open a kanban_db connection, auto-initializing on first use.

    ``board`` is the query-param slug (already normalised by
    :func:`_resolve_board`). When ``None`` the active board is used
    via the resolution chain (env var → ``current`` file → ``default``).
    """
    return kanban_db.connect(board=board)


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

# Columns shown by the dashboard, in left-to-right order. "archived" is
# available via a filter toggle rather than a visible column.
#
# Keep this in sync with kanban_db.VALID_STATUSES.  In particular,
# ``scheduled`` is a first-class waiting column used for time-based follow-ups;
# if it is omitted here, the board-level fallback below mis-buckets scheduled
# tasks into ``todo`` and makes the dashboard look like the Scheduled column
# disappeared.
BOARD_COLUMNS: list[str] = [
    "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
]


_CARD_SUMMARY_PREVIEW_CHARS = 200
_LOOP_INTAKE_EVENT_KIND = "loop_intake_state"
_LOOP_NODE_EVENT_KIND = "loop_node_state"
_LOOP_NODE_METADATA_FIELDS = (
    "branch_kind",
    "decision_group_id",
    "selection_state",
)
_LOOP_INTAKE_DRAFT_PAYLOAD = {
    "needed": True,
    "state": "drafted",
    "source": "slash_loop_draft",
    "dispatchable": False,
}


def _task_dict(
    task: kanban_db.Task,
    *,
    latest_summary: Optional[str] = None,
) -> dict[str, Any]:
    d = asdict(task)
    # Add derived age metrics so the UI can colour stale cards without
    # computing deltas client-side.
    try:
        d["age"] = kanban_db.task_age(task)
    except Exception:
        d["age"] = {"created_age_seconds": None, "started_age_seconds": None, "time_to_complete_seconds": None}
    # Surface the latest non-null run summary so dashboards don't show
    # blank cards/drawers for tasks where the worker handed off via
    # ``task_runs.summary`` (the kanban-worker pattern) instead of
    # ``tasks.result``. ``None`` when no run has produced a summary yet.
    d["latest_summary"] = latest_summary
    # Keep body short on list endpoints; full body comes from /tasks/:id.
    return d


def _normalized_loop_intake_payload(payload: Any) -> Optional[dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    if payload.get("needed") is not True:
        return None
    state = str(payload.get("state") or "").strip() or "drafted"
    source = str(payload.get("source") or "").strip() or "slash_loop_draft"
    dispatchable = bool(payload.get("dispatchable") is True)
    return {
        "needed": True,
        "state": state,
        "source": source,
        "dispatchable": dispatchable,
    }


def _loop_intake_states_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM (
            SELECT e.*, ROW_NUMBER() OVER (
                PARTITION BY e.task_id ORDER BY e.created_at DESC, e.id DESC
            ) AS rn
            FROM task_events e
            WHERE e.task_id IN ({placeholders})
              AND e.kind = ?
        ) ranked
        WHERE rn = 1
        """,
        tuple(task_ids) + (_LOOP_INTAKE_EVENT_KIND,),
    ).fetchall()
    states: dict[str, dict[str, Any]] = {}
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if row["payload"] else None
        except Exception:
            payload = None
        normalized = _normalized_loop_intake_payload(payload)
        if normalized:
            states[str(row["task_id"])] = normalized
    return states


def _loop_intake_state_for_task(conn: sqlite3.Connection, task_id: str) -> Optional[dict[str, Any]]:
    return _loop_intake_states_for_tasks(conn, [task_id]).get(task_id)


def _specification_failures_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, dict[str, Any]]:
    """Return the current-revision decomposer failure for each task."""
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM (
            SELECT e.*, ROW_NUMBER() OVER (
                PARTITION BY e.task_id ORDER BY e.id DESC
            ) AS rn
            FROM task_events e
            WHERE e.task_id IN ({placeholders})
              AND e.kind IN ('specification_started', 'specification_failed')
        ) ranked
        WHERE rn = 1
        """,
        tuple(task_ids),
    ).fetchall()
    now = int(time.time())
    failures: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row["kind"] != "specification_failed":
            continue
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        task_id = str(row["task_id"])
        fingerprint = str(payload.get("fingerprint") or "")
        if fingerprint and kanban_db.task_specification_fingerprint(conn, task_id) != fingerprint:
            continue
        retry_after = int(payload.get("retry_after") or 0)
        failures[task_id] = {
            "reason": str(payload.get("reason") or "Specification failed"),
            "retry_after": retry_after,
            "retry_after_seconds": int(payload.get("retry_after_seconds") or 0),
            "backing_off": retry_after > now,
        }
    return failures


def _specification_failure_for_task(
    conn: sqlite3.Connection,
    task_id: str,
) -> Optional[dict[str, Any]]:
    return _specification_failures_for_tasks(conn, [task_id]).get(task_id)


def _loop_node_metadata_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT task_id, payload
        FROM task_events
        WHERE task_id IN ({placeholders})
          AND kind = ?
        ORDER BY id ASC
        """,
        tuple(task_ids) + (_LOOP_NODE_EVENT_KIND,),
    ).fetchall()
    metadata: dict[str, dict[str, Any]] = {task_id: {} for task_id in task_ids}
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        state = metadata.setdefault(str(row["task_id"]), {})
        for key in _LOOP_NODE_METADATA_FIELDS:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                state[key] = value.strip()
    return {task_id: state for task_id, state in metadata.items() if state}


def _loop_node_metadata_for_task(conn: sqlite3.Connection, task_id: str) -> Optional[dict[str, Any]]:
    return _loop_node_metadata_for_tasks(conn, [task_id]).get(task_id)


def _task_dict_with_loop_intake(
    conn: sqlite3.Connection,
    task: kanban_db.Task,
    *,
    latest_summary: Optional[str] = None,
) -> dict[str, Any]:
    item = _task_dict(task, latest_summary=latest_summary)
    intake = _loop_intake_state_for_task(conn, task.id)
    if intake:
        item["loop_intake"] = intake
    specification_failure = _specification_failure_for_task(conn, task.id)
    if specification_failure:
        item["specification_failure"] = specification_failure
    active_decomposition_child_count = kanban_db.active_decomposition_child_count(
        conn, task.id
    )
    if active_decomposition_child_count:
        item["active_decomposition_child_count"] = active_decomposition_child_count
    metadata = _loop_node_metadata_for_task(conn, task.id)
    if metadata:
        item.update(metadata)
    return item


def _loop_planning_projection(
    conn: sqlite3.Connection,
    workflow_id: Optional[str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
    """Return lightweight planning nodes for one workflow without task rows.

    ``tasks`` / ``links`` stay reserved for real Kanban execution rows and
    formal prerequisites. These planning nodes are rendered by the Loop UI as
    graph/detail records only; they are not dispatchable queue items.
    """
    if not workflow_id:
        return [], [], 0
    try:
        from hermes_cli import loop_graph

        graph = loop_graph.read_graph(conn, workflow_id, include_nodes=True)
    except Exception:
        log.debug(
            "loop planning projection failed for workflow %s",
            workflow_id,
            exc_info=True,
        )
        return [], [], 0

    nodes: list[dict[str, Any]] = []
    links: list[dict[str, str]] = []
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or node.get("is_plan_node") is not True:
            continue
        node_id = str(node.get("task_id") or "").strip()
        if not node_id:
            continue
        parents = [str(parent) for parent in node.get("parents") or [] if str(parent)]
        children = [str(child) for child in node.get("children") or [] if str(child)]
        item: dict[str, Any] = {
            "id": node_id,
            "title": node.get("title") or node_id,
            "body": node.get("body"),
            "status": node.get("status") or "scheduled",
            "workflow_id": workflow_id,
            "tenant": workflow_id,
            "created_by": "workflow_plan",
            "is_planning_node": True,
            "active": bool(node.get("active")),
            "frontier": bool(node.get("frontier")),
            "included_parent_ids": parents,
            "included_child_ids": children,
            "links": {"parents": parents, "children": children},
            "parent_count": len(parents),
            "child_count": len(children),
            "branch_kind": node.get("branch_kind"),
            "decision_group_id": node.get("decision_group_id"),
            "selection_state": node.get("selection_state"),
            "execution_task_id": node.get("execution_task_id"),
            "suggested_owner": node.get("suggested_owner"),
        }
        nodes.append(item)
        for parent_id in parents:
            links.append({
                "parent_id": parent_id,
                "child_id": node_id,
                "workflow_id": workflow_id,
            })
    return nodes, links, int(graph.get("graph_revision") or 0)


def _task_has_unresolved_loop_intake(conn: sqlite3.Connection, task_id: str) -> bool:
    intake = _loop_intake_state_for_task(conn, task_id)
    if not intake:
        return False
    if intake.get("dispatchable") is True:
        return False
    return str(intake.get("state") or "").strip().lower() not in {
        "planned",
        "spec-ready",
        "spec_ready",
        "approved",
    }


def _loop_intake_is_planned(intake: Optional[dict[str, Any]]) -> bool:
    if not intake or intake.get("needed") is not True or intake.get("dispatchable") is True:
        return False
    return str(intake.get("state") or "").strip().lower() == "planned"


def _activate_planned_loop(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    author: str,
) -> dict[str, Any]:
    intake = _loop_intake_state_for_task(conn, task_id)
    if intake and intake.get("dispatchable") is True and str(intake.get("state") or "").lower() == "approved":
        return {"ok": True, "task_id": task_id, "activated_ids": [], "already_active": True}
    if not _loop_intake_is_planned(intake):
        return {
            "ok": False,
            "task_id": task_id,
            "activated_ids": [],
            "reason": f"Loop task {task_id} must be triaged before it can be submitted.",
        }

    task = kanban_db.get_task(conn, task_id)
    if task is None:
        return {
            "ok": False,
            "task_id": task_id,
            "activated_ids": [],
            "reason": "unknown task id",
        }
    workflow_id = str(task.workflow_id or "").strip()
    if not workflow_id:
        return {
            "ok": False,
            "task_id": task_id,
            "activated_ids": [],
            "reason": f"task {task_id} has no workflow membership",
        }
    rows = conn.execute(
        "SELECT id, status FROM tasks WHERE workflow_id = ? "
        "ORDER BY created_at ASC, id ASC",
        (workflow_id,),
    ).fetchall()

    task_ids = list(dict.fromkeys(str(row["id"]) for row in rows))
    scheduled_ids = [str(row["id"]) for row in rows if row["status"] == "scheduled"]
    with kanban_db.write_txn(conn):
        if scheduled_ids:
            placeholders = ",".join("?" for _ in scheduled_ids)
            conn.execute(
                f"UPDATE tasks SET status = 'todo' WHERE id IN ({placeholders}) AND status = 'scheduled'",
                tuple(scheduled_ids),
            )
            for activated_id in scheduled_ids:
                kanban_db._append_event(
                    conn,
                    activated_id,
                    "loop_plan_activated",
                    {"workflow_id": workflow_id, "author": author},
                )
        kanban_db._append_event(
            conn,
            task_id,
            _LOOP_INTAKE_EVENT_KIND,
            {
                "needed": True,
                "state": "approved",
                "source": "desktop_submit",
                "dispatchable": True,
                "author": author,
            },
        )

    kanban_db.recompute_ready(conn)
    status_rows = conn.execute(
        f"SELECT id, status FROM tasks WHERE id IN ({','.join('?' for _ in task_ids)})",
        tuple(task_ids),
    ).fetchall()
    return {
        "ok": True,
        "task_id": task_id,
        "activated_ids": scheduled_ids,
        "already_active": False,
        "fanout": len(task_ids) > 1,
        "statuses": {str(row["id"]): str(row["status"]) for row in status_rows},
    }


def _task_has_loop_intake_blocking_ready(conn: sqlite3.Connection, task_id: str) -> bool:
    intake = _loop_intake_state_for_task(conn, task_id)
    return bool(intake and intake.get("needed") is True and intake.get("dispatchable") is not True)


def _task_has_loop_intake_pending_submit(conn: sqlite3.Connection, task_id: str) -> bool:
    intake = _loop_intake_state_for_task(conn, task_id)
    if not intake:
        return False
    if intake.get("needed") is not True or intake.get("dispatchable") is True:
        return False
    return True


def _loop_intake_required_reason(task_id: str) -> str:
    return (
        f"Loop planning is still in progress for {task_id}; let the foreground agent "
        "create the first live graph fragment."
    )


def _event_dict(event: kanban_db.Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "task_id": event.task_id,
        "kind": event.kind,
        "payload": event.payload,
        "created_at": event.created_at,
        "run_id": event.run_id,
    }


def _comment_dict(c: kanban_db.Comment) -> dict[str, Any]:
    return {
        "id": c.id,
        "task_id": c.task_id,
        "author": c.author,
        "body": c.body,
        "created_at": c.created_at,
    }


def _attachment_dict(a: kanban_db.Attachment) -> dict[str, Any]:
    """Serialise an Attachment for the drawer. ``stored_path`` is the
    absolute on-disk path workers read; the UI uses ``id`` for download."""
    return {
        "id": a.id,
        "task_id": a.task_id,
        "filename": a.filename,
        "content_type": a.content_type,
        "size": a.size,
        "uploaded_by": a.uploaded_by,
        "stored_path": a.stored_path,
        "created_at": a.created_at,
    }


def _run_dict(r: kanban_db.Run) -> dict[str, Any]:
    """Serialise a Run for the drawer's Run history section."""
    return {
        "id": r.id,
        "task_id": r.task_id,
        "profile": r.profile,
        "step_key": r.step_key,
        "status": r.status,
        "claim_lock": r.claim_lock,
        "claim_expires": r.claim_expires,
        "worker_pid": r.worker_pid,
        "max_runtime_seconds": r.max_runtime_seconds,
        "last_heartbeat_at": r.last_heartbeat_at,
        "started_at": r.started_at,
        "ended_at": r.ended_at,
        "outcome": r.outcome,
        "summary": r.summary,
        "metadata": r.metadata,
        "error": r.error,
    }


# Hallucination-warning event kinds — see complete_task() in kanban_db.py.
# completion_blocked_hallucination: kernel rejected created_cards with
#   phantom ids; task stays in prior state.
# suspected_hallucinated_references: prose scan found t_<hex> in summary
#   that doesn't resolve; completion succeeded, advisory only.
_WARNING_EVENT_KINDS = (
    "completion_blocked_hallucination",
    "suspected_hallucinated_references",
)


def _compute_task_diagnostics(
    conn: sqlite3.Connection,
    task_ids: Optional[list[str]] = None,
) -> dict[str, list[dict]]:
    """Run the diagnostic rule engine against every task (or a subset)
    and return ``{task_id: [diagnostic_dict, ...]}``.

    Tasks with no active diagnostics are omitted from the result.
    Uses ``hermes_cli.kanban_diagnostics`` — see that module for the
    rule definitions.
    """
    from hermes_cli import kanban_diagnostics as kd
    from hermes_cli.config import load_config

    diag_config = kd.config_from_runtime_config(load_config())

    # Build the candidate task list. We need each task's row + its
    # events + its runs. Doing N separate queries works but scales
    # poorly; do three aggregate queries instead.
    if task_ids is not None:
        if not task_ids:
            return {}
        placeholders = ",".join(["?"] * len(task_ids))
        rows = conn.execute(
            f"SELECT * FROM tasks WHERE id IN ({placeholders})",
            tuple(task_ids),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE status != 'archived'",
        ).fetchall()

    if not rows:
        return {}

    # Index events + runs by task id. For very large boards this will
    # slurp a lot — acceptable on the dashboard's typical working set
    # (hundreds of tasks), but we can add pagination / filtering later
    # if profiling shows it's a hotspot.
    row_ids = [r["id"] for r in rows]
    placeholders = ",".join(["?"] * len(row_ids))
    events_by_task: dict[str, list] = {tid: [] for tid in row_ids}
    for ev_row in conn.execute(
        f"SELECT * FROM task_events WHERE task_id IN ({placeholders}) ORDER BY id",
        tuple(row_ids),
    ).fetchall():
        events_by_task.setdefault(ev_row["task_id"], []).append(ev_row)
    runs_by_task: dict[str, list] = {tid: [] for tid in row_ids}
    for run_row in conn.execute(
        f"SELECT * FROM task_runs WHERE task_id IN ({placeholders}) ORDER BY id",
        tuple(row_ids),
    ).fetchall():
        runs_by_task.setdefault(run_row["task_id"], []).append(run_row)

    out: dict[str, list[dict]] = {}
    for r in rows:
        tid = r["id"]
        diags = kd.compute_task_diagnostics(
            r,
            events_by_task.get(tid, []),
            runs_by_task.get(tid, []),
            config=diag_config,
        )
        if diags:
            out[tid] = [d.to_dict() for d in diags]
    return out


def _warnings_summary_from_diagnostics(
    diagnostics: list[dict],
) -> Optional[dict]:
    """Compact summary for cards: {count, highest_severity, kinds,
    latest_at}. Replaces the old hallucination-only ``warnings`` object
    — same shape additions plus ``highest_severity`` so the UI can color
    badges per diagnostic severity.

    Returns None when ``diagnostics`` is empty.
    """
    if not diagnostics:
        return None
    from hermes_cli.kanban_diagnostics import SEVERITY_ORDER

    kinds: dict[str, int] = {}
    latest = 0
    highest_idx = -1
    highest_sev: Optional[str] = None
    count = 0
    for d in diagnostics:
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + d.get("count", 1)
        count += d.get("count", 1)
        la = d.get("last_seen_at") or 0
        if la > latest:
            latest = la
        sev = d.get("severity")
        if sev in SEVERITY_ORDER:
            idx = SEVERITY_ORDER.index(sev)
            if idx > highest_idx:
                highest_idx = idx
                highest_sev = sev
    return {
        "count": count,
        "kinds": kinds,
        "latest_at": latest,
        "highest_severity": highest_sev,
    }


def _links_for(conn: sqlite3.Connection, task_id: str) -> dict[str, list[str]]:
    """Return {'parents': [...], 'children': [...]} for a task."""
    parents = [
        r["parent_id"]
        for r in conn.execute(
            "SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id",
            (task_id,),
        )
    ]
    children = [
        r["child_id"]
        for r in conn.execute(
            "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
            (task_id,),
        )
    ]
    return {"parents": parents, "children": children}


def _session_compression_lineage(session_id: Optional[str]) -> list[str]:
    """Return compression-root → current/tip lineage ids for a session.

    If the session store is unavailable (common in isolated tests or fresh
    installs), degrade to the provided session id. The endpoint remains useful
    for tasks whose ``session_id`` was already stored on Kanban rows.
    """
    sid = (session_id or os.environ.get("HERMES_SESSION_ID") or "").strip()
    if not sid:
        return []

    try:
        from hermes_state import DEFAULT_DB_PATH, SessionDB
    except Exception:
        return [sid]

    try:
        if not DEFAULT_DB_PATH.exists():
            return [sid]
        session_db = SessionDB(read_only=True)
    except Exception:
        return [sid]

    try:
        lineage = session_db.get_compression_lineage_root_to_tip(sid)
        return lineage or [sid]
    except Exception:
        return [sid]
    finally:
        try:
            session_db.close()
        except Exception:
            pass


_SESSION_SOURCE_LOOP_TOOL_NAMES = {
    "loop_block",
    "loop_create",
    # Compatibility-only: old session transcripts can still contain this
    # retired tool result. Keep parsing its loop_item_id so legacy tasks remain
    # discoverable from their originating session.
    "loop_request_review",
    "loop_status",
    "loop_update",
}


def _append_unique_task_id(out: list[str], seen: set[str], value: Any) -> None:
    task_id = str(value or "").strip()
    if not task_id or task_id in seen:
        return
    seen.add(task_id)
    out.append(task_id)


def _loop_task_ids_from_tool_result(result: Any) -> list[str]:
    if not isinstance(result, dict):
        return []
    out: list[str] = []
    seen: set[str] = set()

    for key in ("loop_item_id", "task_id"):
        _append_unique_task_id(out, seen, result.get(key))

    for key in ("item", "task"):
        nested = result.get(key)
        if isinstance(nested, dict):
            _append_unique_task_id(out, seen, nested.get("id"))

    return out


def _loop_tool_task_ids_for_sessions(session_ids: list[str]) -> list[str]:
    if not session_ids:
        return []
    try:
        from hermes_state import DEFAULT_DB_PATH, SessionDB
    except Exception:
        return []
    try:
        if not DEFAULT_DB_PATH.exists():
            return []
        session_db = SessionDB(read_only=True)
    except Exception:
        return []

    out: list[str] = []
    seen: set[str] = set()
    try:
        for session_id in session_ids:
            try:
                messages = session_db.get_messages(session_id)
            except Exception:
                continue
            for message in messages:
                tool_name = str(message.get("tool_name") or "").strip()
                if tool_name not in _SESSION_SOURCE_LOOP_TOOL_NAMES:
                    continue
                content = message.get("content")
                if not isinstance(content, str):
                    continue
                try:
                    result = json.loads(content)
                except json.JSONDecodeError:
                    continue
                for task_id in _loop_task_ids_from_tool_result(result):
                    _append_unique_task_id(out, seen, task_id)
    finally:
        try:
            session_db.close()
        except Exception:
            pass
    return out


def _infer_session_source_tenants(
    conn: sqlite3.Connection,
    lineage_session_ids: list[str],
) -> list[str]:
    """Return tenant labels for compatibility/display, not discovery mode.

    Legacy rows that stored the session key in ``tenant`` win so old Loop roots
    keep their familiar label. If none exist, report non-null tenants already
    attached to explicit source-session rows without using them to filter.
    """
    if not lineage_session_ids:
        return []
    placeholders = ",".join("?" for _ in lineage_session_ids)
    lineage_tenants = [
        r["tenant"]
        for r in conn.execute(
            f"""
            SELECT DISTINCT tenant
            FROM tasks
            WHERE tenant IN ({placeholders})
              AND status != 'archived'
            ORDER BY tenant
            """,
            tuple(lineage_session_ids),
        )
    ]
    if lineage_tenants:
        return lineage_tenants
    return [
        r["tenant"]
        for r in conn.execute(
            f"""
            SELECT DISTINCT tenant
            FROM tasks
            WHERE session_id IN ({placeholders})
              AND tenant IS NOT NULL
              AND status != 'archived'
            ORDER BY tenant
            """,
            tuple(lineage_session_ids),
        )
    ]


def _session_source_board_candidates(explicit_board: Optional[str]) -> list[str]:
    if explicit_board:
        return [explicit_board]

    candidates: list[str] = []

    def add(slug: str | None) -> None:
        value = (slug or "").strip()
        if value and value not in candidates:
            candidates.append(value)

    add(kanban_db.get_current_board())
    for meta in kanban_db.list_boards(include_archived=False):
        add(str(meta.get("slug") or ""))

    return candidates or [kanban_db.DEFAULT_BOARD]


def _query_session_source_rows(
    conn: sqlite3.Connection,
    lineage_session_ids: list[str],
    *,
    explicit_tenant: Optional[str],
    include_archived: bool,
    referenced_task_ids: Optional[list[str]] = None,
) -> tuple[list[sqlite3.Row], list[str], list[str]]:
    inferred_tenants = _infer_session_source_tenants(conn, lineage_session_ids)
    tenant_filters = [explicit_tenant] if explicit_tenant else inferred_tenants

    referenced_task_ids = [
        task_id
        for index, task_id in enumerate(referenced_task_ids or [])
        if task_id and task_id not in (referenced_task_ids or [])[:index]
    ]

    disjuncts: list[str] = []
    params: list[Any] = []
    if lineage_session_ids:
        placeholders = ",".join("?" for _ in lineage_session_ids)
        disjuncts.append(f"session_id IN ({placeholders})")
        params.extend(lineage_session_ids)
        # Tenant used to double as source identity before ``session_id`` was
        # introduced. Keep this read-only fallback for those older rows.
        disjuncts.append(f"tenant IN ({placeholders})")
        params.extend(lineage_session_ids)

    if referenced_task_ids:
        disjuncts.append(f"id IN ({','.join('?' for _ in referenced_task_ids)})")
        params.extend(referenced_task_ids)

    where = [f"({' OR '.join(disjuncts)})"] if disjuncts else ["0"]
    if explicit_tenant:
        where.append("tenant = ?")
        params.append(explicit_tenant)
    if not include_archived:
        where.append("status != 'archived'")

    rows = conn.execute(
        f"""
        SELECT * FROM tasks
        WHERE {' AND '.join(where)}
        ORDER BY created_at ASC, priority DESC, id ASC
        """,
        tuple(params),
    ).fetchall()
    return rows, inferred_tenants, tenant_filters


def _compact_task_context(task: kanban_db.Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "tenant": task.tenant,
        "session_id": task.session_id,
        "created_at": task.created_at,
        "completed_at": task.completed_at,
    }


def _topologically_order_tasks(
    tasks: list[kanban_db.Task],
    links: list[dict[str, str]],
) -> list[kanban_db.Task]:
    """Stable Kahn ordering over returned tasks; ties keep creation order."""
    task_by_id = {t.id: t for t in tasks}
    original = {t.id: idx for idx, t in enumerate(tasks)}
    indegree = {t.id: 0 for t in tasks}
    children: dict[str, list[str]] = {t.id: [] for t in tasks}
    for link in links:
        parent_id = link["parent_id"]
        child_id = link["child_id"]
        if parent_id in task_by_id and child_id in task_by_id:
            children[parent_id].append(child_id)
            indegree[child_id] += 1
    ready = sorted(
        [task_id for task_id, degree in indegree.items() if degree == 0],
        key=lambda task_id: original[task_id],
    )
    ordered: list[kanban_db.Task] = []
    while ready:
        task_id = ready.pop(0)
        ordered.append(task_by_id[task_id])
        for child_id in sorted(children[task_id], key=lambda cid: original[cid]):
            indegree[child_id] -= 1
            if indegree[child_id] == 0:
                ready.append(child_id)
                ready.sort(key=lambda cid: original[cid])
    if len(ordered) != len(tasks):
        # Cycles should be prevented at write time, but preserve all real rows if
        # a legacy DB contains one.
        ordered_ids = {t.id for t in ordered}
        ordered.extend(t for t in tasks if t.id not in ordered_ids)
    return ordered



def _latest_runs_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM (
            SELECT r.*, ROW_NUMBER() OVER (
                PARTITION BY r.task_id ORDER BY r.started_at DESC, r.id DESC
            ) AS rn
            FROM task_runs r
            WHERE r.task_id IN ({placeholders})
        ) ranked
        WHERE rn = 1
        """,
        tuple(task_ids),
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        run = kanban_db.Run.from_row(row)
        out[run.task_id] = _run_dict(run)
    return out


def _latest_event_id_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> int:
    """Return the scoped task_events revision for a session-source payload."""
    if not task_ids:
        return 0
    placeholders = ",".join("?" for _ in task_ids)
    row = conn.execute(
        f"SELECT COALESCE(MAX(id), 0) AS m FROM task_events WHERE task_id IN ({placeholders})",
        tuple(task_ids),
    ).fetchone()
    return int(row["m"] if row else 0)




def _preview_text(value: Any, *, max_chars: int = 200) -> Optional[str]:
    if value is None:
        return None
    text = str(value).replace("\x00", "").strip().splitlines()[0].strip()
    if not text:
        return None
    return text[: max(0, max_chars)]


def _worker_session_id_from_metadata(metadata: Any) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("worker_session_id")
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _worker_current_tool_from_metadata(metadata: Any) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    for key in ("current_tool", "currentTool", "current_tool_name", "tool_name", "last_tool"):
        value = metadata.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _log_tail_payload(task_id: str, *, board: Optional[str], tail_bytes: int = 8192) -> dict[str, Any]:
    log_path = kanban_db.worker_log_path(task_id, board=board)
    exists = log_path.exists()
    size = log_path.stat().st_size if exists else 0
    content: Optional[str] = None
    if exists and tail_bytes > 0:
        content = kanban_db.read_worker_log(task_id, tail_bytes=tail_bytes, board=board)
    return {
        "log_path": str(log_path),
        "log_tail_available": exists,
        "log_size_bytes": size,
        "log_tail": content if exists and tail_bytes > 0 else None,
        "log_tail_truncated": bool(exists and tail_bytes > 0 and size > tail_bytes),
    }


def _recent_events_by_task(
    conn: sqlite3.Connection,
    task_ids: list[str],
    *,
    limit_per_task: int = 5,
) -> dict[str, list[dict[str, Any]]]:
    if not task_ids or limit_per_task <= 0:
        return {task_id: [] for task_id in task_ids}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT * FROM (
            SELECT e.*, ROW_NUMBER() OVER (
                PARTITION BY e.task_id ORDER BY e.id DESC
            ) AS rn
            FROM task_events e
            WHERE e.task_id IN ({placeholders})
        ) ranked
        WHERE rn <= ?
        ORDER BY task_id ASC, created_at ASC, id ASC
        """,
        tuple(task_ids) + (limit_per_task,),
    ).fetchall()
    events_by_task: dict[str, list[dict[str, Any]]] = {task_id: [] for task_id in task_ids}
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if row["payload"] else None
        except Exception:
            payload = None
        event = kanban_db.Event(
            id=row["id"],
            task_id=row["task_id"],
            kind=row["kind"],
            payload=payload,
            created_at=row["created_at"],
            run_id=(int(row["run_id"]) if "run_id" in row.keys() and row["run_id"] is not None else None),
        )
        events_by_task.setdefault(row["task_id"], []).append(_event_dict(event))
    return events_by_task


def _worker_activity_for_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
    latest_runs: dict[str, dict[str, Any]],
    *,
    board: Optional[str],
) -> dict[str, dict[str, Any]]:
    """Reconstruct compact worker status from durable runs/events only.

    This is the reload/late-open fallback for the live kanban.worker stream:
    it deliberately exposes status, timings, outcome, and a sanitized summary
    preview, not raw tool output or arbitrary event payloads.
    """
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    event_rows = conn.execute(
        f"""
        SELECT * FROM (
            SELECT e.*, ROW_NUMBER() OVER (
                PARTITION BY e.task_id ORDER BY e.id DESC
            ) AS rn
            FROM task_events e
            WHERE e.task_id IN ({placeholders})
              AND e.kind IN (
                'claimed', 'spawned', 'heartbeat', 'completed', 'blocked',
                'failed', 'reclaimed', 'spawn_failed', 'crashed', 'timed_out',
                'stale', 'protocol_violation', 'rate_limited', 'gave_up'
              )
        ) ranked
        WHERE rn = 1
        """,
        tuple(task_ids),
    ).fetchall()
    latest_events = {row["task_id"]: row for row in event_rows}
    recent_events = _recent_events_by_task(conn, task_ids)
    out: dict[str, dict[str, Any]] = {}
    for task_id, run in latest_runs.items():
        event = latest_events.get(task_id)
        status = run.get("status")
        outcome = run.get("outcome")
        summary_preview = _preview_text(run.get("summary"))
        error_preview = _preview_text(run.get("error"))
        current_tool = _worker_current_tool_from_metadata(run.get("metadata"))
        out[task_id] = {
            "task_id": task_id,
            "run_id": run.get("id"),
            "status": status,
            "outcome": outcome,
            "profile": run.get("profile"),
            "started_at": run.get("started_at"),
            "ended_at": run.get("ended_at"),
            "last_heartbeat_at": run.get("last_heartbeat_at"),
            "worker_session_id": run.get("worker_session_id") or _worker_session_id_from_metadata(run.get("metadata")),
            "worker_pid": run.get("worker_pid"),
            "claim_expires": run.get("claim_expires"),
            "recent_task_events": recent_events.get(task_id, []),
            "latest_event_id": int(event["id"]) if event is not None else None,
            "latest_event_kind": event["kind"] if event is not None else None,
            "summary_preview": summary_preview,
            "error_preview": error_preview,
        }
        if current_tool:
            out[task_id]["current_tool"] = current_tool
        out[task_id].update(_log_tail_payload(task_id, board=board))
    return out


@router.get("/session-source")
def get_session_source(
    session_id: Optional[str] = Query(
        None,
        description="Current Loop session id; defaults to HERMES_SESSION_ID when omitted",
    ),
    tenant: Optional[str] = Query(
        None,
        description="Optional tenant override. When omitted, non-null tenants are inferred from lineage tasks.",
    ),
    include_archived: bool = Query(False),
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
    since_event_id: Optional[int] = Query(
        None,
        description="Client's last seen source revision; response reports whether scoped task_events changed.",
    ),
):
    """Return real Kanban tasks for the current Loop compression lineage.

    The response is intentionally flat: every row is a real ``tasks`` row. The
    ``links`` array contains only formal ``task_links`` prerequisite edges; no
    synthetic root/container node is added.
    """
    board = _resolve_board(board)
    lineage_session_ids = _session_compression_lineage(session_id)
    if not lineage_session_ids:
        raise HTTPException(status_code=400, detail="session_id is required")

    explicit_tenant = (tenant or "").strip() or None
    selected_board: Optional[str] = None
    conn: Optional[sqlite3.Connection] = None
    rows: list[sqlite3.Row] = []
    inferred_tenants: list[str] = []
    tenant_filters: list[str] = []

    candidate_boards = _session_source_board_candidates(board)
    referenced_task_ids = _loop_tool_task_ids_for_sessions(lineage_session_ids)
    attempted_paths: set[str] = set()
    first_candidate_error: Optional[Exception] = None
    fallback: Optional[
        tuple[str, sqlite3.Connection, list[str], list[str]]
    ] = None
    for candidate_board in candidate_boards:
        candidate_path = str(
            kanban_db.kanban_db_path(board=candidate_board).resolve()
        )
        if candidate_path in attempted_paths:
            continue
        attempted_paths.add(candidate_path)

        candidate_conn: Optional[sqlite3.Connection] = None
        try:
            candidate_conn = _conn(board=candidate_board)
            candidate_rows, candidate_inferred, candidate_filters = _query_session_source_rows(
                candidate_conn,
                lineage_session_ids,
                explicit_tenant=explicit_tenant,
                include_archived=include_archived,
                referenced_task_ids=referenced_task_ids,
            )
        except (kanban_db.KanbanDbCorruptError, sqlite3.Error, OSError) as exc:
            if candidate_conn is not None:
                candidate_conn.close()
            if board is not None:
                if fallback is not None:
                    fallback[1].close()
                raise
            if first_candidate_error is None:
                first_candidate_error = exc
            log.warning(
                "Skipping unreadable Kanban board %r during session-source discovery: %s",
                candidate_board,
                exc,
            )
            continue
        except Exception:
            if candidate_conn is not None:
                candidate_conn.close()
            if fallback is not None:
                fallback[1].close()
            raise

        if candidate_rows:
            if fallback is not None:
                fallback[1].close()
            selected_board = candidate_board
            conn = candidate_conn
            rows = candidate_rows
            inferred_tenants = candidate_inferred
            tenant_filters = candidate_filters
            break

        if fallback is None:
            fallback = (
                candidate_board,
                candidate_conn,
                candidate_inferred,
                candidate_filters,
            )
        else:
            candidate_conn.close()

    if conn is None:
        if fallback is not None:
            selected_board, conn, inferred_tenants, tenant_filters = fallback
        elif first_candidate_error is not None:
            raise first_candidate_error
        else:
            raise HTTPException(
                status_code=503,
                detail="No readable Kanban board is available",
            )

    try:
        tasks = [kanban_db.Task.from_row(row) for row in rows]
        task_ids = [task.id for task in tasks]
        task_id_set = set(task_ids)

        if task_ids:
            link_rows = conn.execute(
                f"""
                SELECT parent_id, child_id
                FROM task_links
                WHERE parent_id IN ({','.join('?' for _ in task_ids)})
                   OR child_id IN ({','.join('?' for _ in task_ids)})
                ORDER BY parent_id, child_id
                """,
                tuple(task_ids + task_ids),
            ).fetchall()
        else:
            link_rows = []
        all_links = [
            {"parent_id": row["parent_id"], "child_id": row["child_id"]}
            for row in link_rows
        ]
        included_links = [
            link for link in all_links
            if link["parent_id"] in task_id_set and link["child_id"] in task_id_set
        ]

        context_ids = sorted(
            {
                endpoint
                for link in all_links
                for endpoint in (link["parent_id"], link["child_id"])
                if endpoint not in task_id_set
            }
        )
        context: dict[str, dict[str, Any]] = {}
        if context_ids:
            context_rows = conn.execute(
                f"SELECT * FROM tasks WHERE id IN ({','.join('?' for _ in context_ids)})",
                tuple(context_ids),
            ).fetchall()
            context = {
                row["id"]: _compact_task_context(kanban_db.Task.from_row(row))
                for row in context_rows
            }

        summary_map = kanban_db.latest_summaries(conn, task_ids)
        latest_runs = _latest_runs_for_tasks(conn, task_ids)
        worker_activity = _worker_activity_for_tasks(conn, task_ids, latest_runs, board=selected_board or board)
        source_revision = _latest_event_id_for_tasks(conn, task_ids)
        comment_counts: dict[str, int] = {}
        if task_ids:
            comment_counts = {
                r["task_id"]: r["n"]
                for r in conn.execute(
                    f"""
                    SELECT task_id, COUNT(*) AS n
                    FROM task_comments
                    WHERE task_id IN ({','.join('?' for _ in task_ids)})
                    GROUP BY task_id
                    """,
                    tuple(task_ids),
                )
            }
        diagnostics = _compute_task_diagnostics(conn, task_ids=task_ids) if task_ids else {}

        intake_states = _loop_intake_states_for_tasks(conn, task_ids)
        specification_failures = _specification_failures_for_tasks(conn, task_ids)
        active_decomposition_child_counts = (
            kanban_db.active_decomposition_child_counts(conn, task_ids)
        )
        loop_node_metadata = _loop_node_metadata_for_tasks(conn, task_ids)
        workflow_ids = list(
            dict.fromkeys(
                str(task.workflow_id).strip()
                for task in tasks
                if task.workflow_id and str(task.workflow_id).strip()
            )
        )
        planning_nodes: list[dict[str, Any]] = []
        planning_links: list[dict[str, str]] = []
        planning_revision = 0
        for workflow_id in workflow_ids:
            workflow_nodes, workflow_links, workflow_revision = (
                _loop_planning_projection(conn, workflow_id)
            )
            planning_nodes.extend(workflow_nodes)
            planning_links.extend(workflow_links)
            planning_revision = max(planning_revision, workflow_revision)
        source_revision = max(source_revision, planning_revision)
        ordered_tasks = _topologically_order_tasks(tasks, included_links)
        payload_tasks: list[dict[str, Any]] = []
        for task in ordered_tasks:
            task_links = _links_for(conn, task.id)
            item = _task_dict(task, latest_summary=summary_map.get(task.id))
            if task.id in intake_states:
                item["loop_intake"] = intake_states[task.id]
            if task.id in specification_failures:
                item["specification_failure"] = specification_failures[task.id]
            active_decomposition_child_count = active_decomposition_child_counts.get(task.id, 0)
            if active_decomposition_child_count:
                item["active_decomposition_child_count"] = active_decomposition_child_count
            if task.id in loop_node_metadata:
                item.update(loop_node_metadata[task.id])
            item["is_container"] = False
            item["links"] = task_links
            item["included_parent_ids"] = [pid for pid in task_links["parents"] if pid in task_id_set]
            item["included_child_ids"] = [cid for cid in task_links["children"] if cid in task_id_set]
            item["external_parent_tasks"] = [
                context[pid] for pid in task_links["parents"] if pid in context
            ]
            item["external_child_tasks"] = [
                context[cid] for cid in task_links["children"] if cid in context
            ]
            item["comment_count"] = comment_counts.get(task.id, 0)
            item["latest_run"] = latest_runs.get(task.id)
            item["worker_activity"] = worker_activity.get(task.id)
            if task.id in diagnostics:
                item["diagnostics"] = diagnostics[task.id]
                item["warnings"] = _warnings_summary_from_diagnostics(diagnostics[task.id])
            payload_tasks.append(item)

        return {
            "board": selected_board,
            "session_id": (session_id or os.environ.get("HERMES_SESSION_ID") or "").strip(),
            "lineage_session_ids": lineage_session_ids,
            "workflow_id": workflow_ids[0] if len(workflow_ids) == 1 else None,
            "workflow_ids": workflow_ids,
            "tenant": explicit_tenant
            or (inferred_tenants[0] if len(inferred_tenants) == 1 else None),
            "tenants": tenant_filters,
            "include_archived": include_archived,
            "tasks": payload_tasks,
            "planning_nodes": planning_nodes,
            "planning_links": planning_links,
            "workers": [
                {**worker_activity[task.id], "task_title": task.title, "task_status": task.status}
                for task in ordered_tasks
                if task.id in worker_activity
            ],
            "links": included_links,
            "external_links": [link for link in all_links if link not in included_links],
            "latest_event_id": source_revision,
            "source_revision": source_revision,
            "changed_since": int(since_event_id) if since_event_id is not None else None,
            "has_changes_since": (
                source_revision > int(since_event_id)
                if since_event_id is not None else None
            ),
            "now": int(time.time()),
        }
    finally:
        if conn is not None:
            conn.close()


# ---------------------------------------------------------------------------
# GET /board
# ---------------------------------------------------------------------------

@router.get("/board")
def get_board(
    tenant: Optional[str] = Query(None, description="Filter to a single tenant"),
    include_archived: bool = Query(False),
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
    workflow_template_id: Optional[str] = Query(
        None, description="Restrict to tasks using this workflow template id",
    ),
    current_step_key: Optional[str] = Query(
        None, description="Restrict to tasks at this workflow step key",
    ),
):
    """Return the full board grouped by status column.

    ``_conn()`` auto-initializes ``kanban.db`` on first call so a fresh
    install doesn't surface a "failed to load" error on the plugin tab.

    ``board`` selects which board to read from. Omitting it falls
    through to the active board (``HERMES_KANBAN_BOARD`` env → on-disk
    ``current`` pointer → ``default``).
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        tasks = kanban_db.list_tasks(
            conn,
            tenant=tenant,
            include_archived=include_archived,
            workflow_template_id=workflow_template_id,
            current_step_key=current_step_key,
        )
        # Pre-fetch link counts per task (cheap: one query).
        link_counts: dict[str, dict[str, int]] = {}
        for row in conn.execute(
            "SELECT parent_id, child_id FROM task_links"
        ).fetchall():
            link_counts.setdefault(row["parent_id"], {"parents": 0, "children": 0})[
                "children"
            ] += 1
            link_counts.setdefault(row["child_id"], {"parents": 0, "children": 0})[
                "parents"
            ] += 1

        # Comment + event counts (both cheap aggregates).
        comment_counts: dict[str, int] = {
            r["task_id"]: r["n"]
            for r in conn.execute(
                "SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id"
            )
        }

        # Progress rollup: for each parent, how many children are done / total.
        # One pass over task_links joined with child status — cheaper than
        # N per-task queries and the plugin uses it to render "N/M".
        progress: dict[str, dict[str, int]] = {}
        for row in conn.execute(
            "SELECT l.parent_id AS pid, t.status AS cstatus "
            "FROM task_links l JOIN tasks t ON t.id = l.child_id"
        ).fetchall():
            p = progress.setdefault(row["pid"], {"done": 0, "total": 0})
            p["total"] += 1
            if row["cstatus"] == "done":
                p["done"] += 1

        # Diagnostics rollup for this board — see kanban_diagnostics.
        # We get the full structured list per task AND a compact
        # summary for the card badge (so cards don't carry the detail
        # text; the drawer fetches that via /tasks/:id or /diagnostics).
        diagnostics_per_task = _compute_task_diagnostics(conn, task_ids=None)

        latest_event_id = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS m FROM task_events"
        ).fetchone()["m"]

        columns: dict[str, list[dict]] = {c: [] for c in BOARD_COLUMNS}
        if include_archived:
            columns["archived"] = []

        # Batch-fetch the latest non-null run summary per task in one
        # window-function query (avoids N+1 ``latest_summary`` calls
        # for boards with hundreds of tasks). Truncated to a card-size
        # preview here — the full text is available via /tasks/:id.
        summary_map = kanban_db.latest_summaries(conn, [t.id for t in tasks])

        for t in tasks:
            full = summary_map.get(t.id)
            preview = (
                full[:_CARD_SUMMARY_PREVIEW_CHARS] if full else None
            )
            d = _task_dict(t, latest_summary=preview)
            d["link_counts"] = link_counts.get(t.id, {"parents": 0, "children": 0})
            d["comment_count"] = comment_counts.get(t.id, 0)
            d["progress"] = progress.get(t.id)  # None when the task has no children
            diags = diagnostics_per_task.get(t.id)
            if diags:
                # Full list goes into the payload so the drawer can render
                # without a second round-trip. The board-level badge only
                # needs the summary.
                d["diagnostics"] = diags
                d["warnings"] = _warnings_summary_from_diagnostics(diags)
            col = t.status if t.status in columns else "todo"
            columns[col].append(d)

        # Stable per-column ordering already applied by list_tasks
        # (priority DESC, created_at ASC), keep as-is.

        # List of known tenants for the UI filter dropdown.
        tenants = [
            r["tenant"]
            for r in conn.execute(
                "SELECT DISTINCT tenant FROM tasks WHERE tenant IS NOT NULL ORDER BY tenant"
            )
        ]
        # List of distinct assignees for the lane-by-profile sub-grouping.
        assignees = [
            r["assignee"]
            for r in conn.execute(
                "SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL "
                "AND status != 'archived' ORDER BY assignee"
            )
        ]

        return {
            "columns": [
                {"name": name, "tasks": columns[name]} for name in columns.keys()
            ],
            "tenants": tenants,
            "assignees": assignees,
            "latest_event_id": int(latest_event_id),
            "now": int(time.time()),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /tasks/:id
# ---------------------------------------------------------------------------

@router.get("/tasks/{task_id}")
def get_task(
    task_id: str,
    board: Optional[str] = Query(None),
    run_state_type: Optional[str] = Query(
        None, description="With run_state_name: filter runs by column 'status' or 'outcome'",
    ),
    run_state_name: Optional[str] = Query(
        None, description="With run_state_type: exact value for that run column",
    ),
):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        if (run_state_type is None) ^ (run_state_name is None):
            raise HTTPException(
                status_code=400,
                detail="run_state_type and run_state_name must be passed together or omitted",
            )
        if run_state_type is not None and run_state_type not in ("status", "outcome"):
            raise HTTPException(
                status_code=400,
                detail="run_state_type must be 'status' or 'outcome'",
            )
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        # Drawer/detail view returns the FULL summary (no truncation) so
        # operators can read the complete worker handoff without making
        # a second round-trip. Cards on /board carry a 200-char preview.
        full_summary = kanban_db.latest_summary(conn, task_id)
        task_d = _task_dict_with_loop_intake(conn, task, latest_summary=full_summary)
        latest_runs = _latest_runs_for_tasks(conn, [task_id])
        worker_activity = _worker_activity_for_tasks(conn, [task_id], latest_runs, board=board).get(task_id)
        if worker_activity:
            task_d["worker_activity"] = worker_activity
        latest_event_id = _latest_event_id_for_tasks(conn, [task_id])
        links = _links_for(conn, task_id)
        child_ids = links["children"]
        child_summaries = kanban_db.latest_summaries(conn, child_ids)
        child_results = []
        for child_id in child_ids:
            child = kanban_db.get_task(conn, child_id)
            if child is None:
                continue
            child_results.append({
                "id": child.id,
                "title": child.title,
                "status": child.status,
                "latest_summary": child_summaries.get(child.id),
                "result": child.result,
            })
        # Attach diagnostics so the drawer's Diagnostics section can
        # render recovery actions without a second round-trip.
        diags = _compute_task_diagnostics(conn, task_ids=[task_id])
        diag_list = diags.get(task_id) or []
        if diag_list:
            task_d["diagnostics"] = diag_list
            task_d["warnings"] = _warnings_summary_from_diagnostics(diag_list)
        return {
            "task": task_d,
            "comments": [_comment_dict(c) for c in kanban_db.list_comments(conn, task_id)],
            "events": [_event_dict(e) for e in kanban_db.list_events(conn, task_id)],
            "attachments": [_attachment_dict(a) for a in kanban_db.list_attachments(conn, task_id)],
            "links": links,
            "child_results": child_results,
            "runs": [
                _run_dict(r)
                for r in kanban_db.list_runs(
                    conn,
                    task_id,
                    state_type=run_state_type,
                    state_name=run_state_name,
                )
            ],
            "latest_event_id": latest_event_id,
            "source_revision": latest_event_id,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /tasks
# ---------------------------------------------------------------------------

class CreateTaskBody(BaseModel):
    title: str
    body: Optional[str] = None
    assignee: Optional[str] = None
    workflow_id: Optional[str] = None
    tenant: Optional[str] = None
    session_id: Optional[str] = None
    priority: int = 0
    workspace_kind: str = "scratch"
    workspace_path: Optional[str] = None
    parents: list[str] = Field(default_factory=list)
    triage: bool = False
    idempotency_key: Optional[str] = None
    max_runtime_seconds: Optional[int] = None
    skills: Optional[list[str]] = None
    goal_mode: bool = False
    goal_max_turns: Optional[int] = None
    model_override: Optional[str] = None
    provider_override: Optional[str] = None


@router.post("/tasks")
def create_task(payload: CreateTaskBody, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        task_id = kanban_db.create_task(
            conn,
            title=payload.title,
            body=payload.body,
            assignee=payload.assignee,
            created_by="dashboard",
            workspace_kind=payload.workspace_kind,
            workspace_path=payload.workspace_path,
            tenant=payload.tenant,
            priority=payload.priority,
            parents=payload.parents,
            triage=payload.triage,
            idempotency_key=payload.idempotency_key,
            max_runtime_seconds=payload.max_runtime_seconds,
            skills=payload.skills,
            goal_mode=payload.goal_mode,
            goal_max_turns=payload.goal_max_turns,
            session_id=payload.session_id,
            workflow_id=payload.workflow_id,
            model_override=payload.model_override,
            provider_override=payload.provider_override,
        )
        task = kanban_db.get_task(conn, task_id)
        body: dict[str, Any] = {"task": _task_dict(task) if task else None}
        # Surface a dispatcher-presence warning so the UI can show a
        # banner when a `ready` task would otherwise sit idle because no
        # gateway is running (or dispatch_in_gateway=false). Only emit
        # for ready+assigned tasks; triage/todo are expected to wait,
        # and unassigned tasks can't be dispatched regardless.
        if task and task.status == "ready" and task.assignee:
            try:
                from hermes_cli.kanban import _check_dispatcher_presence
                running, message = _check_dispatcher_presence()
                if not running and message:
                    body["warning"] = message
            except Exception:
                # Probe failure must never block the create itself.
                pass
        return body
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


class CreateLoopDraftBody(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    workflow_id: Optional[str] = None
    # COMPAT(workflow-id-cutover): old Desktop builds send the former root
    # task id. It is resolved through tasks.workflow_id and never restores
    # root/sink semantics.
    root_task_id: Optional[str] = None
    assignee: Optional[str] = "orchestrator"
    tenant: Optional[str] = None
    session_id: Optional[str] = None
    parents: list[str] = Field(default_factory=list)
    child_ids: list[str] = Field(default_factory=list)
    priority: int = 0
    workspace_kind: str = "scratch"
    workspace_path: Optional[str] = None
    idempotency_key: Optional[str] = None


@router.get("/capabilities")
def kanban_capabilities():
    """Advertise mutation contracts that older Desktop backends may not support."""
    return {"live_loop_graph": True}


def _draft_title(value: Optional[str]) -> str:
    title = (value or "").strip()
    return title or "Loop draft"


def _resolve_workflow_request(
    conn: sqlite3.Connection,
    *,
    workflow_id: Optional[str] = None,
    root_task_id: Optional[str] = None,
    required: bool = False,
) -> Optional[str]:
    """Resolve a canonical workflow id and its temporary root-task alias."""

    canonical = str(workflow_id or "").strip() or None
    legacy = str(root_task_id or "").strip() or None
    legacy_workflow_id: Optional[str] = None
    if legacy:
        legacy_task = kanban_db.get_task(conn, legacy)
        if legacy_task is not None and legacy_task.workflow_id:
            legacy_workflow_id = str(legacy_task.workflow_id)
        elif kanban_db.get_workflow(conn, legacy) is not None:
            # Migrated legacy workflow ids can equal their former root id.
            legacy_workflow_id = legacy
        else:
            raise ValueError(
                f"unknown workflow or deprecated root_task_id alias: {legacy}"
            )
    if canonical and legacy_workflow_id and canonical != legacy_workflow_id:
        raise ValueError(
            "workflow_id and deprecated root_task_id alias resolve to "
            "different workflows"
        )
    resolved = canonical or legacy_workflow_id
    if required and not resolved:
        raise ValueError("workflow_id is required")
    if resolved and kanban_db.get_workflow(conn, resolved) is None:
        raise ValueError(f"unknown workflow: {resolved}")
    return resolved


def _require_workflow(
    conn: sqlite3.Connection,
    workflow_id: str,
) -> str:
    """Resolve a workflow-first route, accepting a legacy task id in its slot."""

    try:
        resolved = _resolve_workflow_request(
            conn,
            workflow_id=workflow_id,
            root_task_id=workflow_id,
            required=True,
        )
    except ValueError:
        # Supplying the same value as both fields only works for workflow ids;
        # retry it strictly as the legacy alias for old `/.../{root_task_id}`
        # callers.
        try:
            resolved = _resolve_workflow_request(
                conn,
                root_task_id=workflow_id,
                required=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    assert resolved is not None
    return resolved


def _workflow_relation_tasks(
    conn: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, kanban_db.Task]:
    tasks: dict[str, kanban_db.Task] = {}
    for task_id in dict.fromkeys(task_ids):
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise ValueError(f"unknown task: {task_id}")
        tasks[task_id] = task
    return tasks


def _create_loop_draft_node(
    conn: sqlite3.Connection,
    payload: CreateLoopDraftBody,
    *,
    board: Optional[str],
) -> dict[str, Any]:
    """Create one ordinary workflow member through the canonical graph API."""

    title = _draft_title(payload.title)
    session_id = (
        payload.session_id or os.environ.get("HERMES_SESSION_ID") or ""
    ).strip() or None
    tenant = (payload.tenant or "").strip() or None
    needs_intake = not (payload.body or "").strip()
    workflow_id = _resolve_workflow_request(
        conn,
        workflow_id=payload.workflow_id,
        root_task_id=payload.root_task_id,
    )
    parents = list(
        dict.fromkeys(
            str(task_id).strip() for task_id in payload.parents if str(task_id).strip()
        )
    )
    child_ids = list(
        dict.fromkeys(
            str(task_id).strip()
            for task_id in payload.child_ids
            if str(task_id).strip()
        )
    )

    if payload.workspace_kind not in kanban_db.VALID_WORKSPACE_KINDS:
        raise ValueError(
            f"workspace_kind must be one of {sorted(kanban_db.VALID_WORKSPACE_KINDS)}, "
            f"got {payload.workspace_kind!r}"
        )

    if payload.workspace_path is None and payload.workspace_kind in {"dir", "worktree"}:
        board_meta = kanban_db.read_board_metadata(
            board if board else kanban_db.get_current_board()
        )
        board_default = board_meta.get("default_workdir")
        if board_default:
            payload.workspace_path = str(board_default)

    relation_tasks = _workflow_relation_tasks(conn, [*parents, *child_ids])
    relation_workflows = {
        str(task.workflow_id).strip()
        for task in relation_tasks.values()
        if task.workflow_id and str(task.workflow_id).strip()
    }
    unowned = [
        task_id
        for task_id, task in relation_tasks.items()
        if not task.workflow_id or not str(task.workflow_id).strip()
    ]
    if unowned:
        raise ValueError(
            "Loop relations require workflow members: " + ", ".join(unowned)
        )
    if len(relation_workflows) > 1:
        raise ValueError(
            "Loop relations belong to different workflows: "
            + ", ".join(sorted(relation_workflows))
        )
    if relation_workflows:
        relation_workflow_id = next(iter(relation_workflows))
        if workflow_id and workflow_id != relation_workflow_id:
            raise ValueError(f"workflow {workflow_id} does not own every related task")
        workflow_id = relation_workflow_id

    child_status_guards = {
        child_id: _loop_graph_allowed_child_statuses(conn, child_id)
        for child_id in child_ids
    }
    creates_workflow = workflow_id is None
    idempotency_scope = (
        str(payload.idempotency_key or "").strip()
        or f"dashboard-loop-draft:{uuid.uuid4().hex}"
    )
    result = kanban_db.create_loop_skeleton_graph(
        conn,
        nodes=[
            {
                "client_id": "draft",
                "title": title,
                "depends_on": parents,
                "context": (payload.body or "").strip() or None,
            }
        ],
        workflow_id=workflow_id,
        session_id=session_id,
        tenant=tenant,
        workspace_kind=payload.workspace_kind,
        workspace_path=payload.workspace_path,
        board=board,
        created_by="dashboard",
        idempotency_scope=idempotency_scope,
    )
    task_id = str(result["items"][0]["task_id"])
    workflow_id = str(result["workflow_id"])

    for child_id in child_ids:
        kanban_db.link_tasks(
            conn,
            task_id,
            child_id,
            allowed_child_statuses=child_status_guards[child_id],
        )

    if (
        creates_workflow
        and needs_intake
        and not _loop_intake_state_for_task(conn, task_id)
    ):
        with kanban_db.write_txn(conn):
            kanban_db._append_event(
                conn,
                task_id,
                _LOOP_INTAKE_EVENT_KIND,
                dict(_LOOP_INTAKE_DRAFT_PAYLOAD),
            )
    result["workflow_id"] = workflow_id
    return result


def _loop_draft_source_payload(
    conn: sqlite3.Connection,
    task: kanban_db.Task,
    *,
    workflow_id: str,
    board: Optional[str],
) -> dict[str, Any]:
    task_item = _task_dict_with_loop_intake(conn, task)
    task_links = _links_for(conn, task.id)
    task_item["links"] = task_links
    task_item["included_parent_ids"] = []
    task_item["included_child_ids"] = []
    latest_event_id = _latest_event_id_for_tasks(conn, [task.id])
    tenant = task.tenant
    session_id = task.session_id
    return {
        "board": board,
        "external_links": [],
        "include_archived": False,
        "latest_event_id": latest_event_id,
        "source_revision": latest_event_id,
        "lineage_session_ids": [session_id] if session_id else [],
        "links": [],
        "now": int(time.time()),
        "workflow_id": workflow_id,
        "workflow_ids": [workflow_id],
        "session_id": session_id,
        "tasks": [task_item],
        "tenant": tenant,
        "tenants": [tenant] if tenant else [],
        "workers": [],
    }


@router.post("/loop-drafts")
def create_loop_draft(payload: CreateLoopDraftBody, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        graph_result = _create_loop_draft_node(conn, payload, board=board)
        task_id = str(graph_result["items"][0]["task_id"])
        workflow_id = str(graph_result["workflow_id"])
        subscribed = False
        dispatch: Optional[dict[str, Any]] = None
        warnings: list[str] = []
        try:
            from tools.kanban_notify import maybe_auto_subscribe

            subscribed = maybe_auto_subscribe(conn, task_id)
        except Exception as exc:
            warnings.append(f"auto-subscribe failed: {type(exc).__name__}: {exc}")
        if payload.workflow_id or payload.root_task_id:
            try:
                dispatch_result = kanban_db.dispatch_once(
                    conn,
                    board=board,
                    max_spawn=1,
                )
                dispatch = {
                    "spawned": [
                        task for task, _assignee, _workspace in dispatch_result.spawned
                    ],
                }
            except Exception as exc:
                warnings.append(f"inline dispatch failed: {type(exc).__name__}: {exc}")
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(
                status_code=500, detail=f"draft task {task_id} was not persisted"
            )
        return {
            "workflow_id": workflow_id,
            "task": _task_dict_with_loop_intake(conn, task),
            "source": _loop_draft_source_payload(
                conn,
                task,
                workflow_id=workflow_id,
                board=board,
            ),
            "graph": graph_result,
            "subscribed": subscribed,
            "dispatch": dispatch,
            "warnings": warnings,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


class LoopCanvasPosition(BaseModel):
    task_id: str
    x: float
    y: float


class PutLoopCanvasPositionsBody(BaseModel):
    positions: list[LoopCanvasPosition] = Field(default_factory=list)


class ArchiveLoopNodesBody(BaseModel):
    task_ids: list[str] = Field(default_factory=list)
    session_id: Optional[str] = None


_LOOP_CANVAS_COORD_LIMIT = 1_000_000.0

_LOOP_CANVAS_POSITIONS_SQL = """
    CREATE TABLE IF NOT EXISTS loop_canvas_positions (
        workflow_id TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, task_id)
    )
"""


def _ensure_loop_canvas_positions_schema(conn: sqlite3.Connection) -> None:
    """Create or idempotently migrate workflow-owned canvas positions."""

    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(loop_canvas_positions)").fetchall()
    }
    if not columns:
        conn.execute(_LOOP_CANVAS_POSITIONS_SQL)
        return
    if "workflow_id" in columns and "root_task_id" not in columns:
        return
    if "root_task_id" not in columns:
        raise sqlite3.OperationalError(
            "loop_canvas_positions has neither workflow_id nor legacy root_task_id"
        )

    conn.execute("SAVEPOINT loop_canvas_workflow_migration")
    try:
        legacy_table = "loop_canvas_positions__legacy_root_owner"
        conn.execute(f"ALTER TABLE loop_canvas_positions RENAME TO {legacy_table}")
        conn.execute(_LOOP_CANVAS_POSITIONS_SQL)
        owner_source = (
            "COALESCE(l.workflow_id, t.workflow_id, w.id, l.root_task_id)"
            if "workflow_id" in columns
            else "COALESCE(t.workflow_id, w.id, l.root_task_id)"
        )
        conn.execute(
            f"""
            INSERT OR REPLACE INTO loop_canvas_positions (
                workflow_id, task_id, x, y, updated_at
            )
            SELECT {owner_source}, l.task_id, l.x, l.y, l.updated_at
            FROM {legacy_table} l
            LEFT JOIN tasks t ON t.id = l.root_task_id
            LEFT JOIN workflows w ON w.id = l.root_task_id
            """
        )
        conn.execute(f"DROP TABLE {legacy_table}")
        conn.execute("RELEASE SAVEPOINT loop_canvas_workflow_migration")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT loop_canvas_workflow_migration")
        conn.execute("RELEASE SAVEPOINT loop_canvas_workflow_migration")
        raise


def _loop_canvas_positions_payload(
    conn: sqlite3.Connection,
    workflow_id: str,
    members: Optional[set[str]] = None,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT p.task_id, p.x, p.y, p.updated_at
        FROM loop_canvas_positions p
        JOIN tasks t ON t.id = p.task_id
        WHERE p.workflow_id = ?
          AND t.workflow_id = p.workflow_id
          AND t.status != 'archived'
        ORDER BY p.task_id
        """,
        (workflow_id,),
    ).fetchall()
    return {
        "workflow_id": workflow_id,
        "positions": [
            {
                "task_id": row["task_id"],
                "x": float(row["x"]),
                "y": float(row["y"]),
                "updated_at": int(row["updated_at"]),
            }
            for row in rows
            if members is None or row["task_id"] in members
        ],
    }


def _require_loop_canvas_tasks(
    conn: sqlite3.Connection,
    workflow_id: str,
    task_ids: list[str],
    *,
    session_id: Optional[str] = None,
) -> set[str]:
    """Require immutable workflow membership; session scope is compatibility-only."""

    if kanban_db.get_workflow(conn, workflow_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"workflow {workflow_id} not found",
        )
    members = {
        str(row["id"])
        for row in conn.execute(
            "SELECT id FROM tasks WHERE workflow_id = ?",
            (workflow_id,),
        ).fetchall()
    }
    required = dict.fromkeys(task_ids)
    outside = [task_id for task_id in required if task_id not in members]
    if outside:
        raise HTTPException(
            status_code=400,
            detail=(f"task(s) outside workflow {workflow_id}: " + ", ".join(outside)),
        )
    return members


@router.get("/loop-canvas/{workflow_id}/positions")
def get_loop_canvas_positions(
    workflow_id: str,
    board: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
):
    """Return saved world-space coordinates for a Loop canvas."""
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        workflow_id = _require_workflow(conn, workflow_id)
        members = _require_loop_canvas_tasks(
            conn,
            workflow_id,
            [],
            session_id=session_id,
        )
        _ensure_loop_canvas_positions_schema(conn)
        return _loop_canvas_positions_payload(conn, workflow_id, members)
    finally:
        conn.close()


@router.post("/loop-canvas/{workflow_id}/archive-nodes")
def archive_loop_nodes(
    workflow_id: str,
    payload: ArchiveLoopNodesBody,
    board: Optional[str] = Query(None),
):
    """Atomically archive pending Loop nodes with in-transaction state guards."""
    task_ids = list(
        dict.fromkeys(
            str(task_id).strip() for task_id in payload.task_ids if str(task_id).strip()
        )
    )
    if not task_ids:
        raise HTTPException(status_code=400, detail="task_ids is required")
    from hermes_cli import loop_graph

    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        workflow_id = _require_workflow(conn, workflow_id)
        _require_loop_canvas_tasks(
            conn,
            workflow_id,
            task_ids,
            session_id=payload.session_id,
        )
        revision = loop_graph.graph_revision(conn, workflow_id)
        result = loop_graph.apply_patch(
            conn,
            workflow_id,
            expected_revision=revision,
            mutation_id=f"desktop-archive-{uuid.uuid4().hex}",
            operations=[
                {"op": "archive_node", "task_id": task_id} for task_id in task_ids
            ],
        )
        return _canonical_loop_graph_payload(result)
    except loop_graph.LoopError as exc:
        raise HTTPException(status_code=409, detail=exc.message)
    finally:
        conn.close()


@router.put("/loop-canvas/{workflow_id}/positions")
def put_loop_canvas_positions(
    workflow_id: str,
    payload: PutLoopCanvasPositionsBody,
    board: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
):
    """Replace all saved world-space coordinates for a Loop canvas."""
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        workflow_id = _require_workflow(conn, workflow_id)
        _ensure_loop_canvas_positions_schema(conn)

        task_ids: list[str] = []
        coordinates: list[tuple[str, float, float]] = []
        for item in payload.positions:
            task_id = item.task_id.strip()
            if not task_id:
                raise HTTPException(
                    status_code=400, detail="position task_id is required"
                )
            if task_id in task_ids:
                raise HTTPException(
                    status_code=400, detail=f"duplicate position for task {task_id}"
                )
            if not math.isfinite(item.x) or not math.isfinite(item.y):
                raise HTTPException(
                    status_code=400, detail=f"position for {task_id} must be finite"
                )
            if (
                abs(item.x) > _LOOP_CANVAS_COORD_LIMIT
                or abs(item.y) > _LOOP_CANVAS_COORD_LIMIT
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"position for {task_id} exceeds the canvas coordinate limit",
                )
            task_ids.append(task_id)
            coordinates.append((task_id, float(item.x), float(item.y)))

        if task_ids:
            placeholders = ",".join("?" for _ in task_ids)
            existing = {
                row["id"]
                for row in conn.execute(
                    f"SELECT id FROM tasks WHERE id IN ({placeholders})",
                    tuple(task_ids),
                ).fetchall()
            }
            missing = [task_id for task_id in task_ids if task_id not in existing]
            if missing:
                raise HTTPException(
                    status_code=400, detail=f"unknown task(s): {', '.join(missing)}"
                )

        members = _require_loop_canvas_tasks(
            conn,
            workflow_id,
            task_ids,
            session_id=session_id,
        )

        now = int(time.time())
        with kanban_db.write_txn(conn):
            conn.execute(
                "DELETE FROM loop_canvas_positions WHERE workflow_id = ?",
                (workflow_id,),
            )
            conn.executemany(
                "INSERT INTO loop_canvas_positions (workflow_id, task_id, x, y, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                [(workflow_id, task_id, x, y, now) for task_id, x, y in coordinates],
            )

        return {
            "ok": True,
            **_loop_canvas_positions_payload(conn, workflow_id, members),
        }
    finally:
        conn.close()


class LoopGraphPatchBody(BaseModel):
    expected_revision: int
    mutation_id: str
    operations: list[dict[str, Any]] = Field(default_factory=list)


def _canonical_loop_graph_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove deprecated task-root and handoff projections from graph output."""

    result = dict(payload)
    result.pop("root_task_id", None)
    result.pop("pending_handoffs", None)
    nodes = result.get("nodes")
    if isinstance(nodes, list):
        canonical_nodes: list[Any] = []
        for node in nodes:
            if not isinstance(node, dict):
                canonical_nodes.append(node)
                continue
            item = dict(node)
            for key in (
                "root_task_id",
                "handoff",
                "attention",
                "verification_state",
            ):
                item.pop(key, None)
            canonical_nodes.append(item)
        result["nodes"] = canonical_nodes
    return result


@router.get("/loop-graph/{workflow_id}")
def read_loop_graph(
    workflow_id: str,
    include_nodes: bool = Query(False),
    board: Optional[str] = Query(None),
):
    board = _resolve_board(board)
    from hermes_cli import loop_graph as graph

    conn = _conn(board=board)
    try:
        workflow_id = _require_workflow(conn, workflow_id)
        return _canonical_loop_graph_payload(
            graph.read_graph(conn, workflow_id, include_nodes=include_nodes)
        )
    except graph.LoopError as e:
        raise HTTPException(
            status_code=400,
            detail=graph.error_response(e, conn, workflow_id),
        )
    finally:
        conn.close()


@router.patch("/loop-graph/{workflow_id}")
def patch_loop_graph(
    workflow_id: str,
    request: LoopGraphPatchBody,
    board: Optional[str] = Query(None),
):
    board = _resolve_board(board)
    from hermes_cli import loop_graph as graph

    conn = _conn(board=board)
    try:
        workflow_id = _require_workflow(conn, workflow_id)
        return _canonical_loop_graph_payload(
            graph.apply_patch(
                conn,
                workflow_id,
                expected_revision=request.expected_revision,
                mutation_id=request.mutation_id,
                operations=request.operations,
            )
        )
    except graph.LoopError as e:
        raise HTTPException(
            status_code=400,
            detail=graph.error_response(e, conn, workflow_id),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Attachments — upload / list / download / delete (#35338)
# ---------------------------------------------------------------------------

# The size cap, filename sanitiser, and collision resolver now live in
# ``kanban_db`` so the dashboard, the agent toolset, and the CLI share one
# implementation and cannot drift. ``_safe_attachment_name`` raises a plain
# ``ValueError`` there; the upload handler's ``except ValueError`` below maps
# it to a 400, preserving the previous response.
from hermes_cli.kanban_db import (  # noqa: E402
    KANBAN_ATTACHMENT_MAX_BYTES,
    _collision_free_path,
    _safe_attachment_name,
)


@router.get("/tasks/{task_id}/attachments")
def list_task_attachments(task_id: str, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        if kanban_db.get_task(conn, task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        return {
            "attachments": [
                _attachment_dict(a) for a in kanban_db.list_attachments(conn, task_id)
            ]
        }
    finally:
        conn.close()


@router.post("/tasks/{task_id}/attachments")
async def upload_task_attachment(
    task_id: str,
    file: UploadFile = File(...),
    board: Optional[str] = Query(None),
    uploaded_by: Optional[str] = Form(None),
):
    """Store an uploaded file for a task and record its metadata.

    The blob lands under ``attachments_root(board)/<task_id>/`` with a
    sanitised, collision-resolved name. The worker reads it via the
    absolute path surfaced in ``build_worker_context``.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        if kanban_db.get_task(conn, task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")

        safe_name = _safe_attachment_name(file.filename or "")

        # Stream to disk with a hard size cap so a huge upload can't fill
        # the disk. Read in chunks; abort + clean up if the cap is hit.
        dest_dir = kanban_db.task_attachments_dir(task_id, board=board)
        dest_dir.mkdir(parents=True, exist_ok=True)

        # Resolve name collisions: foo.pdf → foo (1).pdf, foo (2).pdf, …
        dest_path = _collision_free_path(dest_dir, safe_name)
        candidate = dest_path.name

        total = 0
        try:
            with open(dest_path, "wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > KANBAN_ATTACHMENT_MAX_BYTES:
                        out.close()
                        dest_path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                f"attachment exceeds {KANBAN_ATTACHMENT_MAX_BYTES // (1024 * 1024)} MB limit"
                            ),
                        )
                    out.write(chunk)
        except HTTPException:
            raise
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"failed to store attachment: {exc}")

        att_id = kanban_db.add_attachment(
            conn,
            task_id,
            filename=candidate,
            stored_path=str(dest_path.resolve()),
            content_type=file.content_type,
            size=total,
            uploaded_by=(uploaded_by or "dashboard"),
        )
        att = kanban_db.get_attachment(conn, att_id)
        return {"attachment": _attachment_dict(att) if att else None}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


@router.get("/attachments/{attachment_id}")
def download_attachment(attachment_id: int, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        att = kanban_db.get_attachment(conn, attachment_id)
        if att is None:
            raise HTTPException(status_code=404, detail="attachment not found")
        # Confirm the blob still lives under the board's attachments root
        # before serving — defense in depth against a tampered DB row.
        root = kanban_db.attachments_root(board=board).resolve()
        try:
            stored = Path(att.stored_path).resolve()
            stored.relative_to(root)
        except (ValueError, OSError):
            raise HTTPException(status_code=404, detail="attachment file unavailable")
        if not stored.is_file():
            raise HTTPException(status_code=404, detail="attachment file missing on disk")
        return FileResponse(
            path=str(stored),
            filename=att.filename,
            media_type=att.content_type or "application/octet-stream",
        )
    finally:
        conn.close()


@router.delete("/attachments/{attachment_id}")
def remove_attachment(attachment_id: int, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        att = kanban_db.delete_attachment(conn, attachment_id)
        if att is None:
            raise HTTPException(status_code=404, detail="attachment not found")
        return {"ok": True, "id": attachment_id}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# PATCH /tasks/:id  (status / assignee / priority / title / body)
# ---------------------------------------------------------------------------

class UpdateTaskBody(BaseModel):
    status: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[int] = None
    title: Optional[str] = None
    body: Optional[str] = None
    result: Optional[str] = None
    block_reason: Optional[str] = None
    # Structured handoff fields — forwarded to complete_task when status
    # transitions to 'done'. Dashboard parity with ``hermes kanban
    # complete --summary ... --metadata ...``.
    summary: Optional[str] = None
    metadata: Optional[dict] = None
    loop_intake: Optional[dict[str, Any]] = None
    # Per-task model/provider override (the board's model dropdown).
    # ``model_override=""`` clears both. ``clear_model_override=True`` is
    # the explicit clear signal — needed because Optional[str]=None means
    # "field not sent" in a PATCH, not "set to NULL".
    model_override: Optional[str] = None
    provider_override: Optional[str] = None
    clear_model_override: bool = False


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, payload: UpdateTaskBody, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    effective_board = board or kanban_db.get_current_board()
    conn = _conn(board=effective_board)
    completion_progress = None
    try:
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")

        # --- intake state -------------------------------------------------
        if payload.loop_intake is not None:
            normalized_intake = _normalized_loop_intake_payload(payload.loop_intake)
            if not normalized_intake:
                raise HTTPException(status_code=400, detail="loop_intake must include needed=true")
            with kanban_db.write_txn(conn):
                kanban_db._append_event(conn, task_id, _LOOP_INTAKE_EVENT_KIND, normalized_intake)

        # --- assignee ----------------------------------------------------
        if payload.assignee is not None:
            try:
                ok = kanban_db.assign_task(
                    conn, task_id, payload.assignee or None,
                )
            except RuntimeError as e:
                raise HTTPException(status_code=409, detail=str(e))
            if not ok:
                raise HTTPException(status_code=404, detail="task not found")

        # --- status -------------------------------------------------------
        if payload.status is not None:
            s = payload.status
            ok = True
            if s == "ready" and _task_has_loop_intake_blocking_ready(conn, task_id):
                raise HTTPException(status_code=409, detail=_loop_intake_required_reason(task_id))
            if s == "done":
                from hermes_cli import kanban_progress

                policy = kanban_progress.load_progress_policy()
                transitions = kanban_db.ReadyTransitions()
                with kanban_db.scoped_current_board(effective_board):
                    ok = kanban_db.complete_task(
                        conn, task_id,
                        result=payload.result,
                        summary=payload.summary,
                        metadata=payload.metadata,
                        transitions=transitions,
                        recompute_dependents=False,
                    )
                if ok:
                    recovery_warnings = (
                        kanban_progress.capture_completion_transitions(
                            [task_id],
                            transitions=transitions,
                            board=effective_board,
                            conn=conn,
                            policy=policy,
                        )
                    )
                    completion_progress = kanban_progress.advance_transitions(
                        transitions,
                        board=effective_board,
                        conn=conn,
                        author="dashboard-completion-auto-decomposer",
                        policy=policy,
                        recovery_warnings=recovery_warnings,
                    )
            elif s == "blocked":
                ok = kanban_db.block_task(conn, task_id, reason=payload.block_reason)
            elif s == "scheduled":
                ok = kanban_db.schedule_task(conn, task_id, reason=payload.block_reason)
            elif s == "ready":
                # Re-open a blocked/scheduled task, or just an explicit status set.
                current = kanban_db.get_task(conn, task_id)
                if current and current.status in ("blocked", "scheduled"):
                    ok = kanban_db.unblock_task(conn, task_id)
                else:
                    # Direct status write for drag-drop (todo -> ready etc).
                    ok = _set_status_direct(conn, task_id, "ready")
            elif s == "archived":
                ok = kanban_db.archive_task(conn, task_id)
            elif s == "running":
                raise HTTPException(
                    status_code=400,
                    detail="Cannot set status to 'running' directly; use the dispatcher/claim path",
                )
            elif s in ("todo", "triage", "scheduled"):
                ok = _set_status_direct(conn, task_id, s)
            else:
                raise HTTPException(status_code=400, detail=f"unknown status: {s}")
            if not ok:
                # For ``ready``, name the blocking parent(s) so the dashboard
                # can render an actionable toast instead of a silent no-op.
                # See #26744.
                if s == "ready":
                    blockers = _parents_blocking_ready(conn, task_id)
                    if blockers:
                        names = ", ".join(
                            f"{p['title']!r} ({p['id']}, status={p['status']})"
                            for p in blockers
                        )
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                f"Cannot move to 'ready': blocked by parent(s) "
                                f"not done — {names}"
                            ),
                        )
                raise HTTPException(
                    status_code=409,
                    detail=f"status transition to {s!r} not valid from current state",
                )

        # --- model/provider override ---------------------------------------
        if payload.clear_model_override or payload.model_override is not None:
            new_model = (
                None if payload.clear_model_override
                else (payload.model_override or "").strip() or None
            )
            try:
                ok = kanban_db.set_model_override(
                    conn, task_id, new_model,
                    provider=payload.provider_override,
                )
            except (ValueError, RuntimeError) as e:
                raise HTTPException(status_code=400, detail=str(e))
            if not ok:
                raise HTTPException(status_code=404, detail="task not found")

        # --- priority -----------------------------------------------------
        if payload.priority is not None:
            with kanban_db.write_txn(conn):
                conn.execute(
                    "UPDATE tasks SET priority = ? WHERE id = ?",
                    (int(payload.priority), task_id),
                )
                conn.execute(
                    "INSERT INTO task_events (task_id, kind, payload, created_at) "
                    "VALUES (?, 'reprioritized', ?, ?)",
                    (task_id, json.dumps({"priority": int(payload.priority)}),
                     int(time.time())),
                )

        # --- title / body -------------------------------------------------
        if payload.title is not None or payload.body is not None:
            with kanban_db.write_txn(conn):
                sets, vals = [], []
                if payload.title is not None:
                    if not payload.title.strip():
                        raise HTTPException(status_code=400, detail="title cannot be empty")
                    sets.append("title = ?")
                    vals.append(payload.title.strip())
                if payload.body is not None:
                    sets.append("body = ?")
                    vals.append(payload.body)
                vals.append(task_id)
                conn.execute(
                    f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", vals,
                )
                conn.execute(
                    "INSERT INTO task_events (task_id, kind, payload, created_at) "
                    "VALUES (?, 'edited', NULL, ?)",
                    (task_id, int(time.time())),
                )

        updated = kanban_db.get_task(conn, task_id)
        response = {
            "task": _task_dict_with_loop_intake(conn, updated) if updated else None
        }
        if completion_progress is not None:
            response["progress"] = completion_progress
        return response
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# DELETE /tasks/:id
# ---------------------------------------------------------------------------

@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        ok = kanban_db.delete_task(conn, task_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        return {"deleted": True, "task_id": task_id}
    finally:
        conn.close()


def _parents_blocking_ready(
    conn: sqlite3.Connection, task_id: str,
) -> list:
    """Return parent rows (``id``, ``title``, ``status``) that aren't ``done``
    and therefore prevent ``task_id`` from being promoted to ``ready``.

    Used to enrich the 409 response from :func:`update_task` so the
    dashboard can show an actionable toast (#26744) instead of a silent
    no-op.  Returns ``[]`` when nothing blocks the transition (e.g. no
    parents, or all parents already done).
    """
    rows = conn.execute(
        "SELECT t.id, t.title, t.status FROM tasks t "
        "JOIN task_links l ON l.parent_id = t.id "
        "WHERE l.child_id = ? AND t.status != 'done'",
        (task_id,),
    ).fetchall()
    return [
        {"id": r["id"], "title": r["title"], "status": r["status"]}
        for r in rows
    ]


def _set_status_direct(
    conn: sqlite3.Connection, task_id: str, new_status: str,
) -> bool:
    """Direct status write for drag-drop moves that aren't covered by the
    structured complete/block/unblock/archive verbs (e.g. todo<->ready,
    running<->ready). Appends a ``status`` event row for the live feed.

    When this transitions OFF ``running`` to anything other than the
    terminal verbs above (which own their own run closing), we close the
    active run with outcome='reclaimed' so attempt history isn't
    orphaned. ``running -> ready`` via drag-drop is the common case
    (user yanking a stuck worker back to the queue).
    """
    with kanban_db.write_txn(conn):
        # Snapshot current state so we know whether to close a run.
        prev = conn.execute(
            "SELECT status, current_run_id FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if prev is None:
            return False

        # Guard: don't allow promoting to 'ready' unless all parents are done.
        # Prevents the dispatcher from spawning a child whose upstream work
        # hasn't completed (e.g. T4 dispatched while T3 is still blocked).
        if new_status == "ready":
            parent_statuses = conn.execute(
                "SELECT t.status FROM tasks t "
                "JOIN task_links l ON l.parent_id = t.id "
                "WHERE l.child_id = ?",
                (task_id,),
            ).fetchall()
            if parent_statuses and not all(
                p["status"] == "done" for p in parent_statuses
            ):
                return False

        was_running = prev["status"] == "running"
        reopening_satisfied_parent = (
            prev["status"] in {"done", "archived"}
            and new_status not in {"done", "archived"}
        )

        cur = conn.execute(
            "UPDATE tasks SET status = ?, "
            "  claim_lock = CASE WHEN ? = 'running' THEN claim_lock ELSE NULL END, "
            "  claim_expires = CASE WHEN ? = 'running' THEN claim_expires ELSE NULL END, "
            "  worker_pid = CASE WHEN ? = 'running' THEN worker_pid ELSE NULL END "
            "WHERE id = ?",
            (new_status, new_status, new_status, new_status, task_id),
        )
        if cur.rowcount != 1:
            return False
        run_id = None
        if was_running and new_status != "running" and prev["current_run_id"]:
            run_id = kanban_db._end_run(
                conn, task_id,
                outcome="reclaimed", status="reclaimed",
                summary=f"status changed to {new_status} (dashboard/direct)",
            )
        conn.execute(
            "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
            "VALUES (?, ?, 'status', ?, ?)",
            (task_id, run_id, json.dumps({"status": new_status}), int(time.time())),
        )
        if reopening_satisfied_parent:
            # A parent leaving done/archived invalidates any direct child that
            # was sitting in ready solely because that parent used to satisfy
            # the dependency gate. Demote those children immediately so the
            # dashboard does not keep advertising stale-ready work.
            for row in conn.execute(
                "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
                (task_id,),
            ).fetchall():
                child_id = row["child_id"]
                demoted = conn.execute(
                    "UPDATE tasks SET status = 'todo' "
                    "WHERE id = ? AND status = 'ready'",
                    (child_id,),
                )
                if demoted.rowcount == 1:
                    conn.execute(
                        "INSERT INTO task_events (task_id, kind, payload, created_at) "
                        "VALUES (?, 'status', ?, ?)",
                        (
                            child_id,
                            json.dumps(
                                {
                                    "status": "todo",
                                    "reason": "parent_reopened",
                                    "parent": task_id,
                                }
                            ),
                            int(time.time()),
                        ),
                    )
    # If we re-opened something, children may have gone stale.
    if new_status in {"done", "ready"}:
        kanban_db.recompute_ready(conn)
    return True


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

class CommentBody(BaseModel):
    body: str
    author: Optional[str] = "dashboard"


@router.get("/tasks/{task_id}/comments")
def list_task_comments(task_id: str, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        if kanban_db.get_task(conn, task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        return [_comment_dict(c) for c in kanban_db.list_comments(conn, task_id)]
    finally:
        conn.close()


@router.post("/tasks/{task_id}/comments")
def add_comment(task_id: str, payload: CommentBody, board: Optional[str] = Query(None)):
    if not payload.body.strip():
        raise HTTPException(status_code=400, detail="body is required")
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        if kanban_db.get_task(conn, task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        kanban_db.add_comment(
            conn, task_id, author=payload.author or "dashboard", body=payload.body,
        )
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------

class LinkBody(BaseModel):
    parent_id: str
    child_id: str
    workflow_id: Optional[str] = None
    # COMPAT(workflow-id-cutover)
    root_task_id: Optional[str] = None
    session_id: Optional[str] = None


_LOOP_GRAPH_MUTABLE_STATUSES = frozenset({"triage", "scheduled", "todo"})


def _require_loop_graph_ownership(
    conn: sqlite3.Connection,
    workflow_id: str,
    task_ids: list[str],
) -> None:
    """Require every scoped mutation to stay inside one immutable workflow."""

    if kanban_db.get_workflow(conn, workflow_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"workflow {workflow_id} not found",
        )
    outside: list[str] = []
    for task_id in dict.fromkeys(task_ids):
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        if task.workflow_id != workflow_id:
            outside.append(task_id)
    if outside:
        raise HTTPException(
            status_code=400,
            detail=(
                f"task(s) not owned by workflow {workflow_id}: " + ", ".join(outside)
            ),
        )


def _loop_graph_allowed_child_statuses(
    conn: sqlite3.Connection,
    child_id: str,
) -> set[str]:
    child = kanban_db.get_task(conn, child_id)
    if child is None:
        raise HTTPException(status_code=404, detail=f"task {child_id} not found")
    if child.status not in _LOOP_GRAPH_MUTABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Loop dependencies are immutable once {child_id} is {child.status}; "
                "add or rewire a pending task instead"
            ),
        )
    if kanban_db.task_has_active_decomposition_children(conn, child_id):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Loop dependencies are immutable while decomposition children "
                f"for {child_id} are still active"
            ),
        )
    return set(_LOOP_GRAPH_MUTABLE_STATUSES)


@router.post("/links")
def add_link(payload: LinkBody, board: Optional[str] = Query(None)):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        workflow_id = _resolve_workflow_request(
            conn,
            workflow_id=payload.workflow_id,
            root_task_id=payload.root_task_id,
        )
        allowed_child_statuses = None
        if workflow_id:
            _require_loop_graph_ownership(
                conn,
                workflow_id,
                [payload.parent_id, payload.child_id],
            )
            allowed_child_statuses = _loop_graph_allowed_child_statuses(
                conn,
                payload.child_id,
            )
        kanban_db.link_tasks(
            conn,
            payload.parent_id,
            payload.child_id,
            allowed_child_statuses=allowed_child_statuses,
        )
        return {"ok": True}
    except kanban_db.TaskStatusConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


@router.delete("/links")
def delete_link(
    parent_id: str = Query(...),
    child_id: str = Query(...),
    workflow_id: Optional[str] = Query(None),
    root_task_id: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
    board: Optional[str] = Query(None),
):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        workflow_id = _resolve_workflow_request(
            conn,
            workflow_id=workflow_id,
            root_task_id=root_task_id,
        )
        allowed_child_statuses = None
        if workflow_id:
            _require_loop_graph_ownership(
                conn,
                workflow_id,
                [parent_id, child_id],
            )
            allowed_child_statuses = _loop_graph_allowed_child_statuses(
                conn,
                child_id,
            )
        ok = kanban_db.unlink_tasks(
            conn,
            parent_id,
            child_id,
            allowed_child_statuses=allowed_child_statuses,
        )
        return {"ok": bool(ok)}
    except kanban_db.TaskStatusConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Bulk actions (multi-select on the board)
# ---------------------------------------------------------------------------

class BulkTaskBody(BaseModel):
    ids: list[str]
    status: Optional[str] = None
    assignee: Optional[str] = None  # "" or None = unassign
    priority: Optional[int] = None
    archive: bool = False
    result: Optional[str] = None
    summary: Optional[str] = None
    metadata: Optional[dict] = None
    reclaim_first: bool = False
    # Bulk model/provider override — same semantics as UpdateTaskBody.
    model_override: Optional[str] = None
    provider_override: Optional[str] = None
    clear_model_override: bool = False


@router.post("/tasks/bulk")
def bulk_update(payload: BulkTaskBody, board: Optional[str] = Query(None)):
    """Apply the same patch to every id in ``payload.ids``.

    This is an *independent* iteration — per-task failures don't abort
    siblings. Returns per-id outcome so the UI can surface partials.
    """
    ids = [i for i in (payload.ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="ids is required")
    results: list[dict] = []
    board = _resolve_board(board)
    effective_board = board or kanban_db.get_current_board()
    conn = _conn(board=effective_board)
    completion_transitions = kanban_db.ReadyTransitions()
    completion_policy = None
    completed_ids: list[str] = []
    completion_recovery_warnings: list[str] = []
    if payload.status == "done" and not payload.archive:
        from hermes_cli import kanban_progress

        completion_policy = kanban_progress.load_progress_policy()
    try:
        for tid in ids:
            entry: dict[str, Any] = {"id": tid, "ok": True}
            try:
                task = kanban_db.get_task(conn, tid)
                if task is None:
                    entry.update(ok=False, error="not found")
                    results.append(entry)
                    continue
                if payload.archive:
                    if not kanban_db.archive_task(conn, tid):
                        entry.update(ok=False, error="archive refused")
                if payload.status is not None and not payload.archive:
                    s = payload.status
                    if s == "done":
                        with kanban_db.scoped_current_board(effective_board):
                            ok = kanban_db.complete_task(
                                conn, tid,
                                result=payload.result,
                                summary=payload.summary,
                                metadata=payload.metadata,
                                transitions=completion_transitions,
                                recompute_dependents=False,
                            )
                        if ok:
                            completed_ids.append(tid)
                            completion_recovery_warnings.extend(
                                kanban_progress.capture_completion_transitions(
                                    [tid],
                                    transitions=completion_transitions,
                                    board=effective_board,
                                    conn=conn,
                                    policy=completion_policy,
                                )
                            )
                    elif s == "blocked":
                        ok = kanban_db.block_task(conn, tid)
                    elif s == "ready":
                        cur = kanban_db.get_task(conn, tid)
                        if cur and cur.status in ("blocked", "scheduled"):
                            ok = kanban_db.unblock_task(conn, tid)
                        else:
                            ok = _set_status_direct(conn, tid, "ready")
                    elif s == "running":
                        entry.update(
                            ok=False,
                            error=(
                                "Cannot set status to 'running' directly; "
                                "use the dispatcher/claim path"
                            ),
                        )
                        results.append(entry)
                        continue
                    elif s == "scheduled":
                        ok = kanban_db.schedule_task(conn, tid)
                    elif s in {"todo", "triage"}:
                        ok = _set_status_direct(conn, tid, s)
                    else:
                        entry.update(ok=False, error=f"unknown status {s!r}")
                        results.append(entry)
                        continue
                    if not ok:
                        entry.update(ok=False, error=f"transition to {s!r} refused")
                if payload.assignee is not None:
                    try:
                        if payload.reclaim_first:
                            ok = kanban_db.reassign_task(
                                conn, tid, payload.assignee or None,
                                reclaim_first=True,
                            )
                        else:
                            ok = kanban_db.assign_task(
                                conn, tid, payload.assignee or None,
                            )
                        if not ok:
                            entry.update(ok=False, error="assign refused")
                    except RuntimeError as e:
                        entry.update(ok=False, error=str(e))
                if payload.priority is not None:
                    with kanban_db.write_txn(conn):
                        conn.execute(
                            "UPDATE tasks SET priority = ? WHERE id = ?",
                            (int(payload.priority), tid),
                        )
                        conn.execute(
                            "INSERT INTO task_events (task_id, kind, payload, created_at) "
                            "VALUES (?, 'reprioritized', ?, ?)",
                            (tid, json.dumps({"priority": int(payload.priority)}),
                             int(time.time())),
                        )
                if payload.clear_model_override or payload.model_override is not None:
                    new_model = (
                        None if payload.clear_model_override
                        else (payload.model_override or "").strip() or None
                    )
                    try:
                        ok = kanban_db.set_model_override(
                            conn, tid, new_model,
                            provider=payload.provider_override,
                        )
                        if not ok:
                            entry.update(ok=False, error="model override refused")
                    except (ValueError, RuntimeError) as e:
                        entry.update(ok=False, error=str(e))
            except Exception as e:  # defensive — one bad id shouldn't kill the batch
                entry.update(ok=False, error=str(e))
            results.append(entry)
        response: dict[str, Any] = {"results": results}
        if completed_ids:
            response["progress"] = kanban_progress.advance_transitions(
                completion_transitions,
                board=effective_board,
                conn=conn,
                author="dashboard-completion-auto-decomposer",
                policy=completion_policy,
                recovery_warnings=completion_recovery_warnings,
            )
        return response
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Diagnostics — fleet-wide distress signals (hallucinations, crashes,
# spawn failures, stuck-blocked). See hermes_cli.kanban_diagnostics for
# the rule engine.
# ---------------------------------------------------------------------------

@router.get("/diagnostics")
def list_diagnostics(
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
    severity: Optional[str] = Query(
        None,
        description="Filter by severity: warning|error|critical",
    ),
):
    """Return ``[{task_id, task_title, task_status, task_assignee,
    diagnostics: [...]}, ...]`` for every task on the board with at
    least one active diagnostic.

    Severity-filterable so the UI can render "just the critical ones"
    or the CLI can grep. Useful for the board-header attention strip
    AND for ``hermes kanban diagnostics`` which shells to this
    endpoint when the dashboard's running, or invokes the engine
    directly when it isn't.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        diags_by_task = _compute_task_diagnostics(conn, task_ids=None)
        if not diags_by_task:
            return {"diagnostics": [], "count": 0}

        # Narrow by severity if asked.
        if severity:
            filtered: dict[str, list[dict]] = {}
            for tid, dl in diags_by_task.items():
                keep = [d for d in dl if kd.severity_at_or_above(d.get("severity"), severity)]
                if keep:
                    filtered[tid] = keep
            diags_by_task = filtered
            if not diags_by_task:
                return {"diagnostics": [], "count": 0}

        # Pull the task rows we need in one query so we can include
        # titles/statuses without a per-task lookup.
        ids = list(diags_by_task.keys())
        placeholders = ",".join(["?"] * len(ids))
        rows = {
            r["id"]: r
            for r in conn.execute(
                f"SELECT id, title, status, assignee FROM tasks WHERE id IN ({placeholders})",
                tuple(ids),
            ).fetchall()
        }

        out = []
        for tid, dl in diags_by_task.items():
            r = rows.get(tid)
            out.append({
                "task_id": tid,
                "task_title": r["title"] if r else None,
                "task_status": r["status"] if r else None,
                "task_assignee": r["assignee"] if r else None,
                "diagnostics": dl,
            })
        # Sort: highest severity first, then most recent.
        from hermes_cli.kanban_diagnostics import SEVERITY_ORDER
        sev_idx = {s: i for i, s in enumerate(SEVERITY_ORDER)}
        def _sort_key(row):
            top = row["diagnostics"][0]
            return (
                -sev_idx.get(top.get("severity"), -1),
                -(top.get("last_seen_at") or 0),
            )
        out.sort(key=_sort_key)

        return {
            "diagnostics": out,
            "count": sum(len(d["diagnostics"]) for d in out),
        }
    finally:
        conn.close()



# ---------------------------------------------------------------------------
# Worker visibility — cross-task active-worker list and per-run inspection
# ---------------------------------------------------------------------------

try:
    import psutil as _psutil
except ImportError:
    _psutil = None  # type: ignore[assignment]


@router.get("/workers/active")
def list_active_workers(
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
):
    """Return every currently-running worker on the board.

    A worker is a ``task_runs`` row whose ``ended_at`` is NULL and whose
    ``worker_pid`` is non-NULL, belonging to a task with ``status='running'``.

    Returns ``{workers: [...], count: N, checked_at: <epoch>}``.  Each
    worker entry carries enough context for the dashboard to link back to
    its task without a second round-trip.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        rows = conn.execute(
            """
            SELECT
                r.id          AS run_id,
                r.task_id,
                t.title       AS task_title,
                t.status      AS task_status,
                t.assignee    AS task_assignee,
                r.profile,
                r.worker_pid,
                r.started_at,
                r.claim_lock,
                r.claim_expires,
                r.last_heartbeat_at,
                r.max_runtime_seconds
            FROM task_runs r
            JOIN tasks t ON t.id = r.task_id
            WHERE r.ended_at IS NULL
              AND r.worker_pid IS NOT NULL
              AND t.status = 'running'
            ORDER BY r.started_at ASC
            """,
        ).fetchall()
        workers = [
            {
                "run_id": row["run_id"],
                "task_id": row["task_id"],
                "task_title": row["task_title"],
                "task_status": row["task_status"],
                "task_assignee": row["task_assignee"],
                "profile": row["profile"],
                "worker_pid": row["worker_pid"],
                "started_at": row["started_at"],
                "claim_lock": row["claim_lock"],
                "claim_expires": row["claim_expires"],
                "last_heartbeat_at": row["last_heartbeat_at"],
                "max_runtime_seconds": row["max_runtime_seconds"],
            }
            for row in rows
        ]
        return {"workers": workers, "count": len(workers), "checked_at": int(time.time())}
    finally:
        conn.close()


@router.get("/runs/{run_id}")
def get_run_endpoint(
    run_id: int,
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
):
    """Direct lookup of a ``task_runs`` row by its integer id.

    Returns ``{run: {...}}`` using the same serialisation as the
    per-task run history embedded in ``GET /tasks/{task_id}``.
    404 when no such run exists.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        r = kanban_db.get_run(conn, run_id)
        if r is None:
            raise HTTPException(status_code=404, detail=f"run {run_id} not found")
        return {"run": _run_dict(r)}
    finally:
        conn.close()


@router.get("/runs/{run_id}/inspect")
def inspect_run_endpoint(
    run_id: int,
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
):
    """Live PID stats for a run's worker process via psutil.

    If the run has already ended, or has no recorded ``worker_pid``,
    returns ``{alive: false}`` with a human-readable ``reason``.

    When the process is live, returns CPU, memory, thread count, fd count,
    status, create_time, and cmdline.  ``access_denied`` is set when the
    OS refuses inspection rather than raising a 500.

    psutil availability: if psutil is not installed the endpoint still
    works but ``alive`` is always returned as ``false`` with
    ``reason="psutil not available"``.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        r = kanban_db.get_run(conn, run_id)
        if r is None:
            raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    finally:
        conn.close()

    if r.ended_at is not None:
        return {"run_id": run_id, "alive": False, "reason": "run already ended"}
    if r.worker_pid is None:
        return {"run_id": run_id, "alive": False, "reason": "no worker_pid recorded"}

    pid = r.worker_pid

    if _psutil is None:
        return {"run_id": run_id, "alive": False, "pid": pid, "reason": "psutil not available"}

    try:
        proc = _psutil.Process(pid)
        info = proc.as_dict(attrs=[
            "cpu_percent", "memory_info", "num_threads",
            "status", "create_time", "cmdline",
        ])
        # num_fds is POSIX-only; skip gracefully on Windows.
        try:
            num_fds = proc.num_fds()
        except AttributeError:
            num_fds = None
        mem = info.get("memory_info")
        return {
            "run_id": run_id,
            "alive": True,
            "pid": pid,
            "cpu_percent": info.get("cpu_percent"),
            "memory_rss_bytes": mem.rss if mem else None,
            "memory_vms_bytes": mem.vms if mem else None,
            "num_threads": info.get("num_threads"),
            "num_fds": num_fds,
            "status": info.get("status"),
            "create_time": info.get("create_time"),
            "cmdline": info.get("cmdline"),
        }
    except _psutil.NoSuchProcess:
        return {"run_id": run_id, "alive": False, "pid": pid, "reason": "process not found"}
    except _psutil.AccessDenied:
        return {"run_id": run_id, "alive": True, "pid": pid, "error": "access denied"}


class TerminateRunBody(BaseModel):
    reason: Optional[str] = None


@router.post("/runs/{run_id}/terminate")
def terminate_run_endpoint(
    run_id: int,
    payload: TerminateRunBody,
    board: Optional[str] = Query(None, description="Kanban board slug (omit for current)"),
):
    """Terminate the worker process backing an in-flight run.

    Resolves ``run_id`` to its parent ``task_id`` and routes through
    :func:`kanban_db.reclaim_task` so the SIGTERM->SIGKILL flow,
    run-outcome bookkeeping, and event-log append all match what the
    existing ``POST /tasks/{task_id}/reclaim`` endpoint does.

    Responses:
      * 200 ``{"ok": true, "run_id": ..., "task_id": ...}`` on success.
      * 404 when ``run_id`` is unknown.
      * 409 when the run has already ended, or the task is no longer in
        a claimable state.

    Closes the gap left by PR #28432, which shipped the read-only
    sibling endpoints (``/workers/active``, ``/runs/{run_id}``,
    ``/runs/{run_id}/inspect``) but no termination control surface.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        r = kanban_db.get_run(conn, run_id)
        if r is None:
            raise HTTPException(status_code=404, detail=f"run {run_id} not found")
        if r.ended_at is not None:
            raise HTTPException(
                status_code=409,
                detail=f"run {run_id} already ended",
            )
        ok = kanban_db.reclaim_task(conn, r.task_id, reason=payload.reason)
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"cannot terminate run {run_id}: task {r.task_id} is no "
                    "longer in a reclaimable state"
                ),
            )
        return {"ok": True, "run_id": run_id, "task_id": r.task_id}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Recovery actions — reclaim a running claim, reassign to a new profile
# ---------------------------------------------------------------------------

class ReclaimBody(BaseModel):
    reason: Optional[str] = None


@router.post("/tasks/{task_id}/reclaim")
def reclaim_task_endpoint(
    task_id: str,
    payload: ReclaimBody,
    board: Optional[str] = Query(None),
):
    """Release an active worker claim on a running task.

    Used by the dashboard recovery popover when an operator wants to
    abort a stuck worker (e.g. one that keeps hallucinating card ids)
    without waiting for the claim TTL. Maps 1:1 to
    ``hermes kanban reclaim <task_id> --reason ...``.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        ok = kanban_db.reclaim_task(conn, task_id, reason=payload.reason)
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"cannot reclaim {task_id}: not in a claimable state "
                    "(not running, or unknown id)"
                ),
            )
        return {"ok": True, "task_id": task_id}
    finally:
        conn.close()


class SpecifyBody(BaseModel):
    """Optional author override. Nothing else is configurable from the
    dashboard — model + prompt come from ``auxiliary.triage_specifier``
    in config.yaml, same as the CLI."""

    author: Optional[str] = None


@router.post("/tasks/{task_id}/specify")
def specify_task_endpoint(
    task_id: str,
    payload: SpecifyBody,
    board: Optional[str] = Query(None),
):
    """Flesh out a triage-column task via the auxiliary LLM and promote
    it to ``todo``. Maps 1:1 to ``hermes kanban specify <task_id>``.

    Returns the outcome shape used by the CLI: ``{ok, task_id, reason,
    new_title}``. A non-OK outcome is NOT an HTTP error — the UI renders
    the reason inline (e.g. "no auxiliary client configured") so the
    operator knows what to fix, and retries without a page reload.

    This endpoint runs in FastAPI's threadpool (sync ``def``) because
    the underlying LLM call can take tens of seconds to minutes on
    reasoning models, which would block the event loop if we used
    ``async def`` without an explicit ``run_in_executor``.
    """
    board = _resolve_board(board)
    effective_board = board or kanban_db.get_current_board()
    # Pin the board for the duration of this call so the specifier module
    # (which calls ``kb.connect()`` with no args) hits the right DB. Use a
    # context-local override rather than mutating the process-global
    # HERMES_KANBAN_BOARD env var — this endpoint runs in FastAPI's
    # threadpool, so two concurrent requests for different boards would
    # otherwise race on the shared env var and cross-write (issue #38323).
    with kanban_db.scoped_current_board(effective_board):
        # Import lazily so a missing auxiliary client at import time
        # doesn't break plugin load.
        from hermes_cli import kanban_specify  # noqa: WPS433 (intentional)

        outcome = kanban_specify.specify_task(
            task_id,
            author=(payload.author or None),
        )

    return {
        "ok": bool(outcome.ok),
        "task_id": outcome.task_id,
        "reason": outcome.reason,
        "new_title": outcome.new_title,
    }


class ReassignBody(BaseModel):
    profile: Optional[str] = None  # "" or None = unassign
    reclaim_first: bool = False
    reason: Optional[str] = None


@router.post("/tasks/{task_id}/reassign")
def reassign_task_endpoint(
    task_id: str,
    payload: ReassignBody,
    board: Optional[str] = Query(None),
):
    """Reassign a task to a different profile, optionally reclaiming first.

    Used by the dashboard recovery popover when an operator wants to
    retry a task with a different worker profile (e.g. switch to a
    smarter model after the assigned profile keeps hallucinating).
    Maps 1:1 to ``hermes kanban reassign <task_id> <profile> [--reclaim]``.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        ok = kanban_db.reassign_task(
            conn, task_id,
            payload.profile or None,
            reclaim_first=bool(payload.reclaim_first),
            reason=payload.reason,
        )
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"cannot reassign {task_id}: unknown id, or still "
                    "running (pass reclaim_first=true to release the claim first)"
                ),
            )
        return {"ok": True, "task_id": task_id, "assignee": payload.profile or None}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Plugin config (read dashboard.kanban.* defaults from config.yaml)
# ---------------------------------------------------------------------------

@router.get("/config")
def get_config():
    """Return kanban dashboard preferences from ~/.hermes/config.yaml.

    Reads the ``dashboard.kanban`` section if present; defaults otherwise.
    Used by the UI to pre-select tenant filters, toggle markdown rendering,
    or set column-width preferences without a round-trip per page load.
    """
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
    except Exception:
        cfg = {}
    dash_cfg = (cfg.get("dashboard") or {})
    # dashboard.kanban may itself be a dict; fall back to {}.
    k_cfg = dash_cfg.get("kanban") or {}
    return {
        "default_tenant": k_cfg.get("default_tenant") or "",
        "lane_by_profile": bool(k_cfg.get("lane_by_profile", True)),
        "include_archived_by_default": bool(k_cfg.get("include_archived_by_default", False)),
        "render_markdown": bool(k_cfg.get("render_markdown", True)),
    }


# ---------------------------------------------------------------------------
# Home-channel subscriptions (per-task, per-platform toggles)
# ---------------------------------------------------------------------------
#
# Home channels are a first-class gateway concept — each configured platform
# can have exactly one (chat_id, thread_id, name) it considers "home". The
# dashboard surfaces these as per-task toggles so a user can opt a specific
# task into receiving terminal notifications (completed / blocked / gave_up)
# at their telegram/discord/slack home, without touching the CLI.
#
# The wire format mirrors kanban_db.add_notify_sub — (task_id, platform,
# chat_id, thread_id) — so toggle-on creates exactly the same row the
# `/kanban create` slash command would, and the existing gateway notifier
# watcher delivers events without any additional plumbing.


def _configured_home_channels() -> list[dict]:
    """Return every platform that has a home_channel set, fully hydrated.

    Reads the live GatewayConfig so env-var overlays (``TELEGRAM_HOME_CHANNEL``
    etc.) are honored alongside config.yaml. Returns platforms in a stable
    order and drops platforms without a home.
    """
    try:
        from gateway.config import load_gateway_config
    except Exception:
        return []
    try:
        gw_cfg = load_gateway_config()
    except Exception:
        return []
    result: list[dict] = []
    for platform, pcfg in gw_cfg.platforms.items():
        if not pcfg or not pcfg.home_channel:
            continue
        hc = pcfg.home_channel
        result.append({
            "platform": platform.value,
            "chat_id": hc.chat_id,
            "thread_id": hc.thread_id or "",
            "name": hc.name or "Home",
        })
    # Stable order for deterministic UI — platform name alphabetical.
    result.sort(key=lambda r: r["platform"])
    return result


def _active_profile_name() -> str:
    """Return the current Hermes profile name for notify-sub ownership."""
    try:
        from hermes_cli.profiles import get_active_profile_name
        return get_active_profile_name() or "default"
    except Exception:
        return "default"


def _home_sub_matches(sub: dict, home: dict) -> bool:
    """True if a notify_subs row corresponds to the given home channel."""
    return (
        sub.get("platform") == home["platform"]
        and str(sub.get("chat_id", "")) == str(home["chat_id"])
        and str(sub.get("thread_id") or "") == str(home["thread_id"] or "")
    )


@router.get("/home-channels")
def get_home_channels(
    task_id: Optional[str] = Query(None),
    board: Optional[str] = Query(None),
):
    """List every platform with a home channel, plus whether *task_id*
    (if given) is currently subscribed to that home.

    When ``task_id`` is omitted, every entry's ``subscribed`` is ``false``
    — useful for the "no task selected" state of the UI.
    """
    homes = _configured_home_channels()
    subscribed_homes: set[tuple[str, str, str]] = set()
    if task_id:
        board = _resolve_board(board)
        conn = _conn(board=board)
        try:
            subs = kanban_db.list_notify_subs(conn, task_id)
        finally:
            conn.close()
        for sub in subs:
            key = (
                str(sub.get("platform") or ""),
                str(sub.get("chat_id") or ""),
                str(sub.get("thread_id") or ""),
            )
            subscribed_homes.add(key)
    result = []
    for home in homes:
        key = (home["platform"], home["chat_id"], home["thread_id"])
        result.append({**home, "subscribed": key in subscribed_homes})
    return {"home_channels": result}


@router.post("/tasks/{task_id}/home-subscribe/{platform}")
def subscribe_home(task_id: str, platform: str, board: Optional[str] = Query(None)):
    """Subscribe *task_id* to notifications routed to *platform*'s home channel.

    Idempotent — re-subscribing is a no-op at the DB layer. 404 if the
    platform has no home channel configured. 404 if the task doesn't exist.
    """
    homes = _configured_home_channels()
    home = next((h for h in homes if h["platform"] == platform), None)
    if not home:
        raise HTTPException(
            status_code=404,
            detail=f"No home channel configured for platform {platform!r}. "
            f"Set one from the messenger via /sethome, or configure "
            f"gateway.platforms.{platform}.home_channel in config.yaml.",
        )
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        task = kanban_db.get_task(conn, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        route = {
            "platform": platform,
            "chat_id": home["chat_id"],
            "chat_type": ("thread" if home["thread_id"] else "group"),
            "thread_id": home["thread_id"] or None,
            "notifier_profile": _active_profile_name(),
        }
        if task.workflow_id:
            kanban_db.cutover_legacy_workflow_route(
                conn,
                workflow_id=task.workflow_id,
                **route,
            )
        else:
            kanban_db.add_notify_sub(
                conn,
                task_id=task_id,
                scope="task",
                **route,
            )
        return {
            "ok": True,
            "task_id": task_id,
            "workflow_id": task.workflow_id,
            "home_channel": home,
        }
    finally:
        conn.close()


@router.delete("/tasks/{task_id}/home-subscribe/{platform}")
def unsubscribe_home(task_id: str, platform: str, board: Optional[str] = Query(None)):
    """Remove any notify subscription on *task_id* that matches *platform*'s home."""
    homes = _configured_home_channels()
    home = next((h for h in homes if h["platform"] == platform), None)
    if not home:
        raise HTTPException(
            status_code=404,
            detail=f"No home channel configured for platform {platform!r}.",
        )
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        task = kanban_db.get_task(conn, task_id)
        if task is not None and task.workflow_id:
            kanban_db.remove_workflow_notify_sub_if_idle(
                conn,
                workflow_id=task.workflow_id,
                notifier_profile=_active_profile_name(),
                platform=platform,
                chat_id=home["chat_id"],
                thread_id=home["thread_id"] or None,
            )
        else:
            kanban_db.remove_notify_sub(
                conn,
                task_id=task_id,
                platform=platform,
                chat_id=home["chat_id"],
                thread_id=home["thread_id"] or None,
            )
        return {"ok": True, "task_id": task_id, "home_channel": home}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Stats (per-profile / per-status counts + oldest-ready age)
# ---------------------------------------------------------------------------

@router.get("/stats")
def get_stats(board: Optional[str] = Query(None)):
    """Per-status + per-assignee counts + oldest-ready age.

    Designed for the dashboard HUD and for router profiles that need to
    answer "is this specialist overloaded?" without scanning the whole
    board themselves.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        return kanban_db.board_stats(conn)
    finally:
        conn.close()


@router.get("/assignees")
def get_assignees(board: Optional[str] = Query(None)):
    """Known profiles + per-profile task counts.

    Returns the union of ``~/.hermes/profiles/*`` on disk and every
    distinct assignee currently used on the board. The dashboard uses
    this to populate its assignee dropdown so a freshly-created profile
    appears in the picker before it's been given any task.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        return {"assignees": kanban_db.known_assignees(conn)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Worker log (read-only; file written by _default_spawn)
# ---------------------------------------------------------------------------

@router.get("/tasks/{task_id}/log")
def get_task_log(
    task_id: str,
    tail: Optional[int] = Query(None, ge=1, le=2_000_000),
    board: Optional[str] = Query(None),
):
    """Return the worker's stdout/stderr log.

    ``tail`` caps the response size (bytes) so the dashboard drawer
    doesn't paginate megabytes into the browser. Returns 404 if the task
    has never spawned. The on-disk log is rotated at 2 MiB per
    ``_rotate_worker_log`` — a single ``.log.1`` is kept, no further
    generations, so disk usage per task is bounded at ~4 MiB.
    """
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        task = kanban_db.get_task(conn, task_id)
    finally:
        conn.close()
    if task is None:
        raise HTTPException(status_code=404, detail=f"task {task_id} not found")
    content = kanban_db.read_worker_log(task_id, tail_bytes=tail, board=board)
    log_path = kanban_db.worker_log_path(task_id, board=board)
    size = log_path.stat().st_size if log_path.exists() else 0
    return {
        "task_id": task_id,
        "path": str(log_path),
        "exists": content is not None,
        "size_bytes": size,
        "content": content or "",
        # Truncated when the on-disk file was larger than the tail cap.
        "truncated": bool(tail and size > tail),
    }


# ---------------------------------------------------------------------------
# Dispatch nudge (optional quick-path so the UI doesn't wait 60 s)
# ---------------------------------------------------------------------------

@router.post("/dispatch")
def dispatch(
    dry_run: bool = Query(False),
    max_n: int = Query(8, alias="max"),
    board: Optional[str] = Query(None),
):
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        result = kanban_db.dispatch_once(
            conn, dry_run=dry_run, max_spawn=max_n, board=board,
        )
        # DispatchResult is a dataclass.
        try:
            return asdict(result)
        except TypeError:
            return {"result": str(result)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Model options (the board's per-task model-override dropdown)
# ---------------------------------------------------------------------------

@router.get("/model-options")
def model_options():
    """Authenticated providers + curated model lists for the task drawer's
    model-override dropdown.

    Thin wrapper around ``hermes_cli.inventory.build_models_payload`` — the
    same substrate the dashboard Models page and the TUI picker use, so the
    dropdown can never offer a model/provider pair the rest of Hermes
    wouldn't accept. Deliberately skips pricing/capability enrichment and
    custom-provider probes: the dropdown needs names fast, not $/Mtok
    columns (a slow/offline local endpoint must not hang the drawer).
    """
    try:
        from hermes_cli.inventory import build_models_payload, load_picker_context

        payload = build_models_payload(
            load_picker_context(),
            explicit_only=True,
            canonical_order=True,
            probe_custom_providers=False,
        )
        return {
            "providers": [
                {
                    "slug": row.get("slug", ""),
                    "label": row.get("label") or row.get("slug", ""),
                    "models": list(row.get("models") or []),
                }
                for row in payload.get("providers", [])
                if row.get("models")
            ],
        }
    except Exception:
        log.exception("kanban model-options failed")
        # Degrade to an empty catalog — the UI falls back to a free-text
        # input so the feature still works without the inventory module.
        return {"providers": []}


# ---------------------------------------------------------------------------
# Boards CRUD (multi-project support)
# ---------------------------------------------------------------------------

class CreateBoardBody(BaseModel):
    slug: str
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    default_workdir: Optional[str] = None
    switch: bool = False


class RenameBoardBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    # Board-level default project directory for new tasks. ``None`` =
    # leave unchanged; empty string = clear; a path = validate + set.
    default_workdir: Optional[str] = None


def _board_counts(slug: str) -> dict[str, int]:
    """Return ``{status: count}`` for a board. Safe on an empty DB."""
    try:
        path = kanban_db.kanban_db_path(board=slug)
        if not path.exists():
            return {}
        conn = kanban_db.connect(board=slug)
        try:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"
            ).fetchall()
            return {r["status"]: int(r["n"]) for r in rows}
        finally:
            conn.close()
    except Exception:
        return {}


def _default_workspace_kind(board: dict[str, Any]) -> str:
    """Recommend a non-destructive task workspace from board metadata."""
    workdir = str(board.get("default_workdir") or "").strip()
    if not workdir:
        return "scratch"
    try:
        return "worktree" if kanban_db._git_toplevel(Path(workdir)) else "dir"
    except (OSError, ValueError):
        return "dir"


@router.get("/boards")
def list_boards(include_archived: bool = Query(False)):
    """Return every board on disk with task counts and the active slug."""
    boards = kanban_db.list_boards(include_archived=include_archived)
    current = kanban_db.get_current_board()
    for b in boards:
        b["is_current"] = (b["slug"] == current)
        b["counts"] = _board_counts(b["slug"])
        b["total"] = sum(b["counts"].values())
        b["default_workspace_kind"] = _default_workspace_kind(b)
    return {"boards": boards, "current": current}


def _validate_workdir(raw: str) -> str:
    """Validate a board default_workdir value; return the resolved path.

    Raises :class:`HTTPException` (400) for relative or non-directory
    paths — mirroring the create-board contract.
    """
    requested = Path(raw).expanduser()
    if not requested.is_absolute():
        raise HTTPException(
            status_code=400,
            detail="Project directory must be an absolute path.",
        )
    if not requested.is_dir():
        raise HTTPException(
            status_code=400,
            detail="Project directory must be an existing directory.",
        )
    return str(requested.resolve())


@router.post("/boards")
def create_board_endpoint(payload: CreateBoardBody):
    """Create a new board. Idempotent — ``slug`` collision returns existing."""
    default_workdir = None
    if payload.default_workdir:
        default_workdir = _validate_workdir(payload.default_workdir)
    try:
        meta = kanban_db.create_board(
            payload.slug,
            name=payload.name,
            description=payload.description,
            icon=payload.icon,
            color=payload.color,
            default_workdir=default_workdir,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if payload.switch:
        try:
            kanban_db.set_current_board(meta["slug"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    meta["default_workspace_kind"] = _default_workspace_kind(meta)
    return {"board": meta, "current": kanban_db.get_current_board()}


@router.patch("/boards/{slug}")
def rename_board(slug: str, payload: RenameBoardBody):
    """Update a board's display metadata + default project directory (slug is immutable — create a new one to rename the directory)."""
    try:
        normed = kanban_db._normalize_board_slug(slug)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not normed or not kanban_db.board_exists(normed):
        raise HTTPException(status_code=404, detail=f"board {slug!r} does not exist")
    # default_workdir: None = leave unchanged; "" = clear; path = validate + set.
    # write_board_metadata treats a falsy value as "clear", so pass "" through.
    default_workdir: Optional[str] = None
    if payload.default_workdir is not None:
        raw = payload.default_workdir.strip()
        default_workdir = _validate_workdir(raw) if raw else ""
    meta = kanban_db.write_board_metadata(
        normed,
        name=payload.name,
        description=payload.description,
        icon=payload.icon,
        color=payload.color,
        default_workdir=default_workdir,
    )
    meta["default_workspace_kind"] = _default_workspace_kind(meta)
    return {"board": meta}


@router.delete("/boards/{slug}")
def delete_board(slug: str, delete: bool = Query(False, description="Hard-delete instead of archive")):
    """Archive (default) or hard-delete a board."""
    try:
        res = kanban_db.remove_board(slug, archive=not delete)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"result": res, "current": kanban_db.get_current_board()}


@router.post("/boards/{slug}/switch")
def switch_board(slug: str):
    """Persist ``slug`` as the active board for subsequent CLI / slash calls.

    Dashboard users pick boards via a client-side ``localStorage`` — this
    endpoint is for ``/kanban boards switch`` parity so gateway slash
    commands and the CLI share the same current-board pointer.
    """
    try:
        normed = kanban_db._normalize_board_slug(slug)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not normed or not kanban_db.board_exists(normed):
        raise HTTPException(status_code=404, detail=f"board {slug!r} does not exist")
    kanban_db.set_current_board(normed)
    return {"current": normed}


# ---------------------------------------------------------------------------
# WebSocket: /events?since=<event_id>
# ---------------------------------------------------------------------------

# Poll interval for the event tail loop. SQLite WAL + 300 ms polling is
# the simplest and most robust approach; it adds a fraction of a percent
# of CPU and has no shared state to synchronize across workers.
_EVENT_POLL_SECONDS = 0.3


# ---------------------------------------------------------------------------
# Profile metadata & description editing (consumed by the kanban orchestrator)
# ---------------------------------------------------------------------------

class DescribeBody(BaseModel):
    description: Optional[str] = None  # explicit user-authored text


class DescribeAutoBody(BaseModel):
    overwrite: bool = False


@router.get("/profiles")
def list_profile_roster():
    """Return every installed profile with its description.

    Consumed by the dashboard's settings panel (orchestrator picker)
    and the profile-description editing UI. Profiles without a
    description still appear here — they're routable on name alone,
    just less precisely.
    """
    try:
        from hermes_cli import profiles as profiles_mod
        profiles = profiles_mod.list_profiles()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to list profiles: {exc}")
    return {
        "profiles": [
            {
                "name": p.name,
                "is_default": bool(p.is_default),
                "model": p.model or "",
                "provider": p.provider or "",
                "description": p.description or "",
                "description_auto": bool(p.description_auto),
                "skill_count": int(p.skill_count or 0),
            }
            for p in profiles
        ],
    }


@router.patch("/profiles/{profile_name}")
def update_profile_description(profile_name: str, payload: DescribeBody):
    """Set or clear the description of a profile.

    Empty string clears the description; non-empty stores it as a
    user-authored description (``description_auto: false``) so the
    auto-describer won't overwrite it on a sweep without
    ``--overwrite``.
    """
    try:
        from hermes_cli import profiles as profiles_mod
        canon = profiles_mod.normalize_profile_name(profile_name)
        if canon == "default":
            from hermes_constants import get_hermes_home  # type: ignore
            from pathlib import Path as _Path
            profile_dir = _Path(get_hermes_home())
        else:
            profile_dir = profiles_mod.get_profile_dir(canon)
        if not profile_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"profile '{profile_name}' not found")
        text = (payload.description or "").strip()
        profiles_mod.write_profile_meta(
            profile_dir,
            description=text,
            description_auto=False,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to update profile: {exc}")
    return {"ok": True, "profile": canon, "description": text}


@router.post("/profiles/{profile_name}/describe-auto")
def auto_describe_profile(profile_name: str, payload: DescribeAutoBody):
    """Generate a description for the named profile via the auxiliary
    LLM (``auxiliary.profile_describer``). Persists with
    ``description_auto: true`` so the dashboard can surface a "review"
    badge.

    Maps 1:1 to ``hermes profile describe <name> --auto``. Non-OK
    outcomes are NOT HTTP errors — the UI renders the reason inline
    (e.g. "no auxiliary client configured") so the operator can fix
    config and retry without a page reload.
    """
    try:
        from hermes_cli import profile_describer  # noqa: WPS433 (intentional)
        outcome = profile_describer.describe_profile(
            profile_name,
            overwrite=bool(payload.overwrite),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"describer crashed: {exc}")
    return {
        "ok": bool(outcome.ok),
        "profile": outcome.profile_name,
        "reason": outcome.reason,
        "description": outcome.description,
    }


# ---------------------------------------------------------------------------
# Decompose endpoint (built-in decomposer fan-out)
# ---------------------------------------------------------------------------

class DecomposeBody(BaseModel):
    author: Optional[str] = None
    approve_intake: bool = False
    loop_safe: bool = False


class ActivateLoopBody(BaseModel):
    author: Optional[str] = None


@router.post("/tasks/{task_id}/activate")
def activate_loop_task_endpoint(
    task_id: str,
    payload: ActivateLoopBody,
    board: Optional[str] = Query(None),
):
    """Activate an existing scheduled Loop plan without planning it again."""
    board = _resolve_board(board)
    conn = _conn(board=board)
    try:
        return _activate_planned_loop(
            conn,
            task_id,
            author=(payload.author or "desktop-submit").strip() or "desktop-submit",
        )
    finally:
        conn.close()


@router.post("/tasks/{task_id}/decompose")
def decompose_task_endpoint(
    task_id: str,
    payload: DecomposeBody,
    board: Optional[str] = Query(None),
):
    """Fan a triage-column task out into a graph of child tasks via the
    auxiliary LLM, routed to specialist profiles by description. Maps
    1:1 to ``hermes kanban decompose <task_id>``.

    Returns the outcome shape used by the CLI: ``{ok, task_id, reason,
    fanout, child_ids, new_title}``. A non-OK outcome is NOT an HTTP
    error — the UI renders the reason inline.

    Runs in FastAPI's threadpool (sync ``def``) because the LLM call
    can take minutes on reasoning models.
    """
    board = _resolve_board(board)
    effective_board = board or kanban_db.get_current_board()
    conn = _conn(board=effective_board)
    try:
        if payload.approve_intake and _task_has_loop_intake_pending_submit(conn, task_id):
            with kanban_db.write_txn(conn):
                kanban_db._append_event(
                    conn,
                    task_id,
                    _LOOP_INTAKE_EVENT_KIND,
                    {
                        "needed": True,
                        "state": "approved",
                        "source": "desktop_submit",
                        "dispatchable": bool(not payload.loop_safe),
                    },
                )
                if not payload.loop_safe:
                    conn.execute(
                        "UPDATE tasks SET status = 'triage' WHERE id = ? AND status = 'scheduled'",
                        (task_id,),
                    )
        if _task_has_unresolved_loop_intake(conn, task_id):
            return {
                "ok": False,
                "task_id": task_id,
                "reason": _loop_intake_required_reason(task_id),
                "fanout": False,
                "child_ids": [],
                "new_title": None,
            }
    finally:
        conn.close()
    # Context-local board pin (see specify endpoint above): this sync
    # endpoint runs in FastAPI's threadpool, so mutating the process-global
    # HERMES_KANBAN_BOARD env var would let concurrent requests for
    # different boards race and cross-write (issue #38323).
    with kanban_db.scoped_current_board(effective_board):
        from hermes_cli import kanban_decompose  # noqa: WPS433 (intentional)
        outcome = kanban_decompose.decompose_task(
            task_id,
            author=(payload.author or None),
            loop_safe=payload.loop_safe,
        )

    progress = {
        "candidate_task_ids": [],
        "dispatch": {"spawned": []},
        "warnings": [],
    }
    if outcome.ok:
        from hermes_cli import kanban_progress  # noqa: WPS433 (intentional)

        progress = kanban_progress.dispatch_candidates(
            [outcome.task_id, *(outcome.child_ids or [])],
            board=effective_board,
        )

    return {
        "ok": bool(outcome.ok),
        "task_id": outcome.task_id,
        "reason": outcome.reason,
        "fanout": bool(outcome.fanout),
        "child_ids": outcome.child_ids or [],
        "new_title": outcome.new_title,
        "candidate_task_ids": progress["candidate_task_ids"],
        "dispatch": progress["dispatch"],
        "warnings": progress["warnings"],
    }


# ---------------------------------------------------------------------------
# Orchestration settings (kanban.orchestrator_profile / default_assignee /
# auto_decompose) — surfaced to the dashboard's settings panel
# ---------------------------------------------------------------------------

class OrchestrationSettingsBody(BaseModel):
    orchestrator_profile: Optional[str] = None
    default_assignee: Optional[str] = None
    auto_decompose: Optional[bool] = None
    auto_promote_children: Optional[bool] = None


@router.get("/orchestration")
def get_orchestration_settings():
    """Return the current kanban orchestration knobs from config.yaml
    plus the resolved effective values (filling in fallbacks)."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config() or {}
    except Exception:
        cfg = {}
    kanban_cfg = (cfg.get("kanban") or {}) if isinstance(cfg, dict) else {}
    explicit_orch = (kanban_cfg.get("orchestrator_profile") or "").strip()
    explicit_default = (kanban_cfg.get("default_assignee") or "").strip()
    auto_decompose = bool(kanban_cfg.get("auto_decompose", True))
    auto_promote_children = bool(kanban_cfg.get("auto_promote_children", True))

    # Resolve fallbacks the same way the decomposer does.
    resolved_orch = explicit_orch
    resolved_default = explicit_default
    try:
        from hermes_cli import profiles as profiles_mod
        active_default = profiles_mod.get_active_profile_name() or "default"
        if not resolved_orch or not profiles_mod.profile_exists(resolved_orch):
            resolved_orch = active_default
        if not resolved_default or not profiles_mod.profile_exists(resolved_default):
            resolved_default = active_default
    except Exception:
        active_default = "default"
        if not resolved_orch:
            resolved_orch = active_default
        if not resolved_default:
            resolved_default = active_default

    return {
        "orchestrator_profile": explicit_orch,
        "default_assignee": explicit_default,
        "auto_decompose": auto_decompose,
        "auto_promote_children": auto_promote_children,
        "resolved_orchestrator_profile": resolved_orch,
        "resolved_default_assignee": resolved_default,
        "active_profile": active_default,
    }


@router.put("/orchestration")
def set_orchestration_settings(payload: OrchestrationSettingsBody):
    """Update the kanban orchestration knobs in ~/.hermes/config.yaml.

    Each field is optional — only fields explicitly passed are
    written. ``orchestrator_profile`` / ``default_assignee`` accept
    empty strings to clear the override and fall back to the default
    profile.
    """
    try:
        from hermes_cli.config import load_config, save_config
        cfg = load_config() or {}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to load config: {exc}")

    kanban_section = cfg.setdefault("kanban", {})
    if not isinstance(kanban_section, dict):
        kanban_section = {}
        cfg["kanban"] = kanban_section

    # Validate any non-empty profile names exist before saving.
    try:
        from hermes_cli import profiles as profiles_mod
    except Exception:
        profiles_mod = None  # type: ignore

    if payload.orchestrator_profile is not None:
        name = (payload.orchestrator_profile or "").strip()
        if name and profiles_mod is not None:
            try:
                if not profiles_mod.profile_exists(name):
                    raise HTTPException(
                        status_code=400,
                        detail=f"profile '{name}' does not exist",
                    )
            except HTTPException:
                raise
            except Exception:
                pass  # fail open if the lookup itself errors
        kanban_section["orchestrator_profile"] = name

    if payload.default_assignee is not None:
        name = (payload.default_assignee or "").strip()
        if name and profiles_mod is not None:
            try:
                if not profiles_mod.profile_exists(name):
                    raise HTTPException(
                        status_code=400,
                        detail=f"profile '{name}' does not exist",
                    )
            except HTTPException:
                raise
            except Exception:
                pass
        kanban_section["default_assignee"] = name

    if payload.auto_decompose is not None:
        kanban_section["auto_decompose"] = bool(payload.auto_decompose)

    if payload.auto_promote_children is not None:
        kanban_section["auto_promote_children"] = bool(payload.auto_promote_children)

    try:
        save_config(cfg)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to save config: {exc}")

    # Echo back the resolved state (callers usually re-render from it).
    return get_orchestration_settings()


@router.websocket("/events")
async def stream_events(ws: WebSocket):
    # Authorize the upgrade via the dashboard's canonical WS gate so the
    # correct credential is accepted in every mode (loopback token / gated
    # single-use ticket / server-internal credential). Browsers can't set
    # Authorization on a WS upgrade, so the credential rides in the query
    # string — the browser SDK's buildWsUrl() assembles it.
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    try:
        since_raw = ws.query_params.get("since", "0")
        try:
            cursor = int(since_raw)
        except ValueError:
            cursor = 0

        # Board selection — pinned at the WS handshake; re-subscribe to
        # switch boards. Changing boards mid-stream would require
        # reconciling two cursors, so the UI just opens a new WS on
        # board change.
        ws_board_raw = ws.query_params.get("board")
        try:
            ws_board = kanban_db._normalize_board_slug(ws_board_raw) if ws_board_raw else None
        except ValueError:
            ws_board = None

        def _fetch_new(cursor_val: int) -> tuple[int, list[dict]]:
            conn = kanban_db.connect(board=ws_board)
            try:
                rows = conn.execute(
                    "SELECT id, task_id, run_id, kind, payload, created_at "
                    "FROM task_events WHERE id > ? ORDER BY id ASC LIMIT 200",
                    (cursor_val,),
                ).fetchall()
                out: list[dict] = []
                new_cursor = cursor_val
                for r in rows:
                    try:
                        payload = json.loads(r["payload"]) if r["payload"] else None
                    except Exception:
                        payload = None
                    out.append({
                        "id": r["id"],
                        "task_id": r["task_id"],
                        "run_id": r["run_id"],
                        "kind": r["kind"],
                        "payload": payload,
                        "created_at": r["created_at"],
                    })
                    new_cursor = r["id"]
                return new_cursor, out
            finally:
                conn.close()

        while True:
            cursor, events = await asyncio.to_thread(_fetch_new, cursor)
            if events:
                await ws.send_json({"events": events, "cursor": cursor})
            await asyncio.sleep(_EVENT_POLL_SECONDS)
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        # Normal shutdown path: dashboard process exit (Ctrl-C) cancels the
        # websocket task while it is sleeping in the poll loop.
        # CancelledError is a BaseException in 3.8+ so the bare Exception
        # handler below would not catch it; without this clause Uvicorn
        # surfaces the cancellation as an application traceback. Quiet it.
        return
    except Exception as exc:  # defensive: never crash the dashboard worker
        log.warning("Kanban event stream error: %s", exc)
        try:
            await ws.close()
        except Exception:
            pass
