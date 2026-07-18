from __future__ import annotations

import json
import sqlite3
import time

import pytest


@pytest.fixture
def workflow_graph_db(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)

    from hermes_cli import kanban_db as kb

    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    conn = kb.connect()
    try:
        yield conn
    finally:
        conn.close()


def test_legacy_graph_tables_migrate_owner_values_idempotently():
    from hermes_cli import loop_graph as graph

    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        for create_sql in (
            graph._LOOP_MUTATIONS_SQL,
            graph._LOOP_PLAN_NODES_SQL,
            graph._LOOP_PLAN_EDGES_SQL,
            graph._LOOP_PLAN_EVENTS_SQL,
        ):
            conn.execute(create_sql.replace("workflow_id", "root_task_id"))

        now = int(time.time())
        conn.execute(
            "INSERT INTO loop_mutations "
            "(root_task_id, mutation_id, result_json, created_at) "
            "VALUES ('legacy-root', 'm1', ?, ?)",
            (json.dumps({"ok": True, "root_task_id": "legacy-root"}), now),
        )
        conn.execute(
            "INSERT INTO loop_plan_nodes "
            "(root_task_id, node_id, title, created_at, updated_at) "
            "VALUES ('legacy-root', 'plan:a', 'A', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO loop_plan_edges "
            "(root_task_id, parent_id, child_id, created_at) "
            "VALUES ('legacy-root', 'plan:a', 'plan:b', ?)",
            (now,),
        )
        conn.execute(
            "INSERT INTO loop_plan_events "
            "(root_task_id, mutation_id, payload_json, created_at) "
            "VALUES ('legacy-root', 'm1', '{}', ?)",
            (now,),
        )

        graph.ensure_schema(conn)
        graph.ensure_schema(conn)

        for table in (
            "loop_mutations",
            "loop_plan_nodes",
            "loop_plan_edges",
            "loop_plan_events",
        ):
            columns = {
                row["name"] for row in conn.execute(f"PRAGMA table_info({table})")
            }
            assert "workflow_id" in columns
            assert "root_task_id" not in columns
            assert (
                conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE workflow_id = 'legacy-root'"
                ).fetchone()[0]
                == 1
            )

        duplicate = graph.apply_patch(
            conn,
            root_task_id="legacy-root",
            expected_revision=0,
            mutation_id="m1",
            operations=[],
        )
        assert duplicate["workflow_id"] == "legacy-root"
        assert "root_task_id" not in duplicate
        assert duplicate["duplicate"] is True
    finally:
        conn.close()


def test_rootless_workflow_persists_graph_events_without_task_event_mirror(
    workflow_graph_db,
):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    conn = workflow_graph_db
    workflow_id = kb.create_workflow(conn, title="Rootless graph")
    assert kb.get_task(conn, workflow_id) is None

    result = graph.apply_patch(
        conn,
        workflow_id,
        expected_revision=0,
        mutation_id="create-plan",
        operations=[{"op": "add_node", "client_id": "research", "title": "Research"}],
    )

    assert result["workflow_id"] == workflow_id
    assert "root_task_id" not in result
    assert result["graph_revision"] == 1
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM loop_plan_events WHERE workflow_id = ?",
            (workflow_id,),
        ).fetchone()[0]
        == 1
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM task_events WHERE kind = ?",
            (graph.LOOP_EVENT_KIND,),
        ).fetchone()[0]
        == 0
    )

    canonical = graph.read_graph(conn, workflow_id, include_nodes=True)
    compatibility = graph.read_graph(conn, root_task_id=workflow_id, include_nodes=True)
    assert canonical == compatibility
    assert canonical["workflow_id"] == workflow_id
    assert "root_task_id" not in canonical
    assert canonical["nodes"][0]["workflow_id"] == workflow_id
    assert "root_task_id" not in canonical["nodes"][0]


def test_task_membership_and_revision_use_typed_workflow_id(workflow_graph_db):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    conn = workflow_graph_db
    workflow_a = kb.create_workflow(conn, title="A")
    workflow_b = kb.create_workflow(conn, title="B")
    member = kb.create_task(
        conn,
        title="Member",
        created_by="foreground",
        workflow_id=workflow_a,
        initial_status="scheduled",
    )
    marker_only = kb.create_task(
        conn,
        title="Legacy-looking non-member",
        created_by=f"loop:{workflow_a}",
        workflow_id=workflow_b,
        initial_status="scheduled",
    )

    initial_revision = graph.graph_revision(conn, workflow_a)
    kb._append_event(conn, marker_only, "blocked", {"reason": "other workflow"})
    assert graph.graph_revision(conn, workflow_a) == initial_revision

    kb._append_event(conn, member, "blocked", {"reason": "same workflow"})
    assert graph.graph_revision(conn, workflow_a) == initial_revision + 1

    payload = graph.read_graph(conn, workflow_a, include_nodes=True)
    assert [node["task_id"] for node in payload["nodes"]] == [member]


def test_task_id_equal_to_legacy_workflow_id_is_not_special_or_immutable(
    workflow_graph_db,
):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    conn = workflow_graph_db
    workflow_id = "t_legacy_root"
    kb.create_workflow(conn, workflow_id=workflow_id, title="Legacy identity")
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "INSERT INTO tasks "
            "(id, title, status, created_at, workspace_kind, workflow_id) "
            "VALUES (?, 'Ordinary task', 'scheduled', ?, 'scratch', ?)",
            (workflow_id, now, workflow_id),
        )
        kb._append_event(conn, workflow_id, "created", {"status": "scheduled"})

    revision = graph.graph_revision(conn, workflow_id)
    result = graph.apply_patch(
        conn,
        workflow_id,
        expected_revision=revision,
        mutation_id="rename-former-root",
        operations=[
            {"op": "update_node", "task_id": workflow_id, "title": "Uniform task"}
        ],
    )

    assert result["updated"] == [workflow_id]
    assert kb.get_task(conn, workflow_id).title == "Uniform task"


def test_conflicting_legacy_identity_alias_is_rejected(workflow_graph_db):
    from hermes_cli import loop_graph as graph

    with pytest.raises(graph.LoopError, match="alias disagree"):
        graph.read_graph(
            workflow_graph_db,
            "wf_canonical",
            root_task_id="t_legacy",
        )


def test_graph_operations_reject_unknown_workflow(workflow_graph_db):
    from hermes_cli import loop_graph as graph

    with pytest.raises(graph.LoopError, match="unknown workflow"):
        graph.read_graph(workflow_graph_db, "wf_missing")

    with pytest.raises(graph.LoopError, match="unknown workflow"):
        graph.apply_patch(
            workflow_graph_db,
            "wf_missing",
            expected_revision=0,
            mutation_id="must-not-create-orphan-plan",
            operations=[{"op": "add_node", "title": "Orphan"}],
        )
