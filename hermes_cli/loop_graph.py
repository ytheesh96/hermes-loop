"""Lightweight workflow-owned Loop planning graph API.

Workflow identity is independent of every Kanban task.  Live task nodes remain
ordinary rows in ``tasks`` while interview/planning options live in dedicated
planning tables.  The public API is workflow-keyed; ``root_task_id`` is
accepted only as a deprecated input alias while persisted legacy graph rows are
migrated.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any, Optional

from hermes_cli import kanban_db as kb

LOOP_EVENT_KIND = "loop_mutation"
LOOP_NODE_EVENT_KIND = "loop_node_state"
_SAFE_MUTATION_STATUSES = {"triage", "scheduled", "todo"}
_DONE_LIKE = {"done", "archived"}
_NODE_BRANCH_KINDS = {"alternative", "required"}
_NODE_SELECTION_STATES = {"candidate", "chosen", "rejected"}
_NODE_METADATA_KEYS = ("branch_kind", "decision_group_id", "selection_state")
_PLAN_NODE_STATUS_VALUES = {"triage", "scheduled", "archived"}

# Optimistic graph revisions track durable graph shape and task-state
# boundaries, not high-frequency worker telemetry. ``edited`` is filtered
# separately because completed-result backfills share that event kind with
# title/body edits.
_GRAPH_REVISION_EVENT_KINDS = frozenset({
    "activated",
    "archived",
    "assigned",
    "block_loop_detected",
    "blocked",
    "blocker_triage_resolved",
    "claim_rejected",
    "claimed",
    "completed",
    "crashed",
    "created",
    "decomposed",
    "dependency_wait",
    "error",
    "failed",
    "gave_up",
    "linked",
    "promoted",
    "promoted_manual",
    "protocol_violation",
    "rate_limited",
    "reclaimed",
    "released",
    "scheduled",
    "spawn_failed",
    "specification_requested",
    "specified",
    "stale",
    "status",
    "timed_out",
    "unblocked",
    "unlinked",
})


class LoopError(Exception):
    def __init__(
        self, code: str, message: str, *, current_revision: Optional[int] = None
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.current_revision = current_revision


_LOOP_MUTATIONS_SQL = """
    CREATE TABLE IF NOT EXISTS loop_mutations (
        workflow_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, mutation_id)
    )
"""

_LOOP_PLAN_NODES_SQL = """
    CREATE TABLE IF NOT EXISTS loop_plan_nodes (
        workflow_id      TEXT NOT NULL,
        node_id           TEXT NOT NULL,
        client_id         TEXT,
        title             TEXT NOT NULL,
        body              TEXT,
        status            TEXT NOT NULL DEFAULT 'scheduled',
        suggested_owner   TEXT,
        active            INTEGER NOT NULL DEFAULT 0,
        frontier          INTEGER NOT NULL DEFAULT 0,
        branch_kind       TEXT,
        decision_group_id TEXT,
        selection_state   TEXT,
        execution_task_id TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        archived_at       INTEGER,
        PRIMARY KEY (workflow_id, node_id)
    )
"""

_LOOP_PLAN_EDGES_SQL = """
    CREATE TABLE IF NOT EXISTS loop_plan_edges (
        workflow_id TEXT NOT NULL,
        parent_id    TEXT NOT NULL,
        child_id     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, parent_id, child_id)
    )
"""

_LOOP_PLAN_EVENTS_SQL = """
    CREATE TABLE IF NOT EXISTS loop_plan_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id  TEXT NOT NULL,
        mutation_id  TEXT,
        payload_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
    )
"""

_GRAPH_TABLE_MIGRATIONS = (
    (
        "loop_mutations",
        _LOOP_MUTATIONS_SQL,
        ("mutation_id", "result_json", "created_at"),
    ),
    (
        "loop_plan_nodes",
        _LOOP_PLAN_NODES_SQL,
        (
            "node_id",
            "client_id",
            "title",
            "body",
            "status",
            "suggested_owner",
            "active",
            "frontier",
            "branch_kind",
            "decision_group_id",
            "selection_state",
            "execution_task_id",
            "created_at",
            "updated_at",
            "archived_at",
        ),
    ),
    (
        "loop_plan_edges",
        _LOOP_PLAN_EDGES_SQL,
        ("parent_id", "child_id", "created_at"),
    ),
    (
        "loop_plan_events",
        _LOOP_PLAN_EVENTS_SQL,
        ("id", "mutation_id", "payload_json", "created_at"),
    ),
)


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate_legacy_graph_ownership(conn: sqlite3.Connection) -> None:
    """Replace legacy ``root_task_id`` ownership with ``workflow_id``.

    Legacy values are copied verbatim: an old root id becomes the workflow id.
    Each table rebuild is protected by one savepoint, so re-running this after
    success is a no-op and a failed migration cannot leave a half-renamed table.
    """

    conn.execute("SAVEPOINT loop_graph_workflow_migration")
    try:
        for table, create_sql, payload_columns in _GRAPH_TABLE_MIGRATIONS:
            columns = _table_columns(conn, table)
            if not columns:
                conn.execute(create_sql)
                continue
            if "workflow_id" in columns and "root_task_id" not in columns:
                continue
            if "root_task_id" not in columns:
                raise sqlite3.OperationalError(
                    f"{table} has neither workflow_id nor legacy root_task_id"
                )

            legacy_table = f"{table}__legacy_root_owner"
            conn.execute(f"ALTER TABLE {table} RENAME TO {legacy_table}")
            conn.execute(create_sql)
            destination = ", ".join(("workflow_id", *payload_columns))
            owner_source = (
                "COALESCE(workflow_id, root_task_id)"
                if "workflow_id" in columns
                else "root_task_id"
            )
            source = ", ".join((owner_source, *payload_columns))
            conn.execute(
                f"INSERT OR IGNORE INTO {table} ({destination}) "
                f"SELECT {source} FROM {legacy_table}"
            )
            conn.execute(f"DROP TABLE {legacy_table}")
        conn.execute("RELEASE SAVEPOINT loop_graph_workflow_migration")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT loop_graph_workflow_migration")
        conn.execute("RELEASE SAVEPOINT loop_graph_workflow_migration")
        raise


def ensure_schema(conn: sqlite3.Connection) -> None:
    _migrate_legacy_graph_ownership(conn)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_plan_nodes_workflow "
        "ON loop_plan_nodes(workflow_id, status, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_plan_nodes_workflow_client "
        "ON loop_plan_nodes(workflow_id, client_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_plan_edges_workflow_child "
        "ON loop_plan_edges(workflow_id, child_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_plan_events_workflow "
        "ON loop_plan_events(workflow_id, id)"
    )


def _resolve_workflow_identity(
    workflow_id: Optional[str] = None,
    *,
    root_task_id: Optional[str] = None,
) -> str:
    """Resolve the canonical workflow id and its temporary legacy alias."""

    canonical = str(workflow_id or "").strip()
    legacy = str(root_task_id or "").strip()
    if canonical and legacy and canonical != legacy:
        raise LoopError(
            "validation_failed",
            "workflow_id and deprecated root_task_id alias disagree",
        )
    resolved = canonical or legacy
    if not resolved:
        raise LoopError("validation_failed", "workflow_id is required")
    return resolved


def _canonical_response(payload: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    """Return the workflow-keyed shape, including for replayed legacy mutations."""

    payload.pop("root_task_id", None)
    payload["workflow_id"] = workflow_id
    return payload


def _assert_workflow_exists(conn: sqlite3.Connection, workflow_id: str) -> None:
    """Reject graph operations that are not anchored to durable coordination."""

    tables = {
        str(row["name"])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    # Migration-only tests and standalone legacy graph stores predate the
    # Kanban workflow table. Their already-recorded mutations remain readable.
    if "workflows" not in tables:
        return
    if kb.get_workflow(conn, workflow_id) is None:
        raise LoopError("not_found", f"unknown workflow: {workflow_id}")


def graph_revision(
    conn: sqlite3.Connection,
    workflow_id: Optional[str] = None,
    *,
    root_task_id: Optional[str] = None,
) -> int:
    ensure_schema(conn)
    workflow_id = _resolve_workflow_identity(workflow_id, root_task_id=root_task_id)
    _assert_workflow_exists(conn, workflow_id)
    relevant_kinds = sorted(_GRAPH_REVISION_EVENT_KINDS)
    kind_placeholders = ",".join("?" for _ in relevant_kinds)
    event_row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT e.id) AS rev
          FROM task_events e
          JOIN tasks t ON t.id = e.task_id
         WHERE t.workflow_id = ?
           AND (
                e.kind IN ({kind_placeholders})
                OR (substr(e.kind, 1, 5) = 'loop_' AND e.kind != ?)
                OR substr(e.kind, 1, 8) = 'handoff_'
                OR substr(e.kind, 1, 7) = 'review_'
                OR (
                    e.kind = 'edited'
                    AND (
                        e.payload IS NULL
                        OR NOT json_valid(e.payload)
                        OR json_type(
                            CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{{}}' END,
                            '$.fields'
                        ) IS NULL
                        OR EXISTS (
                            SELECT 1
                              FROM json_each(
                                  CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{{}}' END,
                                  '$.fields'
                              )
                             WHERE value IN (
                                 'title', 'body', 'status', 'assignee',
                                 'needs_specification'
                             )
                        )
                    )
                )
           )
        """,
        (
            workflow_id,
            *relevant_kinds,
            LOOP_EVENT_KIND,
        ),
    ).fetchone()
    plan_row = conn.execute(
        "SELECT COUNT(*) AS rev FROM loop_plan_events WHERE workflow_id = ?",
        (workflow_id,),
    ).fetchone()
    # Logical per-workflow revision. Task state is included only through typed
    # workflow membership; lightweight planning events need no task-row mirror.
    return int((event_row["rev"] or 0) if event_row else 0) + int(
        (plan_row["rev"] or 0) if plan_row else 0
    )


def _append_graph_event(
    conn: sqlite3.Connection,
    workflow_id: str,
    payload: dict[str, Any],
) -> int:
    """Append a workflow-owned planning event without synthesizing task events."""
    now = int(time.time())
    conn.execute(
        "INSERT INTO loop_plan_events (workflow_id, mutation_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
        (
            workflow_id,
            payload.get("mutation_id"),
            json.dumps(payload, ensure_ascii=False),
            now,
        ),
    )
    return graph_revision(conn, workflow_id)


def _append_node_event(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    workflow_id: str,
    active: Optional[bool] = None,
    frontier: Optional[bool] = None,
    client_id: Optional[str] = None,
    branch_kind: Optional[str] = None,
    decision_group_id: Optional[str] = None,
    selection_state: Optional[str] = None,
) -> None:
    payload: dict[str, Any] = {"workflow_id": workflow_id}
    if active is not None:
        payload["active"] = bool(active)
    if frontier is not None:
        payload["frontier"] = bool(frontier)
    if client_id:
        payload["client_id"] = client_id
    if branch_kind:
        payload["branch_kind"] = branch_kind
    if decision_group_id:
        payload["decision_group_id"] = decision_group_id
    if selection_state:
        payload["selection_state"] = selection_state
    kb._append_event(conn, task_id, LOOP_NODE_EVENT_KIND, payload)


def _clean_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _node_metadata_from_op(op: dict[str, Any], *, prefix: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    if "branch_kind" in op:
        branch_kind = (_clean_optional_str(op.get("branch_kind")) or "").lower()
        if branch_kind and branch_kind not in _NODE_BRANCH_KINDS:
            allowed = ", ".join(sorted(_NODE_BRANCH_KINDS))
            raise LoopError(
                "validation_failed", f"{prefix}.branch_kind must be one of: {allowed}"
            )
        if branch_kind:
            metadata["branch_kind"] = branch_kind
    if "decision_group_id" in op:
        decision_group_id = _clean_optional_str(op.get("decision_group_id"))
        if decision_group_id:
            metadata["decision_group_id"] = decision_group_id
    if "selection_state" in op:
        selection_state = (_clean_optional_str(op.get("selection_state")) or "").lower()
        if selection_state and selection_state not in _NODE_SELECTION_STATES:
            allowed = ", ".join(sorted(_NODE_SELECTION_STATES))
            raise LoopError(
                "validation_failed",
                f"{prefix}.selection_state must be one of: {allowed}",
            )
        if selection_state:
            metadata["selection_state"] = selection_state
    return metadata


def _task_or_error(conn: sqlite3.Connection, task_id: str):
    task = kb.get_task(conn, task_id)
    if task is None:
        raise LoopError("not_found", f"unknown task {task_id}")
    return task


def _assert_safe_node(task) -> None:
    if task.status not in _SAFE_MUTATION_STATUSES:
        raise LoopError(
            "unsafe_status",
            f"refusing to mutate {task.id}: status {task.status!r} is not triage/scheduled",
        )


def _assert_loop_node(conn: sqlite3.Connection, task_id: str, workflow_id: str):
    task = _task_or_error(conn, task_id)
    _assert_safe_node(task)
    _assert_loop_membership(task, task_id, workflow_id)
    if kb.task_has_active_decomposition_children(conn, task_id):
        raise LoopError(
            "unsafe_status",
            f"refusing to mutate {task_id}: decomposition children are still active",
        )
    return task


def _assert_loop_membership(task: Any, task_id: str, workflow_id: str) -> None:
    if task.workflow_id != workflow_id:
        raise LoopError(
            "wrong_workflow",
            f"refusing to mutate {task_id}: not a node in workflow {workflow_id}",
        )


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


def _plan_node_id_from_client(
    conn: sqlite3.Connection, workflow_id: str, client_id: Optional[str]
) -> str:
    if client_id:
        existing = conn.execute(
            "SELECT node_id FROM loop_plan_nodes WHERE workflow_id = ? AND client_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 1",
            (workflow_id, client_id),
        ).fetchone()
        if existing:
            return str(existing["node_id"])
        safe = "".join(
            ch if (ch.isalnum() or ch in {"-", "_"}) else "_" for ch in client_id
        ).strip("_")
        base = f"plan:{safe or uuid.uuid4().hex[:10]}"
    else:
        base = f"plan:{kb._new_task_id()}"

    candidate = base
    suffix = 2
    while conn.execute(
        "SELECT 1 FROM loop_plan_nodes WHERE workflow_id = ? AND node_id = ?",
        (workflow_id, candidate),
    ).fetchone():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _plan_node_row(
    conn: sqlite3.Connection,
    workflow_id: str,
    node_id: str,
    *,
    include_archived: bool = False,
):
    where = "workflow_id = ? AND node_id = ?"
    params: list[Any] = [workflow_id, node_id]
    if not include_archived:
        where += " AND status != 'archived'"
    return conn.execute(
        f"SELECT * FROM loop_plan_nodes WHERE {where}", tuple(params)
    ).fetchone()


def _resolve_plan_node_row(
    conn: sqlite3.Connection,
    workflow_id: str,
    ref: str,
    *,
    include_archived: bool = False,
):
    row = _plan_node_row(conn, workflow_id, ref, include_archived=include_archived)
    if row:
        return row
    where = "workflow_id = ? AND client_id = ?"
    params: list[Any] = [workflow_id, ref]
    if not include_archived:
        where += " AND status != 'archived'"
    return conn.execute(
        f"SELECT * FROM loop_plan_nodes WHERE {where} ORDER BY created_at DESC LIMIT 1",
        tuple(params),
    ).fetchone()


def _target_plan_node_or_none(
    conn: sqlite3.Connection,
    workflow_id: str,
    node_id: str,
    *,
    include_archived: bool = False,
):
    row = _resolve_plan_node_row(
        conn, workflow_id, node_id, include_archived=include_archived
    )
    if row:
        return row
    other = conn.execute(
        "SELECT workflow_id FROM loop_plan_nodes WHERE (node_id = ? OR client_id = ?) AND workflow_id != ? AND status != 'archived' LIMIT 1",
        (node_id, node_id, workflow_id),
    ).fetchone()
    if other:
        raise LoopError(
            "wrong_workflow",
            f"refusing to mutate {node_id}: not a planning node in workflow {workflow_id}",
        )
    return None


def _assert_plan_parent_ids(
    conn: sqlite3.Connection, parent_ids: list[str], workflow_id: str
) -> None:
    for parent_id in parent_ids:
        if _resolve_plan_node_row(conn, workflow_id, parent_id):
            continue
        if conn.execute(
            "SELECT 1 FROM loop_plan_nodes WHERE (node_id = ? OR client_id = ?) AND workflow_id != ? AND status != 'archived' LIMIT 1",
            (parent_id, parent_id, workflow_id),
        ).fetchone():
            raise LoopError(
                "wrong_workflow",
                f"refusing to parent to {parent_id}: not a planning node in workflow {workflow_id}",
            )
        task = kb.get_task(conn, parent_id)
        if task is None:
            raise LoopError("validation_failed", f"unknown parent node(s): {parent_id}")
        _assert_loop_membership(task, parent_id, workflow_id)


def _canonical_plan_parent_ids(
    conn: sqlite3.Connection, parent_ids: list[str], workflow_id: str
) -> list[str]:
    canonical: list[str] = []
    for parent_id in parent_ids:
        row = _resolve_plan_node_row(conn, workflow_id, parent_id)
        canonical.append(str(row["node_id"]) if row else parent_id)
    return canonical


def _plan_edges(conn: sqlite3.Connection, workflow_id: str) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT parent_id, child_id FROM loop_plan_edges WHERE workflow_id = ? ORDER BY created_at ASC, parent_id ASC, child_id ASC",
            (workflow_id,),
        ).fetchall()
    )


def _would_plan_cycle_with_replacement(
    conn: sqlite3.Connection,
    workflow_id: str,
    child_id: str,
    new_parent_ids: list[str],
) -> bool:
    edges = {
        (row["parent_id"], row["child_id"])
        for row in _plan_edges(conn, workflow_id)
        if row["child_id"] != child_id
    }
    for parent_id in new_parent_ids:
        edges.add((parent_id, child_id))
    children: dict[str, list[str]] = {}
    for parent_id, edge_child_id in edges:
        children.setdefault(parent_id, []).append(edge_child_id)
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


def _set_plan_parents_in_txn(
    conn: sqlite3.Connection,
    workflow_id: str,
    node_id: str,
    parent_ids: list[str],
) -> None:
    row = _target_plan_node_or_none(conn, workflow_id, node_id)
    if not row:
        raise LoopError("not_found", f"unknown planning node {node_id}")
    node_id = str(row["node_id"])
    parent_ids = _canonical_plan_parent_ids(conn, parent_ids, workflow_id)
    _assert_plan_parent_ids(conn, parent_ids, workflow_id)
    if node_id in parent_ids:
        raise LoopError("validation_failed", "a node cannot depend on itself")
    if _would_plan_cycle_with_replacement(conn, workflow_id, node_id, parent_ids):
        raise LoopError(
            "validation_failed", "planning edge update would create a cycle"
        )
    conn.execute(
        "DELETE FROM loop_plan_edges WHERE workflow_id = ? AND child_id = ?",
        (workflow_id, node_id),
    )
    now = int(time.time())
    for parent_id in parent_ids:
        conn.execute(
            "INSERT OR IGNORE INTO loop_plan_edges (workflow_id, parent_id, child_id, created_at) VALUES (?, ?, ?, ?)",
            (workflow_id, parent_id, node_id, now),
        )


def _create_plan_node_in_txn(
    conn: sqlite3.Connection,
    *,
    title: str,
    body: Optional[str],
    workflow_id: str,
    parents: list[str],
    client_id: Optional[str],
    suggested_owner: Optional[str],
    status: str,
    active: Optional[bool],
    frontier: Optional[bool],
    metadata: dict[str, str],
    execution_task_id: Optional[str] = None,
) -> str:
    if status not in _PLAN_NODE_STATUS_VALUES - {"archived"}:
        allowed = ", ".join(sorted(_PLAN_NODE_STATUS_VALUES - {"archived"}))
        raise LoopError(
            "validation_failed", f"add_node.status must be one of: {allowed}"
        )
    _assert_plan_parent_ids(conn, parents, workflow_id)
    node_id = _plan_node_id_from_client(conn, workflow_id, client_id)
    existing = _plan_node_row(conn, workflow_id, node_id)
    if existing:
        return node_id
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO loop_plan_nodes (
            workflow_id, node_id, client_id, title, body, status, suggested_owner,
            active, frontier, branch_kind, decision_group_id, selection_state,
            execution_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            workflow_id,
            node_id,
            client_id,
            title,
            body,
            status,
            suggested_owner,
            1 if active else 0,
            1 if frontier else 0,
            metadata.get("branch_kind"),
            metadata.get("decision_group_id"),
            metadata.get("selection_state"),
            execution_task_id,
            now,
            now,
        ),
    )
    _set_plan_parents_in_txn(conn, workflow_id, node_id, parents)
    return node_id


def _update_plan_node_in_txn(
    conn: sqlite3.Connection,
    workflow_id: str,
    node_id: str,
    op: dict[str, Any],
    *,
    metadata: dict[str, str],
) -> None:
    if not _target_plan_node_or_none(conn, workflow_id, node_id):
        raise LoopError("not_found", f"unknown planning node {node_id}")
    assignments = ["updated_at = ?"]
    params: list[Any] = [int(time.time())]
    if "title" in op:
        title = str(op.get("title") or "").strip()
        if not title:
            raise LoopError("validation_failed", "update_node.title cannot be empty")
        assignments.append("title = ?")
        params.append(title)
    if "body" in op:
        assignments.append("body = ?")
        params.append(str(op.get("body") or "").strip() or None)
    if "suggested_owner" in op:
        assignments.append("suggested_owner = ?")
        params.append(_clean_optional_str(op.get("suggested_owner")))
    if "active" in op:
        assignments.append("active = ?")
        params.append(1 if op.get("active") else 0)
    if "frontier" in op:
        assignments.append("frontier = ?")
        params.append(1 if op.get("frontier") else 0)
    if "execution_task_id" in op:
        assignments.append("execution_task_id = ?")
        params.append(_clean_optional_str(op.get("execution_task_id")))
    for key in _NODE_METADATA_KEYS:
        if key in metadata:
            assignments.append(f"{key} = ?")
            params.append(metadata[key])
    params.extend([workflow_id, node_id])
    conn.execute(
        f"UPDATE loop_plan_nodes SET {', '.join(assignments)} WHERE workflow_id = ? AND node_id = ?",
        params,
    )


def _provenance_body(
    body: Optional[str],
    *,
    client_id: Optional[str],
    suggested_owner: Optional[str],
) -> str:
    parts: list[str] = []
    if body and str(body).strip():
        parts.append(str(body).strip())
    prov = ["Loop planning metadata:"]
    if client_id:
        prov.append(f"draft_node: {client_id}")
    if suggested_owner:
        prov.append(f"suggested_owner: {suggested_owner}")
    if len(prov) > 1:
        parts.append("\n".join(prov))
    return "\n\n".join(parts)


def _graph_task_rows(conn: sqlite3.Connection, workflow_id: str) -> list[sqlite3.Row]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE workflow_id = ? AND status != 'archived' "
        "ORDER BY created_at ASC, id ASC",
        (workflow_id,),
    ).fetchall()
    return list(rows)


def _graph_task_ids(conn: sqlite3.Connection, workflow_id: str) -> set[str]:
    return {row["id"] for row in _graph_task_rows(conn, workflow_id)}


def _latest_node_flags(
    conn: sqlite3.Connection, task_ids: set[str], workflow_id: str
) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"SELECT task_id, payload FROM task_events "
        f"WHERE kind = ? AND task_id IN ({placeholders}) ORDER BY id ASC",
        (LOOP_NODE_EVENT_KIND, *task_ids),
    ).fetchall()
    flags: dict[str, dict[str, Any]] = {
        tid: {"active": False, "frontier": False} for tid in task_ids
    }
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except Exception:
            continue
        # Historical node-state events used the former root identity field.
        event_workflow_id = payload.get("workflow_id") or payload.get("root_task_id")
        if event_workflow_id != workflow_id:
            continue
        state = flags.setdefault(row["task_id"], {"active": False, "frontier": False})
        if "active" in payload:
            state["active"] = bool(payload["active"])
        if "frontier" in payload:
            state["frontier"] = bool(payload["frontier"])
        if payload.get("client_id"):
            state["client_id"] = payload["client_id"]
        for key in _NODE_METADATA_KEYS:
            value = payload.get(key)
            if value:
                state[key] = value
    return flags


def _event_payload(row: sqlite3.Row) -> dict[str, Any]:
    try:
        payload = json.loads(row["payload"] or "{}")
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


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
    workflow_id: str,
    task_id: str,
    parent_ids: list[str],
) -> None:
    _assert_loop_node(conn, task_id, workflow_id)
    for pid in parent_ids:
        parent = _task_or_error(conn, pid)
        _assert_loop_membership(parent, pid, workflow_id)
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
    _refresh_readiness_in_txn(conn, [task_id], workflow_id=workflow_id)
    kb._append_event(conn, task_id, "loop_parents_set", {"parents": parent_ids})


def _refresh_readiness_in_txn(
    conn: sqlite3.Connection,
    task_ids: list[str],
    *,
    workflow_id: str,
) -> None:
    """Refresh dependency-gated lanes without opening a nested transaction."""
    for task_id in dict.fromkeys(task_ids):
        row = conn.execute(
            "SELECT status, needs_specification FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if row is None:
            continue
        if row["status"] not in {"todo", "triage"}:
            continue
        unfinished = conn.execute(
            "SELECT 1 FROM task_links l JOIN tasks p ON p.id = l.parent_id "
            "WHERE l.child_id = ? AND p.status NOT IN ('done', 'archived') LIMIT 1",
            (task_id,),
        ).fetchone()
        next_status = (
            "todo"
            if unfinished
            else ("triage" if row["needs_specification"] else "ready")
        )
        if next_status != row["status"]:
            conn.execute(
                "UPDATE tasks SET status = ? WHERE id = ?", (next_status, task_id)
            )
            if next_status == "triage":
                event_kind, payload = (
                    "specification_requested",
                    {"reason": "dependencies_satisfied"},
                )
            elif next_status == "ready":
                event_kind, payload = "promoted", None
            else:
                event_kind, payload = "dependency_wait", {"reason": "parents_not_done"}
            kb._append_event(
                conn,
                task_id,
                event_kind,
                payload,
            )


def read_graph(
    conn: sqlite3.Connection,
    workflow_id: Optional[str] = None,
    *,
    include_nodes: bool = False,
    root_task_id: Optional[str] = None,
) -> dict[str, Any]:
    ensure_schema(conn)
    workflow_id = _resolve_workflow_identity(workflow_id, root_task_id=root_task_id)
    rev = graph_revision(conn, workflow_id)
    out: dict[str, Any] = _canonical_response(
        {"ok": True, "graph_revision": rev}, workflow_id
    )
    if not include_nodes:
        return out

    rows = _graph_task_rows(conn, workflow_id)
    task_ids = {row["id"] for row in rows}
    plan_rows = list(
        conn.execute(
            "SELECT * FROM loop_plan_nodes WHERE workflow_id = ? AND status != 'archived' ORDER BY created_at ASC, node_id ASC",
            (workflow_id,),
        ).fetchall()
    )
    plan_ids = {row["node_id"] for row in plan_rows}
    node_ids = task_ids | plan_ids
    flags = _latest_node_flags(conn, task_ids, workflow_id)
    parent_map = {tid: kb.parent_ids(conn, tid) for tid in task_ids}
    children: dict[str, list[str]] = {tid: [] for tid in node_ids}
    for child, parents in parent_map.items():
        for parent in parents:
            if parent in task_ids:
                children.setdefault(parent, []).append(child)
    for edge in _plan_edges(conn, workflow_id):
        child_id = edge["child_id"]
        parent_id = edge["parent_id"]
        if child_id not in plan_ids:
            continue
        parent_map.setdefault(child_id, []).append(parent_id)
        if parent_id in node_ids:
            children.setdefault(parent_id, []).append(child_id)
    depth_cache: dict[str, int] = {}

    def depth(tid: str, visiting: Optional[set[str]] = None) -> int:
        if tid in depth_cache:
            return depth_cache[tid]
        visiting = visiting or set()
        if tid in visiting:
            return 0
        visiting.add(tid)
        graph_parents = [pid for pid in parent_map.get(tid, []) if pid in node_ids]
        value = (
            0
            if not graph_parents
            else 1 + max(depth(pid, visiting) for pid in graph_parents)
        )
        depth_cache[tid] = value
        return value

    nodes = []
    order: dict[str, int] = {}
    for index, row in enumerate(rows):
        tid = row["id"]
        order[tid] = index
        state = flags.get(tid, {"active": False, "frontier": False})
        node = {
            "task_id": tid,
            "title": row["title"],
            "status": row["status"],
            "parents": parent_map.get(tid, []),
            "depth": depth(tid),
            "active": bool(state.get("active")),
            "frontier": bool(state.get("frontier")),
            "workflow_id": workflow_id,
        }
        if state.get("client_id"):
            node["node_id"] = state["client_id"]
        for key in _NODE_METADATA_KEYS:
            if state.get(key):
                node[key] = state[key]
        nodes.append(node)
    for index, row in enumerate(plan_rows, start=len(rows)):
        node_id = row["node_id"]
        order[node_id] = index
        node = {
            "task_id": node_id,
            "node_id": row["client_id"] or node_id,
            "title": row["title"],
            "body": row["body"],
            "status": row["status"],
            "parents": parent_map.get(node_id, []),
            "children": children.get(node_id, []),
            "depth": depth(node_id),
            "active": bool(row["active"]),
            "frontier": bool(row["frontier"]),
            "workflow_id": workflow_id,
            "is_plan_node": True,
        }
        for key in _NODE_METADATA_KEYS:
            if row[key]:
                node[key] = row[key]
        if row["suggested_owner"]:
            node["suggested_owner"] = row["suggested_owner"]
        if row["execution_task_id"]:
            node["execution_task_id"] = row["execution_task_id"]
        nodes.append(node)
    nodes.sort(key=lambda n: (n["depth"], order.get(n["task_id"], 0)))
    out["nodes"] = nodes
    return out


def apply_patch(
    conn: sqlite3.Connection,
    workflow_id: Optional[str] = None,
    *,
    expected_revision: int,
    mutation_id: str,
    operations: list[dict[str, Any]],
    root_task_id: Optional[str] = None,
) -> dict[str, Any]:
    ensure_schema(conn)
    workflow_id = _resolve_workflow_identity(workflow_id, root_task_id=root_task_id)
    if not mutation_id or not str(mutation_id).strip():
        raise LoopError("validation_failed", "mutation_id is required")
    mutation_id = str(mutation_id).strip()
    if not isinstance(operations, list):
        raise LoopError("validation_failed", "operations must be a list")

    duplicate = conn.execute(
        "SELECT result_json FROM loop_mutations WHERE workflow_id = ? AND mutation_id = ?",
        (workflow_id, mutation_id),
    ).fetchone()
    if duplicate:
        result = json.loads(duplicate["result_json"])
        result["duplicate"] = True
        return _canonical_response(result, workflow_id)

    current = graph_revision(conn, workflow_id)
    if int(expected_revision) != current:
        raise LoopError(
            "stale_revision",
            f"expected revision {expected_revision}, current revision is {current}",
            current_revision=current,
        )

    created: list[dict[str, str]] = []
    updated: list[str] = []
    archived: list[str] = []
    client_to_task: dict[str, str] = {}

    with kb.write_txn(conn):
        # Re-check duplicate mutations inside the write lock. A retry can start
        # before the original mutation commits, then acquire the lock after it;
        # in that case replay the stored result rather than reporting stale_revision.
        duplicate = conn.execute(
            "SELECT result_json FROM loop_mutations WHERE workflow_id = ? AND mutation_id = ?",
            (workflow_id, mutation_id),
        ).fetchone()
        if duplicate:
            result = json.loads(duplicate["result_json"])
            result["duplicate"] = True
            return _canonical_response(result, workflow_id)

        # Re-check inside the write lock so stale-safe mutations are serialized.
        locked_current = graph_revision(conn, workflow_id)
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
                status = str(op.get("status") or "scheduled").strip().lower()
                client_id = str(op.get("client_id") or "").strip() or None
                metadata = _node_metadata_from_op(op, prefix="add_node")
                parents = _canonical_parent_ids(client_to_task, op.get("parents"))
                task_id = _create_plan_node_in_txn(
                    conn,
                    title=title,
                    body=str(op.get("body") or "").strip() or None,
                    workflow_id=workflow_id,
                    parents=parents,
                    client_id=client_id,
                    suggested_owner=_clean_optional_str(op.get("suggested_owner")),
                    status=status,
                    active=op.get("active") if "active" in op else None,
                    frontier=op.get("frontier") if "frontier" in op else None,
                    metadata=metadata,
                    execution_task_id=_clean_optional_str(op.get("execution_task_id")),
                )
                if client_id:
                    client_to_task[client_id] = task_id
                created.append({"client_id": client_id or "", "task_id": task_id})
            elif kind == "update_node":
                task_id = str(op.get("task_id") or "").strip()
                metadata = _node_metadata_from_op(op, prefix="update_node")
                plan_row = _target_plan_node_or_none(conn, workflow_id, task_id)
                if plan_row:
                    task_id = str(plan_row["node_id"])
                    _update_plan_node_in_txn(
                        conn, workflow_id, task_id, op, metadata=metadata
                    )
                    updated.append(task_id)
                    continue
                task = _assert_loop_node(conn, task_id, workflow_id)
                assignments: list[str] = []
                params: list[Any] = []
                if "title" in op:
                    title = str(op.get("title") or "").strip()
                    if not title:
                        raise LoopError(
                            "validation_failed", "update_node.title cannot be empty"
                        )
                    assignments.append("title = ?")
                    params.append(title)
                if "body" in op or "suggested_owner" in op:
                    assignments.append("body = ?")
                    params.append(
                        _provenance_body(
                            op.get("body") if "body" in op else task.body,
                            client_id=None,
                            suggested_owner=(
                                str(op.get("suggested_owner")).strip()
                                if op.get("suggested_owner")
                                else None
                            ),
                        )
                    )
                if assignments:
                    params.append(task_id)
                    conn.execute(
                        f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ?",
                        params,
                    )
                if "active" in op or "frontier" in op or metadata:
                    _append_node_event(
                        conn,
                        task_id,
                        workflow_id=workflow_id,
                        active=op.get("active") if "active" in op else None,
                        frontier=op.get("frontier") if "frontier" in op else None,
                        **metadata,
                    )
                updated.append(task_id)
            elif kind in {"archive_node", "delete_node"}:
                task_id = str(op.get("task_id") or "").strip()
                plan_row = _target_plan_node_or_none(conn, workflow_id, task_id)
                if plan_row:
                    task_id = str(plan_row["node_id"])
                    now = int(time.time())
                    conn.execute(
                        "UPDATE loop_plan_nodes SET status = 'archived', archived_at = ?, updated_at = ? WHERE workflow_id = ? AND node_id = ?",
                        (now, now, workflow_id, task_id),
                    )
                    conn.execute(
                        "DELETE FROM loop_plan_edges WHERE workflow_id = ? AND (parent_id = ? OR child_id = ?)",
                        (workflow_id, task_id, task_id),
                    )
                    archived.append(task_id)
                    continue
                _assert_loop_node(conn, task_id, workflow_id)
                affected_children = [
                    str(row["child_id"])
                    for row in conn.execute(
                        "SELECT child_id FROM task_links WHERE parent_id = ?",
                        (task_id,),
                    ).fetchall()
                ]
                conn.execute(
                    "UPDATE tasks SET status = 'archived', claim_lock = NULL, claim_expires = NULL, worker_pid = NULL "
                    "WHERE id = ?",
                    (task_id,),
                )
                conn.execute(
                    "DELETE FROM task_links WHERE parent_id = ? OR child_id = ?",
                    (task_id, task_id),
                )
                kb._append_event(conn, task_id, "archived", {"source": "loop"})
                _refresh_readiness_in_txn(
                    conn,
                    affected_children,
                    workflow_id=workflow_id,
                )
                archived.append(task_id)
            elif kind == "set_parents":
                task_id = str(op.get("task_id") or "").strip()
                parents = _canonical_parent_ids(client_to_task, op.get("parents"))
                plan_row = _target_plan_node_or_none(conn, workflow_id, task_id)
                if plan_row:
                    task_id = str(plan_row["node_id"])
                    _set_plan_parents_in_txn(conn, workflow_id, task_id, parents)
                    updated.append(task_id)
                    continue
                _set_parents_in_txn(conn, workflow_id, task_id, parents)
                updated.append(task_id)
            elif kind == "mark_node":
                task_id = str(op.get("task_id") or "").strip()
                metadata = _node_metadata_from_op(op, prefix="mark_node")
                plan_row = _target_plan_node_or_none(conn, workflow_id, task_id)
                if plan_row:
                    task_id = str(plan_row["node_id"])
                    _update_plan_node_in_txn(
                        conn, workflow_id, task_id, op, metadata=metadata
                    )
                    updated.append(task_id)
                    continue
                _assert_loop_node(conn, task_id, workflow_id)
                _append_node_event(
                    conn,
                    task_id,
                    workflow_id=workflow_id,
                    active=op.get("active") if "active" in op else None,
                    frontier=op.get("frontier") if "frontier" in op else None,
                    **metadata,
                )
                updated.append(task_id)
            elif kind == "validate":
                # Validation-only op; all prior operations in this patch have already
                # been checked. Keep it as a no-op so callers can force a revision check.
                continue
            else:
                raise LoopError("validation_failed", f"unknown operation {kind!r}")

        workflow_event_payload = {
            "workflow_id": workflow_id,
            "mutation_id": mutation_id,
            "created": created,
            "updated": updated,
            "archived": archived,
        }
        new_revision = _append_graph_event(conn, workflow_id, workflow_event_payload)
        result = {
            "ok": True,
            "workflow_id": workflow_id,
            "previous_revision": locked_current,
            "graph_revision": new_revision,
            "created": created,
            "updated": updated,
            "archived": archived,
            "duplicate": False,
            "validation": "ok",
        }
        conn.execute(
            "INSERT INTO loop_mutations (workflow_id, mutation_id, result_json, created_at) "
            "VALUES (?, ?, ?, ?)",
            (
                workflow_id,
                mutation_id,
                json.dumps(result, ensure_ascii=False),
                int(time.time()),
            ),
        )
        return _canonical_response(result, workflow_id)


def error_response(
    exc: LoopError,
    conn: Optional[sqlite3.Connection] = None,
    workflow_id: Optional[str] = None,
    *,
    root_task_id: Optional[str] = None,
) -> dict[str, Any]:
    current = exc.current_revision
    resolved_workflow_id = str(workflow_id or root_task_id or "").strip()
    if current is None and conn is not None and resolved_workflow_id:
        try:
            current = graph_revision(conn, resolved_workflow_id)
        except Exception:
            current = None
    out: dict[str, Any] = {"ok": False, "error": exc.code, "message": exc.message}
    if current is not None:
        out["current_revision"] = current
    return out
