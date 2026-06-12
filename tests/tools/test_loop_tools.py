from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest


@pytest.fixture
def loop_env(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_PROFILE", "planner")
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    from hermes_cli import kanban_db as kb

    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    conn = kb.connect()
    try:
        root = kb.create_task(
            conn,
            title="Loop root",
            assignee=None,
            triage=True,
            tenant="tenant-a",
        )
    finally:
        conn.close()
    return root


def _call(args):
    from tools import loop_tools as wt

    return json.loads(wt._handle_loop_graph(args))


def test_loop_graph_tool_is_in_core_but_minimal_and_gated(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    import tools.loop_tools  # ensure registered
    from tools.registry import invalidate_check_fn_cache, registry
    from toolsets import resolve_toolset

    invalidate_check_fn_cache()
    schema = registry.get_definitions(set(resolve_toolset("hermes-cli")), quiet=True)
    names = {s["function"].get("name") for s in schema if "function" in s}
    assert "loop_graph" in names
    assert not any(n.startswith("loop_") and n != "loop_graph" for n in names)

    (home / "config.yaml").write_text("loop:\n  enabled: false\n")
    invalidate_check_fn_cache()
    schema = registry.get_definitions(set(resolve_toolset("hermes-cli")), quiet=True)
    names = {s["function"].get("name") for s in schema if "function" in s}
    assert "loop_graph" not in names


def test_patch_creates_real_triage_tasks_with_dependencies_and_compact_response(loop_env):
    root = loop_env
    out = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-create",
            "operations": [
                {
                    "op": "add_node",
                    "client_id": "a",
                    "title": "Research options",
                    "body": "Define research scope",
                    "suggested_owner": "researcher-a",
                    "active": True,
                    "frontier": True,
                },
                {
                    "op": "add_node",
                    "client_id": "b",
                    "title": "Synthesize plan",
                    "parents": ["a"],
                },
            ],
        }
    )

    assert out["ok"] is True
    assert out["previous_revision"] == 0
    assert out["graph_revision"] > 0
    assert set(out) <= {
        "ok",
        "root_task_id",
        "previous_revision",
        "graph_revision",
        "created",
        "updated",
        "archived",
        "duplicate",
        "validation",
    }
    created_by_client = {item["client_id"]: item["task_id"] for item in out["created"]}

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        first = kb.get_task(conn, created_by_client["a"])
        second = kb.get_task(conn, created_by_client["b"])
        assert first is not None and first.status == "triage" and first.assignee is None
        assert second is not None and second.status == "triage" and second.assignee is None
        assert second.tenant == "tenant-a"
        assert kb.parent_ids(conn, second.id) == [first.id]
        assert "Loop provenance" in (first.body or "")
        assert "suggested_owner: researcher-a" in (first.body or "")
    finally:
        conn.close()


def test_patch_rejects_stale_revision_and_replays_duplicate_mutation(loop_env):
    root = loop_env
    first = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-once",
            "operations": [{"op": "add_node", "client_id": "x", "title": "Only once"}],
        }
    )
    assert first["ok"] is True

    stale = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-stale",
            "operations": [{"op": "add_node", "client_id": "y", "title": "Too late"}],
        }
    )
    assert stale["ok"] is False
    assert stale["error"] == "stale_revision"
    assert stale["current_revision"] == first["graph_revision"]

    duplicate = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-once",
            "operations": [{"op": "add_node", "client_id": "x", "title": "Only once"}],
        }
    )
    assert duplicate == {**first, "duplicate": True}

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        rows = [t for t in kb.list_tasks(conn, status="triage") if t.title == "Only once"]
        assert len(rows) == 1
    finally:
        conn.close()


@pytest.mark.parametrize("op_name", ["update_node", "archive_node", "mark_node", "set_parents"])
def test_patch_rejects_mutation_targets_outside_requested_root(loop_env, op_name):
    root = loop_env
    created = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-root-a",
            "operations": [{"op": "add_node", "client_id": "a", "title": "Root A node"}],
        }
    )

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        unrelated = kb.create_task(conn, title="Unrelated triage", assignee=None, triage=True)
        other_root = kb.create_task(conn, title="Other root", assignee=None, triage=True)
    finally:
        conn.close()

    other_created = _call(
        {
            "action": "patch",
            "root_task_id": other_root,
            "expected_revision": 0,
            "mutation_id": "m-root-b",
            "operations": [{"op": "add_node", "client_id": "b", "title": "Root B node"}],
        }
    )
    other_node = other_created["created"][0]["task_id"]

    for target in [unrelated, root, other_node]:
        operation = {"op": op_name, "task_id": target}
        if op_name == "update_node":
            operation["title"] = "Should not change"
        elif op_name == "mark_node":
            operation["active"] = True
        elif op_name == "set_parents":
            operation["parents"] = []

        out = _call(
            {
                "action": "patch",
                "root_task_id": root,
                "expected_revision": created["graph_revision"],
                "mutation_id": f"m-{op_name}-{target}",
                "operations": [operation],
            }
        )

        assert out["ok"] is False
        assert out["error"] == "wrong_root"

    conn = kb.connect()
    try:
        unrelated_task = kb.get_task(conn, unrelated)
        root_task = kb.get_task(conn, root)
        other_task = kb.get_task(conn, other_node)
        assert unrelated_task is not None and unrelated_task.title == "Unrelated triage"
        assert root_task is not None and root_task.title == "Loop root"
        assert other_task is not None and other_task.title == "Root B node"
    finally:
        conn.close()


@pytest.mark.parametrize("parent_kind", ["external", "root", "other_root"])
def test_add_node_rejects_parents_outside_requested_root(loop_env, parent_kind):
    root = loop_env
    created = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-root-a-parent-source",
            "operations": [{"op": "add_node", "client_id": "a", "title": "Root A node"}],
        }
    )

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        external = kb.create_task(conn, title="External triage", assignee=None, triage=True)
        other_root = kb.create_task(conn, title="Other Loop root", assignee=None, triage=True)
    finally:
        conn.close()

    other_created = _call(
        {
            "action": "patch",
            "root_task_id": other_root,
            "expected_revision": 0,
            "mutation_id": "m-other-root-parent-source",
            "operations": [{"op": "add_node", "client_id": "b", "title": "Root B node"}],
        }
    )
    parent_id = {
        "external": external,
        "root": root,
        "other_root": other_created["created"][0]["task_id"],
    }[parent_kind]

    out = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": created["graph_revision"],
            "mutation_id": f"m-add-node-bad-parent-{parent_kind}",
            "operations": [{"op": "add_node", "client_id": "child", "title": "Child", "parents": [parent_id]}],
        }
    )

    assert out["ok"] is False
    assert out["error"] == "wrong_root"

    conn = kb.connect()
    try:
        rows = [t for t in kb.list_tasks(conn, status="triage") if t.title == "Child"]
        assert rows == []
    finally:
        conn.close()


def test_add_node_allows_existing_same_root_parent_and_prior_client_id_parent(loop_env):
    root = loop_env
    first = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-existing-parent-source",
            "operations": [{"op": "add_node", "client_id": "existing", "title": "Existing parent"}],
        }
    )
    existing_id = first["created"][0]["task_id"]

    out = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": first["graph_revision"],
            "mutation_id": "m-add-allowed-parents",
            "operations": [
                {"op": "add_node", "client_id": "same-root-child", "title": "Same-root child", "parents": [existing_id]},
                {"op": "add_node", "client_id": "prior-client-child", "title": "Prior-client child", "parents": ["same-root-child"]},
            ],
        }
    )

    assert out["ok"] is True
    ids = {item["client_id"]: item["task_id"] for item in out["created"]}

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        assert kb.parent_ids(conn, ids["same-root-child"]) == [existing_id]
        assert kb.parent_ids(conn, ids["prior-client-child"]) == [ids["same-root-child"]]
    finally:
        conn.close()


def test_patch_replays_duplicate_mutation_that_started_before_first_commit(loop_env, monkeypatch):
    root = loop_env

    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    original_append_root_event = graph._append_root_event
    first_thread_entered_commit = threading.Event()
    release_first_thread = threading.Event()
    results = []
    errors = []

    def slow_first_commit(conn, root_task_id, payload):
        if payload.get("mutation_id") == "m-concurrent":
            first_thread_entered_commit.set()
            release_first_thread.wait(timeout=5)
        return original_append_root_event(conn, root_task_id, payload)

    monkeypatch.setattr(graph, "_append_root_event", slow_first_commit)

    def apply_from_thread():
        conn = kb.connect()
        try:
            results.append(
                graph.apply_patch(
                    conn,
                    root,
                    expected_revision=0,
                    mutation_id="m-concurrent",
                    operations=[{"op": "add_node", "client_id": "x", "title": "Only once concurrently"}],
                )
            )
        except Exception as exc:  # captured so assertion failures show both thread outcomes
            errors.append(exc)
        finally:
            conn.close()

    first = threading.Thread(target=apply_from_thread)
    first.start()
    assert first_thread_entered_commit.wait(timeout=5)

    duplicate_thread = threading.Thread(target=apply_from_thread)
    duplicate_thread.start()
    time.sleep(0.2)
    release_first_thread.set()
    first.join(timeout=5)
    duplicate_thread.join(timeout=5)
    assert not first.is_alive()
    assert not duplicate_thread.is_alive()
    assert errors == []

    assert len(results) == 2
    first_result = next(item for item in results if item["duplicate"] is False)
    replay_result = next(item for item in results if item["duplicate"] is True)
    assert replay_result == {**first_result, "duplicate": True}

    conn = kb.connect()
    try:
        rows = [t for t in kb.list_tasks(conn, status="triage") if t.title == "Only once concurrently"]
        assert len(rows) == 1
    finally:
        conn.close()


def test_patch_validates_cycles_and_keeps_ready_running_rows_safe(loop_env):
    root = loop_env
    created = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-chain",
            "operations": [
                {"op": "add_node", "client_id": "a", "title": "A"},
                {"op": "add_node", "client_id": "b", "title": "B", "parents": ["a"]},
            ],
        }
    )
    ids = {item["client_id"]: item["task_id"] for item in created["created"]}

    cycle = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": created["graph_revision"],
            "mutation_id": "m-cycle",
            "operations": [{"op": "set_parents", "task_id": ids["a"], "parents": [ids["b"]]}],
        }
    )
    assert cycle["ok"] is False
    assert cycle["error"] == "validation_failed"
    assert "cycle" in cycle["message"]

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        ready = kb.create_task(conn, title="Dispatchable", assignee="worker")
        assert kb.get_task(conn, ready).status == "ready"
    finally:
        conn.close()

    unsafe = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": created["graph_revision"],
            "mutation_id": "m-unsafe",
            "operations": [{"op": "update_node", "task_id": ready, "title": "Nope"}],
        }
    )
    assert unsafe["ok"] is False
    assert unsafe["error"] == "unsafe_status"


def test_read_returns_revision_and_optional_dependency_derived_nodes(loop_env):
    root = loop_env
    patched = _call(
        {
            "action": "patch",
            "root_task_id": root,
            "expected_revision": 0,
            "mutation_id": "m-read",
            "operations": [
                {"op": "add_node", "client_id": "a", "title": "A", "active": True},
                {"op": "add_node", "client_id": "b", "title": "B", "parents": ["a"], "frontier": True},
            ],
        }
    )
    read = _call({"action": "read", "root_task_id": root, "include_nodes": True})
    assert read["ok"] is True
    assert read["graph_revision"] == patched["graph_revision"]
    assert [node["depth"] for node in read["nodes"]] == [0, 1]
    assert read["nodes"][0]["active"] is True
    assert read["nodes"][1]["frontier"] is True
