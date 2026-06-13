"""Triage-backed Loop graph API.

This module stores the Loop graph as real Kanban ``triage`` tasks plus
``task_links`` dependency edges.  The model/tool surface intentionally stays
compact: one mutation/read entry point with revision and mutation-id guards.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Optional

from hermes_cli import kanban_db as kb

LOOP_EVENT_KIND = "loop_mutation"
LOOP_NODE_EVENT_KIND = "loop_node_state"
LOOP_HANDOFF_EVENT_KIND = "loop_foreground_handoff"
LOOP_HANDOFF_RESOLUTION_EVENT_KIND = "loop_foreground_handoff_resolution"
_SAFE_MUTATION_STATUSES = {"triage"}
_DONE_LIKE = {"done", "archived"}
_ALLOWED_HANDOFF_VERIFICATION_STATES = {"approved", "rejected", "needs-user", "done"}
_ALLOWED_HANDOFF_ATTENTION = {None, "needs-orchestrator", "needs-user"}


class LoopError(Exception):
    def __init__(self, code: str, message: str, *, current_revision: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.current_revision = current_revision


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS loop_mutations (
            root_task_id TEXT NOT NULL,
            mutation_id  TEXT NOT NULL,
            result_json  TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (root_task_id, mutation_id)
        )
        """
    )


def graph_revision(conn: sqlite3.Connection, root_task_id: str) -> int:
    ensure_schema(conn)
    row = conn.execute(
        """
        SELECT MAX(e.id) AS rev
          FROM task_events e
          JOIN tasks t ON t.id = e.task_id
         WHERE t.created_by = ?
        """,
        (f"loop:{root_task_id}",),
    ).fetchone()
    return int(row["rev"] or 0) if row else 0


def _append_graph_event(
    conn: sqlite3.Connection,
    root_task_id: str,
    task_ids: list[str],
    payload: dict[str, Any],
) -> int:
    """Append a mutation event to a real Loop task; no container/root row exists."""
    target_id = next((task_id for task_id in task_ids if task_id), None)
    if not target_id:
        return graph_revision(conn, root_task_id)
    now = int(time.time())
    conn.execute(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
        "VALUES (?, NULL, ?, ?, ?)",
        (target_id, LOOP_EVENT_KIND, json.dumps(payload, ensure_ascii=False), now),
    )
    return int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])


def _append_node_event(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    root_task_id: str,
    active: Optional[bool] = None,
    frontier: Optional[bool] = None,
    client_id: Optional[str] = None,
) -> None:
    payload: dict[str, Any] = {"root_task_id": root_task_id}
    if active is not None:
        payload["active"] = bool(active)
    if frontier is not None:
        payload["frontier"] = bool(frontier)
    if client_id:
        payload["client_id"] = client_id
    kb._append_event(conn, task_id, LOOP_NODE_EVENT_KIND, payload)


def _task_or_error(conn: sqlite3.Connection, task_id: str):
    task = kb.get_task(conn, task_id)
    if task is None:
        raise LoopError("not_found", f"unknown task {task_id}")
    return task


def _assert_loop_identity(root_task_id: str) -> str:
    root_task_id = str(root_task_id or "").strip()
    if not root_task_id:
        raise LoopError("validation_failed", "root_task_id is required")
    return root_task_id


def _assert_safe_node(task) -> None:
    if task.status not in _SAFE_MUTATION_STATUSES:
        raise LoopError(
            "unsafe_status",
            f"refusing to mutate {task.id}: status {task.status!r} is not triage",
        )


def _assert_loop_node(conn: sqlite3.Connection, task_id: str, root_task_id: str):
    task = _task_or_error(conn, task_id)
    _assert_safe_node(task)
    if task.created_by != f"loop:{root_task_id}":
        raise LoopError(
            "wrong_root",
            f"refusing to mutate {task_id}: not a Loop node for root {root_task_id}",
        )
    return task


def _canonical_parent_ids(client_to_task: dict[str, str], parents: Any) -> list[str]:
    if parents is None:
        return []
    if not isinstance(parents, list):
        raise LoopError("validation_failed", "parents must be a list")
    out: list[str] = []
    for item in parents:
        pid = str(item).strip()
        if not pid:
            continue
        out.append(client_to_task.get(pid, pid))
    return out


def _assert_loop_parent_ids(conn: sqlite3.Connection, parent_ids: list[str], root_task_id: str) -> None:
    missing = kb._find_missing_parents(conn, parent_ids)
    if missing:
        raise LoopError("validation_failed", f"unknown parent task(s): {', '.join(missing)}")
    for parent_id in parent_ids:
        _assert_loop_node(conn, parent_id, root_task_id)


def _provenance_body(
    body: Optional[str],
    *,
    root_task_id: str,
    client_id: Optional[str],
    suggested_owner: Optional[str],
) -> str:
    parts: list[str] = []
    if body and str(body).strip():
        parts.append(str(body).strip())
    prov = ["Loop provenance:", f"root_task_id: {root_task_id}"]
    if client_id:
        prov.append(f"draft_node: {client_id}")
    if suggested_owner:
        prov.append(f"suggested_owner: {suggested_owner}")
    parts.append("\n".join(prov))
    return "\n\n".join(parts)


def _create_triage_task_in_txn(
    conn: sqlite3.Connection,
    *,
    title: str,
    body: str,
    root_task_id: str,
    tenant: Optional[str],
    parents: list[str],
    idempotency_key: Optional[str],
) -> str:
    """Create a Loop triage row inside the caller's write transaction."""
    if idempotency_key:
        existing = conn.execute(
            "SELECT id FROM tasks WHERE idempotency_key = ? AND status != 'archived' "
            "ORDER BY created_at DESC LIMIT 1",
            (idempotency_key,),
        ).fetchone()
        if existing:
            return existing["id"]
    missing = kb._find_missing_parents(conn, parents)
    if missing:
        raise LoopError("validation_failed", f"unknown parent task(s): {', '.join(missing)}")
    now = int(time.time())
    task_id = kb._new_task_id()
    conn.execute(
        """
        INSERT INTO tasks (
            id, title, body, assignee, status, priority,
            created_by, created_at, workspace_kind, workspace_path,
            branch_name, tenant, idempotency_key, max_runtime_seconds,
            skills, max_retries, goal_mode, goal_max_turns, session_id
        ) VALUES (?, ?, ?, NULL, 'triage', 0, ?, ?, 'scratch', NULL, NULL, ?, ?, NULL, NULL, NULL, 0, NULL, ?)
        """,
        (
            task_id,
            title,
            body,
            f"loop:{root_task_id}",
            now,
            tenant,
            idempotency_key,
            os.environ.get("HERMES_SESSION_ID"),
        ),
    )
    for parent_id in parents:
        conn.execute(
            "INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)",
            (parent_id, task_id),
        )
    kb._append_event(
        conn,
        task_id,
        "created",
        {
            "assignee": None,
            "status": "triage",
            "parents": list(parents),
            "tenant": tenant,
            "source": "loop",
            "root_task_id": root_task_id,
        },
    )
    return task_id


def _graph_task_rows(conn: sqlite3.Connection, root_task_id: str) -> list[sqlite3.Row]:
    created_by = f"loop:{root_task_id}"
    rows = conn.execute(
        "SELECT * FROM tasks WHERE created_by = ? ORDER BY created_at ASC, id ASC",
        (created_by,),
    ).fetchall()
    return list(rows)


def _graph_task_ids(conn: sqlite3.Connection, root_task_id: str) -> set[str]:
    return {row["id"] for row in _graph_task_rows(conn, root_task_id)}


def _latest_node_flags(conn: sqlite3.Connection, task_ids: set[str], root_task_id: str) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"SELECT task_id, payload FROM task_events "
        f"WHERE kind = ? AND task_id IN ({placeholders}) ORDER BY id ASC",
        (LOOP_NODE_EVENT_KIND, *task_ids),
    ).fetchall()
    flags: dict[str, dict[str, Any]] = {tid: {"active": False, "frontier": False} for tid in task_ids}
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except Exception:
            continue
        if payload.get("root_task_id") != root_task_id:
            continue
        state = flags.setdefault(row["task_id"], {"active": False, "frontier": False})
        if "active" in payload:
            state["active"] = bool(payload["active"])
        if "frontier" in payload:
            state["frontier"] = bool(payload["frontier"])
        if payload.get("client_id"):
            state["client_id"] = payload["client_id"]
    return flags


def _event_payload(row: sqlite3.Row) -> dict[str, Any]:
    try:
        payload = json.loads(row["payload"] or "{}")
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _compact_handoff(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    handoff: dict[str, Any] = {
        "task_id": task_id,
        "handoff_kind": payload.get("handoff_kind"),
        "attention": payload.get("attention"),
        "verification_state": payload.get("verification_state"),
    }
    if "run_id" in payload:
        handoff["run_id"] = payload.get("run_id")
    for key in (
        "handoff_id",
        "state",
        "source_event_id",
        "worker_profile",
        "originating_session_id",
        "summary",
        "reason",
        "worker_session_id",
        "artifacts",
        "changed_files",
        "created_cards",
        "review_task_id",
        "review_run_id",
        "reviewer_session_id",
        "review_batch_id",
        "decision_actor",
        "decision_reason",
        "resolution_summary",
        "created_at",
        "updated_at",
        "resolved_at",
    ):
        if key in payload:
            handoff[key] = payload[key]
    return handoff


def _durable_handoff_payloads_for_tasks(
    conn: sqlite3.Connection,
    task_ids: set[str],
    root_task_id: str,
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    try:
        rows = conn.execute(
            f"""
            SELECT *
              FROM loop_handoffs
             WHERE root_task_id = ?
               AND task_id IN ({placeholders})
             ORDER BY updated_at ASC, id ASC
            """,
            (root_task_id, *task_ids),
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    payloads: dict[str, dict[str, Any]] = {}
    for row in rows:
        handoff = kb._loop_handoff_row_to_dict(row)
        task_id = handoff["task_id"]
        payloads[task_id] = {
            "handoff_id": handoff["id"],
            "root_task_id": handoff["root_task_id"],
            "task_id": task_id,
            "run_id": handoff.get("run_id"),
            "source_event_id": handoff.get("source_event_id"),
            "handoff_kind": handoff.get("handoff_kind"),
            "state": handoff.get("state"),
            "attention": handoff.get("attention"),
            "verification_state": handoff.get("verification_state"),
            "worker_profile": handoff.get("worker_profile"),
            "worker_session_id": handoff.get("worker_session_id"),
            "originating_session_id": handoff.get("originating_session_id"),
            "summary": handoff.get("summary"),
            "reason": handoff.get("reason"),
            "artifacts": handoff.get("artifacts", []),
            "changed_files": handoff.get("changed_files", []),
            "created_cards": handoff.get("created_cards", []),
            "review_task_id": handoff.get("review_task_id"),
            "review_run_id": handoff.get("review_run_id"),
            "reviewer_session_id": handoff.get("reviewer_session_id"),
            "review_batch_id": handoff.get("review_batch_id"),
            "decision_actor": handoff.get("decision_actor"),
            "decision_reason": handoff.get("decision_reason"),
            "resolution_summary": handoff.get("resolution_summary"),
            "created_at": handoff.get("created_at"),
            "updated_at": handoff.get("updated_at"),
            "resolved_at": handoff.get("resolved_at"),
        }
    return payloads


def _latest_handoffs_for_tasks(
    conn: sqlite3.Connection,
    task_ids: set[str],
    root_task_id: str,
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT task_id, kind, payload, run_id
          FROM task_events
         WHERE task_id IN ({placeholders})
           AND kind IN (?, ?)
         ORDER BY id ASC
        """,
        (*task_ids, LOOP_HANDOFF_EVENT_KIND, LOOP_HANDOFF_RESOLUTION_EVENT_KIND),
    ).fetchall()
    handoffs: dict[str, dict[str, Any]] = _durable_handoff_payloads_for_tasks(conn, task_ids, root_task_id)
    for row in rows:
        payload = _event_payload(row)
        if payload.get("root_task_id") != root_task_id:
            continue
        task_id = row["task_id"]
        if row["kind"] == LOOP_HANDOFF_EVENT_KIND:
            if task_id not in handoffs:
                handoffs[task_id] = dict(payload)
        elif row["kind"] == LOOP_HANDOFF_RESOLUTION_EVENT_KIND:
            current = dict(handoffs.get(task_id, {}))
            current.update(payload)
            handoffs[task_id] = current
    return handoffs


def latest_handoff_for_task(
    conn: sqlite3.Connection,
    task_id: str,
    root_task_id: str,
) -> Optional[dict[str, Any]]:
    """Return compact latest Loop foreground handoff state for one task."""
    payload = _latest_handoffs_for_tasks(conn, {task_id}, root_task_id).get(task_id)
    return _compact_handoff(task_id, payload) if payload else None


def handoff_is_pending(handoff: Optional[dict[str, Any]]) -> bool:
    """Whether a compact handoff still needs foreground attention."""
    if not handoff:
        return False
    return bool(handoff.get("attention")) or handoff.get("verification_state") == "needs-orchestrator"


def _assert_handoff_target(conn: sqlite3.Connection, task_id: str, root_task_id: str):
    task = _task_or_error(conn, task_id)
    if task.created_by != f"loop:{root_task_id}":
        raise LoopError(
            "wrong_root",
            f"resolve_handoff target {task_id} is non-Loop or not a node for root {root_task_id}",
        )
    return task


def _would_cycle_with_replacement(
    conn: sqlite3.Connection,
    child_id: str,
    new_parent_ids: list[str],
) -> bool:
    rows = conn.execute("SELECT parent_id, child_id FROM task_links").fetchall()
    edges = {(r["parent_id"], r["child_id"]) for r in rows if r["child_id"] != child_id}
    for parent_id in new_parent_ids:
        edges.add((parent_id, child_id))
    children: dict[str, list[str]] = {}
    for parent, child in edges:
        children.setdefault(parent, []).append(child)
    for parent_id in new_parent_ids:
        stack = [child_id]
        seen: set[str] = set()
        while stack:
            node = stack.pop()
            if node == parent_id:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(children.get(node, []))
    return False


def _set_parents_in_txn(
    conn: sqlite3.Connection,
    root_task_id: str,
    task_id: str,
    parent_ids: list[str],
) -> None:
    _assert_loop_node(conn, task_id, root_task_id)
    for pid in parent_ids:
        _assert_loop_node(conn, pid, root_task_id)
    if task_id in parent_ids:
        raise LoopError("validation_failed", "a task cannot depend on itself")
    if _would_cycle_with_replacement(conn, task_id, parent_ids):
        raise LoopError("validation_failed", "dependency update would create a cycle")
    conn.execute("DELETE FROM task_links WHERE child_id = ?", (task_id,))
    for pid in parent_ids:
        conn.execute(
            "INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)",
            (pid, task_id),
        )
    kb._append_event(conn, task_id, "loop_parents_set", {"parents": parent_ids})


def read_graph(
    conn: sqlite3.Connection,
    root_task_id: str,
    *,
    include_nodes: bool = False,
) -> dict[str, Any]:
    ensure_schema(conn)
    root_task_id = _assert_loop_identity(root_task_id)
    rev = graph_revision(conn, root_task_id)
    out: dict[str, Any] = {"ok": True, "root_task_id": root_task_id, "graph_revision": rev}
    if not include_nodes:
        return out

    rows = _graph_task_rows(conn, root_task_id)
    task_ids = {row["id"] for row in rows}
    flags = _latest_node_flags(conn, task_ids, root_task_id)
    handoff_payloads = _latest_handoffs_for_tasks(conn, task_ids, root_task_id)
    parent_map = {tid: kb.parent_ids(conn, tid) for tid in task_ids}
    children: dict[str, list[str]] = {tid: [] for tid in task_ids}
    for child, parents in parent_map.items():
        for parent in parents:
            if parent in task_ids:
                children.setdefault(parent, []).append(child)
    depth_cache: dict[str, int] = {}

    def depth(tid: str, visiting: Optional[set[str]] = None) -> int:
        if tid in depth_cache:
            return depth_cache[tid]
        visiting = visiting or set()
        if tid in visiting:
            return 0
        visiting.add(tid)
        graph_parents = [pid for pid in parent_map.get(tid, []) if pid in task_ids]
        value = 0 if not graph_parents else 1 + max(depth(pid, visiting) for pid in graph_parents)
        depth_cache[tid] = value
        return value

    nodes = []
    pending_handoffs: list[dict[str, Any]] = []
    for row in rows:
        tid = row["id"]
        state = flags.get(tid, {"active": False, "frontier": False})
        node = {
            "task_id": tid,
            "title": row["title"],
            "status": row["status"],
            "parents": parent_map.get(tid, []),
            "depth": depth(tid),
            "active": bool(state.get("active")),
            "frontier": bool(state.get("frontier")),
            "root_task_id": root_task_id,
        }
        if state.get("client_id"):
            node["node_id"] = state["client_id"]
        handoff_payload = handoff_payloads.get(tid)
        if handoff_payload:
            handoff = _compact_handoff(tid, handoff_payload)
            node["attention"] = handoff.get("attention")
            node["verification_state"] = handoff.get("verification_state")
            node["handoff"] = handoff
            if handoff_is_pending(handoff):
                pending: dict[str, Any] = {
                    "task_id": tid,
                    "node_id": state.get("client_id"),
                    "handoff_kind": handoff.get("handoff_kind"),
                    "verification_state": handoff.get("verification_state"),
                }
                for key in ("handoff_id", "state", "review_task_id", "reviewer_session_id", "summary", "reason"):
                    if handoff.get(key) is not None:
                        pending[key] = handoff[key]
                pending_handoffs.append(pending)
        nodes.append(node)
    nodes.sort(key=lambda n: (n["depth"], rows.index(next(r for r in rows if r["id"] == n["task_id"]))))
    out["nodes"] = nodes
    out["pending_handoffs"] = pending_handoffs
    return out


def _resolve_handoff_in_txn(
    conn: sqlite3.Connection,
    root_task_id: str,
    op: dict[str, Any],
) -> str:
    task_id = str(op.get("task_id") or "").strip()
    if not task_id:
        raise LoopError("validation_failed", "resolve_handoff.task_id is required")
    _assert_handoff_target(conn, task_id, root_task_id)

    verification_state = op.get("verification_state")
    if verification_state not in _ALLOWED_HANDOFF_VERIFICATION_STATES:
        allowed = ", ".join(sorted(_ALLOWED_HANDOFF_VERIFICATION_STATES))
        raise LoopError("validation_failed", f"resolve_handoff.verification_state must be one of: {allowed}")
    attention = op.get("attention", None)
    if attention not in _ALLOWED_HANDOFF_ATTENTION:
        raise LoopError(
            "validation_failed",
            "resolve_handoff.attention must be null, needs-orchestrator, or needs-user",
        )

    latest_payload = _latest_handoffs_for_tasks(conn, {task_id}, root_task_id).get(task_id)
    if not latest_payload:
        raise LoopError("validation_failed", "resolve_handoff target has no pending Loop handoff")
    if op.get("handoff_run_id") is not None and latest_payload.get("run_id") != op.get("handoff_run_id"):
        raise LoopError("stale_revision", "resolve_handoff stale run guard failed")
    if op.get("handoff_kind") is not None and latest_payload.get("handoff_kind") != op.get("handoff_kind"):
        raise LoopError("stale_revision", "resolve_handoff stale kind guard failed")

    payload: dict[str, Any] = {
        "root_task_id": root_task_id,
        "handoff_kind": latest_payload.get("handoff_kind"),
        "attention": attention,
        "verification_state": verification_state,
    }
    if "run_id" in latest_payload:
        payload["run_id"] = latest_payload.get("run_id")
    for key in ("summary", "reason", "worker_session_id", "artifacts", "created_cards"):
        if key in latest_payload:
            payload[key] = latest_payload[key]
    if op.get("reason") is not None:
        payload["reason"] = op.get("reason")
    if op.get("resolution_summary") is not None:
        payload["resolution_summary"] = op.get("resolution_summary")
    kb._append_event(conn, task_id, LOOP_HANDOFF_RESOLUTION_EVENT_KIND, payload, run_id=payload.get("run_id"))
    durable_state = str(verification_state).replace("-", "_")
    if verification_state == "done":
        durable_state = "closed"
    now = int(time.time())
    conn.execute(
        """
        UPDATE loop_handoffs
           SET state = ?,
               attention = ?,
               verification_state = ?,
               decision_reason = ?,
               resolution_summary = ?,
               updated_at = ?,
               resolved_at = COALESCE(resolved_at, ?),
               completed_at = COALESCE(completed_at, ?)
         WHERE id = (
             SELECT id FROM loop_handoffs
              WHERE root_task_id = ?
                AND task_id = ?
                AND handoff_kind = ?
                AND (run_id IS ? OR run_id = ?)
              ORDER BY updated_at DESC, id DESC
              LIMIT 1
         )
        """,
        (
            durable_state,
            attention,
            verification_state,
            op.get("reason"),
            op.get("resolution_summary"),
            now,
            now,
            now,
            root_task_id,
            task_id,
            latest_payload.get("handoff_kind"),
            latest_payload.get("run_id"),
            latest_payload.get("run_id"),
        ),
    )
    return task_id


def apply_patch(
    conn: sqlite3.Connection,
    root_task_id: str,
    *,
    expected_revision: int,
    mutation_id: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    ensure_schema(conn)
    root_task_id = _assert_loop_identity(root_task_id)
    if not mutation_id or not str(mutation_id).strip():
        raise LoopError("validation_failed", "mutation_id is required")
    mutation_id = str(mutation_id).strip()
    if not isinstance(operations, list):
        raise LoopError("validation_failed", "operations must be a list")

    duplicate = conn.execute(
        "SELECT result_json FROM loop_mutations WHERE root_task_id = ? AND mutation_id = ?",
        (root_task_id, mutation_id),
    ).fetchone()
    if duplicate:
        result = json.loads(duplicate["result_json"])
        result["duplicate"] = True
        return result

    current = graph_revision(conn, root_task_id)
    if int(expected_revision) != current:
        raise LoopError(
            "stale_revision",
            f"expected revision {expected_revision}, current revision is {current}",
            current_revision=current,
        )

    created: list[dict[str, str]] = []
    updated: list[str] = []
    archived: list[str] = []
    resolved_handoffs: list[str] = []
    client_to_task: dict[str, str] = {}

    with kb.write_txn(conn):
        # Re-check duplicate mutations inside the write lock. A retry can start
        # before the original mutation commits, then acquire the lock after it;
        # in that case replay the stored result rather than reporting stale_revision.
        duplicate = conn.execute(
            "SELECT result_json FROM loop_mutations WHERE root_task_id = ? AND mutation_id = ?",
            (root_task_id, mutation_id),
        ).fetchone()
        if duplicate:
            result = json.loads(duplicate["result_json"])
            result["duplicate"] = True
            return result

        # Re-check inside the write lock so stale-safe mutations are serialized.
        locked_current = graph_revision(conn, root_task_id)
        if int(expected_revision) != locked_current:
            raise LoopError(
                "stale_revision",
                f"expected revision {expected_revision}, current revision is {locked_current}",
                current_revision=locked_current,
            )

        for op in operations:
            if not isinstance(op, dict):
                raise LoopError("validation_failed", "each operation must be an object")
            kind = str(op.get("op") or "").strip()
            if kind == "add_node":
                title = str(op.get("title") or "").strip()
                if not title:
                    raise LoopError("validation_failed", "add_node.title is required")
                client_id = str(op.get("client_id") or "").strip() or None
                parents = _canonical_parent_ids(client_to_task, op.get("parents"))
                _assert_loop_parent_ids(conn, parents, root_task_id)
                body = _provenance_body(
                    op.get("body"),
                    root_task_id=root_task_id,
                    client_id=client_id,
                    suggested_owner=(str(op.get("suggested_owner")).strip() if op.get("suggested_owner") else None),
                )
                task_id = _create_triage_task_in_txn(
                    conn,
                    title=title,
                    body=body,
                    root_task_id=root_task_id,
                    tenant=root_task_id,
                    parents=parents,
                    idempotency_key=(f"loop:{root_task_id}:{client_id}" if client_id else None),
                )
                if client_id:
                    client_to_task[client_id] = task_id
                _append_node_event(
                    conn,
                    task_id,
                    root_task_id=root_task_id,
                    active=op.get("active") if "active" in op else None,
                    frontier=op.get("frontier") if "frontier" in op else None,
                    client_id=client_id,
                )
                created.append({"client_id": client_id or "", "task_id": task_id})
            elif kind == "update_node":
                task_id = str(op.get("task_id") or "").strip()
                task = _assert_loop_node(conn, task_id, root_task_id)
                assignments: list[str] = []
                params: list[Any] = []
                if "title" in op:
                    title = str(op.get("title") or "").strip()
                    if not title:
                        raise LoopError("validation_failed", "update_node.title cannot be empty")
                    assignments.append("title = ?")
                    params.append(title)
                if "body" in op or "suggested_owner" in op:
                    assignments.append("body = ?")
                    params.append(
                        _provenance_body(
                            op.get("body") if "body" in op else task.body,
                            root_task_id=root_task_id,
                            client_id=None,
                            suggested_owner=(str(op.get("suggested_owner")).strip() if op.get("suggested_owner") else None),
                        )
                    )
                if assignments:
                    params.append(task_id)
                    conn.execute(f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ?", params)
                if "active" in op or "frontier" in op:
                    _append_node_event(
                        conn,
                        task_id,
                        root_task_id=root_task_id,
                        active=op.get("active") if "active" in op else None,
                        frontier=op.get("frontier") if "frontier" in op else None,
                    )
                updated.append(task_id)
            elif kind == "archive_node":
                task_id = str(op.get("task_id") or "").strip()
                _assert_loop_node(conn, task_id, root_task_id)
                conn.execute(
                    "UPDATE tasks SET status = 'archived', claim_lock = NULL, claim_expires = NULL, worker_pid = NULL "
                    "WHERE id = ?",
                    (task_id,),
                )
                kb._append_event(conn, task_id, "archived", {"source": "loop"})
                archived.append(task_id)
            elif kind == "set_parents":
                task_id = str(op.get("task_id") or "").strip()
                parents = _canonical_parent_ids(client_to_task, op.get("parents"))
                _set_parents_in_txn(conn, root_task_id, task_id, parents)
                updated.append(task_id)
            elif kind == "mark_node":
                task_id = str(op.get("task_id") or "").strip()
                _assert_loop_node(conn, task_id, root_task_id)
                _append_node_event(
                    conn,
                    task_id,
                    root_task_id=root_task_id,
                    active=op.get("active") if "active" in op else None,
                    frontier=op.get("frontier") if "frontier" in op else None,
                )
                updated.append(task_id)
            elif kind == "resolve_handoff":
                resolved_handoffs.append(_resolve_handoff_in_txn(conn, root_task_id, op))
            elif kind == "validate":
                # Validation-only op; all prior operations in this patch have already
                # been checked. Keep it as a no-op so callers can force a revision check.
                continue
            else:
                raise LoopError("validation_failed", f"unknown operation {kind!r}")

        root_event_payload = {
            "mutation_id": mutation_id,
            "created": created,
            "updated": updated,
            "archived": archived,
        }
        if resolved_handoffs:
            root_event_payload["resolved_handoffs"] = resolved_handoffs
        touched_task_ids = [
            *[item["task_id"] for item in created],
            *updated,
            *archived,
            *resolved_handoffs,
        ]
        new_revision = _append_graph_event(conn, root_task_id, touched_task_ids, root_event_payload)
        result = {
            "ok": True,
            "root_task_id": root_task_id,
            "previous_revision": locked_current,
            "graph_revision": new_revision,
            "created": created,
            "updated": updated,
            "archived": archived,
            "duplicate": False,
            "validation": "ok",
        }
        if resolved_handoffs:
            result["resolved_handoffs"] = resolved_handoffs
        conn.execute(
            "INSERT INTO loop_mutations (root_task_id, mutation_id, result_json, created_at) "
            "VALUES (?, ?, ?, ?)",
            (root_task_id, mutation_id, json.dumps(result, ensure_ascii=False), int(time.time())),
        )
        return result


def error_response(exc: LoopError, conn: Optional[sqlite3.Connection] = None, root_task_id: Optional[str] = None) -> dict[str, Any]:
    current = exc.current_revision
    if current is None and conn is not None and root_task_id:
        try:
            current = graph_revision(conn, root_task_id)
        except Exception:
            current = None
    out: dict[str, Any] = {"ok": False, "error": exc.code, "message": exc.message}
    if current is not None:
        out["current_revision"] = current
    return out
