from __future__ import annotations

import json
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


def test_delegate_task_loop_mode_creates_durable_loop_item(loop_delegate_env, monkeypatch):
    from hermes_cli import kanban_db as kb
    from tools import delegate_tool

    def fail_child_build(*_args, **_kwargs):
        raise AssertionError("loop mode should not build ephemeral child agents")

    monkeypatch.setattr(delegate_tool, "_build_child_agent", fail_child_build)

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
    assert out["assignee"] == "reviewer-qa"
    assert out["loop_item_id"].startswith("t_")
    assert out["subscribed"] is True

    conn = kb.connect()
    try:
        task = kb.get_task(conn, out["loop_item_id"])
        subs = kb.list_notify_subs(conn, out["loop_item_id"])
    finally:
        conn.close()

    assert task is not None
    assert task.title == "Review the Loop adapter"
    assert task.assignee == "reviewer-qa"
    assert task.session_id == "session-123"
    assert "Repo: /tmp/hermes-agent" in (task.body or "")
    assert "delegate_task_mode_loop" in (task.body or "")
    assert [(s["platform"], s["chat_id"]) for s in subs] == [("tui", "tui-session-123")]


def test_delegate_task_loop_mode_uses_default_assignee(loop_delegate_env):
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
    assert out["assignee"] == "worker-a"


def test_delegate_task_loop_mode_requires_assignee_without_default(loop_delegate_env):
    from tools import delegate_tool

    out = json.loads(
        delegate_tool.delegate_task(
            goal="Needs a durable worker",
            mode="loop",
            parent_agent=DummyParent(),
        )
    )

    assert "error" in out
    assert "assignee" in out["error"]
