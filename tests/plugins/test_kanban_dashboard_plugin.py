"""Tests for the Kanban dashboard plugin backend (plugins/kanban/dashboard/plugin_api.py).

The plugin mounts as /api/plugins/kanban/ inside the dashboard's FastAPI app,
but here we attach its router to a bare FastAPI instance so we can test the
REST surface without spinning up the whole dashboard.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _load_plugin_router():
    """Dynamically load plugins/kanban/dashboard/plugin_api.py and return its router."""
    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    assert plugin_file.exists(), f"plugin file missing: {plugin_file}"

    spec = importlib.util.spec_from_file_location(
        "hermes_dashboard_plugin_kanban_test", plugin_file,
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod.router


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME with an empty kanban DB."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def client(kanban_home):
    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    return TestClient(app)


def _loop_node(
    conn,
    *,
    root_task_id: str = "t_looproot",
    tenant: str = "tenant-a",
    session_id: str = "origin-session",
) -> str:
    task_id = kb.create_task(
        conn,
        title="loop worker node",
        assignee="implementation-worker",
        created_by=f"loop:{root_task_id}",
        tenant=tenant,
        session_id=session_id,
    )
    with kb.write_txn(conn):
        kb._append_event(
            conn,
            task_id,
            "loop_node_state",
            {
                "root_task_id": root_task_id,
                "client_id": "loop-worker-node",
                "active": True,
                "frontier": True,
            },
        )
    return task_id


# ---------------------------------------------------------------------------
# GET /board on an empty DB
# ---------------------------------------------------------------------------


def test_board_empty(client):
    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    data = r.json()
    # All canonical columns present (triage + the rest), each empty.
    names = [c["name"] for c in data["columns"]]
    assert set(names) == kb.VALID_STATUSES - {"archived"}
    for expected in ("triage", "todo", "scheduled", "ready", "running", "blocked", "done"):
        assert expected in names, f"missing column {expected}: {names}"
    assert all(len(c["tasks"]) == 0 for c in data["columns"])
    assert data["tenants"] == []
    assert data["assignees"] == []
    assert data["latest_event_id"] == 0


# ---------------------------------------------------------------------------
# POST /tasks then GET /board sees it
# ---------------------------------------------------------------------------


def test_create_task_appears_on_board(client):
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={
            "title": "Research LLM caching",
            "assignee": "researcher",
            "priority": 3,
            "tenant": "acme",
        },
    )
    assert r.status_code == 200, r.text
    task = r.json()["task"]
    assert task["title"] == "Research LLM caching"
    assert task["assignee"] == "researcher"
    assert task["status"] == "ready"  # no parents -> immediately ready
    assert task["priority"] == 3
    assert task["tenant"] == "acme"
    task_id = task["id"]

    # Board now lists it under 'ready'.
    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    data = r.json()
    ready = next(c for c in data["columns"] if c["name"] == "ready")
    assert len(ready["tasks"]) == 1
    assert ready["tasks"][0]["id"] == task_id
    assert "acme" in data["tenants"]
    assert "researcher" in data["assignees"]


def test_create_task_upserts_triage_draft_root_without_dispatch_run(client):
    """Draft roots are real triage rows, not dummy containers or dispatched workers."""

    payload = {
        "title": "Draft Loop root",
        "body": "Spec before decomposition",
        "assignee": "orchestrator",
        "tenant": "draft-root-tenant",
        "triage": True,
        "idempotency_key": "draft-root:first",
    }

    first = client.post("/api/plugins/kanban/tasks", json=payload)
    second = client.post("/api/plugins/kanban/tasks", json={**payload, "title": "ignored duplicate"})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    task = first.json()["task"]
    assert second.json()["task"]["id"] == task["id"]
    assert task["status"] == "triage"
    assert task["tenant"] == "draft-root-tenant"
    assert "warning" not in first.json()

    conn = kb.connect()
    try:
        persisted = kb.get_task(conn, task["id"])
        runs = kb.list_runs(conn, task["id"])
    finally:
        conn.close()

    assert persisted is not None
    assert persisted.status == "triage"
    assert runs == []


def test_create_loop_draft_anchors_session_source_and_real_root(client):
    payload = {
        "title": "Draft overview",
        "body": "User-visible draft spec",
        "session_id": "session-draft-1",
    }

    first = client.post("/api/plugins/kanban/loop-drafts", json=payload)
    second = client.post("/api/plugins/kanban/loop-drafts", json={**payload, "title": "duplicate ignored"})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    task = first.json()["task"]
    assert task["id"] == second.json()["task"]["id"]
    assert task["title"] == "Draft overview"
    assert task["status"] == "scheduled"
    assert task["session_id"] == "session-draft-1"
    assert task["tenant"] is None
    assert task["created_by"] == f"loop:{task['id']}"

    source = first.json()["source"]
    assert source["root_task_id"] == task["id"]
    assert source["session_id"] == "session-draft-1"
    assert source["tasks"][0]["id"] == task["id"]

    session_source = client.get("/api/plugins/kanban/session-source", params={"session_id": "session-draft-1"})
    assert session_source.status_code == 200, session_source.text
    session_payload = session_source.json()
    assert session_payload["root_task_id"] == task["id"]
    assert [item["id"] for item in session_payload["tasks"]] == [task["id"]]

    conn = kb.connect()
    try:
        persisted = kb.get_task(conn, task["id"])
        runs = kb.list_runs(conn, task["id"])
    finally:
        conn.close()

    assert persisted is not None
    assert persisted.created_by == f"loop:{task['id']}"
    assert persisted.status == "scheduled"
    assert persisted.tenant is None
    assert runs == []


def test_loop_canvas_positions_round_trip_replace_and_clear_without_task_events(client):
    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Canvas root", "session_id": "session-canvas-layout"},
    ).json()["task"]
    child = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Canvas child", "session_id": "session-canvas-layout", "triage": True},
    ).json()["task"]

    empty = client.get(f"/api/plugins/kanban/loop-canvas/{root['id']}/positions")
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"root_task_id": root["id"], "positions": []}

    conn = kb.connect()
    try:
        event_count = conn.execute("SELECT COUNT(*) AS n FROM task_events").fetchone()["n"]
    finally:
        conn.close()

    saved = client.put(
        f"/api/plugins/kanban/loop-canvas/{root['id']}/positions",
        json={
            "positions": [
                {"task_id": child["id"], "x": 420.5, "y": -18.25},
                {"task_id": root["id"], "x": 32, "y": 64},
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    payload = saved.json()
    assert payload["ok"] is True
    assert payload["root_task_id"] == root["id"]
    assert [item["task_id"] for item in payload["positions"]] == sorted([root["id"], child["id"]])
    assert {(item["task_id"], item["x"], item["y"]) for item in payload["positions"]} == {
        (root["id"], 32.0, 64.0),
        (child["id"], 420.5, -18.25),
    }
    assert all(isinstance(item["updated_at"], int) for item in payload["positions"])

    read_back = client.get(f"/api/plugins/kanban/loop-canvas/{root['id']}/positions")
    assert read_back.status_code == 200, read_back.text
    assert read_back.json() == {"root_task_id": root["id"], "positions": payload["positions"]}

    replaced = client.put(
        f"/api/plugins/kanban/loop-canvas/{root['id']}/positions",
        json={"positions": [{"task_id": child["id"], "x": 7, "y": 9}]},
    )
    assert replaced.status_code == 200, replaced.text
    assert [(item["task_id"], item["x"], item["y"]) for item in replaced.json()["positions"]] == [
        (child["id"], 7.0, 9.0)
    ]

    cleared = client.put(
        f"/api/plugins/kanban/loop-canvas/{root['id']}/positions",
        json={"positions": []},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json() == {"ok": True, "root_task_id": root["id"], "positions": []}

    conn = kb.connect()
    try:
        assert conn.execute("SELECT COUNT(*) AS n FROM task_events").fetchone()["n"] == event_count
        assert kb.get_task(conn, root["id"]).status == "scheduled"
        assert kb.get_task(conn, child["id"]).status == "triage"
    finally:
        conn.close()


def test_loop_canvas_positions_validate_before_replacing_saved_layout(client):
    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Validated canvas", "session_id": "session-canvas-validation"},
    ).json()["task"]
    path = f"/api/plugins/kanban/loop-canvas/{root['id']}/positions"

    initial = client.put(
        path,
        json={"positions": [{"task_id": root["id"], "x": 1, "y": 2}]},
    )
    assert initial.status_code == 200, initial.text

    unknown_root = client.get("/api/plugins/kanban/loop-canvas/t_missing/positions")
    assert unknown_root.status_code == 404

    unknown_task = client.put(
        path,
        json={"positions": [{"task_id": "t_missing", "x": 3, "y": 4}]},
    )
    assert unknown_task.status_code == 400
    assert "unknown task" in unknown_task.json()["detail"]

    duplicate = client.put(
        path,
        json={
            "positions": [
                {"task_id": root["id"], "x": 3, "y": 4},
                {"task_id": root["id"], "x": 5, "y": 6},
            ]
        },
    )
    assert duplicate.status_code == 400
    assert "duplicate position" in duplicate.json()["detail"]

    too_large = client.put(
        path,
        json={"positions": [{"task_id": root["id"], "x": 1_000_001, "y": 0}]},
    )
    assert too_large.status_code == 400
    assert "coordinate limit" in too_large.json()["detail"]

    unchanged = client.get(path)
    assert unchanged.status_code == 200, unchanged.text
    [position] = unchanged.json()["positions"]
    assert (position["task_id"], position["x"], position["y"]) == (root["id"], 1.0, 2.0)


def test_loop_canvas_positions_are_scoped_to_root_component_and_session(client):
    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Canvas root", "session_id": "session-canvas-a"},
    ).json()["task"]
    same_session = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Disconnected card", "session_id": "session-canvas-a", "triage": True},
    ).json()["task"]
    connected = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Cross-session card", "session_id": "session-canvas-b", "triage": True},
    ).json()["task"]
    unrelated = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Other canvas", "session_id": "session-canvas-c", "triage": True},
    ).json()["task"]
    assert client.post(
        "/api/plugins/kanban/links",
        json={"parent_id": root["id"], "child_id": connected["id"]},
    ).status_code == 200

    path = f"/api/plugins/kanban/loop-canvas/{root['id']}/positions"
    allowed = client.put(
        path,
        json={
            "positions": [
                {"task_id": same_session["id"], "x": 10, "y": 20},
                {"task_id": connected["id"], "x": 30, "y": 40},
            ]
        },
    )
    assert allowed.status_code == 200, allowed.text

    rejected = client.put(
        path,
        json={"positions": [{"task_id": unrelated["id"], "x": 50, "y": 60}]},
    )
    assert rejected.status_code == 400
    assert "outside Loop canvas" in rejected.json()["detail"]
    assert {position["task_id"] for position in client.get(path).json()["positions"]} == {
        same_session["id"],
        connected["id"],
    }


def test_loop_canvas_positions_omit_archived_cards_from_session_scope(client):
    session_id = "session-canvas-archived-position"
    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Canvas root", "session_id": session_id},
    ).json()["task"]
    card = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Temporary card", "session_id": session_id, "triage": True},
    ).json()["task"]
    path = f"/api/plugins/kanban/loop-canvas/{root['id']}/positions"
    scope = {"session_id": session_id}

    saved = client.put(
        path,
        params=scope,
        json={
            "positions": [
                {"task_id": root["id"], "x": 10, "y": 20},
                {"task_id": card["id"], "x": 30, "y": 40},
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    assert client.patch(
        f"/api/plugins/kanban/tasks/{card['id']}",
        json={"status": "archived"},
    ).status_code == 200

    visible = client.get(path, params=scope)
    assert visible.status_code == 200, visible.text
    assert [position["task_id"] for position in visible.json()["positions"]] == [root["id"]]

    round_trip = client.put(
        path,
        params=scope,
        json={
            "positions": [
                {key: position[key] for key in ("task_id", "x", "y")}
                for position in visible.json()["positions"]
            ]
        },
    )
    assert round_trip.status_code == 200, round_trip.text


def test_loop_canvas_session_scope_matches_compression_lineage_source(client, kanban_home):
    from hermes_state import SessionDB

    session_db = SessionDB()
    try:
        session_db.create_session("canvas-root-session", "tui")
        session_db.end_session("canvas-root-session", "compression")
        session_db.create_session(
            "canvas-tip-session",
            "tui",
            parent_session_id="canvas-root-session",
        )
    finally:
        session_db.close()

    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Pre-compression root", "session_id": "canvas-root-session"},
    ).json()["task"]
    second_root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Post-compression root", "session_id": "canvas-tip-session"},
    ).json()["task"]
    unrelated = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Other session", "session_id": "unrelated-session"},
    ).json()["task"]
    path = f"/api/plugins/kanban/loop-canvas/{root['id']}/positions"
    scope = {"board": "default", "session_id": "canvas-tip-session"}

    saved = client.put(
        path,
        params=scope,
        json={
            "positions": [
                {"task_id": root["id"], "x": 10, "y": 20},
                {"task_id": second_root["id"], "x": 30, "y": 40},
            ]
        },
    )
    assert saved.status_code == 200, saved.text

    linked = client.post(
        "/api/plugins/kanban/links",
        params={"board": "default"},
        json={
            "parent_id": root["id"],
            "child_id": second_root["id"],
            "root_task_id": root["id"],
            "session_id": "canvas-tip-session",
        },
    )
    assert linked.status_code == 200, linked.text

    rejected_position = client.put(
        path,
        params=scope,
        json={"positions": [{"task_id": unrelated["id"], "x": 50, "y": 60}]},
    )
    assert rejected_position.status_code == 400
    assert "outside Loop canvas" in rejected_position.json()["detail"]

    rejected_link = client.post(
        "/api/plugins/kanban/links",
        params={"board": "default"},
        json={
            "parent_id": root["id"],
            "child_id": unrelated["id"],
            "root_task_id": root["id"],
            "session_id": "canvas-tip-session",
        },
    )
    assert rejected_link.status_code == 400
    assert "outside Loop canvas" in rejected_link.json()["detail"]

    rejected_root = client.get(
        f"/api/plugins/kanban/loop-canvas/{unrelated['id']}/positions",
        params=scope,
    )
    assert rejected_root.status_code == 400
    assert "outside Loop canvas" in rejected_root.json()["detail"]


def test_create_loop_draft_preserves_explicit_tenant_metadata(client):
    first = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={
            "title": "Draft with tenant metadata",
            "body": "Visible draft spec",
            "session_id": "session-draft-tenant",
            "tenant": "custom-origin-metadata",
        },
    )

    assert first.status_code == 200, first.text
    task = first.json()["task"]
    assert task["session_id"] == "session-draft-tenant"
    assert task["tenant"] == "custom-origin-metadata"

    session_source = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "session-draft-tenant"},
    )
    assert session_source.status_code == 200, session_source.text
    assert [item["id"] for item in session_source.json()["tasks"]] == [task["id"]]


def test_title_only_loop_draft_records_durable_intake_needed_state(client):
    """Title-only /loop rows expose a durable, machine-readable intake marker."""

    created = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Needs intake", "session_id": "session-intake-1"},
    )

    assert created.status_code == 200, created.text
    task = created.json()["task"]
    assert task["body"] is None
    assert task["status"] == "scheduled"
    assert task["loop_intake"] == {
        "needed": True,
        "state": "drafted",
        "source": "slash_loop_draft",
        "dispatchable": False,
    }
    assert created.json()["source"]["tasks"][0]["loop_intake"] == task["loop_intake"]

    session_source = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "session-intake-1"},
    )
    assert session_source.status_code == 200, session_source.text
    assert session_source.json()["tasks"][0]["loop_intake"] == task["loop_intake"]

    detail = client.get(f"/api/plugins/kanban/tasks/{task['id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["loop_intake"] == task["loop_intake"]

    conn = kb.connect()
    try:
        events = kb.list_events(conn, task["id"])
    finally:
        conn.close()

    intake_events = [event for event in events if event.kind == "loop_intake_state"]
    assert len(intake_events) == 1
    assert intake_events[0].payload["needed"] is True
    assert intake_events[0].payload["state"] == "drafted"


def test_loop_intake_needed_blocks_ready_and_decompose_until_approved(client):
    created = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Blocked activation", "session_id": "session-intake-2"},
    )
    task_id = created.json()["task"]["id"]
    initial_assignee = created.json()["task"].get("assignee")

    ready = client.patch(f"/api/plugins/kanban/tasks/{task_id}", json={"status": "ready"})
    assert ready.status_code == 409
    assert "Loop intake is still required" in ready.json()["detail"]

    decompose = client.post(f"/api/plugins/kanban/tasks/{task_id}/decompose", json={})
    assert decompose.status_code == 200, decompose.text
    assert decompose.json()["ok"] is False
    assert "Loop intake is still required" in decompose.json()["reason"]

    still_planning = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert still_planning.json()["task"]["status"] == "scheduled"

    approved_body = "Chosen path remains visible in the Loop graph.\n"
    approved = client.patch(
        f"/api/plugins/kanban/tasks/{task_id}",
        json={
            "body": approved_body,
            "loop_intake": {
                "needed": True,
                "state": "approved",
                "source": "user_approval",
                "dispatchable": True,
            },
        },
    )
    assert approved.status_code == 200, approved.text
    approved_task = approved.json()["task"]
    assert approved_task["body"] == approved_body
    assert approved_task["status"] == "scheduled"
    assert approved_task["assignee"] == initial_assignee
    assert approved_task["loop_intake"]["state"] == "approved"
    assert approved_task["loop_intake"]["dispatchable"] is True

    approval_source = client.get("/api/plugins/kanban/session-source", params={"session_id": "session-intake-2"})
    assert approval_source.status_code == 200, approval_source.text
    assert approval_source.json()["root_task_id"] == task_id
    assert [item["id"] for item in approval_source.json()["tasks"]] == [task_id]
    assert approval_source.json()["workers"] == []

    conn = kb.connect()
    try:
        persisted_after_approval = kb.get_task(conn, task_id)
        runs_after_approval = kb.list_runs(conn, task_id)
        children_after_approval = kb.child_ids(conn, task_id)
    finally:
        conn.close()

    assert persisted_after_approval is not None
    assert persisted_after_approval.status == "scheduled"
    assert persisted_after_approval.assignee == initial_assignee
    assert runs_after_approval == []
    assert children_after_approval == []

    ready_after_approval = client.patch(f"/api/plugins/kanban/tasks/{task_id}", json={"status": "ready"})
    assert ready_after_approval.status_code == 200, ready_after_approval.text
    assert ready_after_approval.json()["task"]["status"] == "ready"


def test_decompose_submit_approves_loop_intake_before_decomposing(client, monkeypatch):
    created = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Submit approves intake", "session_id": "session-intake-submit"},
    )
    task_id = created.json()["task"]["id"]
    calls = []

    def fake_decompose_task(decompose_task_id, *, author=None, loop_safe=False):
        calls.append((decompose_task_id, author, loop_safe))

        return SimpleNamespace(
            ok=True,
            task_id=decompose_task_id,
            reason=None,
            fanout=False,
            child_ids=[],
            new_title=None,
        )

    monkeypatch.setattr("hermes_cli.kanban_decompose.decompose_task", fake_decompose_task)

    submitted = client.post(
        f"/api/plugins/kanban/tasks/{task_id}/decompose",
        json={"approve_intake": True, "author": "desktop-submit"},
    )

    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["ok"] is True
    assert calls == [(task_id, "desktop-submit", False)]

    detail = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["loop_intake"] == {
        "needed": True,
        "state": "approved",
        "source": "desktop_submit",
        "dispatchable": True,
    }


def test_decompose_submit_can_approve_loop_safe_planning_without_dispatchability(client, monkeypatch):
    created = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Submit plans safely", "session_id": "session-intake-loop-safe"},
    )
    task_id = created.json()["task"]["id"]
    calls = []

    def fake_decompose_task(decompose_task_id, *, author=None, loop_safe=False):
        calls.append((decompose_task_id, author, loop_safe))

        return SimpleNamespace(
            ok=True,
            task_id=decompose_task_id,
            reason=None,
            fanout=True,
            child_ids=["t_option"],
            new_title=None,
        )

    monkeypatch.setattr("hermes_cli.kanban_decompose.decompose_task", fake_decompose_task)

    submitted = client.post(
        f"/api/plugins/kanban/tasks/{task_id}/decompose",
        json={"approve_intake": True, "author": "desktop-submit", "loop_safe": True},
    )

    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["ok"] is True
    assert calls == [(task_id, "desktop-submit", True)]

    detail = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["task"]["loop_intake"] == {
        "needed": True,
        "state": "approved",
        "source": "desktop_submit",
        "dispatchable": False,
    }

    ready = client.patch(f"/api/plugins/kanban/tasks/{task_id}", json={"status": "ready"})
    assert ready.status_code == 409
    assert "Loop intake is still required" in ready.json()["detail"]


def test_bodyful_loop_draft_and_unrelated_triage_rows_do_not_need_intake(client):
    bodyful = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Has body", "body": "Already specified", "session_id": "session-specified"},
    )
    assert bodyful.status_code == 200, bodyful.text
    assert "loop_intake" not in bodyful.json()["task"]

    unrelated = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Plain triage", "triage": True, "tenant": "session-specified"},
    )
    assert unrelated.status_code == 200, unrelated.text
    assert "loop_intake" not in unrelated.json()["task"]



def test_board_list_recommends_persistent_workspace_for_configured_workdir(
    client, tmp_path
):
    """Board metadata should tell the UI which safe task default to use."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    kb.write_board_metadata("default", default_workdir=str(repo))

    plain_dir = tmp_path / "notes"
    plain_dir.mkdir()
    kb.create_board("notes", default_workdir=str(plain_dir))
    kb.create_board("disposable")

    response = client.get("/api/plugins/kanban/boards")

    assert response.status_code == 200
    boards = {board["slug"]: board for board in response.json()["boards"]}
    assert boards["default"]["default_workspace_kind"] == "worktree"
    assert boards["notes"]["default_workspace_kind"] == "dir"
    assert boards["disposable"]["default_workspace_kind"] == "scratch"


def test_create_board_persists_project_directory(client, tmp_path):
    """The dashboard board form should anchor future tasks to its project."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()

    response = client.post(
        "/api/plugins/kanban/boards",
        json={
            "slug": "project-board",
            "name": "Project Board",
            "default_workdir": str(project_dir),
        },
    )

    assert response.status_code == 200, response.text
    board = response.json()["board"]
    assert board["default_workdir"] == str(project_dir.resolve())
    assert board["default_workspace_kind"] == "dir"
    assert kb.read_board_metadata("project-board")["default_workdir"] == str(
        project_dir.resolve()
    )


@pytest.mark.parametrize("path", ["relative/project", "~/missing-project"])
def test_create_board_rejects_invalid_project_directory(client, path):
    """A board must not persist a path that cannot anchor worker output."""
    response = client.post(
        "/api/plugins/kanban/boards",
        json={"slug": "invalid-project", "default_workdir": path},
    )

    assert response.status_code == 400
    assert "project directory" in response.json()["detail"].lower()


def test_patch_board_sets_project_directory(client, tmp_path):
    """Board-level default_workdir must be editable after creation."""
    kb.create_board("late-config")
    project_dir = tmp_path / "late-project"
    project_dir.mkdir()

    response = client.patch(
        "/api/plugins/kanban/boards/late-config",
        json={"default_workdir": str(project_dir)},
    )

    assert response.status_code == 200, response.text
    board = response.json()["board"]
    assert board["default_workdir"] == str(project_dir.resolve())
    # The recommendation flips from scratch to a persistent kind so the
    # create-task dialog's workspace default follows the board setting.
    assert board["default_workspace_kind"] == "dir"
    assert kb.read_board_metadata("late-config")["default_workdir"] == str(
        project_dir.resolve()
    )


def test_patch_board_clears_project_directory(client, tmp_path):
    """Empty string clears default_workdir; omitting it leaves it unchanged."""
    project_dir = tmp_path / "was-configured"
    project_dir.mkdir()
    kb.create_board("clearable", default_workdir=str(project_dir))

    # Omitted key → unchanged.
    r = client.patch(
        "/api/plugins/kanban/boards/clearable",
        json={"name": "Renamed Only"},
    )
    assert r.status_code == 200
    assert r.json()["board"]["default_workdir"] == str(project_dir.resolve())

    # Empty string → cleared, recommendation falls back to scratch.
    r = client.patch(
        "/api/plugins/kanban/boards/clearable",
        json={"default_workdir": ""},
    )
    assert r.status_code == 200
    board = r.json()["board"]
    assert not board.get("default_workdir")
    assert board["default_workspace_kind"] == "scratch"


@pytest.mark.parametrize("path", ["relative/project", "~/missing-project"])
def test_patch_board_rejects_invalid_project_directory(client, path):
    """PATCH must validate default_workdir like board creation does."""
    kb.create_board("strict")

    response = client.patch(
        "/api/plugins/kanban/boards/strict",
        json={"default_workdir": path},
    )

    assert response.status_code == 400
    assert "project directory" in response.json()["detail"].lower()


def test_new_board_dialog_collects_project_directory():
    """Board creation should expose the setting that controls safe task defaults."""
    bundle = (
        Path(__file__).resolve().parents[2]
        / "plugins"
        / "kanban"
        / "dashboard"
        / "dist"
        / "index.js"
    ).read_text(encoding="utf-8")

    assert 'const [projectDirectory, setProjectDirectory] = useState("");' in bundle
    assert "Project directory" in bundle
    assert "Absolute path to the project folder" in bundle
    assert "default_workdir: projectDirectory.trim() || undefined" in bundle


def test_dashboard_workspace_picker_explains_persistence_contract():
    """Task creation must make scratch deletion visible without a hover."""
    bundle = (
        Path(__file__).resolve().parents[2]
        / "plugins"
        / "kanban"
        / "dashboard"
        / "dist"
        / "index.js"
    ).read_text(encoding="utf-8")

    assert "Temporary — deleted on completion" in bundle
    assert "Git worktree — preserved" in bundle
    assert "Directory — preserved" in bundle
    assert "defaultWorkspacePath: (props.boardMeta && props.boardMeta.default_workdir) || \"\"" in bundle
    assert (
        "This workspace and any files left in it are deleted when the task completes."
        in bundle
    )


def test_scheduled_tasks_have_their_own_column_not_todo(client):
    """Scheduled/time-delay tasks must not be silently bucketed into todo."""

    task = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "wait for indexed data", "assignee": "ops"},
    ).json()["task"]

    conn = kb.connect()
    try:
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET status = 'scheduled' WHERE id = ?",
                (task["id"],),
            )
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    columns = {c["name"]: c["tasks"] for c in r.json()["columns"]}
    assert any(t["id"] == task["id"] for t in columns["scheduled"])
    assert not any(t["id"] == task["id"] for t in columns["todo"])


def test_tenant_filter(client):
    client.post("/api/plugins/kanban/tasks", json={"title": "A", "tenant": "t1"})
    client.post("/api/plugins/kanban/tasks", json={"title": "B", "tenant": "t2"})

    r = client.get("/api/plugins/kanban/board?tenant=t1")
    counts = {c["name"]: len(c["tasks"]) for c in r.json()["columns"]}
    total = sum(counts.values())
    assert total == 1

    r = client.get("/api/plugins/kanban/board?tenant=t2")
    total = sum(len(c["tasks"]) for c in r.json()["columns"])
    assert total == 1


def test_loop_handoff_plugin_routes_expose_detail_and_action():
    routes = {
        (route.path, tuple(sorted(method for method in route.methods if method not in {"HEAD", "OPTIONS"})))
        for route in _load_plugin_router().routes
        if "loop-handoffs" in route.path
    }

    assert ("/loop-handoffs", ("GET",)) in routes
    assert ("/loop-handoffs/{handoff_id}", ("GET",)) in routes
    assert ("/loop-handoffs/{handoff_id}/auto-action", ("POST",)) in routes


def test_loop_handoff_plugin_list_is_empty_after_removal(client, tmp_path):
    conn = kb.connect()
    try:
        task_id = _loop_node(conn)
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="implementation complete",
            metadata={
                "worker_session_id": "worker-session-1",
                "artifacts": [str(tmp_path / "proof.log")],
                "changed_files": ["src/app.py"],
                "tests_run": ["pytest -q"],
            },
        )
        handoffs = kb.list_loop_handoffs(conn)
    finally:
        conn.close()

    assert handoffs == []
    listing = client.get("/api/plugins/kanban/loop-handoffs", params={"board": "default"})
    assert listing.status_code == 200, listing.text
    assert listing.json() == {"ok": True, "handoffs": []}

    status = client.get(
        "/api/plugins/kanban/loop-handoffs",
        params={"tenant": "tenant-a", "root_task_id": "t_looproot", "status_only": True, "board": "default"},
    )
    assert status.status_code == 200, status.text
    assert status.json()["quiet_green"] is False
    assert status.json()["escalated_count"] == 0


def test_session_source_attaches_orchestrator_fork_metadata(client):
    conn = kb.connect()
    try:
        task_id = _loop_node(conn, session_id="sess-parent")
        with kb.write_txn(conn):
            conn.execute(
                """
                UPDATE tasks
                   SET status = 'review',
                       assignee = 'orchestrator',
                       review_kind = 'blocker_triage',
                       resume_mode = 'fork',
                       review_subject_assignee = 'peacock',
                       foreground_parent_session_id = 'sess-parent',
                       foreground_fork_session_id = 'sess-fork'
                 WHERE id = ?
                """,
                (task_id,),
            )
    finally:
        conn.close()

    source = client.get("/api/plugins/kanban/session-source", params={"session_id": "sess-parent", "board": "default"})
    assert source.status_code == 200, source.text
    task = next(item for item in source.json()["tasks"] if item["id"] == task_id)
    assert task["review_kind"] == "blocker_triage"
    assert task["resume_mode"] == "fork"
    assert task["review_subject_assignee"] == "peacock"
    assert task["foreground_parent_session_id"] == "sess-parent"
    assert task["foreground_fork_session_id"] == "sess-fork"
    assert "loop_handoffs" not in task

    detail = client.get(f"/api/plugins/kanban/tasks/{task_id}", params={"board": "default"})
    assert detail.status_code == 200, detail.text
    detail_task = detail.json()["task"]
    assert detail_task["review_kind"] == "blocker_triage"
    assert detail_task["resume_mode"] == "fork"
    assert detail_task["foreground_parent_session_id"] == "sess-parent"
    assert detail_task["foreground_fork_session_id"] == "sess-fork"
    assert "loop_handoffs" not in detail_task


def test_loop_handoff_plugin_auto_action_410s_after_removal(client):
    conn = kb.connect()
    try:
        task_id = _loop_node(conn)
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="needs review")
        assert kb.list_loop_handoffs(conn) == []
    finally:
        conn.close()

    r = client.post(
        "/api/plugins/kanban/loop-handoffs/1/auto-action",
        json={
            "action": "approve_release",
            "actor": "dashboard-reviewer",
            "evidence_passed": True,
            "prohibited_flags": ["push"],
            "reason": "would push to remote",
        },
    )
    assert r.status_code == 410, r.text


def test_loop_handoff_plugin_detail_410s_after_removal(client):
    conn = kb.connect()
    try:
        task_id = _loop_node(conn)
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="needs bounded repair")
        assert kb.list_loop_handoffs(conn) == []
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/loop-handoffs/1")
    assert r.status_code == 410, r.text


def test_session_source_returns_non_archived_tenant_tasks_across_compression_lineage(client, kanban_home):
    """Loop composer source should be real Kanban rows from the session lineage.

    The current session may be a compressed continuation; tasks created before
    compression are attached to ancestor session ids but the current Loop view
    still needs them. Archived rows and unrelated tenants/sessions must stay out.
    """
    from hermes_state import SessionDB

    session_db = SessionDB()
    try:
        session_db.create_session("root-session", "cli")
        session_db.end_session("root-session", "compression")
        session_db.create_session("tip-session", "cli", parent_session_id="root-session")
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        root = kb.create_task(
            conn,
            title="root closure reviewer",
            assignee="reviewer-qa",
            tenant="20260612_145622_dc77fb",
            session_id="root-session",
        )
        child = kb.create_task(
            conn,
            title="tip implementation",
            assignee="peacock",
            tenant="20260612_145622_dc77fb",
            session_id="tip-session",
            parents=[root],
        )
        other_tenant = kb.create_task(
            conn,
            title="wrong tenant",
            tenant="other",
            session_id="root-session",
        )
        archived = kb.create_task(
            conn,
            title="archived in lineage",
            tenant="20260612_145622_dc77fb",
            session_id="tip-session",
        )
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'archived' WHERE id = ?", (archived,))
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "tip-session", "tenant": "20260612_145622_dc77fb"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["lineage_session_ids"] == ["root-session", "tip-session"]
    assert data["root_task_id"] == root
    assert [task["id"] for task in data["tasks"]] == [root, child]
    assert {task["id"] for task in data["tasks"]}.isdisjoint({archived, other_tenant})
    assert all(task["is_container"] is False for task in data["tasks"])
    assert data["links"] == [{"parent_id": root, "child_id": child}]
    child_payload = next(task for task in data["tasks"] if task["id"] == child)
    assert child_payload["links"]["parents"] == [root]
    assert child_payload["assignee"] == "peacock"
    assert child_payload["tenant"] == "20260612_145622_dc77fb"
    assert child_payload["session_id"] == "tip-session"


def test_session_source_includes_loop_tool_referenced_worker_rows(client, kanban_home):
    """Composer Loop rows should recover durable rows referenced by the chat.

    ``loop_create``/``loop_status`` tool results are visible in the foreground
    transcript even when the durable Kanban row is stamped with a worker session
    id or a custom tenant. The session-source payload should include that row so
    Desktop can render the Loop stack above the composer.
    """
    from hermes_state import SessionDB

    session_db = SessionDB()
    try:
        session_db.create_session("foreground-session", "tui")
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        referenced = kb.create_task(
            conn,
            title="foreground-visible delegated row",
            assignee="peacock",
            created_by="loop_delegation:agent",
            tenant="custom-loop-tenant",
            session_id="worker-session",
        )
        foreground_parent = kb.create_task(
            conn,
            title="foreground-parent delegated row",
            assignee="reviewer-qa",
            created_by="loop_delegation:agent",
            tenant="other-loop-tenant",
            session_id="reviewer-session",
        )
        unrelated = kb.create_task(
            conn,
            title="unrelated worker row",
            assignee="peacock",
            created_by="loop_delegation:agent",
            tenant="custom-loop-tenant",
            session_id="worker-session",
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET foreground_parent_session_id = ? WHERE id = ?",
                ("foreground-session", foreground_parent),
            )
    finally:
        conn.close()

    session_db = SessionDB()
    try:
        session_db.append_message(
            "foreground-session",
            "tool",
            json.dumps({"ok": True, "loop_item_id": referenced}),
            tool_name="loop_create",
        )
    finally:
        session_db.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "foreground-session", "board": "default"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    task_ids = [task["id"] for task in data["tasks"]]
    assert referenced in task_ids
    assert foreground_parent in task_ids
    assert unrelated not in task_ids
    referenced_payload = next(task for task in data["tasks"] if task["id"] == referenced)
    assert referenced_payload["session_id"] == "worker-session"
    assert referenced_payload["tenant"] == "custom-loop-tenant"


def test_session_source_includes_explicit_session_rows_when_legacy_tenant_row_exists(client, kanban_home):
    from hermes_state import SessionDB

    session_db = SessionDB()
    try:
        session_db.create_session("source-session", "tui")
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        legacy = kb.create_task(
            conn,
            title="legacy tenant-only row",
            assignee="reviewer-qa",
            created_by="loop:legacy",
            tenant="source-session",
            session_id=None,
        )
        delegated = kb.create_task(
            conn,
            title="explicit source row with custom tenant",
            assignee="peacock",
            created_by="loop_delegation:planner",
            tenant="custom-origin-metadata",
            session_id="source-session",
        )
        foreground_parent = kb.create_task(
            conn,
            title="foreground parent row",
            assignee="reviewer-qa",
            created_by="loop_delegation:planner",
            tenant="other-metadata",
            session_id="worker-session",
        )
        wrong_session = kb.create_task(
            conn,
            title="wrong session control",
            assignee="peacock",
            created_by="loop_delegation:planner",
            tenant="custom-origin-metadata",
            session_id="other-session",
        )
        archived = kb.create_task(
            conn,
            title="archived source row",
            assignee="peacock",
            tenant="custom-origin-metadata",
            session_id="source-session",
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET foreground_parent_session_id = ? WHERE id = ?",
                ("source-session", foreground_parent),
            )
            conn.execute("UPDATE tasks SET status = 'archived' WHERE id = ?", (archived,))
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "source-session", "board": "default"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    task_ids = [task["id"] for task in data["tasks"]]
    assert legacy in task_ids
    assert delegated in task_ids
    assert foreground_parent in task_ids
    assert wrong_session not in task_ids
    assert archived not in task_ids
    delegated_payload = next(task for task in data["tasks"] if task["id"] == delegated)
    assert delegated_payload["session_id"] == "source-session"
    assert delegated_payload["tenant"] == "custom-origin-metadata"


def test_session_source_recovers_overwritten_compression_parent(client, kanban_home):
    """Loop composer follows a compaction child even after parent shutdown.

    Desktop can reopen a continuation tip whose parent was later marked with a
    normal shutdown reason. The compaction marker in the child still identifies
    the logical lineage, so tenant-keyed Loop rows from the parent should show.
    """
    from hermes_state import SessionDB

    session_db = SessionDB()
    try:
        now = time.time()
        session_db.create_session("root-session", "cli")
        session_db._conn.execute(
            "UPDATE sessions "
            "SET started_at = ?, ended_at = ?, end_reason = ? "
            "WHERE id = ?",
            (now - 100, now, "tui_shutdown", "root-session"),
        )
        session_db.create_session("tip-session", "cli", parent_session_id="root-session")
        session_db._conn.execute(
            "UPDATE sessions SET started_at = ? WHERE id = ?",
            (now - 50, "tip-session"),
        )
        session_db.append_message(
            "tip-session",
            "user",
            "[CONTEXT COMPACTION — REFERENCE ONLY] compacted prior turns",
        )
        session_db._conn.commit()
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="parent tenant task",
            tenant="root-session",
            session_id="root-session",
        )
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "tip-session"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["lineage_session_ids"] == ["root-session", "tip-session"]
    assert data["tenants"] == ["root-session"]
    assert [task["id"] for task in data["tasks"]] == [task_id]


def test_session_source_recovers_tasks_when_lineage_id_is_tenant_key(client, kanban_home):
    """Compressed Loop continuations can point at tenant-keyed Kanban work."""
    from hermes_state import SessionDB

    tenant_root = "pass3-tenant-root-session-key"
    tip_session = "pass3-tenant-tip-session"
    session_db = SessionDB()
    try:
        session_db.create_session(tenant_root, "cli")
        session_db.end_session(tenant_root, "compression")
        session_db.create_session(tip_session, "cli", parent_session_id=tenant_root)
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        parent = kb.create_task(
            conn,
            title="tenant-owned parent",
            tenant=tenant_root,
            session_id=None,
        )
        child = kb.create_task(
            conn,
            title="tenant-owned child",
            tenant=tenant_root,
            session_id="worker-session",
            parents=[parent],
        )
        scratch = kb.create_task(
            conn,
            title="tenantless scratch row",
            tenant=None,
            session_id=tip_session,
        )
        wrong_tenant = kb.create_task(
            conn,
            title="wrong tenant in lineage session",
            tenant="other-tenant",
            session_id=tip_session,
        )
        archived = kb.create_task(
            conn,
            title="archived tenant row",
            tenant=tenant_root,
            session_id=None,
        )
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'archived' WHERE id = ?", (archived,))
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": tip_session},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["lineage_session_ids"] == [tenant_root, tip_session]
    assert data["tenant"] == tenant_root
    assert data["tenants"] == [tenant_root]
    assert {task["id"] for task in data["tasks"]} == {parent, child, scratch, wrong_tenant}
    assert {task["id"] for task in data["tasks"]}.isdisjoint({archived})
    assert {task["id"] for task in data["tasks"] if task["session_id"] == tip_session} == {
        scratch,
        wrong_tenant,
    }
    assert data["links"] == [{"parent_id": parent, "child_id": child}]


def test_session_source_reports_decomposed_original_root_task_id(client, kanban_home):
    """The drawer overview must stay bound to the decomposed root row, not the first child."""
    from hermes_state import SessionDB

    tenant_root = "tenant-decomposed-root"
    tip_session = "tenant-decomposed-tip"
    session_db = SessionDB()
    try:
        session_db.create_session(tenant_root, "cli")
        session_db.end_session(tenant_root, "compression")
        session_db.create_session(tip_session, "cli", parent_session_id=tenant_root)
    finally:
        session_db.close()

    conn = kb.connect()
    try:
        root = kb.create_task(
            conn,
            title="original draft root",
            body="living spec body",
            tenant=tenant_root,
            triage=True,
            session_id=None,
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root,
            root_assignee="orchestrator",
            children=[{"title": "implementation child", "assignee": "peacock"}],
            author="foreground",
        )
    finally:
        conn.close()

    assert child_ids

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": tip_session},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["tenant"] == tenant_root
    assert data["root_task_id"] == root
    assert [task["id"] for task in data["tasks"]] == [child_ids[0], root]
    assert data["links"] == [{"parent_id": child_ids[0], "child_id": root}]


def test_session_source_preserves_legacy_loop_planning_projection(client, monkeypatch):
    from hermes_cli import loop_graph

    monkeypatch.setenv("HERMES_SESSION_ID", "session-decision-metadata")
    draft = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={
            "title": "Decision root",
            "session_id": "session-decision-metadata",
            "tenant": "decision-session",
        },
    )
    assert draft.status_code == 200, draft.text
    root_task_id = draft.json()["task"]["id"]

    conn = kb.connect()
    try:
        expected_revision = loop_graph.graph_revision(conn, root_task_id)
        result = loop_graph.apply_patch(
            conn,
            root_task_id,
            expected_revision=expected_revision,
            mutation_id="m-decision-option",
            operations=[
                {
                    "op": "add_node",
                    "client_id": "option-a",
                    "title": "Option A",
                    "parents": [root_task_id],
                    "branch_kind": "alternative",
                    "decision_group_id": "choice-1",
                    "selection_state": "candidate",
                }
            ],
        )
    finally:
        conn.close()

    option_id = result["created"][0]["task_id"]
    response = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "session-decision-metadata", "tenant": "decision-session"},
    )

    assert response.status_code == 200, response.text
    data = response.json()
    [task] = data["tasks"]
    [planning_node] = data["planning_nodes"]
    assert data["root_task_id"] == root_task_id
    assert task["id"] == root_task_id
    assert planning_node["id"] == option_id
    assert planning_node["is_planning_node"] is True
    assert planning_node["branch_kind"] == "alternative"
    assert planning_node["decision_group_id"] == "choice-1"
    assert planning_node["selection_state"] == "candidate"
    assert planning_node["included_parent_ids"] == [root_task_id]
    assert data["planning_links"] == [{"parent_id": root_task_id, "child_id": option_id}]
    assert data["links"] == []

    conn = kb.connect()
    try:
        assert kb.get_task(conn, option_id) is None
        assert conn.execute(
            "SELECT 1 FROM task_links WHERE parent_id = ? OR child_id = ?",
            (option_id, option_id),
        ).fetchone() is None
    finally:
        conn.close()


def test_session_source_falls_back_to_board_containing_lineage_tenant(client, kanban_home):
    """Desktop calls omit a board, so Loop source should find tenant rows off the current board."""
    from hermes_state import SessionDB

    tenant_root = "cross-board-tenant-root"
    tip_session = "cross-board-tip-session"
    session_db = SessionDB()
    try:
        session_db.create_session(tenant_root, "cli")
        session_db.end_session(tenant_root, "compression")
        session_db.create_session(tip_session, "cli", parent_session_id=tenant_root)
    finally:
        session_db.close()

    kb.create_board("developer")
    conn = kb.connect(board="developer")
    try:
        task = kb.create_task(
            conn,
            title="developer board tenant row",
            tenant=tenant_root,
            session_id=None,
        )
    finally:
        conn.close()

    assert kb.get_current_board() == kb.DEFAULT_BOARD

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": tip_session},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["board"] == "developer"
    assert data["tenant"] == tenant_root
    assert [item["id"] for item in data["tasks"]] == [task]


def test_session_source_defaults_to_hermes_session_id_when_query_omits_session_id(
    client,
    monkeypatch,
):
    monkeypatch.setenv("HERMES_SESSION_ID", "env-session")

    conn = kb.connect()
    try:
        keep = kb.create_task(
            conn,
            title="env session task",
            tenant="20260612_145622_dc77fb",
            session_id="env-session",
        )
        drop = kb.create_task(
            conn,
            title="other session task",
            tenant="20260612_145622_dc77fb",
            session_id="other-session",
        )
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"tenant": "20260612_145622_dc77fb"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["session_id"] == "env-session"
    assert data["lineage_session_ids"] == ["env-session"]
    assert [task["id"] for task in data["tasks"]] == [keep]
    assert drop not in {task["id"] for task in data["tasks"]}


def test_session_source_recovers_missed_worker_activity_with_scoped_revision(client, kanban_home):
    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="durable worker activity",
            assignee="peacock",
            tenant="tenant-live",
            session_id="source-session",
        )
        initial = client.get(
            "/api/plugins/kanban/session-source",
            params={"session_id": "source-session", "tenant": "tenant-live"},
        )
        assert initial.status_code == 200, initial.text
        initial_revision = initial.json()["source_revision"]

        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.heartbeat_worker(conn, task_id, note="halfway")
        log_path = kb.worker_log_path(task_id)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("worker booted\nfinished safely\n", encoding="utf-8")
        assert kb.complete_task(
            conn,
            task_id,
            summary="finished safely",
            metadata={"worker_session_id": "worker-session-live"},
        )
    finally:
        conn.close()

    reopened = client.get(
        "/api/plugins/kanban/session-source",
        params={
            "session_id": "source-session",
            "tenant": "tenant-live",
            "since_event_id": initial_revision,
        },
    )

    assert reopened.status_code == 200, reopened.text
    data = reopened.json()
    assert data["source_revision"] == data["latest_event_id"]
    assert data["source_revision"] > initial_revision
    assert data["changed_since"] == initial_revision
    [worker] = data["workers"]
    assert worker["task_id"] == task_id
    assert worker["task_title"] == "durable worker activity"
    assert isinstance(worker["run_id"], int)
    assert worker["worker_session_id"] == "worker-session-live"
    assert worker["log_tail_available"] is True
    assert "finished safely" in worker["log_tail"]
    assert worker["recent_task_events"][-1]["kind"] == "completed"
    [task] = data["tasks"]
    assert task["id"] == task_id
    assert task["status"] == "done"
    assert task["latest_run"]["status"] == "done"
    assert worker["run_id"] == task["latest_run"]["id"]
    assert task["latest_run"]["outcome"] == "completed"
    assert task["worker_activity"] | {
        "run_id": task["latest_run"]["id"],
        "status": "done",
        "outcome": "completed",
        "profile": "peacock",
        "started_at": task["latest_run"]["started_at"],
        "ended_at": task["latest_run"]["ended_at"],
        "last_heartbeat_at": task["latest_run"]["last_heartbeat_at"],
        "worker_session_id": "worker-session-live",
        "log_tail_available": True,
        "latest_event_id": data["latest_event_id"],
        "latest_event_kind": "completed",
        "summary_preview": "finished safely",
        "error_preview": None,
    } == task["worker_activity"]


def test_session_source_can_infer_tenant_from_lineage_tasks(client):
    conn = kb.connect()
    try:
        keep = kb.create_task(
            conn,
            title="tenant-scoped row",
            tenant="20260612_145622_dc77fb",
            session_id="solo-session",
        )
        drop = kb.create_task(
            conn,
            title="tenantless scratch row",
            tenant=None,
            session_id="solo-session",
        )
    finally:
        conn.close()

    r = client.get(
        "/api/plugins/kanban/session-source",
        params={"session_id": "solo-session"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["tenant"] == "20260612_145622_dc77fb"
    assert {task["id"] for task in data["tasks"]} == {keep, drop}


def test_board_query_param_default_overrides_current_board_pointer(client):
    """Dashboard ``?board=default`` must win even if the CLI's current-board
    pointer targets a non-default board.

    Regression: selecting the Default board in the dashboard must not fall
    through to whichever board ``hermes kanban boards switch`` last pinned.
    """
    default_task = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "default-only"},
    ).json()["task"]

    kb.create_board("other")
    other_conn = kb.connect(board="other")
    try:
        kb.create_task(other_conn, title="other-only")
    finally:
        other_conn.close()

    kb.set_current_board("other")

    current_board = client.get("/api/plugins/kanban/board").json()
    current_ids = {
        task["id"]
        for column in current_board["columns"]
        for task in column["tasks"]
    }
    assert default_task["id"] not in current_ids

    pinned_default = client.get("/api/plugins/kanban/board?board=default").json()
    pinned_ids = {
        task["id"]
        for column in pinned_default["columns"]
        for task in column["tasks"]
    }
    assert pinned_ids == {default_task["id"]}


def test_dashboard_select_filters_use_sdk_value_change_handler():
    """Tenant/assignee filters must work with the dashboard SDK Select API.

    The dashboard Select component is shadcn-like and calls
    ``onValueChange(value)`` instead of native ``onChange(event)``. A native-only
    handler leaves the tenant dropdown visually selectable but never updates the
    filtered board query.
    """

    repo_root = Path(__file__).resolve().parents[2]
    bundle = repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    js = bundle.read_text()

    assert "function selectChangeHandler(setter)" in js
    assert "onValueChange: function (v)" in js
    assert "onChange: function (e)" in js
    assert "selectChangeHandler(props.setTenantFilter)" in js
    assert "selectChangeHandler(props.setAssigneeFilter)" in js


def test_dashboard_client_side_filtering_includes_tenant_filter():
    """The rendered board must also filter by tenant.

    The API request includes ``?tenant=...``, but the dashboard also filters the
    locally cached board for search/assignee changes. Without checking
    ``tenantFilter`` here, switching tenants can leave stale cards visible until a
    full reload finishes.
    """

    repo_root = Path(__file__).resolve().parents[2]
    bundle = repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    js = bundle.read_text()

    assert "if (tenantFilter && t.tenant !== tenantFilter) return false;" in js
    assert "[boardData, tenantFilter, assigneeFilter, search]" in js


def test_dashboard_initial_board_uses_backend_current_when_unpinned():
    """Fresh browsers should open the backend current board, not default.

    Explicit dashboard selections are stored in localStorage and should still
    win, but an empty localStorage state must adopt the API's ``current`` board
    so multi-board installs do not look empty on first load.
    """

    repo_root = Path(__file__).resolve().parents[2]
    bundle = repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    js = bundle.read_text()

    assert 'useState(() => readSelectedBoard() || null)' in js
    assert "const storedBoard = readSelectedBoard();" in js
    assert "if (!storedBoard && !board && data && data.current)" in js
    assert "setBoard(data.current);" in js
    assert 'readSelectedBoard() || "default"' not in js


def test_dashboard_markdown_html_is_sanitized_before_render():
    """Markdown rendering must sanitize HTML before dangerouslySetInnerHTML."""

    repo_root = Path(__file__).resolve().parents[2]
    bundle = repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    js = bundle.read_text()

    assert "function sanitizeMarkdownHtml(html)" in js
    assert "MARKDOWN_ALLOWED_TAGS" in js
    assert "sanitizeMarkdownHtml(renderMarkdown(props.source || \"\"))" in js
    assert "dangerouslySetInnerHTML: { __html: renderMarkdown(props.source || \"\") }" not in js


# ---------------------------------------------------------------------------
# GET /tasks/:id returns body + comments + events + links
# ---------------------------------------------------------------------------


def test_task_detail_includes_links_and_events(client):
    parent = client.post(
        "/api/plugins/kanban/tasks", json={"title": "parent"},
    ).json()["task"]
    child = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "child", "parents": [parent["id"]]},
    ).json()["task"]
    assert child["status"] == "todo"  # parent not done yet

    # Detail for the child shows the parent link.
    r = client.get(f"/api/plugins/kanban/tasks/{child['id']}")
    assert r.status_code == 200
    data = r.json()
    assert data["task"]["id"] == child["id"]
    assert parent["id"] in data["links"]["parents"]

    # Detail for the parent shows the child.
    r = client.get(f"/api/plugins/kanban/tasks/{parent['id']}")
    assert child["id"] in r.json()["links"]["children"]

    # Events exist from creation.
    assert len(data["events"]) >= 1


def test_task_detail_404_on_unknown(client):
    r = client.get("/api/plugins/kanban/tasks/does-not-exist")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /tasks/:id — status transitions
# ---------------------------------------------------------------------------


def test_patch_status_complete(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "done", "result": "shipped"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "done"

    # Board reflects the move.
    done = next(
        c for c in client.get("/api/plugins/kanban/board").json()["columns"]
        if c["name"] == "done"
    )
    assert any(x["id"] == t["id"] for x in done["tasks"])


def test_patch_block_then_unblock(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "blocked", "block_reason": "need input"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "blocked"

    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "ready"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "ready"


def test_patch_schedule_then_unblock(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "scheduled", "block_reason": "run tomorrow"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "scheduled"

    columns = client.get("/api/plugins/kanban/board").json()["columns"]
    assert "scheduled" in [c["name"] for c in columns]
    scheduled = next(c for c in columns if c["name"] == "scheduled")
    assert any(x["id"] == t["id"] for x in scheduled["tasks"])

    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "ready"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "ready"


def test_patch_drag_drop_move_todo_to_ready(client):
    """Direct status write: the drag-drop path for statuses without a
    dedicated verb (e.g. manually promoting todo -> ready).

    Promoting a child whose parent is not done is rejected (409).
    Promoting a child whose parent IS done is accepted (200)."""
    parent = client.post("/api/plugins/kanban/tasks", json={"title": "p"}).json()["task"]
    child = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "c", "parents": [parent["id"]]},
    ).json()["task"]
    assert child["status"] == "todo"

    # Rejected: parent not done yet.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{child['id']}",
        json={"status": "ready"},
    )
    assert r.status_code == 409

    # The 409 detail must name the blocking parent so the dashboard can
    # render an actionable toast instead of a silent no-op (#26744).
    detail = r.json()["detail"]
    assert "Cannot move to 'ready'" in detail
    assert parent["id"] in detail
    assert "'p'" in detail
    assert "status=" in detail
    # Whatever non-``done`` status the parent currently has must show up
    # so the operator knows what to fix.
    assert f"status={parent['status']}" in detail
    assert parent["status"] != "done"

    # Complete the parent.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{parent['id']}",
        json={"status": "done"},
    )
    assert r.status_code == 200

    # Now child auto-promoted by recompute_ready — already ready.
    child_after = client.get(f"/api/plugins/kanban/tasks/{child['id']}").json()["task"]
    assert child_after["status"] == "ready"


def test_reopening_parent_demotes_ready_child(client):
    """Reopening a completed parent must invalidate ready children immediately.

    The dispatcher re-checks parent completion on claim, but the dashboard
    should not keep showing a stale child as ready after an operator drags
    its parent back out of done for more work.
    """
    parent = client.post("/api/plugins/kanban/tasks", json={"title": "p"}).json()["task"]
    child = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "c", "parents": [parent["id"]]},
    ).json()["task"]
    assert child["status"] == "todo"

    r = client.patch(
        f"/api/plugins/kanban/tasks/{parent['id']}",
        json={"status": "done"},
    )
    assert r.status_code == 200

    child_after_done = client.get(
        f"/api/plugins/kanban/tasks/{child['id']}"
    ).json()["task"]
    assert child_after_done["status"] == "ready"

    r = client.patch(
        f"/api/plugins/kanban/tasks/{parent['id']}",
        json={"status": "todo"},
    )
    assert r.status_code == 200

    child_after_reopen = client.get(
        f"/api/plugins/kanban/tasks/{child['id']}"
    ).json()["task"]
    assert child_after_reopen["status"] == "todo"


def test_patch_reassign(client):
    t = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "x", "assignee": "a"},
    ).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"assignee": "b"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["assignee"] == "b"


def test_patch_priority_and_edit(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"priority": 5, "title": "renamed"},
    )
    assert r.status_code == 200
    data = r.json()["task"]
    assert data["priority"] == 5
    assert data["title"] == "renamed"


def test_patch_invalid_status(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "banana"},
    )
    assert r.status_code == 400


def test_patch_status_running_rejected(client):
    """Dashboard PATCH cannot transition a task directly to 'running'.

    The only legitimate path into 'running' is through the dispatcher's
    ``claim_task`` — which atomically creates a ``task_runs`` row,
    claim_lock, expiry, and worker-PID metadata. Allowing a direct set
    creates orphaned 'running' tasks with no run row or claim, which
    violate the board's run-history invariants. See issue #19535.
    """
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}",
        json={"status": "running"},
    )
    assert r.status_code == 400
    assert "running" in r.json()["detail"]
    # Task's status should still be its pre-request value — the direct-set
    # was rejected before any mutation.
    board = client.get("/api/plugins/kanban/board").json()
    statuses = {
        tt["id"]: col["name"]
        for col in board["columns"]
        for tt in col["tasks"]
    }
    assert statuses.get(t["id"]) != "running"


# ---------------------------------------------------------------------------
# DELETE /tasks/:id
# ---------------------------------------------------------------------------

def test_delete_task(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "to-delete"}).json()["task"]
    r = client.delete(f"/api/plugins/kanban/tasks/{t['id']}")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert r.json()["task_id"] == t["id"]

    # Gone from board
    board = client.get("/api/plugins/kanban/board").json()
    all_ids = [tt["id"] for col in board["columns"] for tt in col["tasks"]]
    assert t["id"] not in all_ids

    # Gone from detail
    r = client.get(f"/api/plugins/kanban/tasks/{t['id']}")
    assert r.status_code == 404


def test_delete_task_not_found(client):
    r = client.delete("/api/plugins/kanban/tasks/t_nonexistent")
    assert r.status_code == 404
    assert "not found" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Comments + Links
# ---------------------------------------------------------------------------


def test_add_comment(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.post(
        f"/api/plugins/kanban/tasks/{t['id']}/comments",
        json={"body": "how's progress?", "author": "teknium"},
    )
    assert r.status_code == 200

    r = client.get(f"/api/plugins/kanban/tasks/{t['id']}")
    comments = r.json()["comments"]
    assert len(comments) == 1
    assert comments[0]["body"] == "how's progress?"
    assert comments[0]["author"] == "teknium"

    r = client.get(f"/api/plugins/kanban/tasks/{t['id']}/comments")
    assert r.status_code == 200
    comments = r.json()
    assert len(comments) == 1
    assert comments[0]["body"] == "how's progress?"
    assert comments[0]["author"] == "teknium"


def test_add_comment_empty_rejected(client):
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.post(
        f"/api/plugins/kanban/tasks/{t['id']}/comments",
        json={"body": "   "},
    )
    assert r.status_code == 400


def test_add_link_and_delete_link(client):
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks", json={"title": "b"}).json()["task"]

    r = client.post(
        "/api/plugins/kanban/links",
        json={"parent_id": a["id"], "child_id": b["id"]},
    )
    assert r.status_code == 200

    r = client.get(f"/api/plugins/kanban/tasks/{b['id']}")
    assert a["id"] in r.json()["links"]["parents"]

    r = client.delete(
        "/api/plugins/kanban/links",
        params={"parent_id": a["id"], "child_id": b["id"]},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_add_link_can_be_scoped_to_loop_canvas_membership(client):
    root = client.post(
        "/api/plugins/kanban/loop-drafts",
        json={"title": "Canvas root", "session_id": "session-links-a"},
    ).json()["task"]
    same_session = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Disconnected card", "session_id": "session-links-a", "triage": True},
    ).json()["task"]
    connected = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Cross-session card", "session_id": "session-links-b", "triage": True},
    ).json()["task"]
    unrelated = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Other canvas", "session_id": "session-links-c", "triage": True},
    ).json()["task"]
    assert client.post(
        "/api/plugins/kanban/links",
        json={"parent_id": root["id"], "child_id": connected["id"]},
    ).status_code == 200

    same_session_link = client.post(
        "/api/plugins/kanban/links",
        json={
            "parent_id": root["id"],
            "child_id": same_session["id"],
            "root_task_id": root["id"],
        },
    )
    assert same_session_link.status_code == 200, same_session_link.text

    connected_cross_session_link = client.post(
        "/api/plugins/kanban/links",
        json={
            "parent_id": connected["id"],
            "child_id": same_session["id"],
            "root_task_id": root["id"],
        },
    )
    assert connected_cross_session_link.status_code == 200, connected_cross_session_link.text

    rejected = client.post(
        "/api/plugins/kanban/links",
        json={
            "parent_id": root["id"],
            "child_id": unrelated["id"],
            "root_task_id": root["id"],
        },
    )
    assert rejected.status_code == 400
    assert "outside Loop canvas" in rejected.json()["detail"]


def test_add_link_cycle_rejected(client):
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks", json={"title": "b"}).json()["task"]
    client.post(
        "/api/plugins/kanban/links",
        json={"parent_id": a["id"], "child_id": b["id"]},
    )
    r = client.post(
        "/api/plugins/kanban/links",
        json={"parent_id": b["id"], "child_id": a["id"]},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Dispatch nudge
# ---------------------------------------------------------------------------


def test_dispatch_dry_run(client):
    client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "work", "assignee": "researcher"},
    )
    r = client.post("/api/plugins/kanban/dispatch?dry_run=true&max=4")
    assert r.status_code == 200
    body = r.json()
    # DispatchResult is serialized as a dataclass dict.
    assert isinstance(body, dict)


# ---------------------------------------------------------------------------
# Triage column (new v1 status)
# ---------------------------------------------------------------------------


def test_create_triage_lands_in_triage_column(client):
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "rough idea, spec me", "triage": True},
    )
    assert r.status_code == 200
    task = r.json()["task"]
    assert task["status"] == "triage"

    r = client.get("/api/plugins/kanban/board")
    triage = next(c for c in r.json()["columns"] if c["name"] == "triage")
    assert len(triage["tasks"]) == 1
    assert triage["tasks"][0]["title"] == "rough idea, spec me"


def test_triage_task_not_promoted_to_ready(client):
    """Triage tasks must stay in triage even when they have no parents."""
    client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "must stay put", "triage": True},
    )
    # Run the dispatcher — it should NOT promote the triage task.
    client.post("/api/plugins/kanban/dispatch?dry_run=false&max=4")
    r = client.get("/api/plugins/kanban/board")
    triage = next(c for c in r.json()["columns"] if c["name"] == "triage")
    ready = next(c for c in r.json()["columns"] if c["name"] == "ready")
    assert len(triage["tasks"]) == 1
    assert len(ready["tasks"]) == 0


def test_patch_status_triage_works(client):
    """A user (or specifier) can push a task back into triage, and out of it."""
    t = client.post(
        "/api/plugins/kanban/tasks", json={"title": "x"},
    ).json()["task"]
    # Normal creation is 'ready'; push to triage.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}", json={"status": "triage"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "triage"

    # Now promote to todo.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{t['id']}", json={"status": "todo"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["status"] == "todo"


# ---------------------------------------------------------------------------
# Progress rollup (done children / total children)
# ---------------------------------------------------------------------------


def test_board_progress_rollup(client):
    parent = client.post(
        "/api/plugins/kanban/tasks", json={"title": "parent"},
    ).json()["task"]
    child_a = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "a", "parents": [parent["id"]]},
    ).json()["task"]
    child_b = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "b", "parents": [parent["id"]]},
    ).json()["task"]
    # Children start as "todo" because the parent isn't done yet.  Set the
    # parent to done so children auto-promote to ready via recompute_ready.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{parent['id']}",
        json={"status": "done"},
    )
    assert r.status_code == 200
    # Verify children are now ready.
    for cid in (child_a["id"], child_b["id"]):
        t = client.get(f"/api/plugins/kanban/tasks/{cid}").json()["task"]
        assert t["status"] == "ready", f"{cid} should be ready after parent done"

    # 0/2 done.
    r = client.get("/api/plugins/kanban/board")
    parent_row = next(
        t for col in r.json()["columns"] for t in col["tasks"]
        if t["id"] == parent["id"]
    )
    assert parent_row["progress"] == {"done": 0, "total": 2}

    # Complete one child. 1/2.
    r = client.patch(
        f"/api/plugins/kanban/tasks/{child_a['id']}",
        json={"status": "done"},
    )
    assert r.status_code == 200
    r = client.get("/api/plugins/kanban/board")
    parent_row = next(
        t for col in r.json()["columns"] for t in col["tasks"]
        if t["id"] == parent["id"]
    )
    assert parent_row["progress"] == {"done": 1, "total": 2}

    # Childless tasks report progress=None, not {0/0}.
    assert next(
        t for col in r.json()["columns"] for t in col["tasks"]
        if t["id"] == child_b["id"]
    )["progress"] is None


# ---------------------------------------------------------------------------
# Auto-init on first board read
# ---------------------------------------------------------------------------


def test_board_auto_initializes_missing_db(tmp_path, monkeypatch):
    """If kanban.db doesn't exist yet, GET /board must create it, not 500."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_HOME", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    # Deliberately DO NOT call kb.init_db().

    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    c = TestClient(app)
    r = c.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    assert (home / "kanban.db").exists(), "init_db wasn't invoked by /board"


# ---------------------------------------------------------------------------
# WebSocket auth (query-param token)
# ---------------------------------------------------------------------------


def test_ws_events_rejects_when_token_required(tmp_path, monkeypatch):
    """Loopback mode: a missing or wrong ?token= must be rejected with
    policy-violation; the correct token is accepted. The kanban WS now
    delegates to web_server._ws_auth_ok, so we stub that with the real
    loopback-token semantics (auth_required False → constant-time token
    compare)."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()

    # Stub web_server with a loopback-mode _ws_auth_ok (auth_required False →
    # accept only the correct ?token=). Mirrors the real gate's loopback path.
    import hermes_cli
    import types

    def _fake_ws_auth_ok(ws):
        return ws.query_params.get("token", "") == "secret-xyz"

    stub = types.SimpleNamespace(
        _SESSION_TOKEN="secret-xyz",
        _ws_auth_ok=_fake_ws_auth_ok,
    )
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server", stub)
    monkeypatch.setattr(hermes_cli, "web_server", stub, raising=False)

    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    c = TestClient(app)

    # No token → policy violation close.
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect("/api/plugins/kanban/events"):
            pass
    assert exc.value.code == 1008

    # Wrong token → policy violation close.
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect("/api/plugins/kanban/events?token=nope"):
            pass
    assert exc.value.code == 1008

    # Correct token → accepted (connect then close cleanly from our side).
    with c.websocket_connect(
        "/api/plugins/kanban/events?token=secret-xyz"
    ) as ws:
        assert ws is not None  # handshake succeeded


def test_ws_events_accepts_gated_ticket(tmp_path, monkeypatch):
    """Gated OAuth mode: the WS must accept a single-use ?ticket= (and reject
    a bare ?token=, even one matching _SESSION_TOKEN). This is the regression
    for the hosted-dashboard bug where the kanban live-events WS 1008'd on
    every gated deployment because its bespoke check only knew _SESSION_TOKEN.
    We stub _ws_auth_ok with the real gated semantics (ticket-only)."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()

    import hermes_cli
    import types

    def _fake_ws_auth_ok(ws):
        # Gated mode: only a known ticket is accepted; token path rejected.
        return ws.query_params.get("ticket", "") == "good-ticket"

    stub = types.SimpleNamespace(
        _SESSION_TOKEN="secret-xyz",
        _ws_auth_ok=_fake_ws_auth_ok,
    )
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server", stub)
    monkeypatch.setattr(hermes_cli, "web_server", stub, raising=False)

    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    c = TestClient(app)

    from starlette.websockets import WebSocketDisconnect

    # Legacy token is rejected in gated mode, even if it's the real one.
    with pytest.raises(WebSocketDisconnect) as exc:
        with c.websocket_connect("/api/plugins/kanban/events?token=secret-xyz"):
            pass
    assert exc.value.code == 1008

    # A valid ticket is accepted.
    with c.websocket_connect(
        "/api/plugins/kanban/events?ticket=good-ticket"
    ) as ws:
        assert ws is not None


def test_ws_events_board_query_param_default_overrides_current_board_pointer(tmp_path, monkeypatch):
    """The event stream must honor ``board=default`` even when the global
    current-board pointer targets a different board.

    This is the live-update half of the dashboard regression: after the UI
    selects Default, the websocket must not subscribe to the CLI's current
    non-default board.
    """
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()

    default_conn = kb.connect()
    try:
        default_task = kb.create_task(default_conn, title="default-live")
    finally:
        default_conn.close()

    kb.create_board("other")
    other_conn = kb.connect(board="other")
    try:
        other_task = kb.create_task(other_conn, title="other-live")
    finally:
        other_conn.close()

    kb.set_current_board("other")

    import hermes_cli
    import types

    stub = types.SimpleNamespace(
        _SESSION_TOKEN="secret-xyz",
        _ws_auth_ok=lambda ws: ws.query_params.get("token", "") == "secret-xyz",
    )
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server", stub)
    monkeypatch.setattr(hermes_cli, "web_server", stub, raising=False)

    app = FastAPI()
    app.include_router(_load_plugin_router(), prefix="/api/plugins/kanban")
    c = TestClient(app)

    with c.websocket_connect(
        "/api/plugins/kanban/events?token=secret-xyz&board=default&since=0"
    ) as ws:
        payload = ws.receive_json()

    task_ids = {event["task_id"] for event in payload["events"]}
    assert default_task in task_ids
    assert other_task not in task_ids


def test_ws_events_swallows_cancellation_on_shutdown(tmp_path, monkeypatch):
    """``asyncio.CancelledError`` while sleeping in the poll loop is the
    normal uvicorn-shutdown path (``BaseException``, so the bare
    ``except Exception:`` does NOT catch it). Without the explicit
    clause the cancellation surfaces as an application traceback.

    Regression test for #20790 (fix in #20938). Drives the coroutine
    directly (rather than through FastAPI TestClient) so we can observe
    the cancellation outcome deterministically.
    """
    import asyncio

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()

    # Short-circuit the auth check — this test is about the cancellation
    # path, not auth.
    import plugins.kanban.dashboard.plugin_api as pa
    monkeypatch.setattr(pa, "_ws_upgrade_authorized", lambda ws: True)

    class _FakeWS:
        def __init__(self):
            self.query_params = {"token": "x", "since": "0"}
            self.accepted = False
            self.closed = False

        async def accept(self):
            self.accepted = True

        async def send_json(self, data):
            pass

        async def close(self, code=None):
            self.closed = True

    async def _run():
        ws = _FakeWS()
        task = asyncio.create_task(pa.stream_events(ws))
        # Give the handler a tick to accept + start polling.
        await asyncio.sleep(0.05)
        assert ws.accepted is True
        task.cancel()
        # stream_events should swallow CancelledError and return cleanly.
        # If it doesn't, this await re-raises the CancelledError.
        result = await task
        return result, ws

    result, ws = asyncio.run(_run())
    assert result is None, (
        f"stream_events should return cleanly after cancellation, got {result!r}"
    )
    # The bug symptom was a traceback; we don't assert on stderr because
    # capturing asyncio's internal "exception was never retrieved" logging
    # is flaky. The assertion that matters is: no CancelledError escaped.


# ---------------------------------------------------------------------------
# Bulk actions
# ---------------------------------------------------------------------------


def test_bulk_status_ready(client):
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks", json={"title": "b"}).json()["task"]
    c2 = client.post("/api/plugins/kanban/tasks", json={"title": "c"}).json()["task"]
    # Parent-less tasks land in "ready" already; push them to blocked first.
    for tid in (a["id"], b["id"], c2["id"]):
        client.patch(f"/api/plugins/kanban/tasks/{tid}",
                     json={"status": "blocked", "block_reason": "wait"})

    r = client.post("/api/plugins/kanban/tasks/bulk",
                    json={"ids": [a["id"], b["id"], c2["id"]], "status": "ready"})
    assert r.status_code == 200
    results = r.json()["results"]
    assert all(r["ok"] for r in results)
    # All three are now ready.
    board = client.get("/api/plugins/kanban/board").json()
    ready = next(col for col in board["columns"] if col["name"] == "ready")
    ids = {t["id"] for t in ready["tasks"]}
    assert {a["id"], b["id"], c2["id"]}.issubset(ids)


def test_bulk_status_done_forwards_completion_summary(client):
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks", json={"title": "b"}).json()["task"]

    r = client.post(
        "/api/plugins/kanban/tasks/bulk",
        json={
            "ids": [a["id"], b["id"]],
            "status": "done",
            "result": "DECIDED: ship it",
            "summary": "DECIDED: ship it",
            "metadata": {"source": "dashboard"},
        },
    )

    assert r.status_code == 200
    assert all(r["ok"] for r in r.json()["results"])
    conn = kb.connect()
    try:
        for tid in (a["id"], b["id"]):
            task = kb.get_task(conn, tid)
            run = kb.latest_run(conn, tid)
            assert task.status == "done"
            assert task.result == "DECIDED: ship it"
            assert run.summary == "DECIDED: ship it"
            assert run.metadata == {"source": "dashboard"}
    finally:
        conn.close()


def test_bulk_status_running_rejected(client):
    """Bulk updates must match single-task PATCH: direct 'running' is invalid."""
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]

    r = client.post(
        "/api/plugins/kanban/tasks/bulk",
        json={"ids": [t["id"]], "status": "running"},
    )

    assert r.status_code == 200
    results = r.json()["results"]
    assert len(results) == 1
    assert results[0]["id"] == t["id"]
    assert results[0]["ok"] is False
    assert "running" in results[0]["error"]

    board = client.get("/api/plugins/kanban/board").json()
    statuses = {
        tt["id"]: col["name"]
        for col in board["columns"]
        for tt in col["tasks"]
    }
    assert statuses.get(t["id"]) != "running"


def test_dashboard_done_actions_prompt_for_completion_summary():
    repo_root = Path(__file__).resolve().parents[2]
    bundle = (
        repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    ).read_text()

    assert "withCompletionSummary" in bundle
    assert "Completion summary" in bundle
    assert "result: summary" in bundle
    assert "body: JSON.stringify(patch)" in bundle
    assert "body: JSON.stringify(finalPatch)" in bundle


def test_dashboard_surfaces_ready_blocked_error_inline():
    """Regression for #26744: failed status transitions must be surfaced
    inline, not swallowed.  The drag/drop banner and the drawer's action
    row each render the parsed API ``detail`` so operators see *why*
    their click did nothing.
    """
    repo_root = Path(__file__).resolve().parents[2]
    bundle = (
        repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    ).read_text()

    # Helper that strips ``"409: {\"detail\":\"…\"}"`` down to the
    # human-readable message before it lands in any banner.
    assert "function parseApiErrorMessage(err)" in bundle
    assert "parsed.detail" in bundle

    # Drag/drop banner now uses the parsed message instead of raw
    # ``err.message`` so it no longer leaks HTTP plumbing.
    assert "setError(tx(t, \"moveFailed\", \"Move failed: \") + parseApiErrorMessage(err))" in bundle

    # Drawer action row has its own visible error surface and clears it
    # on success/refresh so stale failures don't follow the operator
    # around.
    assert "const [patchErr, setPatchErr] = useState(null);" in bundle
    assert "setPatchErr(parseApiErrorMessage(e))" in bundle
    assert "setPatchErr(null)" in bundle


def test_dashboard_dependency_selects_use_value_change_handler():
    """Regression for the dependency selects in the task drawer: the
    add-parent / add-child dropdowns must wire through the shared
    selectChangeHandler helper so their value actually lands on the
    underlying React state. Salvaged from #20019 @LeonSGP43.
    """
    repo_root = Path(__file__).resolve().parents[2]
    bundle = (
        repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js"
    ).read_text()

    parent_select = (
        'value: newParent,\n'
        '          className: "h-7 text-xs flex-1",\n'
        '        }, selectChangeHandler(setNewParent))'
    )
    child_select = (
        'value: newChild,\n'
        '          className: "h-7 text-xs flex-1",\n'
        '        }, selectChangeHandler(setNewChild))'
    )

    assert parent_select in bundle
    assert child_select in bundle


def test_bulk_archive(client):
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks", json={"title": "b"}).json()["task"]
    r = client.post("/api/plugins/kanban/tasks/bulk",
                    json={"ids": [a["id"], b["id"]], "archive": True})
    assert r.status_code == 200
    assert all(r["ok"] for r in r.json()["results"])
    # Default board (archived hidden) — both gone.
    board = client.get("/api/plugins/kanban/board").json()
    ids = {t["id"] for col in board["columns"] for t in col["tasks"]}
    assert a["id"] not in ids
    assert b["id"] not in ids


def test_bulk_reassign(client):
    a = client.post("/api/plugins/kanban/tasks",
                    json={"title": "a", "assignee": "old"}).json()["task"]
    b = client.post("/api/plugins/kanban/tasks",
                    json={"title": "b", "assignee": "old"}).json()["task"]
    r = client.post("/api/plugins/kanban/tasks/bulk",
                    json={"ids": [a["id"], b["id"]], "assignee": "new"})
    assert r.status_code == 200
    for tid in (a["id"], b["id"]):
        t = client.get(f"/api/plugins/kanban/tasks/{tid}").json()["task"]
        assert t["assignee"] == "new"


def test_bulk_unassign_via_empty_string(client):
    a = client.post("/api/plugins/kanban/tasks",
                    json={"title": "a", "assignee": "x"}).json()["task"]
    r = client.post("/api/plugins/kanban/tasks/bulk",
                    json={"ids": [a["id"]], "assignee": ""})
    assert r.status_code == 200
    t = client.get(f"/api/plugins/kanban/tasks/{a['id']}").json()["task"]
    assert t["assignee"] is None


def test_bulk_partial_failure_doesnt_abort_siblings(client):
    """One bad id in the middle of a batch must not prevent others from
    applying."""
    a = client.post("/api/plugins/kanban/tasks", json={"title": "a"}).json()["task"]
    c2 = client.post("/api/plugins/kanban/tasks", json={"title": "c"}).json()["task"]
    r = client.post("/api/plugins/kanban/tasks/bulk",
                    json={"ids": [a["id"], "bogus-id", c2["id"]], "priority": 7})
    assert r.status_code == 200
    results = r.json()["results"]
    assert len(results) == 3
    ok_ids = {r["id"] for r in results if r["ok"]}
    assert a["id"] in ok_ids
    assert c2["id"] in ok_ids
    assert any(not r["ok"] and r["id"] == "bogus-id" for r in results)
    # Good siblings actually got the priority bump.
    for tid in (a["id"], c2["id"]):
        t = client.get(f"/api/plugins/kanban/tasks/{tid}").json()["task"]
        assert t["priority"] == 7


def test_bulk_empty_ids_400(client):
    r = client.post("/api/plugins/kanban/tasks/bulk", json={"ids": []})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# /config endpoint
# ---------------------------------------------------------------------------


def test_config_returns_defaults_when_section_missing(client):
    r = client.get("/api/plugins/kanban/config")
    assert r.status_code == 200
    data = r.json()
    # Defaults when dashboard.kanban is missing.
    assert data["default_tenant"] == ""
    assert data["lane_by_profile"] is True
    assert data["include_archived_by_default"] is False
    assert data["render_markdown"] is True


def test_config_reads_dashboard_kanban_section(tmp_path, monkeypatch, client):
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text(
        "dashboard:\n"
        "  kanban:\n"
        "    default_tenant: acme\n"
        "    lane_by_profile: false\n"
        "    include_archived_by_default: true\n"
        "    render_markdown: false\n"
    )
    r = client.get("/api/plugins/kanban/config")
    assert r.status_code == 200
    data = r.json()
    assert data["default_tenant"] == "acme"
    assert data["lane_by_profile"] is False
    assert data["include_archived_by_default"] is True
    assert data["render_markdown"] is False


# ---------------------------------------------------------------------------
# Runs surfacing (vulcan-artivus RFC feedback)
# ---------------------------------------------------------------------------

def test_task_detail_includes_runs(client):
    """GET /tasks/:id carries a runs[] array with the attempt history."""
    r = client.post("/api/plugins/kanban/tasks",
                    json={"title": "port x", "assignee": "worker"}).json()
    tid = r["task"]["id"]

    # Drive status running to force a run creation: PATCH to running
    # doesn't call claim_task (the PATCH path uses _set_status_direct),
    # so use the bulk/claim indirection via the kernel.
    import hermes_cli.kanban_db as _kb
    conn = _kb.connect()
    try:
        _kb.claim_task(conn, tid)
        _kb.complete_task(
            conn, tid,
            result="done",
            summary="tested on rate limiter",
            metadata={"changed_files": ["limiter.py"]},
        )
    finally:
        conn.close()

    d = client.get(f"/api/plugins/kanban/tasks/{tid}").json()
    assert "runs" in d
    assert len(d["runs"]) == 1
    run = d["runs"][0]
    assert run["outcome"] == "completed"
    assert run["profile"] == "worker"
    assert run["summary"] == "tested on rate limiter"
    assert run["metadata"] == {"changed_files": ["limiter.py"]}
    assert run["ended_at"] is not None


def test_task_detail_runs_empty_before_claim(client):
    """A task that's never been claimed has an empty runs[] list, not
    a missing key."""
    r = client.post("/api/plugins/kanban/tasks", json={"title": "fresh"}).json()
    d = client.get(f"/api/plugins/kanban/tasks/{r['task']['id']}").json()
    assert d["runs"] == []


def test_patch_status_done_with_summary_and_metadata(client):
    """PATCH /tasks/:id with status=done + summary + metadata must
    reach complete_task, so the dashboard has CLI parity."""
    # Create + claim.
    r = client.post("/api/plugins/kanban/tasks", json={"title": "x", "assignee": "worker"})
    tid = r.json()["task"]["id"]
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    try:
        kb.claim_task(conn, tid)
    finally:
        conn.close()

    r = client.patch(
        f"/api/plugins/kanban/tasks/{tid}",
        json={
            "status": "done",
            "summary": "shipped the thing",
            "metadata": {"changed_files": ["a.py", "b.py"], "tests_run": 7},
        },
    )
    assert r.status_code == 200, r.text

    # The run must have the summary + metadata attached.
    conn = kb.connect()
    try:
        run = kb.latest_run(conn, tid)
        assert run.outcome == "completed"
        assert run.summary == "shipped the thing"
        assert run.metadata == {"changed_files": ["a.py", "b.py"], "tests_run": 7}
    finally:
        conn.close()


def test_patch_status_done_without_summary_still_works(client):
    """Back-compat: PATCH without the new fields still completes."""
    r = client.post("/api/plugins/kanban/tasks", json={"title": "y", "assignee": "worker"})
    tid = r.json()["task"]["id"]
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    try:
        kb.claim_task(conn, tid)
    finally:
        conn.close()
    r = client.patch(
        f"/api/plugins/kanban/tasks/{tid}",
        json={"status": "done", "result": "legacy shape"},
    )
    assert r.status_code == 200, r.text
    conn = kb.connect()
    try:
        run = kb.latest_run(conn, tid)
        assert run.outcome == "completed"
        assert run.summary == "legacy shape"  # falls back to result
    finally:
        conn.close()


def test_patch_status_archive_closes_running_run(client):
    """PATCH to archived while running must close the in-flight run."""
    r = client.post("/api/plugins/kanban/tasks", json={"title": "z", "assignee": "worker"})
    tid = r.json()["task"]["id"]
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    try:
        kb.claim_task(conn, tid)
        open_run = kb.latest_run(conn, tid)
        assert open_run.ended_at is None
    finally:
        conn.close()
    r = client.patch(
        f"/api/plugins/kanban/tasks/{tid}",
        json={"status": "archived"},
    )
    assert r.status_code == 200, r.text
    conn = kb.connect()
    try:
        task = kb.get_task(conn, tid)
        assert task.status == "archived"
        assert task.current_run_id is None
        assert kb.latest_run(conn, tid).outcome == "reclaimed"
    finally:
        conn.close()


def test_event_dict_includes_run_id(client):
    """GET /tasks/:id returns events with run_id populated."""
    r = client.post("/api/plugins/kanban/tasks", json={"title": "e", "assignee": "worker"})
    tid = r.json()["task"]["id"]
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    try:
        kb.claim_task(conn, tid)
        run_id = kb.latest_run(conn, tid).id
        kb.complete_task(conn, tid, summary="wss")
    finally:
        conn.close()

    r = client.get(f"/api/plugins/kanban/tasks/{tid}")
    assert r.status_code == 200
    events = r.json()["events"]
    # Every event in the response must have a run_id key (None or int).
    for e in events:
        assert "run_id" in e, f"missing run_id in event: {e}"
    # completed event must have the actual run_id.
    comp = [e for e in events if e["kind"] == "completed"]
    assert comp[0]["run_id"] == run_id



# ---------------------------------------------------------------------------
# Per-task force-loaded skills via REST
# ---------------------------------------------------------------------------

def test_create_task_with_skills_roundtrips(client):
    """POST /tasks accepts `skills: [...]`, GET /tasks/:id returns it."""
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={
            "title": "translate docs",
            "assignee": "linguist",
            "skills": ["translation", "github-code-review"],
        },
    )
    assert r.status_code == 200, r.text
    task = r.json()["task"]
    assert task["skills"] == ["translation", "github-code-review"]

    # Fetch via GET /tasks/:id as the drawer does.
    got = client.get(f"/api/plugins/kanban/tasks/{task['id']}").json()
    assert got["task"]["skills"] == ["translation", "github-code-review"]


def test_create_task_without_skills_defaults_to_empty_list(client):
    """_task_dict serializes Task.skills=None as [] so the drawer can
    always .length check without guarding against null."""
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "no skills", "assignee": "x"},
    )
    assert r.status_code == 200, r.text
    task = r.json()["task"]
    # Task.skills is None in-memory; _task_dict serializes via
    # dataclasses.asdict which keeps it None. The drawer's
    # `t.skills && t.skills.length > 0` guard handles both null and [].
    assert task.get("skills") in (None, [])


def test_create_task_with_toolset_name_in_skills_is_rejected(client):
    """POST /tasks fails fast when callers confuse toolsets with skills."""
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={
            "title": "bad skills payload",
            "assignee": "linguist",
            "skills": ["web"],
        },
    )
    assert r.status_code == 400, r.text
    assert "toolset name" in r.json()["detail"]



# ---------------------------------------------------------------------------
# Dispatcher-presence warning in POST /tasks response
# ---------------------------------------------------------------------------

def test_create_task_includes_warning_when_no_dispatcher(client, monkeypatch):
    """ready+assigned task + no gateway -> response has `warning` field
    so the dashboard UI can surface a banner."""
    # Force the dispatcher probe to report "not running".
    monkeypatch.setattr(
        "hermes_cli.kanban._check_dispatcher_presence",
        lambda: (False, "No gateway is running — start `hermes gateway start`."),
    )
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "warn-me", "assignee": "worker"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data.get("warning")
    assert "gateway" in data["warning"].lower()


def test_create_task_no_warning_when_dispatcher_up(client, monkeypatch):
    """Dispatcher running -> no `warning` field in the response."""
    monkeypatch.setattr(
        "hermes_cli.kanban._check_dispatcher_presence",
        lambda: (True, ""),
    )
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "silent", "assignee": "worker"},
    )
    assert r.status_code == 200
    assert "warning" not in r.json() or not r.json()["warning"]


def test_create_task_no_warning_on_triage(client, monkeypatch):
    """Triage tasks never get the warning (they can't be dispatched
    anyway until promoted)."""
    monkeypatch.setattr(
        "hermes_cli.kanban._check_dispatcher_presence",
        lambda: (False, "oh no"),
    )
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "triage-task", "assignee": "worker", "triage": True},
    )
    assert r.status_code == 200
    assert "warning" not in r.json() or not r.json()["warning"]


# ---------------------------------------------------------------------------
# _task_dict — outer try/except fallback when task_age raises
#
# Background: kanban_db.task_age was hardened in 061a1830 to return None for
# corrupt timestamp values via _safe_int. The companion fix added a belt-and-
# suspenders try/except in plugin_api._task_dict so that *any future* exception
# from task_age (not just ValueError on '%s') still yields a usable dict
# instead of 500'ing GET /board for the entire org.
#
# kanban_db._safe_int / task_age corruption paths are covered in
# tests/hermes_cli/test_kanban_db.py. The OUTER fallback here is not, which
# means a refactor that drops the try/except would not be caught by CI. The
# tests below pin that contract.
# ---------------------------------------------------------------------------


_FALLBACK_AGE = {
    "created_age_seconds": None,
    "started_age_seconds": None,
    "time_to_complete_seconds": None,
}


def test_board_endpoint_survives_task_age_exception(client, monkeypatch):
    """If task_age raises for any reason, GET /board must NOT 500.

    Pre-fix behavior (without the try/except in _task_dict): a single corrupt
    row turned the entire board response into a 500. The fallback dict lets
    the dashboard render every other card normally.
    """
    create = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "doomed", "assignee": "alice"},
    )
    assert create.status_code == 200, create.text

    # Force task_age to raise an exception type _safe_int does NOT handle —
    # simulates a future regression where someone re-introduces an unguarded
    # operation in task_age. ValueError on '%s' would be absorbed by _safe_int
    # and never reach the outer try/except, so it would not exercise the
    # contract this test pins.
    def _boom(_task):
        raise RuntimeError("simulated future task_age bug")
    monkeypatch.setattr("hermes_cli.kanban_db.task_age", _boom)

    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200, r.text

    payload = r.json()
    # /board returns columns as a list of {name, tasks} — not a dict — so
    # flatten across all columns to find our seeded task.
    tasks = [t for col in payload["columns"] for t in col["tasks"]]
    assert len(tasks) == 1, f"expected exactly the seeded task, got {tasks!r}"
    # Strict equality: the literal fallback dict from plugin_api._task_dict
    # is the published contract the dashboard UI relies on. Key renames or
    # silent additions should fail this test on purpose.
    assert tasks[0]["age"] == _FALLBACK_AGE


def test_single_task_endpoint_survives_task_age_exception(client, monkeypatch):
    """GET /tasks/:id also calls _task_dict — same fallback should kick in.

    This is the "drawer view" path: the user clicks one card and we serialize
    just that task. A corrupt timestamp on a single task should not block the
    user from opening its drawer.
    """
    create = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "drawer-target", "assignee": "bob"},
    )
    task_id = create.json()["task"]["id"]

    def _boom(_task):
        raise RuntimeError("simulated future task_age bug")
    monkeypatch.setattr("hermes_cli.kanban_db.task_age", _boom)

    r = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert r.status_code == 200, r.text
    assert r.json()["task"]["age"] == _FALLBACK_AGE


def test_create_task_probe_error_does_not_break_create(client, monkeypatch):
    """Probe failure must never break task creation."""
    def _raise():
        raise RuntimeError("probe crashed")
    monkeypatch.setattr(
        "hermes_cli.kanban._check_dispatcher_presence", _raise,
    )
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "resilient", "assignee": "worker"},
    )
    assert r.status_code == 200
    assert r.json()["task"]["title"] == "resilient"



# ---------------------------------------------------------------------------
# Home-channel subscription endpoints (#19534 follow-up: GUI opt-in)
# ---------------------------------------------------------------------------
#
# Dashboard surface for per-task, per-platform notification toggles. The
# backend endpoints read the live GatewayConfig, so tests set env vars
# (BOT_TOKEN + HOME_CHANNEL) to simulate a user who has run /sethome on
# telegram and discord.


@pytest.fixture
def with_home_channels(monkeypatch):
    """Simulate a user with home channels set on telegram and discord."""
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "abc:fake")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "1234567")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL_THREAD_ID", "42")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL_NAME", "Main TG")
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "disc_fake")
    monkeypatch.setenv("DISCORD_HOME_CHANNEL", "9999999")
    monkeypatch.setenv("DISCORD_HOME_CHANNEL_NAME", "Main Discord")
    # Slack has a token but NO home — should be excluded from the list.
    monkeypatch.setenv("SLACK_BOT_TOKEN", "slack_fake")


def test_home_channels_lists_only_platforms_with_home(client, with_home_channels):
    """GET /home-channels returns entries only for platforms where the
    user has set a home; untoggled-subscribed bool is false by default."""
    r = client.get("/api/plugins/kanban/home-channels")
    assert r.status_code == 200
    platforms = {h["platform"] for h in r.json()["home_channels"]}
    assert {"telegram", "discord"}.issubset(platforms), platforms
    assert "slack" not in platforms, (
        f"slack has a token but no home — must not appear. got {platforms}"
    )
    for h in r.json()["home_channels"]:
        assert h["subscribed"] is False


def test_home_channels_no_task_id_all_unsubscribed(client, with_home_channels):
    """Without task_id, every entry's subscribed=false (UI "no task" state)."""
    r = client.get("/api/plugins/kanban/home-channels")
    assert r.status_code == 200
    assert all(not h["subscribed"] for h in r.json()["home_channels"])


def test_home_subscribe_creates_notify_sub_row(client, with_home_channels):
    """POST .../home-subscribe/telegram writes a kanban_notify_subs row
    keyed to the telegram home's (chat_id, thread_id)."""
    from hermes_cli import kanban_db as kb
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]

    r = client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    conn = kb.connect()
    try:
        subs = kb.list_notify_subs(conn, t["id"])
    finally:
        conn.close()
    assert len(subs) == 1
    assert subs[0]["platform"] == "telegram"
    assert subs[0]["chat_id"] == "1234567"
    assert subs[0]["thread_id"] == "42"
    assert subs[0]["notifier_profile"] == "default"


def test_home_subscribe_flips_subscribed_flag_in_subsequent_get(client, with_home_channels):
    """After subscribe, the GET endpoint reports subscribed=true for that
    platform and false for the others."""
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")

    r = client.get(f"/api/plugins/kanban/home-channels?task_id={t['id']}")
    flags = {h["platform"]: h["subscribed"] for h in r.json()["home_channels"]}
    assert flags["telegram"] is True
    assert flags["discord"] is False
    assert all(not subscribed for platform, subscribed in flags.items() if platform != "telegram")


def test_home_subscribe_is_idempotent(client, with_home_channels):
    """Re-subscribing keeps a single row at the DB layer."""
    from hermes_cli import kanban_db as kb
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    conn = kb.connect()
    try:
        assert len(kb.list_notify_subs(conn, t["id"])) == 1
    finally:
        conn.close()


def test_home_subscribe_backfills_owner_on_legacy_row(client, with_home_channels):
    """Re-subscribing should backfill notifier ownership on ownerless rows."""
    from hermes_cli import kanban_db as kb
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]

    conn = kb.connect()
    try:
        kb.add_notify_sub(
            conn,
            task_id=t["id"],
            platform="telegram",
            chat_id="1234567",
            thread_id="42",
        )
    finally:
        conn.close()

    r = client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    assert r.status_code == 200

    conn = kb.connect()
    try:
        subs = kb.list_notify_subs(conn, t["id"])
    finally:
        conn.close()

    assert len(subs) == 1
    assert subs[0]["notifier_profile"] == "default"


def test_home_subscribe_unknown_platform_returns_404(client, with_home_channels):
    """Platforms without a home configured (slack in the fixture) return 404."""
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    r = client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/slack")
    assert r.status_code == 404
    assert "slack" in r.json()["detail"]


def test_home_subscribe_unknown_task_returns_404(client, with_home_channels):
    r = client.post("/api/plugins/kanban/tasks/t_nonexistent/home-subscribe/telegram")
    assert r.status_code == 404


def test_home_unsubscribe_removes_notify_sub_row(client, with_home_channels):
    """DELETE .../home-subscribe/telegram removes the matching row."""
    from hermes_cli import kanban_db as kb
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    r = client.delete(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    assert r.status_code == 200

    conn = kb.connect()
    try:
        assert kb.list_notify_subs(conn, t["id"]) == []
    finally:
        conn.close()


def test_home_subscribe_multiple_platforms_independent(client, with_home_channels):
    """Subscribing on telegram does not affect discord and vice versa."""
    from hermes_cli import kanban_db as kb
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]

    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    client.post(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/discord")

    conn = kb.connect()
    try:
        subs = {s["platform"]: s for s in kb.list_notify_subs(conn, t["id"])}
    finally:
        conn.close()
    assert set(subs) == {"telegram", "discord"}

    # Unsubscribe telegram only.
    client.delete(f"/api/plugins/kanban/tasks/{t['id']}/home-subscribe/telegram")
    conn = kb.connect()
    try:
        subs = {s["platform"]: s for s in kb.list_notify_subs(conn, t["id"])}
    finally:
        conn.close()
    assert set(subs) == {"discord"}


def test_home_channels_empty_when_no_homes_configured(client, monkeypatch):
    """Zero platforms with a home -> empty list (UI hides the section)."""
    # No BOT_TOKEN env vars set → load_gateway_config().platforms is empty.
    for var in [
        "TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL",
        "DISCORD_BOT_TOKEN", "DISCORD_HOME_CHANNEL",
        "SLACK_BOT_TOKEN",
    ]:
        monkeypatch.delenv(var, raising=False)
    r = client.get("/api/plugins/kanban/home-channels")
    assert r.status_code == 200
    assert r.json()["home_channels"] == []


# ---------------------------------------------------------------------------
# Recovery endpoints (reclaim + reassign) and warnings field
# ---------------------------------------------------------------------------

def test_board_surfaces_warnings_field_for_hallucinated_completions(client):
    """Tasks with a pending completion_blocked_hallucination event surface
    a ``warnings`` object on the /board payload so the UI can badge
    them without fetching per-task events. The warnings summary is
    keyed by diagnostic kind (``hallucinated_cards``) rather than the
    raw event kind — see hermes_cli.kanban_diagnostics for the rule
    that produces it.
    """
    conn = kb.connect()
    try:
        parent = kb.create_task(conn, title="parent", assignee="alice")
        real = kb.create_task(conn, title="real", assignee="x", created_by="alice")

        import pytest as _pytest
        with _pytest.raises(kb.HallucinatedCardsError):
            kb.complete_task(
                conn, parent,
                summary="claimed phantom",
                created_cards=[real, "t_deadbeefcafe"],
            )
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    data = r.json()
    tasks = [t for col in data["columns"] for t in col["tasks"]]
    parent_dict = next(t for t in tasks if t["title"] == "parent")
    assert parent_dict.get("warnings") is not None
    w = parent_dict["warnings"]
    assert w["count"] >= 1
    assert "hallucinated_cards" in w["kinds"]
    assert w["highest_severity"] == "error"
    # Full diagnostic list also on the payload for drawer rendering.
    assert parent_dict.get("diagnostics") is not None
    assert parent_dict["diagnostics"][0]["kind"] == "hallucinated_cards"
    assert "t_deadbeefcafe" in parent_dict["diagnostics"][0]["data"]["phantom_ids"]


def test_board_warnings_cleared_after_clean_completion(client):
    """A completed or edited event after a hallucination event clears
    the warning badge — we don't mark tasks permanently."""
    conn = kb.connect()
    try:
        parent = kb.create_task(conn, title="parent", assignee="alice")
        real = kb.create_task(conn, title="real", assignee="x", created_by="alice")

        import pytest as _pytest
        with _pytest.raises(kb.HallucinatedCardsError):
            kb.complete_task(
                conn, parent,
                summary="first attempt phantom",
                created_cards=[real, "t_phantom11"],
            )

        # Second attempt drops the bad id — succeeds.
        ok = kb.complete_task(
            conn, parent,
            summary="retry without phantom",
            created_cards=[real],
        )
        assert ok is True
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/board", params={"include_archived": True})
    assert r.status_code == 200
    data = r.json()
    tasks = [t for col in data["columns"] for t in col["tasks"]]
    parent_dict = next(t for t in tasks if t["title"] == "parent")
    # The clean completion wiped the warning.
    assert parent_dict.get("warnings") is None


def test_reclaim_endpoint_releases_running_claim(client):
    """POST /tasks/<id>/reclaim drops the claim, returns ok, and emits
    a manual reclaimed event."""
    import secrets
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="running", assignee="x")
        lock = secrets.token_hex(8)
        future = int(time.time()) + 3600
        conn.execute(
            "UPDATE tasks SET status='running', claim_lock=?, claim_expires=?, "
            "worker_pid=? WHERE id=?",
            (lock, future, 99999, t),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, status, claim_lock, claim_expires, "
            "worker_pid, started_at) VALUES (?, 'running', ?, ?, ?, ?)",
            (t, lock, future, 99999, int(time.time())),
        )
        run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (run_id, t))
        conn.commit()
    finally:
        conn.close()

    r = client.post(
        f"/api/plugins/kanban/tasks/{t}/reclaim",
        json={"reason": "browser recovery"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["task_id"] == t

    # Confirm the task is back to ready.
    conn2 = kb.connect()
    try:
        row = conn2.execute(
            "SELECT status, claim_lock FROM tasks WHERE id=?", (t,),
        ).fetchone()
        assert row["status"] == "ready"
        assert row["claim_lock"] is None
    finally:
        conn2.close()


def test_reclaim_endpoint_409_for_non_running_task(client):
    """Reclaiming a task that's already ready returns 409."""
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="ready", assignee="x")
    finally:
        conn.close()

    r = client.post(
        f"/api/plugins/kanban/tasks/{t}/reclaim",
        json={},
    )
    assert r.status_code == 409


def test_reassign_endpoint_switches_profile(client):
    """POST /tasks/<id>/reassign changes the assignee field."""
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="task", assignee="orig")
    finally:
        conn.close()

    r = client.post(
        f"/api/plugins/kanban/tasks/{t}/reassign",
        json={"profile": "newbie", "reclaim_first": False},
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"] == "newbie"

    conn2 = kb.connect()
    try:
        row = conn2.execute(
            "SELECT assignee FROM tasks WHERE id=?", (t,),
        ).fetchone()
        assert row["assignee"] == "newbie"
    finally:
        conn2.close()


def test_reassign_endpoint_409_on_running_without_reclaim(client):
    """Reassigning a running task without reclaim_first returns 409."""
    import secrets
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="running", assignee="orig")
        conn.execute(
            "UPDATE tasks SET status='running', claim_lock=? WHERE id=?",
            (secrets.token_hex(4), t),
        )
        conn.commit()
    finally:
        conn.close()

    r = client.post(
        f"/api/plugins/kanban/tasks/{t}/reassign",
        json={"profile": "new", "reclaim_first": False},
    )
    assert r.status_code == 409


def test_reassign_endpoint_with_reclaim_first_succeeds_on_running(client):
    """With reclaim_first=true, a running task is reclaimed+reassigned in
    one call."""
    import secrets
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="running", assignee="orig")
        lock = secrets.token_hex(4)
        conn.execute(
            "UPDATE tasks SET status='running', claim_lock=?, claim_expires=?, "
            "worker_pid=? WHERE id=?",
            (lock, int(time.time()) + 3600, 1234, t),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, status, claim_lock, claim_expires, "
            "worker_pid, started_at) VALUES (?, 'running', ?, ?, ?, ?)",
            (t, lock, int(time.time()) + 3600, 1234, int(time.time())),
        )
        rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (rid, t))
        conn.commit()
    finally:
        conn.close()

    r = client.post(
        f"/api/plugins/kanban/tasks/{t}/reassign",
        json={"profile": "new", "reclaim_first": True, "reason": "switch"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"] == "new"

    conn2 = kb.connect()
    try:
        row = conn2.execute(
            "SELECT status, assignee FROM tasks WHERE id=?", (t,),
        ).fetchone()
        assert row["status"] == "ready"
        assert row["assignee"] == "new"
    finally:
        conn2.close()


# ---------------------------------------------------------------------------
# Diagnostics endpoint (/api/plugins/kanban/diagnostics)
# ---------------------------------------------------------------------------

def test_diagnostics_endpoint_empty_for_clean_board(client):
    r = client.get("/api/plugins/kanban/diagnostics")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 0
    assert data["diagnostics"] == []


def test_diagnostics_endpoint_surfaces_blocked_hallucination(client):
    conn = kb.connect()
    try:
        parent = kb.create_task(conn, title="parent", assignee="alice")
        real = kb.create_task(conn, title="real", assignee="x", created_by="alice")
        import pytest as _pytest
        with _pytest.raises(kb.HallucinatedCardsError):
            kb.complete_task(
                conn, parent, summary="phantom",
                created_cards=[real, "t_ffff00001234"],
            )
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/diagnostics")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 1
    row = data["diagnostics"][0]
    assert row["task_id"] == parent
    assert row["diagnostics"][0]["kind"] == "hallucinated_cards"
    assert row["diagnostics"][0]["severity"] == "error"
    assert "t_ffff00001234" in row["diagnostics"][0]["data"]["phantom_ids"]


def test_diagnostics_endpoint_severity_filter(client):
    """Severity filter is at-or-above: warning includes warning+error+critical,
    error includes error+critical, critical is exact (no higher level)."""
    conn = kb.connect()
    try:
        # A warning-severity diagnostic (prose phantom) on one task.
        # Phantom id must be valid hex — the prose scanner regex
        # requires ``t_[a-f0-9]{8,}``.
        p1 = kb.create_task(conn, title="prose", assignee="a")
        kb.complete_task(conn, p1, summary="mentioned t_deadbeef1234")
        # An error-severity diagnostic (spawn failures) on another.
        # Keep this below critical severity (failure_threshold * 2).
        p2 = kb.create_task(conn, title="spawn", assignee="b")
        conn.execute(
            "UPDATE tasks SET consecutive_failures=2, last_failure_error='x' WHERE id=?",
            (p2,),
        )
        conn.commit()
    finally:
        conn.close()

    # warning filter is at-or-above → both the warning AND the error pass.
    r = client.get("/api/plugins/kanban/diagnostics?severity=warning")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 2
    task_ids = {row["task_id"] for row in data["diagnostics"]}
    assert task_ids == {p1, p2}

    # error filter is at-or-above → only the error passes (warning is below).
    r = client.get("/api/plugins/kanban/diagnostics?severity=error")
    data = r.json()
    assert data["count"] == 1
    assert data["diagnostics"][0]["task_id"] == p2


def test_board_exposes_diagnostics_list_and_summary(client):
    """/board should attach both the full diagnostics list AND the
    compact warnings summary (with highest_severity) on each task
    that has any diagnostic.
    """
    conn = kb.connect()
    try:
        t = kb.create_task(conn, title="crashy", assignee="worker")
        # Simulate 2 consecutive crashes -> repeated_crashes error diag
        for i in range(2):
            conn.execute(
                "INSERT INTO task_runs (task_id, status, outcome, started_at, "
                "ended_at, error) VALUES (?, 'crashed', 'crashed', ?, ?, ?)",
                (t, int(time.time()) - 100, int(time.time()) - 50, "OOM"),
            )
        conn.commit()
    finally:
        conn.close()

    r = client.get("/api/plugins/kanban/board")
    data = r.json()
    tasks = [x for col in data["columns"] for x in col["tasks"]]
    task_dict = next(x for x in tasks if x["title"] == "crashy")
    assert task_dict["warnings"] is not None
    assert task_dict["warnings"]["highest_severity"] == "error"
    assert task_dict["diagnostics"][0]["kind"] == "repeated_crashes"


# ---------------------------------------------------------------------------
# POST /tasks/:id/specify — triage specifier endpoint
# ---------------------------------------------------------------------------


def _patch_specifier_response(monkeypatch, *, content, model="test-model"):
    """Helper: install a fake auxiliary client so the specifier endpoint
    can run without hitting any real provider."""
    from unittest.mock import MagicMock

    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    # specify_task routes through call_llm now (#35566) — mock it directly.
    fake_call = MagicMock(return_value=resp)
    monkeypatch.setattr("agent.auxiliary_client.call_llm", fake_call)
    return fake_call


def test_specify_happy_path(client, monkeypatch):
    import json as jsonlib

    # Create a triage task.
    t = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "one-liner", "triage": True},
    ).json()["task"]
    assert t["status"] == "triage"

    _patch_specifier_response(
        monkeypatch,
        content=jsonlib.dumps(
            {"title": "Polished", "body": "**Goal**\nDo the thing."}
        ),
    )

    r = client.post(
        f"/api/plugins/kanban/tasks/{t['id']}/specify",
        json={"author": "ui-tester"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["task_id"] == t["id"]
    assert body["new_title"] == "Polished"

    # Task should have moved off the triage column.
    detail = client.get(f"/api/plugins/kanban/tasks/{t['id']}").json()["task"]
    assert detail["status"] in {"todo", "ready"}
    assert detail["title"] == "Polished"
    assert "**Goal**" in (detail["body"] or "")


def test_specify_non_triage_returns_ok_false_not_http_error(client, monkeypatch):
    """The endpoint intentionally returns ``{ok: false, reason: ...}`` for
    "task not in triage" rather than a 4xx — the dashboard renders the
    reason inline so the user can fix it without a page reload."""
    # Create a normal (ready) task — not in triage.
    t = client.post("/api/plugins/kanban/tasks", json={"title": "x"}).json()["task"]

    _patch_specifier_response(monkeypatch, content="unused")

    r = client.post(
        f"/api/plugins/kanban/tasks/{t['id']}/specify",
        json={},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "not in triage" in body["reason"]


def test_specify_no_aux_client_surfaces_reason(client, monkeypatch):
    t = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "rough", "triage": True},
    ).json()["task"]

    # Simulate "no auxiliary client configured" — call_llm raises when
    # no provider resolves (#35566 routing).
    def _no_provider(**kwargs):
        raise RuntimeError("No LLM provider configured")
    monkeypatch.setattr("agent.auxiliary_client.call_llm", _no_provider)

    r = client.post(
        f"/api/plugins/kanban/tasks/{t['id']}/specify",
        json={},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    # call_llm's no-provider RuntimeError surfaces via the LLM-error branch.
    assert "LLM error" in body["reason"]

    # Task must stay in triage — nothing was touched.
    detail = client.get(f"/api/plugins/kanban/tasks/{t['id']}").json()["task"]
    assert detail["status"] == "triage"


def test_board_endpoint_accepts_explicit_board_default_param(client):
    """GET /board?board=default must not fall through to env/current-file resolution.

    The dashboard always sends ``?board=<slug>`` (including ``board=default``)
    so that the server-side ``current`` file can never override the dashboard's
    selected board.  This test asserts the endpoint accepts the parameter and
    returns the default board without falling back to environment variable or
    current-file resolution.
    Regression: #21819.
    """
    # Create a task on the default board.
    t = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "on-default-board"},
    ).json()["task"]
    assert t["status"] == "ready"

    # Request with explicit board=default — must succeed and include the task.
    r = client.get("/api/plugins/kanban/board?board=default")
    assert r.status_code == 200
    data = r.json()
    ready = next((c for c in data["columns"] if c["name"] == "ready"), None)
    assert ready is not None, "no 'ready' column in default board response"
    task_ids = [task["id"] for task in ready["tasks"]]
    assert t["id"] in task_ids, (
        f"task {t['id']} not found in ready column of default board "
        f"(got tasks: {task_ids}). The board=default param was likely ignored."
    )


def test_dashboard_requests_default_board_explicitly():
    """Dashboard REST calls must include board=default instead of relying on server current board."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()

    assert "SDK.fetchJSON(withBoard(`${API}/config`, board))" in dist
    assert "SDK.fetchJSON(withBoard(`${API}/boards`, board))" in dist
    assert "}, [loadBoardList, switchBoard, board]);" in dist


def test_dashboard_search_includes_body_and_result():
    """Client-side search must match body, result, latest_summary, and summary
    so full card contents are findable."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()

    assert "t.body || \"\"" in dist
    assert "t.result || \"\"" in dist
    assert "t.latest_summary || \"\"" in dist


def test_dashboard_bulk_actions_include_reclaim_first():
    """Bulk action bar must expose reclaim_first checkbox and expanded status buttons."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()

    assert "reclaim_first: reclaimFirst" in dist
    assert "hermes-kanban-bulk-reclaim-first" in dist
    assert '"→ todo"' in dist
    assert '"Block"' in dist
    assert '"Unblock"' in dist


def test_dashboard_shift_click_range_selection_exists():
    """Shift-click must trigger range selection via toggleRange."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()

    assert "function toggleRange" in dist or "const toggleRange =" in dist
    assert "props.toggleRange(t.id)" in dist or "props.toggleRange" in dist
    assert "e.shiftKey" in dist


def test_dashboard_multi_move_bulk_exists():
    """Dragging a selected card with other selections must use /tasks/bulk."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()

    assert "onMoveSelected" in dist
    assert "props.onMoveSelected" in dist
    assert "`${API}/tasks/bulk`" in dist


def test_dashboard_failed_card_highlight_class_exists():
    """Partial bulk failures must highlight failing cards."""
    repo_root = Path(__file__).resolve().parents[2]
    js = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()
    css = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "style.css").read_text()

    assert "hermes-kanban-card--failed" in js
    assert "hermes-kanban-card--failed" in css
    assert "failedIds" in js

# ---------------------------------------------------------------------------
# Final result visibility for Done cards
# ---------------------------------------------------------------------------


def test_task_detail_exposes_result_and_latest_summary_separately(client):
    """The drawer receives both source fields without a duplicate alias."""
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Task with explicit result"},
    )
    task_id = r.json()["task"]["id"]
    client.patch(
        f"/api/plugins/kanban/tasks/{task_id}",
        json={"status": "done", "result": "The final answer is 42.", "summary": "short handoff"},
    )
    r = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert r.status_code == 200
    data = r.json()["task"]
    assert data["result"] == "The final answer is 42."
    assert data["latest_summary"] == "short handoff"
    assert "final_result" not in data


def test_task_detail_exposes_latest_summary_when_result_is_empty(client):
    """Summary-only completions remain available to the drawer fallback."""
    conn = kb.connect()
    task_id = kb.create_task(conn, title="Task with only run summary")
    kb.claim_task(conn, task_id)
    kb.complete_task(conn, task_id, summary="Report written to /output/report.md")
    conn.close()

    r = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert r.status_code == 200
    data = r.json()["task"]
    assert data["status"] == "done"
    assert not data["result"]
    assert data["latest_summary"] == "Report written to /output/report.md"


def test_task_detail_latest_summary_none_when_nothing_recorded(client):
    """When no run summary exists, the existing field remains None."""
    r = client.post(
        "/api/plugins/kanban/tasks",
        json={"title": "Task with no result at all"},
    )
    task_id = r.json()["task"]["id"]
    r = client.get(f"/api/plugins/kanban/tasks/{task_id}")
    assert r.status_code == 200
    assert r.json()["task"]["latest_summary"] is None


def test_board_tasks_include_latest_summary(client):
    """Board cards already expose the summary used by the drawer fallback."""
    conn = kb.connect()
    task_id = kb.create_task(conn, title="Board card with summary only")
    kb.claim_task(conn, task_id)
    kb.complete_task(conn, task_id, summary="Done: see attachment")
    conn.close()

    r = client.get("/api/plugins/kanban/board")
    assert r.status_code == 200
    done_col = next(c for c in r.json()["columns"] if c["name"] == "done")
    card = next((t for t in done_col["tasks"] if t["id"] == task_id), None)
    assert card is not None
    assert "Done: see attachment" in card["latest_summary"]


def test_dashboard_done_final_result_section_rendered_from_summary():
    """Frontend must render Final Result section from run summary when task.result is empty."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()
    assert "t.result || t.latest_summary" in dist
    assert "Final Result (run summary)" in dist
    assert "No final result was recorded" in dist
    assert "orchestrator" in dist or "parent task" in dist


def test_task_detail_includes_child_result_summaries(client):
    """Parent drawers should receive the child results they need to render."""
    with kb.connect() as conn:
        parent = kb.create_task(conn, title="Research topic")
        child = kb.create_task(conn, title="Collect sources")
        kb.link_tasks(conn, parent, child)
        kb.complete_task(conn, parent, summary="Delegated research to child tasks.")
        kb.recompute_ready(conn)
        kb.complete_task(conn, child, summary="Collected five primary sources.")

    response = client.get(f"/api/plugins/kanban/tasks/{parent}")

    assert response.status_code == 200
    assert response.json()["child_results"] == [
        {
            "id": child,
            "title": "Collect sources",
            "status": "done",
            "latest_summary": "Collected five primary sources.",
            "result": None,
        }
    ]


def test_dashboard_final_result_uses_existing_fields_without_alias():
    """The drawer should not duplicate result/summary into another API field."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()
    api = (repo_root / "plugins" / "kanban" / "dashboard" / "plugin_api.py").read_text()

    assert "var finalResult = t.result || t.latest_summary || null;" in dist
    assert "t.final_result" not in dist
    assert 'd["final_result"]' not in api


def test_dashboard_parent_notice_and_child_results_use_detail_links():
    """Parent detection must use links.children, which exists in task detail."""
    repo_root = Path(__file__).resolve().parents[2]
    dist = (repo_root / "plugins" / "kanban" / "dashboard" / "dist" / "index.js").read_text()
    detail = dist[dist.index("function TaskDetail"):]

    assert "links.children.length > 0" in detail
    assert "t.link_counts" not in detail
    assert "Child Results" in detail
    assert "props.data.child_results" in detail
