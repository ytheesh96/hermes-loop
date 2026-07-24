"""Workflow-first contracts for the Kanban dashboard Loop API."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb


def _load_plugin_router():
    plugin_file = (
        Path(__file__).resolve().parents[2]
        / "plugins"
        / "kanban"
        / "dashboard"
        / "plugin_api.py"
    )
    spec = importlib.util.spec_from_file_location(
        "hermes_dashboard_plugin_kanban_workflow_test",
        plugin_file,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.router


@pytest.fixture
def workflow_client(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    return TestClient(app)


def _create_draft(
    client: TestClient,
    title: str,
    *,
    session_id: str = "foreground-session",
    **payload,
) -> dict:
    response = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": title, "session_id": session_id, **payload},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_one_session_can_create_multiple_independent_workflows(workflow_client):
    first = _create_draft(workflow_client, "First workflow")
    second = _create_draft(workflow_client, "Second workflow")

    assert first["workflow_id"].startswith("wf_")
    assert second["workflow_id"].startswith("wf_")
    assert first["workflow_id"] != second["workflow_id"]
    assert "root_task_id" not in first
    assert "root_task_id" not in first["graph"]
    assert first["source"]["workflow_id"] == first["workflow_id"]
    assert "root_task_id" not in first["source"]
    assert first["task"]["workflow_id"] == first["workflow_id"]
    assert second["task"]["workflow_id"] == second["workflow_id"]

    with kb.connect() as conn:
        from hermes_cli import loop_graph

        first_task = kb.get_task(conn, first["task"]["id"])
        second_task = kb.get_task(conn, second["task"]["id"])
        links = conn.execute("SELECT parent_id, child_id FROM task_links").fetchall()
        for workflow_id, title in (
            (first["workflow_id"], "First option"),
            (second["workflow_id"], "Second option"),
        ):
            loop_graph.apply_patch(
                conn,
                workflow_id,
                expected_revision=loop_graph.graph_revision(conn, workflow_id),
                mutation_id=f"plan-{workflow_id}",
                operations=[
                    {
                        "op": "add_node",
                        "client_id": f"option-{workflow_id}",
                        "title": title,
                    }
                ],
            )

    assert first_task is not None and first_task.created_by == "dashboard"
    assert second_task is not None and second_task.created_by == "dashboard"
    assert links == []

    source = workflow_client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "foreground-session"},
    )
    assert source.status_code == 200, source.text
    payload = source.json()
    assert set(payload["workflow_ids"]) == {
        first["workflow_id"],
        second["workflow_id"],
    }
    assert payload["workflow_id"] is None
    assert "root_task_id" not in payload
    assert {item["workflow_id"] for item in payload["planning_nodes"]} == {
        first["workflow_id"],
        second["workflow_id"],
    }


def test_workflow_overview_batches_sessions_and_keeps_unattached_workflows(
    workflow_client,
):
    from hermes_state import SessionDB

    first = _create_draft(workflow_client, "First workflow", session_id="session-one")
    child = _create_draft(
        workflow_client,
        "First child",
        session_id="session-one",
        workflow_id=first["workflow_id"],
        parents=[first["task"]["id"]],
    )
    second = _create_draft(workflow_client, "Second workflow", session_id="session-two")

    with kb.connect() as conn:
        detached_id = kb.create_workflow(conn, title="Detached workflow")
        archived_id = kb.create_workflow(conn, title="Archived workflow")
        assert kb.close_workflow(conn, archived_id, archive=True)
        with kb.write_txn(conn):
            run_id = conn.execute(
                "INSERT INTO task_runs "
                "(task_id, profile, status, metadata, worker_pid, started_at) "
                "VALUES (?, ?, 'running', ?, ?, ?)",
                (
                    first["task"]["id"],
                    "reviewer-qa",
                    json.dumps({"worker_session_id": "worker-session-one"}),
                    4321,
                    12345,
                ),
            ).lastrowid
            conn.execute(
                "UPDATE tasks SET current_run_id = ? WHERE id = ?",
                (run_id, first["task"]["id"]),
            )
        worker_event_id = conn.execute(
            "SELECT MAX(id) FROM task_events WHERE task_id = ?",
            (first["task"]["id"],),
        ).fetchone()[0]

    session_db = SessionDB(db_path=Path(os.environ["HERMES_HOME"]) / "state.db")
    try:
        for session_id, title in (
            ("session-one", "Session one"),
            ("session-two", "Session two"),
        ):
            session_db.create_session(session_id=session_id, source="desktop")
            session_db.set_session_title(session_id, title)
    finally:
        session_db.close()

    response = workflow_client.get("/api/plugins/kanban/workflow-overview")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["errors"] == []
    assert "now" not in payload
    assert len(payload["boards"]) == 1

    board = payload["boards"][0]
    assert {workflow["id"] for workflow in board["workflows"]} == {
        first["workflow_id"],
        second["workflow_id"],
        detached_id,
    }
    assert archived_id not in {
        workflow["id"] for workflow in board["workflows"]
    }
    assert {task["id"] for task in board["tasks"]} == {
        first["task"]["id"],
        child["task"]["id"],
        second["task"]["id"],
    }
    assert board["links"] == [
        {"parent_id": first["task"]["id"], "child_id": child["task"]["id"]}
    ]
    child_payload = next(
        task for task in board["tasks"] if task["id"] == child["task"]["id"]
    )
    assert child_payload["included_parent_ids"] == [first["task"]["id"]]
    assert board["workers"] == [
        {
            "task_id": first["task"]["id"],
            "run_id": run_id,
            "profile": "reviewer-qa",
            "status": "running",
            "outcome": None,
            "worker_session_id": "worker-session-one",
            "worker_pid": 4321,
            "started_at": 12345,
            "ended_at": None,
            "last_heartbeat_at": None,
            "latest_event_id": worker_event_id,
        }
    ]
    assert {session["id"] for session in payload["sessions"]} == {
        "session-one",
        "session-two",
    }


def test_workflow_overview_reads_only_the_requested_profile_session_store(
    workflow_client,
):
    from hermes_state import SessionDB

    _create_draft(workflow_client, "Scoped workflow", session_id="shared-session")
    home = Path(os.environ["HERMES_HOME"])
    other_home = home / "profiles" / "other"
    other_home.mkdir(parents=True)

    for db_path, title, cwd in (
        (home / "state.db", "Default title", "/default"),
        (other_home / "state.db", "Other title", "/other"),
    ):
        session_db = SessionDB(db_path=db_path)
        try:
            session_db.create_session(
                session_id="shared-session", source="desktop", cwd=cwd
            )
            session_db.set_session_title("shared-session", title)
        finally:
            session_db.close()

    response = workflow_client.get(
        "/api/plugins/kanban/workflow-overview",
        params={"profile": "other"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["sessions"] == [
        {
            "id": "shared-session",
            "current_session_id": "shared-session",
            "lineage_session_ids": ["shared-session"],
            "title": "Other title",
            "cwd": "/other",
        }
    ]


def test_workflow_overview_keeps_workflow_and_task_revision_domains_separate(
    workflow_client,
):
    draft = _create_draft(
        workflow_client, "Closable workflow", session_id="missing-session"
    )
    before = workflow_client.get("/api/plugins/kanban/workflow-overview").json()[
        "boards"
    ][0]
    before_workflow = next(
        item for item in before["workflows"] if item["id"] == draft["workflow_id"]
    )

    with kb.connect() as conn:
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET status = 'done' WHERE id = ?", (draft["task"]["id"],)
            )
        assert kb.close_workflow(conn, draft["workflow_id"])

    after = workflow_client.get("/api/plugins/kanban/workflow-overview").json()[
        "boards"
    ][0]
    workflow = next(
        item for item in after["workflows"] if item["id"] == draft["workflow_id"]
    )

    assert after["source_revision"] == before["source_revision"]
    assert workflow["status"] == "closed"
    assert workflow["revision"] == before_workflow["revision"] + 1
    assert (
        workflow_client.get(
            "/api/plugins/kanban/workflow-overview",
            params={"profile": "does-not-exist"},
        ).status_code
        == 404
    )


def test_create_extends_a_workflow_without_a_root_card_or_sink_edge(
    workflow_client,
):
    first = _create_draft(workflow_client, "Research")
    workflow_id = first["workflow_id"]
    second = _create_draft(
        workflow_client,
        "Implement",
        workflow_id=workflow_id,
        parents=[first["task"]["id"]],
    )
    legacy_alias = _create_draft(
        workflow_client,
        "Review",
        root_task_id=first["task"]["id"],
    )

    assert second["workflow_id"] == workflow_id
    assert legacy_alias["workflow_id"] == workflow_id

    with kb.connect() as conn:
        assert kb.parent_ids(conn, second["task"]["id"]) == [first["task"]["id"]]
        assert kb.parent_ids(conn, first["task"]["id"]) == []
        assert kb.parent_ids(conn, legacy_alias["task"]["id"]) == []
        assert {
            kb.get_task(conn, task_id).workflow_id
            for task_id in (
                first["task"]["id"],
                second["task"]["id"],
                legacy_alias["task"]["id"],
            )
        } == {workflow_id}


def test_plain_task_create_accepts_explicit_workflow_membership(workflow_client):
    draft = _create_draft(workflow_client, "Workflow anchor")
    created = workflow_client.post(
        "/api/plugins/kanban/tasks",
        json={
            "title": "Foreground follow-up",
            "workflow_id": draft["workflow_id"],
            "triage": True,
        },
    )

    assert created.status_code == 200, created.text
    assert created.json()["task"]["workflow_id"] == draft["workflow_id"]


def test_graph_and_link_routes_are_workflow_scoped(workflow_client):
    first = _create_draft(workflow_client, "First")
    second = _create_draft(
        workflow_client,
        "Second",
        workflow_id=first["workflow_id"],
    )
    outsider = _create_draft(
        workflow_client,
        "Other workflow",
        session_id="foreground-session",
    )

    linked = workflow_client.post(
        "/api/plugins/kanban/links",
        json={
            "workflow_id": first["workflow_id"],
            "parent_id": first["task"]["id"],
            "child_id": second["task"]["id"],
        },
    )
    assert linked.status_code == 200, linked.text

    rejected = workflow_client.post(
        "/api/plugins/kanban/links",
        json={
            "workflow_id": first["workflow_id"],
            "parent_id": first["task"]["id"],
            "child_id": outsider["task"]["id"],
        },
    )
    assert rejected.status_code == 400
    assert "not owned by workflow" in rejected.json()["detail"]

    graph = workflow_client.get(
        f"/api/plugins/kanban/loop-graph/{first['workflow_id']}",
        params={"include_nodes": True},
    )
    assert graph.status_code == 200, graph.text
    assert graph.json()["workflow_id"] == first["workflow_id"]
    assert "root_task_id" not in graph.json()
    assert "pending_handoffs" not in graph.json()
    assert all("root_task_id" not in node for node in graph.json()["nodes"])
    assert all("handoff" not in node for node in graph.json()["nodes"])
    assert {node["task_id"] for node in graph.json()["nodes"]} == {
        first["task"]["id"],
        second["task"]["id"],
    }

    patched = workflow_client.patch(
        f"/api/plugins/kanban/loop-graph/{first['workflow_id']}",
        json={
            "expected_revision": graph.json()["graph_revision"],
            "mutation_id": "validate-workflow-contract",
            "operations": [{"op": "validate"}],
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["workflow_id"] == first["workflow_id"]
    assert "root_task_id" not in patched.json()
    assert "pending_handoffs" not in patched.json()

    legacy_route = workflow_client.get(
        f"/api/plugins/kanban/loop-graph/{first['task']['id']}"
    )
    assert legacy_route.status_code == 200, legacy_route.text
    assert legacy_route.json()["workflow_id"] == first["workflow_id"]


def test_canvas_schema_migrates_and_membership_uses_workflow_id(
    workflow_client,
):
    first = _create_draft(workflow_client, "Canvas A")
    sibling = _create_draft(
        workflow_client,
        "Disconnected member",
        workflow_id=first["workflow_id"],
    )
    other = _create_draft(
        workflow_client,
        "Canvas B",
        session_id="foreground-session",
    )

    with kb.connect() as conn:
        conn.execute(
            """
            CREATE TABLE loop_canvas_positions (
                root_task_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (root_task_id, task_id)
            )
            """
        )
        conn.execute(
            "INSERT INTO loop_canvas_positions "
            "(root_task_id, task_id, x, y, updated_at) VALUES (?, ?, ?, ?, ?)",
            (first["task"]["id"], first["task"]["id"], 12.0, 34.0, 1),
        )

    migrated = workflow_client.get(
        f"/api/plugins/kanban/loop-canvas/{first['workflow_id']}/positions"
    )
    assert migrated.status_code == 200, migrated.text
    assert migrated.json()["workflow_id"] == first["workflow_id"]
    assert "root_task_id" not in migrated.json()
    assert migrated.json()["positions"][0]["task_id"] == first["task"]["id"]

    with kb.connect() as conn:
        columns = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(loop_canvas_positions)"
            ).fetchall()
        }
        [owner] = conn.execute(
            "SELECT DISTINCT workflow_id FROM loop_canvas_positions"
        ).fetchall()
    assert "workflow_id" in columns
    assert "root_task_id" not in columns
    assert owner["workflow_id"] == first["workflow_id"]

    valid = workflow_client.put(
        f"/api/plugins/kanban/loop-canvas/{first['workflow_id']}/positions",
        json={
            "positions": [
                {"task_id": first["task"]["id"], "x": 1, "y": 2},
                {"task_id": sibling["task"]["id"], "x": 3, "y": 4},
            ]
        },
    )
    assert valid.status_code == 200, valid.text
    assert "root_task_id" not in valid.json()
    assert {item["task_id"] for item in valid.json()["positions"]} == {
        first["task"]["id"],
        sibling["task"]["id"],
    }

    rejected = workflow_client.put(
        f"/api/plugins/kanban/loop-canvas/{first['workflow_id']}/positions",
        params={"session_id": "foreground-session"},
        json={
            "positions": [
                {"task_id": other["task"]["id"], "x": 5, "y": 6},
            ]
        },
    )
    assert rejected.status_code == 400
    assert "outside workflow" in rejected.json()["detail"]

    legacy_route = workflow_client.get(
        f"/api/plugins/kanban/loop-canvas/{first['task']['id']}/positions"
    )
    assert legacy_route.status_code == 200, legacy_route.text
    assert legacy_route.json()["workflow_id"] == first["workflow_id"]
