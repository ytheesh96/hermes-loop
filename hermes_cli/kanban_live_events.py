"""Best-effort live event emission for Kanban workers and Loop sources.

The Kanban SQLite tables remain authoritative.  This module only mirrors small,
redacted, invalidation-oriented frames to the dashboard/Desktop live bus when a
publisher URL is available in the process environment.  All functions are
fail-open: live delivery must never affect worker/task state mutations.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:  # Imported lazily in tests; websocket support is optional for non-dashboard runs.
    from tui_gateway.event_publisher import WsPublisherTransport
except Exception:  # pragma: no cover - dependency/import failures are fail-open
    WsPublisherTransport = None  # type: ignore[assignment]

_SCHEMA_VERSION = 1
_PREVIEW_MAX = 500
_SUMMARY_MAX = 2000
_SOURCE_HEARTBEAT_MIN_INTERVAL_S = 30.0
_PROGRESS_MIN_INTERVAL_S = 0.10  # 10/sec per worker bridge

_transport_lock = threading.Lock()
_transport_url: Optional[str] = None
_transport: Any = None
_source_heartbeat_last: dict[tuple[str, str, Optional[int]], float] = {}

_TASK_EVENT_TO_SOURCE_KIND = {
    "created": "task_created",
    "edited": "task_edited",
    "assigned": "task_edited",
    "linked": "task_linked",
    "unlinked": "task_unlinked",
    "promoted": "task_promoted",
    "claimed": "task_claimed",
    "spawned": "run_started",
    "heartbeat": "run_heartbeat",
    "blocked": "task_blocked",
    "unblocked": "task_unblocked",
    "completed": "task_completed",
    "archived": "task_archived",
    "commented": "comment_added",
    "reclaimed": "run_reclaimed",
    "spawn_failed": "run_failed",
    "crashed": "run_failed",
    "timed_out": "run_failed",
    "manual_terminated": "run_failed",
    "failed": "run_failed",
    "gave_up": "run_failed",
    "scheduled": "task_edited",
}

_WORKER_EVENT_BY_TASK_EVENT = {
    "claimed": "kanban.worker.spawn_requested",
    "spawned": "kanban.worker.start",
    "heartbeat": "kanban.worker.heartbeat",
    "completed": "kanban.worker.complete",
    "blocked": "kanban.worker.blocked",
    "reclaimed": "kanban.worker.reclaimed",
    "spawn_failed": "kanban.worker.spawn_failed",
    "crashed": "kanban.worker.crashed",
    "timed_out": "kanban.worker.timed_out",
    "manual_terminated": "kanban.worker.manual_terminated",
    "failed": "kanban.worker.failed",
    "gave_up": "kanban.worker.gave_up",
}


def _event_revision(event_id: Optional[int]) -> Optional[int]:
    if event_id is None:
        return None
    try:
        return int(event_id)
    except Exception:
        return None


def _iso(ts: Optional[int | float] = None) -> str:
    if ts is None:
        ts = time.time()
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _cap_text(value: Any, limit: int = _PREVIEW_MAX) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        from agent.redact import redact_sensitive_text

        text = redact_sensitive_text(text, force=True)
    except Exception:
        pass
    if len(text) > limit:
        text = text[: max(0, limit - 1)] + "…"
    return text


def _publisher_url() -> Optional[str]:
    for key in ("HERMES_KANBAN_EVENT_PUBLISHER_URL", "HERMES_TUI_SIDECAR_URL"):
        val = (os.environ.get(key) or "").strip()
        if val:
            return val
    return None


def _get_transport() -> Any:
    global _transport, _transport_url
    url = _publisher_url()
    if not url or WsPublisherTransport is None:
        return None
    with _transport_lock:
        if _transport is not None and _transport_url == url:
            return _transport
        _transport = WsPublisherTransport(url)
        _transport_url = url
        return _transport


def _publish_frame(frame: dict) -> bool:
    transport = _get_transport()
    if transport is None:
        return False
    try:
        return bool(transport.write(frame))
    except Exception:
        return False


def publish_live_event(event: str, payload: dict, *, session_id: Optional[str] = None) -> bool:
    if not _publisher_url():
        return False
    safe_payload = dict(payload)
    safe_payload.setdefault("schema_version", _SCHEMA_VERSION)
    safe_payload.setdefault("event", event)
    safe_payload.setdefault("event_id", uuid.uuid4().hex)
    safe_payload.setdefault("created_at", _iso())
    sid = session_id or str(
        safe_payload.get("worker_session_id")
        or safe_payload.get("source_session_id")
        or safe_payload.get("root_session_id")
        or "kanban"
    )
    frame = {
        "jsonrpc": "2.0",
        "method": "event",
        "params": {"type": event, "session_id": sid, "payload": safe_payload},
    }
    return _publish_frame(frame)


def emit_session_message_appended(
    *,
    session_id: str,
    message_id: Optional[int] = None,
    role: str = "user",
    observed: bool = False,
    reason: Optional[str] = None,
    profile: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> bool:
    """Notify live clients that a durable SessionDB message was appended externally.

    Some background paths append an ``observed`` user message directly to the
    target conversation's state.db instead of flowing through the active gateway
    turn stream. The DB write is authoritative, but the Desktop runtime only
    repaints when it sees gateway events. This small invalidation event nudges
    live clients to refetch the session transcript.
    session.
    """
    sid = str(session_id or "").strip()
    if not sid:
        return False
    payload: dict[str, Any] = {
        "schema_version": _SCHEMA_VERSION,
        "event": "session.message.appended",
        "stored_session_id": sid,
        "session_id": sid,
        "role": str(role or ""),
        "observed": bool(observed),
        "created_at": _iso(),
    }
    if message_id is not None:
        try:
            payload["message_id"] = int(message_id)
        except Exception:
            payload["message_id"] = message_id
    if reason:
        payload["reason"] = str(reason)
    if profile:
        payload["profile"] = str(profile)
    if metadata:
        payload.update(metadata)
    return publish_live_event("session.message.appended", payload, session_id=sid)


def _board_slug(explicit: Optional[str] = None) -> str:
    if explicit:
        return str(explicit)
    return (os.environ.get("HERMES_KANBAN_BOARD") or "default").strip() or "default"


def _run_for_task(conn: Any, run_id: Optional[int], task: Any) -> Any:
    rid = run_id or getattr(task, "current_run_id", None)
    if rid is None:
        return None
    try:
        return conn.execute("SELECT * FROM task_runs WHERE id = ?", (int(rid),)).fetchone()
    except Exception:
        return None


def _metadata_from_run(run: Any) -> dict:
    if not run:
        return {}
    try:
        raw = run["metadata"]
    except Exception:
        raw = None
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _run_value(run: Any, key: str) -> Any:
    if not run:
        return None
    try:
        return run[key]
    except Exception:
        return getattr(run, key, None)


def _worker_session_id(payload: Optional[dict], run: Any = None) -> Optional[str]:
    value = None
    if isinstance(payload, dict):
        value = payload.get("worker_session_id")
    if not value:
        value = _metadata_from_run(run).get("worker_session_id")
    if not value:
        value = os.environ.get("HERMES_SESSION_ID")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _worker_current_tool(payload: Optional[dict] = None, run: Any = None) -> Optional[str]:
    metadata = _metadata_from_run(run)
    sources = (payload if isinstance(payload, dict) else {}, metadata)
    for source in sources:
        for key in ("current_tool", "currentTool", "current_tool_name", "tool_name", "last_tool"):
            value = source.get(key) if isinstance(source, dict) else None
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
    return None


def _session_lineage_ids(session_id: Optional[str]) -> list[str]:
    sid = str(session_id or "").strip()
    if not sid:
        return []
    try:
        from hermes_state import DEFAULT_DB_PATH, SessionDB
    except Exception:
        return [sid]
    try:
        if not DEFAULT_DB_PATH.exists():
            return [sid]
        db = SessionDB(read_only=True)
    except Exception:
        return [sid]
    try:
        lineage = db.get_compression_lineage_root_to_tip(sid)
        return lineage or [sid]
    except Exception:
        return [sid]
    finally:
        try:
            db.close()
        except Exception:
            pass


def _session_identity_payload(source_session_id: Optional[str]) -> dict:
    lineage = _session_lineage_ids(source_session_id)
    out: dict[str, Any] = {}
    if source_session_id:
        out["source_session_id"] = str(source_session_id)
    if lineage:
        out["lineage_session_ids"] = lineage
        out["logical_session_id"] = lineage[0]
        out["root_session_id"] = lineage[0]
        out["current_session_id"] = lineage[-1]
    return out


def _task_session_payload(task: Any) -> dict:
    source_session_id = getattr(task, "session_id", None) or getattr(task, "tenant", None)
    return _session_identity_payload(source_session_id)


def _publish_session_id(payload: dict) -> Optional[str]:
    for key in ("current_session_id", "source_session_id", "logical_session_id", "worker_session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _task_link_payload(conn: Any, task_id: str) -> dict:
    try:
        parents = [
            str(r["parent_id"])
            for r in conn.execute(
                "SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id",
                (task_id,),
            )
        ]
        children = [
            str(r["child_id"])
            for r in conn.execute(
                "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
                (task_id,),
            )
        ]
    except Exception:
        parents = []
        children = []
    return {
        "child_task_ids": children,
        # Legacy render hint only. Workflow identity comes from workflow_id.
        "is_root_task": len(parents) == 0,
        "parent_task_ids": parents,
    }


def _task_row_payload(task: Any, *, board: Optional[str]) -> dict:
    row = {
        "id": getattr(task, "id", ""),
        "task_id": getattr(task, "id", ""),
        "title": getattr(task, "title", ""),
        "status": getattr(task, "status", ""),
        "priority": getattr(task, "priority", None),
        "assignee": getattr(task, "assignee", None),
        "tenant": getattr(task, "tenant", None),
        "board": _board_slug(board),
        "workflow_id": getattr(task, "workflow_id", None),
        "workspace_kind": getattr(task, "workspace_kind", None),
        "current_run_id": getattr(task, "current_run_id", None),
        "source_session_id": getattr(task, "session_id", None),
    }
    for attr in ("created_at", "started_at", "completed_at", "last_heartbeat_at", "claim_expires"):
        value = getattr(task, attr, None)
        if value:
            row[attr] = _iso(value)
    if getattr(task, "workspace_path", None):
        row["workspace_path_preview"] = _cap_text(str(getattr(task, "workspace_path")))
    if getattr(task, "last_failure_error", None):
        row["last_failure_error_preview"] = _cap_text(getattr(task, "last_failure_error"), 1000)
    row.update(_task_session_payload(task))
    return row


def _task_event_payload(
    *,
    task_id: str,
    kind: str,
    run_id: Optional[int],
    event_id: Optional[int],
    created_at: Optional[int],
) -> dict:
    out = {
        "id": _event_revision(event_id),
        "revision": _event_revision(event_id),
        "task_id": task_id,
        "kind": kind,
        "run_id": int(run_id) if run_id is not None else None,
        "created_at": _iso(created_at),
    }
    return out


def _loopagent_task_upsert_payload(
    conn: Any,
    task: Any,
    *,
    kind: str,
    payload: Optional[dict],
    event_id: Optional[int],
    run_id: Optional[int],
    board: Optional[str],
    created_at: Optional[int],
) -> dict:
    task_id = getattr(task, "id", "")
    revision = _event_revision(event_id)
    # Fetching the run is handled by worker upserts; task upserts stay cheap and
    # useful for optimistic row updates from any task_events append.
    out = {
        "schema_version": _SCHEMA_VERSION,
        "event": "loopagent.task.upsert",
        "board": _board_slug(board),
        "tenant": getattr(task, "tenant", None),
        "workflow_id": getattr(task, "workflow_id", None),
        "task_id": task_id,
        "run_id": int(run_id) if run_id is not None else None,
        "source_session_id": getattr(task, "session_id", None),
        "worker_session_id": _worker_session_id(payload),
        "task_title": getattr(task, "title", ""),
        "task_status": getattr(task, "status", ""),
        "latest_task_event_id": revision,
        "latest_task_event_revision": revision,
        "latest_task_event_kind": kind,
        "created_at": _iso(created_at),
        "task": _task_row_payload(task, board=board),
        "latest_task_event": _task_event_payload(
            task_id=task_id,
            kind=kind,
            run_id=run_id,
            event_id=event_id,
            created_at=created_at,
        ),
    }
    out.update(_task_link_payload(conn, task_id))
    out.update(_task_session_payload(task))
    return out


def _worker_row_payload(
    task: Any,
    run: Any,
    worker_payload: dict,
    *,
    board: Optional[str],
    kind: str,
    event_id: Optional[int],
    created_at: Optional[int],
) -> dict:
    row = {
        "workflow_id": getattr(task, "workflow_id", None),
        "task_id": getattr(task, "id", ""),
        "run_id": worker_payload.get("run_id"),
        "status": worker_payload.get("run_status") or _run_value(run, "status"),
        "outcome": worker_payload.get("outcome") or _run_value(run, "outcome"),
        "profile": worker_payload.get("profile") or _run_value(run, "profile"),
        "worker_session_id": worker_payload.get("worker_session_id"),
        "worker_pid": _run_value(run, "worker_pid") or getattr(task, "worker_pid", None),
        "latest_event_id": _event_revision(event_id),
        "latest_event_kind": kind,
        "recent_task_events": [
            _task_event_payload(
                task_id=getattr(task, "id", ""),
                kind=kind,
                run_id=worker_payload.get("run_id"),
                event_id=event_id,
                created_at=created_at,
            )
        ],
    }
    for src, dest in (
        ("started_at", "started_at"),
        ("ended_at", "ended_at"),
        ("last_heartbeat_at", "last_heartbeat_at"),
        ("claim_expires", "claim_expires"),
    ):
        value = _run_value(run, src)
        if value:
            row[dest] = _iso(value)
    if worker_payload.get("safe_summary"):
        row["summary_preview"] = worker_payload["safe_summary"]
    if worker_payload.get("error_preview"):
        row["error_preview"] = worker_payload["error_preview"]
    if worker_payload.get("block_reason"):
        row["block_reason"] = worker_payload["block_reason"]
    if worker_payload.get("heartbeat_note"):
        row["heartbeat_note"] = worker_payload["heartbeat_note"]
    if worker_payload.get("workspace_kind"):
        row["workspace_kind"] = worker_payload["workspace_kind"]
    if worker_payload.get("workspace_path_preview"):
        row["workspace_path_preview"] = worker_payload["workspace_path_preview"]
    if worker_payload.get("current_tool"):
        row["current_tool"] = worker_payload["current_tool"]
    row["board"] = _board_slug(board)
    return row


def _loopagent_worker_upsert_payload(
    conn: Any,
    task: Any,
    *,
    worker_payload: dict,
    kind: str,
    payload: Optional[dict],
    event_id: Optional[int],
    run_id: Optional[int],
    board: Optional[str],
    created_at: Optional[int],
) -> dict:
    revision = _event_revision(event_id)
    run = _run_for_task(conn, run_id, task)
    worker_session_id = worker_payload.get("worker_session_id") or _worker_session_id(payload, run)
    out = {
        "schema_version": _SCHEMA_VERSION,
        "event": "loopagent.worker.upsert",
        "board": _board_slug(board),
        "tenant": getattr(task, "tenant", None),
        "workflow_id": getattr(task, "workflow_id", None),
        "task_id": getattr(task, "id", ""),
        "run_id": int(run_id) if run_id is not None else worker_payload.get("run_id"),
        "source_session_id": getattr(task, "session_id", None),
        "worker_session_id": worker_session_id,
        "task_title": getattr(task, "title", ""),
        "task_status": getattr(task, "status", ""),
        "run_status": worker_payload.get("run_status"),
        "outcome": worker_payload.get("outcome"),
        "latest_task_event_id": revision,
        "latest_task_event_revision": revision,
        "latest_task_event_kind": kind,
        "created_at": _iso(created_at),
        "task": _task_row_payload(task, board=board),
        "worker": _worker_row_payload(
            task,
            run,
            {**worker_payload, "worker_session_id": worker_session_id},
            board=board,
            kind=kind,
            event_id=event_id,
            created_at=created_at,
        ),
    }
    for key in (
        "current_tool",
        "safe_summary",
        "safe_preview",
        "error_preview",
        "block_reason",
        "heartbeat_note",
        "review_required",
        "tests_run",
        "tests_passed",
        "changed_files_preview",
        "artifacts_preview",
    ):
        if key in worker_payload:
            out[key] = worker_payload[key]
    out.update(_task_session_payload(task))
    return out


def _worker_base_payload(
    conn: Any,
    task: Any,
    *,
    event: str,
    board: Optional[str],
    run_id: Optional[int],
    created_at: Optional[int] = None,
) -> dict:
    run = _run_for_task(conn, run_id, task)
    metadata = _metadata_from_run(run)
    effective_run_id = run_id or getattr(task, "current_run_id", None)
    profile = getattr(task, "assignee", None) or os.environ.get("HERMES_PROFILE") or ""
    run_status = "running"
    outcome = None
    run_started_at = None
    completed_at = getattr(task, "completed_at", None)
    if run:
        try:
            run_status = str(run["status"] or run_status)
            outcome = run["outcome"]
            run_started_at = run["started_at"]
            completed_at = run["ended_at"] or completed_at
        except Exception:
            pass
    payload = {
        "schema_version": _SCHEMA_VERSION,
        "event": event,
        "board": _board_slug(board),
        "tenant": getattr(task, "tenant", None),
        "task_id": getattr(task, "id", ""),
        "run_id": int(effective_run_id) if effective_run_id is not None else None,
        "profile": str(profile),
        "task_title": getattr(task, "title", ""),
        "task_status": getattr(task, "status", ""),
        "run_status": run_status,
        "created_at": _iso(created_at),
    }
    if outcome:
        payload["outcome"] = outcome
    if getattr(task, "created_at", None):
        payload["task_created_at"] = _iso(getattr(task, "created_at"))
    if run_started_at:
        payload["run_started_at"] = _iso(run_started_at)
    if completed_at:
        payload["completed_at"] = _iso(completed_at)
    session_id = getattr(task, "session_id", None)
    if session_id:
        payload["source_session_id"] = session_id
    worker_session_id = metadata.get("worker_session_id") or os.environ.get("HERMES_SESSION_ID")
    if isinstance(worker_session_id, str) and worker_session_id.strip():
        payload["worker_session_id"] = worker_session_id.strip()
    return payload


def _source_payload(
    task: Any,
    *,
    kind: str,
    payload: Optional[dict],
    event_id: Optional[int],
    run_id: Optional[int],
    board: Optional[str],
    created_at: Optional[int],
) -> Optional[dict]:
    changed = _TASK_EVENT_TO_SOURCE_KIND.get(kind)
    if not changed:
        return None
    if changed == "run_heartbeat":
        key = (_board_slug(board), getattr(task, "id", ""), run_id)
        now = time.monotonic()
        last = _source_heartbeat_last.get(key, 0.0)
        if now - last < _SOURCE_HEARTBEAT_MIN_INTERVAL_S:
            return None
        _source_heartbeat_last[key] = now
    out = {
        "schema_version": _SCHEMA_VERSION,
        "event": "loop.source_changed",
        "board": _board_slug(board),
        "tenant": getattr(task, "tenant", None),
        "source": "kanban",
        "affected_task_ids": [getattr(task, "id", "")],
        "changed_kinds": [changed],
        "created_at": _iso(created_at),
        "safe_summary": _cap_text(f"Task {getattr(task, 'id', '')} changed; invalidate Loop source caches"),
    }
    session_id = getattr(task, "session_id", None)
    if session_id:
        out["source_session_id"] = session_id
    out.update(_task_session_payload(task))
    if event_id is not None:
        out["latest_task_event_id"] = int(event_id)
    if run_id is not None:
        out["affected_run_ids"] = [int(run_id)]
        out["latest_run_id"] = int(run_id)
    worker_session_id = None
    if isinstance(payload, dict):
        worker_session_id = payload.get("worker_session_id")
    if not worker_session_id:
        worker_session_id = os.environ.get("HERMES_SESSION_ID")
    if isinstance(worker_session_id, str) and worker_session_id.strip():
        out["worker_session_id"] = worker_session_id.strip()
    return out


def _terminal_worker_payload(
    conn: Any,
    task: Any,
    *,
    event: str,
    kind: str,
    payload: Optional[dict],
    run_id: Optional[int],
    board: Optional[str],
    created_at: Optional[int],
) -> dict:
    out = _worker_base_payload(conn, task, event=event, board=board, run_id=run_id, created_at=created_at)
    current_tool = _worker_current_tool(payload, _run_for_task(conn, run_id, task))
    if current_tool:
        out["current_tool"] = current_tool
    if kind == "completed":
        out["run_status"] = "completed"
        out["outcome"] = "completed"
        summary = payload.get("summary") if isinstance(payload, dict) else None
        if summary:
            out["safe_summary"] = _cap_text(summary, _SUMMARY_MAX)
        run = _run_for_task(conn, run_id, task)
        md = _metadata_from_run(run)
        for key in ("tests_run", "tests_passed"):
            if isinstance(md.get(key), int):
                out[key] = int(md[key])
        if isinstance(md.get("changed_files"), list):
            out["changed_files_preview"] = [str(x) for x in md["changed_files"][:100]]
        if isinstance(md.get("artifacts"), list):
            out["artifacts_preview"] = [str(x) for x in md["artifacts"][:100]]
    elif kind == "blocked":
        out["run_status"] = "blocked"
        out["outcome"] = "blocked"
        reason = payload.get("reason") if isinstance(payload, dict) else None
        out["block_reason"] = _cap_text(reason, 1000) or "blocked"
        out["review_required"] = out["block_reason"].lower().startswith("review-required:")
    elif kind == "heartbeat":
        out["run_status"] = "running"
        note = payload.get("note") if isinstance(payload, dict) else None
        if note:
            out["heartbeat_note"] = _cap_text(note)
        if getattr(task, "last_heartbeat_at", None):
            out["last_activity_at"] = _iso(getattr(task, "last_heartbeat_at"))
        if getattr(task, "worker_pid", None) is not None:
            out["pid_alive"] = True
    elif kind == "claimed":
        out["run_status"] = "spawning"
        out["safe_preview"] = _cap_text(f"Dispatcher claimed task and is spawning {out.get('profile')} worker")
        out["workspace_kind"] = getattr(task, "workspace_kind", "scratch")
        if getattr(task, "workspace_path", None):
            out["workspace_path_preview"] = _cap_text(str(getattr(task, "workspace_path")))
    elif kind == "spawned":
        out["run_status"] = "running"
        out["workspace_kind"] = getattr(task, "workspace_kind", "scratch")
        if isinstance(payload, dict) and payload.get("pid") is not None:
            try:
                out["pid_preview"] = int(payload["pid"])
            except Exception:
                pass
        out["safe_preview"] = "Worker session started"
    else:
        outcome = event.rsplit(".", 1)[-1]
        out["outcome"] = outcome
        out["run_status"] = "reclaimed" if outcome == "reclaimed" else ("terminated" if outcome == "manual_terminated" else "failed")
        if isinstance(payload, dict):
            err = payload.get("error") or payload.get("reason") or payload.get("summary")
            if err:
                out["error_preview"] = _cap_text(err)
            if payload.get("exit_code") is not None:
                try:
                    out["exit_code"] = int(payload["exit_code"])
                except Exception:
                    pass
        out.setdefault("safe_preview", _cap_text(f"Worker {out['run_status']}: {out.get('outcome') or kind}"))
    return out


def emit_for_task_event(
    conn: Any,
    *,
    task_id: str,
    kind: str,
    payload: Optional[dict],
    run_id: Optional[int],
    event_row_id: Optional[int],
    created_at: Optional[int],
    board: Optional[str] = None,
) -> None:
    """Mirror a durable task_events append to best-effort live events."""
    if not _publisher_url():
        return
    try:
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if task is None:
            return
        # Convert sqlite.Row to the public Task dataclass when available so
        # field access below is uniform and schema migrations stay centralized.
        try:
            from hermes_cli.kanban_db import Task

            task_obj = Task.from_row(task)
        except Exception:
            task_obj = task
        source = _source_payload(task_obj, kind=kind, payload=payload, event_id=event_row_id, run_id=run_id, board=board, created_at=created_at)
        if source:
            publish_live_event("loop.source_changed", source, session_id=source.get("source_session_id"))
            task_upsert = _loopagent_task_upsert_payload(
                conn,
                task_obj,
                kind=kind,
                payload=payload,
                event_id=event_row_id,
                run_id=run_id,
                board=board,
                created_at=created_at,
            )
            publish_live_event("loopagent.task.upsert", task_upsert, session_id=_publish_session_id(task_upsert))
        worker_event = _WORKER_EVENT_BY_TASK_EVENT.get(kind)
        if worker_event and run_id is not None:
            worker_payload = _terminal_worker_payload(
                conn,
                task_obj,
                event=worker_event,
                kind=kind,
                payload=payload,
                run_id=run_id,
                board=board,
                created_at=created_at,
            )
            if worker_payload.get("run_id") is not None:
                publish_live_event(worker_event, worker_payload, session_id=worker_payload.get("worker_session_id"))
                worker_upsert = _loopagent_worker_upsert_payload(
                    conn,
                    task_obj,
                    worker_payload=worker_payload,
                    kind=kind,
                    payload=payload,
                    event_id=event_row_id,
                    run_id=run_id,
                    board=board,
                    created_at=created_at,
                )
                publish_live_event("loopagent.worker.upsert", worker_upsert, session_id=_publish_session_id(worker_upsert))
    except Exception:
        return


@dataclass
class KanbanWorkerEventBridge:
    task_id: str
    run_id: int
    board: str
    profile: str
    tenant: Optional[str] = None
    task_title: str = ""
    task_status: str = "running"
    worker_session_id: Optional[str] = None
    source_session_id: Optional[str] = None
    sequence: int = 0
    _tool_started_at: dict[str, float] = field(default_factory=dict)
    _last_progress_at: float = 0.0

    @classmethod
    def from_env(
        cls,
        *,
        task_id: Optional[str] = None,
        run_id: Optional[int] = None,
        board: Optional[str] = None,
        profile: Optional[str] = None,
        worker_session_id: Optional[str] = None,
    ) -> Optional["KanbanWorkerEventBridge"]:
        tid = task_id or os.environ.get("HERMES_KANBAN_TASK")
        rid = run_id or os.environ.get("HERMES_KANBAN_RUN_ID")
        if not tid or rid is None:
            return None
        try:
            rid_i = int(rid)
        except Exception:
            return None
        return cls(
            task_id=str(tid),
            run_id=rid_i,
            board=_board_slug(board),
            profile=profile or os.environ.get("HERMES_PROFILE") or "",
            tenant=os.environ.get("HERMES_TENANT") or None,
            worker_session_id=worker_session_id or os.environ.get("HERMES_SESSION_ID") or None,
        )

    def _base(self, event: str) -> dict:
        self.sequence += 1
        out = {
            "schema_version": _SCHEMA_VERSION,
            "event": event,
            "sequence": self.sequence,
            "board": self.board,
            "tenant": self.tenant,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "profile": self.profile,
            "task_title": self.task_title,
            "task_status": self.task_status,
            "run_status": "running",
            "created_at": _iso(),
        }
        if self.worker_session_id:
            out["worker_session_id"] = self.worker_session_id
        if self.source_session_id:
            out["source_session_id"] = self.source_session_id
        out.update(_session_identity_payload(self.source_session_id or self.tenant))
        return out

    def emit(self, event: str, fields: dict) -> bool:
        payload = self._base(event)
        payload.update(fields)
        delivered = publish_live_event(event, payload, session_id=self.worker_session_id)
        loopagent_payload = dict(payload)
        loopagent_payload["event"] = "loopagent.worker.upsert"
        if loopagent_payload.get("tool_name") and not loopagent_payload.get("current_tool"):
            loopagent_payload["current_tool"] = loopagent_payload["tool_name"]
        if loopagent_payload.get("tool_preview") and not loopagent_payload.get("summary_preview"):
            loopagent_payload["summary_preview"] = loopagent_payload["tool_preview"]
        if loopagent_payload.get("progress_text") and not loopagent_payload.get("summary_preview"):
            loopagent_payload["summary_preview"] = loopagent_payload["progress_text"]
        publish_live_event("loopagent.worker.upsert", loopagent_payload, session_id=_publish_session_id(loopagent_payload))
        return delivered

    def tool_start(self, tool_call_id: str, name: str, args: Optional[dict]) -> bool:
        self._tool_started_at[str(tool_call_id)] = time.monotonic()
        fields = {"tool_call_id": str(tool_call_id), "tool_name": str(name)}
        preview = _tool_context(name, args or {})
        if preview:
            fields["tool_context"] = preview
        return self.emit("kanban.worker.tool_start", fields)

    def tool_progress(self, event_type: str, name: Optional[str] = None, preview: Optional[str] = None, args: Optional[dict] = None, **kwargs: Any) -> bool:
        now = time.monotonic()
        if now - self._last_progress_at < _PROGRESS_MIN_INTERVAL_S:
            return False
        self._last_progress_at = now
        if event_type == "reasoning.available":
            return self.thinking(preview or "")
        text = _cap_text(preview or kwargs.get("text") or event_type)
        if not text:
            return False
        fields: dict[str, Any] = {"progress_text": text}
        if name:
            fields["tool_name"] = str(name)
        for src, dest in (("current", "progress_current"), ("total", "progress_total"), ("unit", "unit")):
            if kwargs.get(src) is not None:
                fields[dest] = kwargs[src]
        return self.emit("kanban.worker.tool_progress", fields)

    def tool_complete(self, tool_call_id: str, name: str, args: Optional[dict], result: Any) -> bool:
        fields: dict[str, Any] = {"tool_call_id": str(tool_call_id), "tool_name": str(name)}
        started = self._tool_started_at.pop(str(tool_call_id), None)
        if started is not None:
            fields["duration_s"] = round(max(0.0, time.monotonic() - started), 3)
        result_text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        fields["result_size_bytes"] = len(result_text.encode("utf-8", "replace"))
        try:
            data = json.loads(result_text)
        except Exception:
            data = None
        if isinstance(data, dict):
            if data.get("exit_code") is not None:
                try:
                    fields["exit_code"] = int(data["exit_code"])
                    fields["success"] = fields["exit_code"] == 0
                except Exception:
                    pass
            elif data.get("ok") is not None:
                fields["success"] = bool(data.get("ok"))
        summary = _safe_tool_summary(name, data, result_text)
        if summary:
            fields["tool_preview"] = summary
        return self.emit("kanban.worker.tool_complete", fields)

    def progress(self, text: str, *, phase: str = "other") -> bool:
        capped = _cap_text(text)
        if not capped:
            return False
        return self.emit("kanban.worker.progress", {"phase": phase, "progress_text": capped})

    def thinking(self, text: str) -> bool:
        capped = _cap_text(text)
        if not capped:
            return False
        return self.emit("kanban.worker.thinking", {"text": capped, "redacted": capped != str(text).strip()})


def _tool_context(name: str, args: dict) -> Optional[str]:
    try:
        from agent.display import build_tool_preview

        return _cap_text(build_tool_preview(name, args, max_len=120) or "")
    except Exception:
        for key in ("path", "url", "command", "task_id"):
            if args.get(key):
                return _cap_text(Path(str(args[key])).name if key == "path" else str(args[key]))
    return None


def _safe_tool_summary(name: str, data: Any, result_text: str) -> Optional[str]:
    if isinstance(data, dict):
        if name == "terminal" and data.get("exit_code") is not None:
            return _cap_text(f"terminal exited {data.get('exit_code')}")
        if data.get("ok") is True:
            return _cap_text(f"{name} completed")
        if data.get("error"):
            return _cap_text(f"{name} error: {data.get('error')}")
    if len(result_text) > _PREVIEW_MAX:
        return _cap_text(f"{name} completed; result {len(result_text)} chars")
    return _cap_text(f"{name} completed")
