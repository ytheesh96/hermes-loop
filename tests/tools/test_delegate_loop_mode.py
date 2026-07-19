from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest


@pytest.fixture
def loop_delegate_env(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_PROFILE", "planner")
    monkeypatch.setenv("HERMES_SESSION_ID", "session-123")
    monkeypatch.setenv("HERMES_SESSION_KEY", "tui-session-123")
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    from gateway.session_context import reset_session_vars_for_tests

    reset_session_vars_for_tests()

    from hermes_cli import kanban_db as kb

    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    return home


class DummyParent:
    _delegate_depth = 0
    _memory_manager = None
    session_id = "parent-session"
    model = "test-model"
    provider = "test-provider"


def test_kanban_worker_cannot_create_durable_loop_via_delegate_task(
    loop_delegate_env, monkeypatch
):
    from tools import delegate_tool

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_worker")
    result = delegate_tool.delegate_task(
        goal="Create a review task",
        mode="loop",
        assignee="reviewer-qa",
        parent_agent=DummyParent(),
    )

    assert "foreground/orchestrator-only" in result
    assert "kanban_comment" in result


@pytest.mark.parametrize("mode", ["loop", "durable"])
def test_delegate_task_loop_refuses_disabled_auto_decompose_before_mutation(
    loop_delegate_env, monkeypatch, mode
):
    (loop_delegate_env / "config.yaml").write_text(
        "kanban:\n  auto_decompose: false\n",
        encoding="utf-8",
    )

    from hermes_cli import kanban_db as kb
    from tools import delegate_tool, loop_tools

    monkeypatch.setattr(
        loop_tools,
        "_handle_loop_create_graph",
        lambda *_args, **_kwargs: pytest.fail(
            "disabled auto-decomposition must reject before graph creation"
        ),
    )

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Compile this vague objective",
            mode=mode,
            parent_agent=DummyParent(),
        )
    )

    assert "kanban.auto_decompose: true" in out["error"]
    assert "No durable work was created" in out["error"]
    with kb.connect() as conn:
        assert kb.list_tasks(conn) == []
        assert (
            conn.execute("SELECT COUNT(*) FROM workflows").fetchone()[0]
            == 0
        )


def test_delegate_task_loop_skeleton_batch_uses_minimal_live_graph_contract(
    loop_delegate_env, monkeypatch
):
    from tools import delegate_tool, loop_tools

    captured = []

    def fake_create_graph(args, **_kwargs):
        captured.append(args)
        return json.dumps(
            {
                "ok": True,
                "workflow_id": "wf_existing",
                "items": [
                    {
                        "client_id": "research",
                        "task_id": "t_research",
                        "status": "triage",
                        "needs_specification": True,
                        "parents": [],
                    },
                    {
                        "client_id": "build",
                        "task_id": "t_build",
                        "status": "todo",
                        "needs_specification": True,
                        "parents": ["t_research"],
                    },
                    {
                        "client_id": "verify",
                        "task_id": "t_verify",
                        "status": "todo",
                        "needs_specification": True,
                        "parents": ["t_build"],
                    },
                ],
                "edges": [
                    {"parent_id": "t_research", "child_id": "t_build"},
                    {"parent_id": "t_build", "child_id": "t_verify"},
                    {"parent_id": "t_verify", "child_id": "t_blocked"},
                ],
                "dispatch": {"spawned": []},
                "subscribed": True,
            }
        )

    monkeypatch.setattr(loop_tools, "_handle_loop_create_graph", fake_create_graph)
    monkeypatch.setattr(delegate_tool, "_get_max_concurrent_children", lambda: 1)

    out = json.loads(
        delegate_tool.delegate_task(
            mode="loop",
            workflow_id="wf_existing",
            tasks=[
                {"id": "research", "title": "Research current behavior"},
                {
                    "id": "build",
                    "goal": "Implement the selected approach",
                    "depends_on": ["research"],
                    "assignee": "foreground-must-not-route",
                },
                {
                    "id": "verify",
                    "title": "Verify end to end",
                    "depends_on": ["build"],
                    "blocks": ["t_blocked"],
                },
            ],
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["count"] == 3
    assert out["workflow_id"] == "wf_existing"
    assert "root_task_id" not in out
    assert out["edges"] == [
        ["t_research", "t_build"],
        ["t_build", "t_verify"],
        ["t_verify", "t_blocked"],
    ]
    assert all(item["needs_specification"] for item in out["items"])
    assert "immediately" in out["note"]
    assert len(captured) == 1
    assert captured[0]["workflow_id"] == "wf_existing"
    assert "root_task_id" not in captured[0]
    assert captured[0]["shared_context"] is None
    assert captured[0]["nodes"] == [
        {
            "client_id": "research",
            "title": "Research current behavior",
            "depends_on": [],
        },
        {
            "client_id": "build",
            "title": "Implement the selected approach",
            "depends_on": ["research"],
        },
        {
            "client_id": "verify",
            "title": "Verify end to end",
            "depends_on": ["build"],
            "blocks": ["t_blocked"],
        },
    ]
    assert all("assignee" not in node and "context" not in node for node in captured[0]["nodes"])


def test_delegate_task_cached_root_resolves_to_task_workflow(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, title="Existing workflow")
        cached_root_task_id = kb.create_task(
            conn,
            title="Former root",
            workflow_id=workflow_id,
        )

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Add a follow-up",
            mode="loop",
            root_task_id=cached_root_task_id,
            parent_agent=DummyParent(),
        )
    )

    assert out["workflow_id"] == workflow_id
    assert "root_task_id" not in out
    with kb.connect() as conn:
        created = kb.get_task(conn, out["loop_item_id"])
        assert created is not None
        assert created.workflow_id == workflow_id


def test_delegate_task_cached_legacy_root_uses_atomic_migration(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    with kb.connect() as conn:
        cached_root_task_id = kb.create_task(conn, title="Legacy Loop root")
        conn.execute(
            "UPDATE tasks SET created_by = ? WHERE id = ?",
            (f"loop:{cached_root_task_id}", cached_root_task_id),
        )

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Add work under the legacy workflow",
            mode="loop",
            root_task_id=cached_root_task_id,
            parent_agent=DummyParent(),
        )
    )

    assert out["workflow_id"] == cached_root_task_id
    with kb.connect() as conn:
        workflow = kb.get_workflow(conn, cached_root_task_id)
        legacy_root = kb.get_task(conn, cached_root_task_id)
        created = kb.get_task(conn, out["loop_item_id"])
        assert workflow is not None
        assert workflow.legacy_root_task_id == cached_root_task_id
        assert legacy_root is not None
        assert legacy_root.workflow_id == cached_root_task_id
        assert created is not None
        assert created.workflow_id == cached_root_task_id


def test_delegate_task_unknown_cached_root_is_ignored_safely(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    stale_root_task_id = "t_stale_cached_root"
    out = json.loads(
        delegate_tool.delegate_task(
            goal="Start an independent workflow",
            mode="loop",
            root_task_id=stale_root_task_id,
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["workflow_id"].startswith("wf_")
    assert out["workflow_id"] != stale_root_task_id
    with kb.connect() as conn:
        assert kb.get_workflow(conn, stale_root_task_id) is None
        assert kb.get_task(conn, stale_root_task_id) is None
        created = kb.get_task(conn, out["loop_item_id"])
        assert created is not None
        assert created.workflow_id == out["workflow_id"]


def test_delegate_task_loop_schema_and_prompt_explain_live_graph_ownership():
    from agent.prompt_builder import KANBAN_FOREGROUND_GUIDANCE
    from tools.delegate_tool import (
        DELEGATE_TASK_SCHEMA,
        _build_tasks_param_description,
        _build_top_level_description,
    )

    properties = DELEGATE_TASK_SCHEMA["parameters"]["properties"]
    task_properties = properties["tasks"]["items"]["properties"]

    assert "root_task_id" not in properties
    assert "workflow_id" not in properties
    assert "decompose" not in properties
    assert "decompose" not in task_properties
    assert "assignee" not in properties
    assert "assignee" not in task_properties
    assert "goal_mode" not in properties
    assert "goal_mode" not in task_properties
    assert "goal_max_turns" not in properties
    assert "goal_max_turns" not in task_properties
    assert "title" in task_properties
    assert "blocks" in task_properties
    assert "auto-decomposer decides" in _build_top_level_description()
    assert "ephemeral concurrency cap does not apply" in _build_tasks_param_description()
    assert "tasks[].context" in _build_tasks_param_description()
    assert "tasks[].blocks" in _build_tasks_param_description()
    assert "You own workflow decisions and graph mutation" in KANBAN_FOREGROUND_GUIDANCE
    assert '`delegate_task(mode="loop", tasks=[...])`' in KANBAN_FOREGROUND_GUIDANCE
    assert "`tasks[].blocks`" in KANBAN_FOREGROUND_GUIDANCE
    assert "`kanban_create(...)`" not in KANBAN_FOREGROUND_GUIDANCE


def test_delegate_task_loop_batch_bypasses_ephemeral_concurrency_without_flag(
    loop_delegate_env, monkeypatch
):
    from tools import delegate_tool, loop_tools

    monkeypatch.setattr(delegate_tool, "_get_max_concurrent_children", lambda: 1)
    captured = []

    def fake_create_graph(args, **_kwargs):
        captured.append(args)
        return json.dumps(
            {
                "ok": True,
                "workflow_id": "wf_implicit",
                "items": [
                    {
                        "client_id": "first",
                        "task_id": "t_first",
                        "status": "triage",
                        "needs_specification": True,
                        "parents": [],
                    },
                    {
                        "client_id": "second",
                        "task_id": "t_second",
                        "status": "triage",
                        "needs_specification": True,
                        "parents": [],
                    },
                ],
                "edges": [],
                "dispatch": {"spawned": []},
                "subscribed": True,
            }
        )

    monkeypatch.setattr(loop_tools, "_handle_loop_create_graph", fake_create_graph)
    out = json.loads(
        delegate_tool.delegate_task(
            mode="loop",
            tasks=[
                {"id": "first", "title": "First task"},
                {"id": "second", "title": "Second task"},
            ],
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["count"] == 2
    assert out["workflow_id"] == "wf_implicit"
    assert [node["client_id"] for node in captured[0]["nodes"]] == [
        "first",
        "second",
    ]


def test_delegate_task_loop_mode_creates_durable_loop_item(loop_delegate_env, monkeypatch):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    def fail_child_build(*_args, **_kwargs):
        raise AssertionError("loop mode should not build ephemeral child agents")

    monkeypatch.setattr(delegate_tool, "_build_child_agent", fail_child_build)
    monkeypatch.setattr(
        delegate_tool,
        "_resolve_delegation_credentials",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("loop mode should not resolve subagent credentials")
        ),
    )

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Review the Loop adapter",
            context="Repo: /tmp/hermes-agent\nCheck routing and tests.",
            mode="loop",
            assignee="reviewer-qa",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["mode"] == "loop"
    assert out["count"] == 1
    assert out["assignee"] is None
    assert out["loop_status"] == "triage"
    assert out["needs_specification"] is True
    assert out["loop_item_id"].startswith("t_")
    assert out["workflow_id"].startswith("wf_")
    assert out["subscribed"] is True
    assert out["auto_reentry"] is True

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
        subs = kb.list_workflow_notify_subs(conn, out["workflow_id"])
        legacy_task_subs = kb.list_notify_subs(conn, out["loop_item_id"])
    finally:
        conn.close()

    assert task is not None
    assert task.title == "Review the Loop adapter"
    assert task.assignee is None
    assert task.status == "triage"
    assert task.needs_specification is True
    assert task.session_id == "tui-session-123"
    assert task.tenant is None
    assert task.created_by == "planner"
    assert task.workflow_id == out["workflow_id"]
    assert "Repo: /tmp/hermes-agent" in (task.body or "")
    assert [
        (s["platform"], s["chat_id"], s["notifier_profile"])
        for s in subs
    ] == [("tui", "tui-session-123", "planner")]
    assert legacy_task_subs == []


def test_delegate_task_loop_mode_does_not_preassign_or_spawn_worker(
    loop_delegate_env, monkeypatch
):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    def fail_child_build(*_args, **_kwargs):
        raise AssertionError("loop mode should not build ephemeral child agents")

    monkeypatch.setattr(delegate_tool, "_build_child_agent", fail_child_build)
    monkeypatch.setattr("hermes_cli.profiles.profile_exists", lambda name: name == "worker-a")
    monkeypatch.setattr(kb, "_default_spawn", lambda task, workspace, *, board=None: 5150)

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Start this durable Loop task now",
            mode="loop",
            assignee="worker-a",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["loop_status"] == "triage"
    assert out["assignee"] is None

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
        events = [event.kind for event in kb.list_events(conn, out["loop_item_id"])]
    finally:
        conn.close()

    assert task is not None
    assert task.status == "triage"
    assert task.needs_specification is True
    assert task.worker_pid is None
    assert "specification_requested" in events
    assert "claimed" not in events
    assert "spawned" not in events


def test_delegate_task_loop_mode_uses_session_context_over_stale_env(
    loop_delegate_env, monkeypatch
):
    from gateway.session_context import clear_session_vars, set_session_vars
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    monkeypatch.setenv("HERMES_SESSION_ID", "stale-env-session")
    monkeypatch.setenv("HERMES_SESSION_KEY", "stale-env-session")
    tokens = set_session_vars(
        session_id="fresh-runtime-session",
        session_key="fresh-context-session",
        tenant="fresh-context-session",
    )
    try:
        out = json.loads(
            delegate_tool.delegate_task(
                goal="Verify session routing",
                mode="loop",
                assignee="reviewer-qa",
                parent_agent=DummyParent(),
            )
        )
    finally:
        clear_session_vars(tokens)

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
        workflow = kb.get_workflow(conn, out["workflow_id"])
        subs = kb.list_workflow_notify_subs(conn, out["workflow_id"])
        legacy_task_subs = kb.list_notify_subs(conn, out["loop_item_id"])
    finally:
        conn.close()

    assert task is not None
    assert task.session_id == "fresh-context-session"
    assert task.tenant is None
    assert workflow is not None
    assert workflow.origin_session_id == "fresh-context-session"
    assert [(s["platform"], s["chat_id"]) for s in subs] == [
        ("tui", "fresh-context-session")
    ]
    assert legacy_task_subs == []


def test_delegate_task_loop_mode_keeps_custom_tenant_metadata_separate_from_source_session(
    loop_delegate_env,
    monkeypatch,
):
    from gateway.session_context import reset_session_vars_for_tests, set_session_vars
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    monkeypatch.setenv("HERMES_SESSION_ID", "stale-runtime-session")
    monkeypatch.setenv("HERMES_SESSION_KEY", "stale-key-session")
    monkeypatch.setenv("HERMES_TENANT", "legacy-env-tenant")
    tokens = set_session_vars(
        session_id="runtime-tip-session",
        session_key="source-root-session",
        tenant="legacy-context-tenant",
    )
    try:
        out = json.loads(
            delegate_tool.delegate_task(
                goal="Verify custom tenant routing",
                mode="loop",
                assignee="reviewer-qa",
                tenant="custom-origin-metadata",
                parent_agent=DummyParent(),
            )
        )
    finally:
        del tokens
        reset_session_vars_for_tests()

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
        workflow = kb.get_workflow(conn, out["workflow_id"])
        subs = kb.list_workflow_notify_subs(conn, out["workflow_id"])
        legacy_task_subs = kb.list_notify_subs(conn, out["loop_item_id"])
    finally:
        conn.close()

    assert task is not None
    assert task.session_id == "source-root-session"
    assert task.tenant == "custom-origin-metadata"
    assert workflow is not None
    assert workflow.origin_session_id == "source-root-session"
    assert workflow.tenant == "custom-origin-metadata"
    assert [(s["platform"], s["chat_id"]) for s in subs] == [
        ("tui", "source-root-session")
    ]
    assert legacy_task_subs == []


def test_delegate_task_loop_single_goal_is_implicit_skeleton(
    loop_delegate_env,
):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Coordinate a multi-stage submission",
            context="Break the work into durable cards and keep going until done.",
            mode="loop",
            assignee="peacock",
            goal_mode=True,
            goal_max_turns=7,
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["loop_status"] == "triage"

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
    finally:
        conn.close()

    assert task is not None
    assert task.status == "triage"
    assert task.assignee is None
    assert task.goal_mode is False
    assert task.goal_max_turns is None
    assert task.needs_specification is True
    assert task.body == "Break the work into durable cards and keep going until done."


def test_delegate_task_loop_skeleton_children_inherit_immutable_workflow_membership(
    loop_delegate_env,
):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Coordinate a decomposed Loop graph",
            mode="loop",
            assignee="peacock",
            parent_agent=DummyParent(),
        )
    )
    task_id = out["loop_item_id"]
    workflow_id = out["workflow_id"]

    conn = kb.connect()
    try:
        child_ids = kb.decompose_triage_task(
            conn,
            task_id,
            root_assignee="peacock",
            children=[
                {
                    "title": "Research",
                    "body": "Find constraints.",
                    "assignee": "research-worker",
                    "parents": [],
                }
            ],
            author="test-decomposer",
        )
        assert child_ids is not None
        task = kb.get_task(conn, task_id)
        child = kb.get_task(conn, child_ids[0])
        child_workflow = kb.workflow_id_for_task(conn, child_ids[0])
        with pytest.raises(
            sqlite3.IntegrityError,
            match="workflow membership is immutable",
        ):
            conn.execute(
                "UPDATE tasks SET workflow_id = ? WHERE id = ?",
                ("wf_other", child_ids[0]),
            )
        workflow_task_ids = kb.workflow_task_ids(conn, workflow_id)
    finally:
        conn.close()

    assert task is not None
    assert task.created_by == "planner"
    assert task.workflow_id == workflow_id
    assert child is not None
    assert child.created_by == "test-decomposer"
    assert child.session_id == "tui-session-123"
    assert child.workflow_id == workflow_id
    assert child_workflow == workflow_id
    assert set(workflow_task_ids) == {task_id, child_ids[0]}


def test_delegate_task_loop_mode_ignores_legacy_per_task_routing_fields(
    loop_delegate_env,
):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {
                    "id": "plan",
                    "goal": "Plan a durable graph",
                    "assignee": "peacock",
                    "decompose": True,
                    "goal_mode": True,
                    "goal_max_turns": 5,
                },
                {
                    "id": "review",
                    "goal": "Quick review",
                    "assignee": "reviewer-qa",
                },
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["count"] == 2
    assert out["workflow_id"].startswith("wf_")
    assert out["edges"] == []
    first, second = out["items"]
    assert first["client_id"] == "plan"
    assert first["assignee"] is None
    assert first["needs_specification"] is True
    assert first["parents"] == []
    assert second["client_id"] == "review"
    assert second["assignee"] is None
    assert second["needs_specification"] is True
    assert second["parents"] == []
    assert all("decompose" not in item for item in out["items"])

    conn = kb.connect()
    try:
        first_task = kb.get_task(conn, first["loop_item_id"])
        second_task = kb.get_task(conn, second["loop_item_id"])
    finally:
        conn.close()

    assert first_task is not None
    assert first_task.status == "triage"
    assert first_task.assignee is None
    assert first_task.needs_specification is True
    assert first_task.goal_mode is False
    assert first_task.goal_max_turns is None
    assert second_task is not None
    assert second_task.status == "triage"
    assert second_task.assignee is None
    assert second_task.needs_specification is True
    assert second_task.goal_mode is False


def test_delegate_task_loop_mode_batch_dependencies_create_links(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {"id": "research", "goal": "Research constraints", "assignee": "researcher-a"},
                {
                    "client_id": "write",
                    "goal": "Write plan",
                    "assignee": "writer-a",
                    "depends_on": ["research"],
                },
                {
                    "client_id": "review",
                    "goal": "Review plan",
                    "assignee": "reviewer-qa",
                    "depends_on": ["write"],
                },
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["count"] == 3
    research, write, review = out["items"]
    assert [item["client_id"] for item in out["items"]] == [
        "research",
        "write",
        "review",
    ]
    assert research["parents"] == []
    assert write["parents"] == [research["loop_item_id"]]
    assert review["parents"] == [write["loop_item_id"]]
    assert out["edges"] == [
        [research["loop_item_id"], write["loop_item_id"]],
        [write["loop_item_id"], review["loop_item_id"]],
    ]

    conn = kb.connect()
    try:
        research_task = kb.get_task(conn, research["loop_item_id"])
        write_task = kb.get_task(conn, write["loop_item_id"])
        review_task = kb.get_task(conn, review["loop_item_id"])
        assert kb.parent_ids(conn, write["loop_item_id"]) == [research["loop_item_id"]]
        assert kb.parent_ids(conn, review["loop_item_id"]) == [write["loop_item_id"]]
        assert set(kb.workflow_task_ids(conn, out["workflow_id"])) == {
            research["loop_item_id"],
            write["loop_item_id"],
            review["loop_item_id"],
        }
        assert len(kb.list_tasks(conn)) == 3
    finally:
        conn.close()

    assert research_task is not None
    assert research_task.status == "triage"
    assert research_task.assignee is None
    assert research_task.needs_specification is True
    assert write_task is not None
    assert write_task.status == "todo"
    assert review_task is not None
    assert review_task.status == "todo"
    assert "root_task_id" not in out


def test_delegate_task_loop_mode_depends_on_existing_task_id(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    conn = kb.connect()
    try:
        parent_id = kb.create_task(conn, title="External gate", assignee="gate-worker")
    finally:
        conn.close()

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {
                    "client_id": "child",
                    "goal": "Run after external gate",
                    "assignee": "worker-a",
                    "depends_on": [parent_id],
                }
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["edges"] == [[parent_id, out["loop_item_id"]]]
    assert out["parents"] == [parent_id]
    conn = kb.connect()
    try:
        child = kb.get_task(conn, out["loop_item_id"])
        assert kb.parent_ids(conn, out["loop_item_id"]) == [parent_id]
    finally:
        conn.close()

    assert child is not None
    assert child.status == "todo"


def test_delegate_task_loop_mode_blocks_existing_task_and_infers_workflow(
    loop_delegate_env,
):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, title="Publication workflow")
        publication_id = kb.create_task(
            conn,
            title="Publish verified candidate",
            assignee="publisher",
            workflow_id=workflow_id,
        )
        assert kb.claim_task(
            conn,
            publication_id,
            claimer="publisher:stale-candidate",
        )
        assert kb.block_task(
            conn,
            publication_id,
            reason="Candidate must be refreshed",
        )

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {
                    "client_id": "refresh",
                    "goal": "Refresh the verified candidate",
                    "blocks": [publication_id],
                }
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )
    refresh_id = out["loop_item_id"]

    assert out["status"] == "dispatched"
    assert out["workflow_id"] == workflow_id
    assert out["parents"] == []
    assert out["edges"] == [[refresh_id, publication_id]]
    assert out["subscribed"] is True
    assert out["auto_reentry"] is True

    with kb.connect() as conn:
        refresh = kb.get_task(conn, refresh_id)
        publication = kb.get_task(conn, publication_id)
        assert kb.parent_ids(conn, publication_id) == [refresh_id]
        assert kb.child_ids(conn, refresh_id) == [publication_id]

    assert refresh is not None
    assert refresh.workflow_id == workflow_id
    assert publication is not None
    assert publication.status == "blocked"


def test_delegate_task_loop_mode_unknown_dependency_creates_no_tasks(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {
                    "client_id": "child",
                    "goal": "Blocked child",
                    "assignee": "worker-a",
                    "depends_on": ["missing-parent"],
                }
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert "error" in out
    assert "unknown dependency" in out["error"]
    conn = kb.connect()
    try:
        assert kb.list_tasks(conn) == []
    finally:
        conn.close()


def test_delegate_task_loop_mode_cycle_creates_no_tasks(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {
                    "client_id": "a",
                    "goal": "A",
                    "assignee": "worker-a",
                    "depends_on": ["b"],
                },
                {
                    "client_id": "b",
                    "goal": "B",
                    "assignee": "worker-b",
                    "depends_on": ["a"],
                },
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert "error" in out
    assert "cycle" in out["error"]
    conn = kb.connect()
    try:
        assert kb.list_tasks(conn) == []
    finally:
        conn.close()


def test_delegate_task_loop_mode_duplicate_alias_creates_no_tasks(loop_delegate_env):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            tasks=[
                {"id": "same", "goal": "First", "assignee": "worker-a"},
                {"client_id": "same", "goal": "Second", "assignee": "worker-b"},
            ],
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert "error" in out
    assert "duplicate" in out["error"]
    conn = kb.connect()
    try:
        assert kb.list_tasks(conn) == []
    finally:
        conn.close()


def test_delegate_task_loop_mode_does_not_preassign_default_assignee(
    loop_delegate_env,
):
    (loop_delegate_env / "config.yaml").write_text(
        "kanban:\n  default_assignee: worker-a\n",
        encoding="utf-8",
    )

    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Use configured worker",
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["loop_status"] == "triage"
    assert out["assignee"] is None
    assert out["needs_specification"] is True


def test_delegate_task_loop_mode_does_not_require_assignee(loop_delegate_env):
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Needs a durable worker",
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert out["status"] == "dispatched"
    assert out["loop_status"] == "triage"
    assert out["assignee"] is None
    assert out["client_id"] == "task"
    assert out["needs_specification"] is True
