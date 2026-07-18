from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def loop_env(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_PROFILE", "planner")
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    from gateway.session_context import (
        _SESSION_WORKFLOW_ID,
        _UNSET,
        _VAR_MAP,
    )

    for var in _VAR_MAP.values():
        var.set(_UNSET)
    _SESSION_WORKFLOW_ID.set(_UNSET)

    from hermes_cli import kanban_db as kb

    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    return "tenant-a"


def _call_graph(args):
    from tools import loop_tools

    return json.loads(loop_tools._handle_loop_graph(args))


def _call_loop(tool_name: str, args: dict):
    from tools import loop_tools

    handlers = {
        "loop_create": loop_tools._handle_loop_create,
        "loop_create_graph": loop_tools._handle_loop_create_graph,
        "loop_status": loop_tools._handle_loop_status,
        "loop_list_queue": loop_tools._handle_loop_list_queue,
        "loop_update": loop_tools._handle_loop_update,
        "loop_block": loop_tools._handle_loop_block,
    }
    return json.loads(handlers[tool_name](args))


def _new_workflow(kb, conn, *, title: str = "Test workflow") -> str:
    return kb.create_workflow(conn, title=title, tenant="tenant-a")


def test_loop_graph_tool_is_core_minimal_workflow_scoped_and_gated(
    monkeypatch, tmp_path
):
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    import tools.loop_tools  # ensure registered
    from tools.registry import invalidate_check_fn_cache, registry
    from toolsets import resolve_toolset

    invalidate_check_fn_cache()
    schema = registry.get_definitions(set(resolve_toolset("hermes-cli")), quiet=True)
    names = {item["function"].get("name") for item in schema if "function" in item}
    assert "loop_graph" in names
    assert not any(name.startswith("loop_") and name != "loop_graph" for name in names)

    loop_schema = next(
        item["function"]
        for item in schema
        if item["function"].get("name") == "loop_graph"
    )
    properties = loop_schema["parameters"]["properties"]
    assert set(properties["action"]["enum"]) == {"read", "patch", "triage", "close"}
    assert "workflow_id" in properties
    assert "task_id" in properties
    assert "root_task_id" not in properties
    exposed = json.dumps(loop_schema).lower()
    for obsolete in (
        "resolve_handoff",
        "branch_kind",
        "decision_group_id",
        "selection_state",
    ):
        assert obsolete not in exposed

    (home / "config.yaml").write_text("loop:\n  enabled: false\n")
    invalidate_check_fn_cache()
    schema = registry.get_definitions(set(resolve_toolset("hermes-cli")), quiet=True)
    names = {item["function"].get("name") for item in schema if "function" in item}
    assert "loop_graph" not in names


def test_task_scoped_worker_cannot_see_or_invoke_loop_mutations(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_worker")
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    from tools import loop_tools
    from tools.registry import invalidate_check_fn_cache, registry
    from toolsets import resolve_toolset

    invalidate_check_fn_cache()
    core_names = {
        schema["function"]["name"]
        for schema in registry.get_definitions(
            set(resolve_toolset("hermes-cli")), quiet=True
        )
        if "function" in schema
    }
    assert "loop_graph" not in core_names

    explicit_names = {
        schema["function"]["name"]
        for schema in registry.get_definitions(
            set(resolve_toolset("loop_delegation")), quiet=True
        )
        if "function" in schema
    }
    assert explicit_names == {"loop_status", "loop_list_queue"}

    mutation_calls = (
        lambda: loop_tools._handle_loop_graph(
            {
                "action": "patch",
                "workflow_id": "wf_test",
                "expected_revision": 1,
                "mutation_id": "worker-bypass",
                "operations": [],
            }
        ),
        lambda: loop_tools._handle_loop_graph(
            {"action": "close", "workflow_id": "wf_test"}
        ),
        lambda: loop_tools._handle_loop_create(
            {
                "objective": "worker follow-up",
                "assignee": "reviewer",
                "activation": "explicit_user_request",
                "proof_packet": {"source": "test"},
            }
        ),
        lambda: loop_tools._handle_loop_update(
            {
                "loop_item_id": "t_task",
                "note": "worker mutation",
                "activation": "explicit_user_request",
                "proof_packet": {"source": "test"},
            }
        ),
        lambda: loop_tools._handle_loop_block(
            {
                "loop_item_id": "t_task",
                "reason": "worker mutation",
                "activation": "explicit_user_request",
                "proof_packet": {"source": "test"},
            }
        ),
    )
    for call in mutation_calls:
        assert "foreground/orchestrator-only" in call()


def test_loop_graph_triage_uses_task_id_and_loop_safe_planning(
    loop_env, monkeypatch
):
    from hermes_cli import kanban_db as kb

    calls = []

    def fake_decompose(task_id, *, author=None, loop_safe=False):
        calls.append((task_id, author, loop_safe, kb.get_current_board()))
        return SimpleNamespace(
            child_ids=["t_child"],
            fanout=True,
            new_title=None,
            ok=True,
            reason="decomposed into 1 children",
            task_id=task_id,
        )

    monkeypatch.setattr("hermes_cli.kanban_decompose.decompose_task", fake_decompose)

    result = _call_graph(
        {
            "action": "triage",
            "author": "foreground-triage",
            "board": "default",
            "task_id": "t_task",
        }
    )

    assert result == {
        "child_ids": ["t_child"],
        "fanout": True,
        "new_title": None,
        "ok": True,
        "reason": "decomposed into 1 children",
        "state": "planned",
        "task_id": "t_task",
    }
    assert calls == [("t_task", "foreground-triage", True, "default")]


def test_loop_delegation_toolset_is_explicit_and_gated(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    import tools.loop_tools  # ensure registered
    from model_tools import get_tool_definitions
    from tools.registry import invalidate_check_fn_cache, registry
    from toolsets import resolve_toolset

    expected = {
        "loop_graph",
        "loop_create",
        "loop_status",
        "loop_update",
        "loop_block",
        "loop_list_queue",
    }
    assert set(resolve_toolset("loop_delegation")) == expected
    assert registry.get_toolset_for_tool("loop_graph") == "loop_delegation"
    assert "loop" not in registry.get_registered_toolset_names()

    invalidate_check_fn_cache()
    schema = registry.get_definitions(
        set(resolve_toolset("loop_delegation")), quiet=True
    )
    names = {item["function"].get("name") for item in schema if "function" in item}
    assert names == expected

    effective_schema = get_tool_definitions(
        enabled_toolsets=["loop_delegation"],
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    effective_names = {
        item["function"].get("name")
        for item in effective_schema
        if "function" in item
    }
    assert expected <= effective_names

    loop_create_schema = next(
        item["function"]
        for item in schema
        if item["function"].get("name") == "loop_create"
    )
    assert "workflow_id" not in loop_create_schema["parameters"]["properties"]

    (home / "config.yaml").write_text("loop:\n  enabled: false\n")
    invalidate_check_fn_cache()
    schema = registry.get_definitions(
        set(resolve_toolset("loop_delegation")), quiet=True
    )
    assert schema == []


def test_loop_create_requires_activation_and_creates_ordinary_workflow_task(
    loop_env, monkeypatch
):
    monkeypatch.setenv("HERMES_SESSION_ID", "session-123")
    denied = _call_loop(
        "loop_create",
        {
            "objective": "Implement durable delegation",
            "assignee": "worker-a",
            "tenant": loop_env,
            "proof_packet": {"summary": "user requested implementation"},
        },
    )
    assert denied["error"] == "activation_required"

    missing_proof = _call_loop(
        "loop_create",
        {
            "objective": "Implement durable delegation",
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
        },
    )
    assert missing_proof["error"] == "proof_packet_required"

    created = _call_loop(
        "loop_create",
        {
            "objective": "Implement durable delegation",
            "acceptance_criteria": ["returns a stable Loop handle"],
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "user requested implementation"},
            "idempotency_key": "loop-create-async",
            "execution": {"mode": "async"},
        },
    )

    assert created["ok"] is True
    assert created["status"] == "ready"
    assert created["workflow_id"].startswith("wf_")
    assert created["foreground_reentry"] == "on_final_or_blocker"
    assert created["approval_required"] is False

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        task = kb.get_task(conn, created["loop_item_id"])
        workflow = kb.get_workflow(conn, created["workflow_id"])
        assert task is not None
        assert workflow is not None
        assert task.workflow_id == workflow.id
        assert kb.workflow_task_ids(conn, workflow.id) == [task.id]
        assert task.title == "Implement durable delegation"
        assert task.assignee == "worker-a"
        assert task.session_id == "session-123"
        assert task.created_by == "planner"
        assert "returns a stable Loop handle" in (task.body or "")
        assert all(
            row["title"] != workflow.title or row["id"] == task.id
            for row in conn.execute("SELECT id, title FROM tasks")
        )
    finally:
        conn.close()


def test_loop_create_pokes_dispatcher_for_ready_work(loop_env, monkeypatch):
    from hermes_cli import kanban_db as kb

    monkeypatch.setattr(
        "hermes_cli.profiles.profile_exists", lambda name: name == "worker-a"
    )
    monkeypatch.setattr(
        kb, "_default_spawn", lambda task, workspace, *, board=None: 4242
    )

    created = _call_loop(
        "loop_create",
        {
            "objective": "Start promptly without manual dispatch",
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "user requested durable routing"},
            "idempotency_key": "loop-create-auto-dispatch",
        },
    )

    assert created["status"] == "running"
    assert created["dispatch"]["spawned"] == [created["loop_item_id"]]
    conn = kb.connect()
    try:
        task = kb.get_task(conn, created["loop_item_id"])
        events = [
            event.kind for event in kb.list_events(conn, created["loop_item_id"])
        ]
    finally:
        conn.close()
    assert task is not None and task.status == "running"
    assert task.worker_pid == 4242
    assert {"claimed", "spawned"} <= set(events)


@pytest.mark.parametrize(
    ("session_env", "expected_route"),
    [
        (
            {"HERMES_SESSION_KEY": "loop-create-tui-session"},
            ("tui", "loop-create-tui-session", "", ""),
        ),
        (
            {
                "HERMES_SESSION_PLATFORM": "telegram",
                "HERMES_SESSION_CHAT_ID": "chat-1",
                "HERMES_SESSION_THREAD_ID": "thread-1",
                "HERMES_SESSION_USER_ID": "user-1",
            },
            ("telegram", "chat-1", "thread-1", "user-1"),
        ),
    ],
)
def test_loop_create_auto_subscribes_once_at_workflow_scope(
    loop_env, monkeypatch, session_env, expected_route
):
    for key, value in session_env.items():
        monkeypatch.setenv(key, value)

    created = _call_loop(
        "loop_create",
        {
            "objective": "Report workflow boundary back here",
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "durable routing"},
            "idempotency_key": f"subscribe-{expected_route[0]}",
        },
    )

    assert created["subscribed"] is True

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        subs = kb.list_workflow_notify_subs(conn, created["workflow_id"])
        legacy_task_subs = kb.list_notify_subs(conn, created["loop_item_id"])
    finally:
        conn.close()

    assert len(subs) == 1
    sub = subs[0]
    assert (
        sub["platform"],
        sub["chat_id"],
        sub["thread_id"],
        sub["user_id"] or "",
    ) == expected_route
    assert sub["workflow_id"] == created["workflow_id"]
    assert legacy_task_subs == []


def test_loop_create_keeps_source_session_and_tenant_independent(
    loop_env, monkeypatch
):
    monkeypatch.setenv("HERMES_SESSION_ID", "source-runtime-session")
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    monkeypatch.setenv("HERMES_TENANT", "legacy-env-tenant")

    created = _call_loop(
        "loop_create",
        {
            "objective": "Keep routing identity separate from metadata",
            "assignee": "worker-a",
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "user requested durable routing"},
            "idempotency_key": "loop-create-independent-source-tenant",
        },
    )

    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        task = kb.get_task(conn, created["loop_item_id"])
        subs = kb.list_workflow_notify_subs(conn, created["workflow_id"])
    finally:
        conn.close()
    assert task is not None
    assert task.session_id == "source-runtime-session"
    assert task.tenant is None
    assert [(sub["platform"], sub["chat_id"]) for sub in subs] == [
        ("tui", "source-runtime-session")
    ]


def test_loop_create_inherits_ambient_workflow_without_model_argument(loop_env):
    from gateway.session_context import _SESSION_WORKFLOW_ID
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn, title="Ambient wake")
    finally:
        conn.close()

    token = _SESSION_WORKFLOW_ID.set(workflow_id)
    try:
        first = _call_loop(
            "loop_create",
            {
                "objective": "Follow up from wake",
                "assignee": "worker-a",
                "activation": "explicit_user_request",
                "proof_packet": {"summary": "ambient workflow"},
                "idempotency_key": "ambient-follow-up",
            },
        )
        second = _call_loop(
            "loop_create",
            {
                "objective": "Review follow-up",
                "assignee": "reviewer",
                "parents": [first["loop_item_id"]],
                "activation": "explicit_user_request",
                "proof_packet": {"summary": "parent workflow"},
                "idempotency_key": "ambient-review",
            },
        )
    finally:
        _SESSION_WORKFLOW_ID.reset(token)

    assert first["workflow_id"] == workflow_id
    assert second["workflow_id"] == workflow_id
    conn = kb.connect()
    try:
        assert set(kb.workflow_task_ids(conn, workflow_id)) == {
            first["loop_item_id"],
            second["loop_item_id"],
        }
        assert kb.parent_ids(conn, second["loop_item_id"]) == [
            first["loop_item_id"]
        ]
    finally:
        conn.close()


def test_loop_status_list_update_and_block(loop_env):
    created = _call_loop(
        "loop_create",
        {
            "objective": "Verify a durable workflow",
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "start workflow"},
            "idempotency_key": "loop-status-flow",
        },
    )
    task_id = created["loop_item_id"]

    status = _call_loop("loop_status", {"loop_item_id": task_id})
    assert status["item"]["id"] == task_id
    assert status["item"]["status"] == "ready"
    assert "comments" not in status
    assert status["counts"]["comments"] == 0

    listed = _call_loop("loop_list_queue", {"tenant": loop_env})
    assert [item["id"] for item in listed["items"]] == [task_id]

    updated = _call_loop(
        "loop_update",
        {
            "loop_item_id": task_id,
            "note": "bounded implementation note",
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "recording status"},
        },
    )
    assert updated["status"] == "ready"
    assert updated["comment_id"] is not None

    detailed = _call_loop(
        "loop_status", {"loop_item_id": task_id, "include_details": True}
    )
    assert detailed["comments"][0]["body"] == "bounded implementation note"

    blocked = _call_loop(
        "loop_block",
        {
            "loop_item_id": task_id,
            "reason": "Waiting for proof packet review",
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "block with evidence"},
        },
    )
    assert blocked["status"] == "blocked"


def test_loop_create_sync_timeout_and_completion_wait(loop_env):
    timed_out = _call_loop(
        "loop_create",
        {
            "objective": "Long durable workflow",
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "bounded wait"},
            "idempotency_key": "loop-sync-timeout",
            "execution": {
                "mode": "sync",
                "wait_until": "done",
                "timeout_seconds": 0.01,
            },
        },
    )
    assert timed_out["status"] == "ready"
    assert timed_out["foreground_reentry"] == "will_continue_async"
    assert timed_out["warnings"] == [
        "sync wait timed out; durable Loop work continues asynchronously"
    ]

    from hermes_cli import kanban_db as kb

    completed_title = "Completes while sync create waits"
    done = threading.Event()

    def complete_when_created():
        deadline = time.time() + 3
        while time.time() < deadline:
            conn = kb.connect()
            try:
                matches = [
                    task
                    for task in kb.list_tasks(conn, tenant=loop_env)
                    if task.title == completed_title
                ]
                if matches:
                    kb.complete_task(
                        conn, matches[0].id, summary="completed during sync wait"
                    )
                    done.set()
                    return
            finally:
                conn.close()
            time.sleep(0.05)

    thread = threading.Thread(target=complete_when_created)
    thread.start()
    completed = _call_loop(
        "loop_create",
        {
            "objective": completed_title,
            "assignee": "worker-a",
            "tenant": loop_env,
            "activation": "explicit_user_request",
            "proof_packet": {"summary": "bounded wait completion"},
            "idempotency_key": "loop-sync-completion",
            "execution": {
                "mode": "sync",
                "wait_until": "done",
                "timeout_seconds": 3,
            },
        },
    )
    thread.join(timeout=3)

    assert done.is_set()
    assert completed["status"] == "done"
    assert completed["foreground_reentry"] == "completed_in_tool_result"
    assert completed["summary"] == "completed during sync wait"


def test_loop_create_graph_has_no_synthetic_root_or_closure_edge(
    loop_env, monkeypatch
):
    monkeypatch.setenv("HERMES_SESSION_KEY", "foreground-loop-session")
    monkeypatch.setattr(
        "tools.loop_tools._poke_dispatcher_once",
        lambda _kb, _conn, _board, _warnings: {"spawned": []},
    )

    result = _call_loop(
        "loop_create_graph",
        {
            "activation": "explicit_user_request",
            "proof_packet": {"source": "test"},
            "tenant": loop_env,
            "nodes": [
                {
                    "client_id": "research",
                    "title": "Research constraints",
                    "depends_on": [],
                },
                {
                    "client_id": "build",
                    "title": "Build the change",
                    "depends_on": ["research"],
                },
                {
                    "client_id": "docs",
                    "title": "Document the change",
                    "depends_on": [],
                },
            ],
        },
    )

    assert result["ok"] is True
    assert result["workflow_id"].startswith("wf_")
    assert "root_task_id" not in result
    assert [item["status"] for item in result["items"]] == [
        "triage",
        "todo",
        "triage",
    ]
    assert all(item["needs_specification"] for item in result["items"])
    assert result["subscribed"] is True
    assert result["subscribed_workflow_id"] == result["workflow_id"]
    assert len(result["edges"]) == 1

    from hermes_cli import kanban_db as kb

    ids = {item["client_id"]: item["task_id"] for item in result["items"]}
    conn = kb.connect()
    try:
        assert set(kb.workflow_task_ids(conn, result["workflow_id"])) == set(
            ids.values()
        )
        assert kb.parent_ids(conn, ids["build"]) == [ids["research"]]
        assert kb.child_ids(conn, ids["build"]) == []
        assert kb.parent_ids(conn, ids["docs"]) == []
        assert kb.child_ids(conn, ids["docs"]) == []
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 3
        subs = kb.list_workflow_notify_subs(conn, result["workflow_id"])
        assert [(sub["platform"], sub["chat_id"]) for sub in subs] == [
            ("tui", "foreground-loop-session")
        ]
        assert all(kb.list_notify_subs(conn, task_id) == [] for task_id in ids.values())
    finally:
        conn.close()


def test_loop_create_graph_compiles_exact_initial_frontier_and_refreshes_items(
    loop_env, monkeypatch
):
    from hermes_cli import kanban_progress

    calls = []

    def fake_decompose_and_dispatch(
        specification_task_ids,
        *,
        ready_task_ids=None,
        board=None,
        conn=None,
        author=None,
    ):
        specification_ids = list(specification_task_ids)
        ready_ids = list(ready_task_ids or [])
        calls.append(
            {
                "specification_ids": specification_ids,
                "ready_ids": ready_ids,
                "board": board,
                "author": author,
            }
        )
        conn.executemany(
            "UPDATE tasks SET status = 'ready', needs_specification = 0, "
            "assignee = 'compiled-worker' WHERE id = ?",
            [(task_id,) for task_id in specification_ids],
        )
        conn.commit()
        return {
            "specification_task_ids": specification_ids,
            "decomposition": [
                {"task_id": task_id, "ok": True}
                for task_id in specification_ids
            ],
            "candidate_task_ids": [*specification_ids, *ready_ids],
            "dispatch": {"spawned": specification_ids},
            "warnings": [],
        }

    monkeypatch.setattr(
        kanban_progress,
        "decompose_and_dispatch",
        fake_decompose_and_dispatch,
    )

    result = _call_loop(
        "loop_create_graph",
        {
            "activation": "explicit_user_request",
            "proof_packet": {"source": "test"},
            "tenant": loop_env,
            "nodes": [
                {
                    "client_id": "entry-a",
                    "title": "Specify entry A",
                    "depends_on": [],
                },
                {
                    "client_id": "dependent",
                    "title": "Wait for entry A",
                    "depends_on": ["entry-a"],
                },
                {
                    "client_id": "entry-b",
                    "title": "Specify entry B",
                    "depends_on": [],
                },
            ],
        },
    )

    ids = {item["client_id"]: item["task_id"] for item in result["items"]}
    assert calls == [
        {
            "specification_ids": [ids["entry-a"], ids["entry-b"]],
            "ready_ids": [],
            "board": "default",
            "author": "foreground-auto-decomposer",
        }
    ]
    assert [
        (
            item["client_id"],
            item["status"],
            item["needs_specification"],
            item["assignee"],
        )
        for item in result["items"]
    ] == [
        ("entry-a", "ready", False, "compiled-worker"),
        ("dependent", "todo", True, None),
        ("entry-b", "ready", False, "compiled-worker"),
    ]
    assert result["candidate_task_ids"] == [ids["entry-a"], ids["entry-b"]]
    assert result["dispatch"]["spawned"] == [ids["entry-a"], ids["entry-b"]]


def test_loop_create_graph_and_graph_read_inherit_ambient_workflow(
    loop_env, monkeypatch
):
    from gateway.session_context import _SESSION_WORKFLOW_ID
    from hermes_cli import kanban_db as kb

    monkeypatch.setattr(
        "tools.loop_tools._poke_dispatcher_once",
        lambda _kb, _conn, _board, _warnings: {"spawned": []},
    )
    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn, title="Ambient graph")
    finally:
        conn.close()

    token = _SESSION_WORKFLOW_ID.set(workflow_id)
    try:
        result = _call_loop(
            "loop_create_graph",
            {
                "activation": "explicit_user_request",
                "proof_packet": {"source": "ambient wake"},
                "nodes": [{"client_id": "followup", "title": "Ambient follow-up"}],
            },
        )
        read = _call_graph({"action": "read", "include_nodes": True})
    finally:
        _SESSION_WORKFLOW_ID.reset(token)

    assert result["workflow_id"] == workflow_id
    assert read["workflow_id"] == workflow_id
    assert [node["task_id"] for node in read["nodes"]] == [
        result["items"][0]["task_id"]
    ]


def test_loop_graph_close_is_explicit_and_idempotent(loop_env):
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn, title="Closable workflow")
        task_id = kb.create_task(
            conn,
            title="Ordinary member",
            workflow_id=workflow_id,
        )
        kb.complete_task(conn, task_id, summary="done")
        assert kb.get_workflow(conn, workflow_id).status == "open"
    finally:
        conn.close()

    closed = _call_graph({"action": "close", "workflow_id": workflow_id})
    repeated = _call_graph({"action": "close", "workflow_id": workflow_id})
    assert closed == {
        "ok": True,
        "workflow_id": workflow_id,
        "status": "closed",
        "already_closed": False,
    }
    assert repeated == {
        "ok": True,
        "workflow_id": workflow_id,
        "status": "closed",
        "already_closed": True,
    }


def test_loop_graph_close_refuses_unfinished_members_with_bounded_details(loop_env):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    conn = kb.connect()
    try:
        graph.ensure_schema(conn)
        workflow_id = _new_workflow(kb, conn, title="Still active")
        task_id = kb.create_task(
            conn,
            title="Finish implementation",
            workflow_id=workflow_id,
        )
        with kb.write_txn(conn):
            conn.execute(
                "INSERT INTO loop_plan_nodes "
                "(workflow_id, node_id, title, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 1, 1)",
                (workflow_id, "plan-review", "Plan review", "planned"),
            )
    finally:
        conn.close()

    refused = _call_graph({"action": "close", "workflow_id": workflow_id})
    assert refused == {
        "ok": False,
        "error": "workflow_not_closable",
        "message": (
            f"workflow {workflow_id} has 2 unfinished task or planning node(s)"
        ),
        "workflow_id": workflow_id,
        "blocker_count": 2,
        "task_blockers": [
            {"id": task_id, "title": "Finish implementation", "status": "ready"}
        ],
        "plan_blockers": [
            {
                "node_id": "plan-review",
                "title": "Plan review",
                "status": "planned",
            }
        ],
    }

    conn = kb.connect()
    try:
        assert kb.get_workflow(conn, workflow_id).status == "open"
    finally:
        conn.close()


def test_loop_graph_close_inherits_ambient_workflow(loop_env):
    from gateway.session_context import _SESSION_WORKFLOW_ID
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn, title="Ambient close")
    finally:
        conn.close()

    token = _SESSION_WORKFLOW_ID.set(workflow_id)
    try:
        closed = _call_graph({"action": "close"})
    finally:
        _SESSION_WORKFLOW_ID.reset(token)

    assert closed == {
        "ok": True,
        "workflow_id": workflow_id,
        "status": "closed",
        "already_closed": False,
    }


def test_workflow_close_error_caps_blocker_details():
    from tools import loop_tools

    error = SimpleNamespace(
        workflow_id="wf_many",
        task_blockers=[
            {"id": f"t_{index}", "title": f"Task {index}", "status": "ready"}
            for index in range(21)
        ],
        plan_blockers=[
            {"node_id": "plan_a", "title": "Plan A", "status": "planned"}
        ],
    )

    response = json.loads(loop_tools._workflow_close_error(error))
    assert response["blocker_count"] == 22
    assert len(response["task_blockers"]) == 20
    assert response["plan_blockers"] == []
    assert response["truncated"] is True


def test_patch_round_trips_workflow_owned_planning_nodes_without_tasks(loop_env):
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn, title="Planning workflow")
    finally:
        conn.close()

    out = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
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
    assert out["workflow_id"] == workflow_id
    created = {item["client_id"]: item["task_id"] for item in out["created"]}

    conn = kb.connect()
    try:
        assert kb.workflow_task_ids(conn, workflow_id) == []
        assert conn.execute("SELECT COUNT(*) FROM task_links").fetchone()[0] == 0
        plan_rows = conn.execute(
            "SELECT node_id, title, body, status, suggested_owner, active, frontier "
            "FROM loop_plan_nodes WHERE workflow_id = ? "
            "ORDER BY created_at, node_id",
            (workflow_id,),
        ).fetchall()
        assert [row["node_id"] for row in plan_rows] == [
            created["a"],
            created["b"],
        ]
        assert [row["title"] for row in plan_rows] == [
            "Research options",
            "Synthesize plan",
        ]
        assert plan_rows[0]["suggested_owner"] == "researcher-a"
        assert plan_rows[0]["active"] == 1
        assert plan_rows[0]["frontier"] == 1
        plan_edges = conn.execute(
            "SELECT parent_id, child_id FROM loop_plan_edges "
            "WHERE workflow_id = ?",
            (workflow_id,),
        ).fetchall()
        assert [(row["parent_id"], row["child_id"]) for row in plan_edges] == [
            (created["a"], created["b"])
        ]
    finally:
        conn.close()

    read = _call_graph(
        {
            "action": "read",
            "workflow_id": workflow_id,
            "include_nodes": True,
        }
    )
    by_id = {node["task_id"]: node for node in read["nodes"]}
    assert by_id[created["a"]]["is_plan_node"] is True
    assert by_id[created["a"]]["suggested_owner"] == "researcher-a"
    assert by_id[created["b"]]["parents"] == [created["a"]]


def test_patch_rejects_stale_revision_and_replays_duplicate_mutation(loop_env):
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
    finally:
        conn.close()

    first = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": 0,
            "mutation_id": "m-once",
            "operations": [
                {"op": "add_node", "client_id": "x", "title": "Only once"}
            ],
        }
    )
    stale = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": 0,
            "mutation_id": "m-stale",
            "operations": [
                {"op": "add_node", "client_id": "y", "title": "Too late"}
            ],
        }
    )
    duplicate = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": 0,
            "mutation_id": "m-once",
            "operations": [
                {"op": "add_node", "client_id": "x", "title": "Only once"}
            ],
        }
    )

    assert stale["error"] == "stale_revision"
    assert stale["current_revision"] == first["graph_revision"]
    assert duplicate == {**first, "duplicate": True}
    conn = kb.connect()
    try:
        rows = conn.execute(
            "SELECT node_id FROM loop_plan_nodes "
            "WHERE workflow_id = ? AND title = ? AND status != 'archived'",
            (workflow_id, "Only once"),
        ).fetchall()
        assert len(rows) == 1
    finally:
        conn.close()


def test_running_sibling_heartbeat_does_not_stale_pending_graph_patch(loop_env):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        running = kb.create_task(
            conn,
            title="Long-running sibling",
            assignee="worker",
            workflow_id=workflow_id,
        )
        pending = kb.create_task(
            conn,
            title="Pending sibling",
            triage=True,
            workflow_id=workflow_id,
        )
        claimed = kb.claim_task(conn, running, claimer="worker:heartbeat")
        assert claimed is not None and claimed.current_run_id is not None

        revision = loop_graph.graph_revision(conn, workflow_id)
        assert kb.heartbeat_worker(
            conn,
            running,
            note="still working",
            expected_run_id=claimed.current_run_id,
            current_tool="terminal",
        )
        assert loop_graph.graph_revision(conn, workflow_id) == revision

        result = loop_graph.apply_patch(
            conn,
            workflow_id,
            expected_revision=revision,
            mutation_id="edit-pending-after-heartbeat",
            operations=[
                {
                    "op": "update_node",
                    "task_id": pending,
                    "title": "Pending sibling, revised",
                }
            ],
        )
        assert result["ok"] is True
        assert kb.get_task(conn, pending).title == "Pending sibling, revised"
    finally:
        conn.close()


@pytest.mark.parametrize(
    "op_name", ["update_node", "archive_node", "mark_node", "set_parents"]
)
def test_patch_rejects_task_from_another_workflow(loop_env, op_name):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_a = _new_workflow(kb, conn, title="A")
        workflow_b = _new_workflow(kb, conn, title="B")
        foreign = kb.create_task(
            conn,
            title="Foreign task",
            triage=True,
            workflow_id=workflow_b,
        )
        revision = loop_graph.graph_revision(conn, workflow_a)
    finally:
        conn.close()

    operation = {"op": op_name, "task_id": foreign}
    if op_name == "update_node":
        operation["title"] = "Should not change"
    elif op_name == "mark_node":
        operation["active"] = True
    elif op_name == "set_parents":
        operation["parents"] = []
    out = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_a,
            "expected_revision": revision,
            "mutation_id": f"wrong-workflow-{op_name}",
            "operations": [operation],
        }
    )
    assert out["error"] == "wrong_workflow"


@pytest.mark.parametrize(
    "op_name", ["update_node", "set_parents", "archive_node", "mark_node"]
)
def test_every_pending_workflow_task_is_mutable_without_root_special_case(
    loop_env, op_name
):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        task_id = kb.create_task(
            conn,
            title="Ordinary first task",
            triage=True,
            workflow_id=workflow_id,
        )
        revision = loop_graph.graph_revision(conn, workflow_id)
    finally:
        conn.close()

    operation = {"op": op_name, "task_id": task_id}
    if op_name == "update_node":
        operation["title"] = "Updated ordinary task"
    elif op_name == "set_parents":
        operation["parents"] = []
    elif op_name == "mark_node":
        operation["active"] = True
    outcome = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": revision,
            "mutation_id": f"ordinary-task-{op_name}",
            "operations": [operation],
        }
    )
    assert outcome["ok"] is True

    conn = kb.connect()
    try:
        task = kb.get_task(conn, task_id)
        if op_name == "update_node":
            assert task.title == "Updated ordinary task"
        elif op_name == "archive_node":
            assert task.status == "archived"
        elif op_name == "set_parents":
            assert task.status == "ready"
        else:
            assert task.status == "triage"
    finally:
        conn.close()


def test_patch_validates_cycles_between_ordinary_workflow_tasks(loop_env):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        first = kb.create_task(
            conn,
            title="First",
            triage=True,
            workflow_id=workflow_id,
        )
        second = kb.create_task(
            conn,
            title="Second",
            parents=[first],
            needs_specification=True,
            workflow_id=workflow_id,
        )
        revision = loop_graph.graph_revision(conn, workflow_id)
    finally:
        conn.close()

    cycle = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": revision,
            "mutation_id": "m-cycle",
            "operations": [
                {"op": "set_parents", "task_id": first, "parents": [second]}
            ],
        }
    )
    assert cycle["error"] == "validation_failed"
    assert "cycle" in cycle["message"]


def test_patch_can_rewire_pending_task_to_completed_workflow_result(loop_env):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        completed = kb.create_task(
            conn,
            title="Known result",
            workflow_id=workflow_id,
        )
        kb.complete_task(conn, completed, summary="Reusable result")
        waiting = kb.create_task(
            conn,
            title="Unfinished gate",
            workflow_id=workflow_id,
        )
        skeleton = kb.create_task(
            conn,
            title="Pending skeleton",
            parents=[waiting],
            needs_specification=True,
            workflow_id=workflow_id,
        )
        revision = loop_graph.graph_revision(conn, workflow_id)
        result = loop_graph.apply_patch(
            conn,
            workflow_id,
            expected_revision=revision,
            mutation_id="rewire-pending-skeleton",
            operations=[
                {
                    "op": "set_parents",
                    "task_id": skeleton,
                    "parents": [completed],
                }
            ],
        )
        task = kb.get_task(conn, skeleton)
        assert result["ok"] is True
        assert kb.parent_ids(conn, skeleton) == [completed]
        assert task.status == "triage"
        assert task.needs_specification is True
    finally:
        conn.close()


@pytest.mark.parametrize(
    "op_name", ["update_node", "set_parents", "archive_node", "mark_node"]
)
def test_patch_rejects_decomposition_shell_while_child_is_active(
    loop_env, op_name
):
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        created = kb.create_loop_skeleton_graph(
            conn,
            workflow_id=workflow_id,
            nodes=[{"client_id": "shell", "title": "Compiled shell"}],
        )
        shell_id = created["items"][0]["task_id"]
        [child_id] = kb.decompose_triage_task(
            conn,
            shell_id,
            root_assignee="orchestrator",
            children=[
                {
                    "title": "Generated child",
                    "body": "Do generated work",
                    "assignee": "worker-a",
                    "parents": [],
                }
            ],
            author="test-decomposer",
        )
        assert kb.claim_task(conn, child_id, claimer="worker-a:active") is not None
        revision = loop_graph.graph_revision(conn, workflow_id)
    finally:
        conn.close()

    operation = {"op": op_name, "task_id": shell_id}
    if op_name == "update_node":
        operation["title"] = "Unsafe rewrite"
    elif op_name == "set_parents":
        operation["parents"] = []
    elif op_name == "mark_node":
        operation["active"] = True
    outcome = _call_graph(
        {
            "action": "patch",
            "workflow_id": workflow_id,
            "expected_revision": revision,
            "mutation_id": f"reject-active-shell-{op_name}",
            "operations": [operation],
        }
    )

    assert outcome["error"] == "unsafe_status"
    assert "decomposition children are still active" in outcome["message"]
    conn = kb.connect()
    try:
        shell = kb.get_task(conn, shell_id)
        assert shell is not None and shell.status == "todo"
        assert kb.active_decomposition_child_ids(conn, shell_id) == [child_id]
    finally:
        conn.close()


def test_read_surfaces_workflow_nodes_without_foreground_handoff_state(loop_env):
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        workflow_id = _new_workflow(kb, conn)
        worker = kb.create_task(
            conn,
            title="Contract tests",
            assignee="worker",
            workflow_id=workflow_id,
        )
        assert kb.claim_task(conn, worker, claimer="worker-host:1") is not None
        assert kb.complete_task(conn, worker, summary="tests define contract")
    finally:
        conn.close()

    read = _call_graph(
        {
            "action": "read",
            "workflow_id": workflow_id,
            "include_nodes": True,
        }
    )
    node = next(item for item in read["nodes"] if item["task_id"] == worker)
    assert node["workflow_id"] == workflow_id
    assert "attention" not in node
    assert "verification_state" not in node
    assert "handoff" not in node
    assert "pending_handoffs" not in read
