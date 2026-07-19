"""Regression tests for the init-time Kanban prompt posture."""

import pytest

from agent.prompt_builder import (
    KANBAN_FOREGROUND_GUIDANCE,
    KANBAN_GUIDANCE,
    KANBAN_ORCHESTRATOR_GUIDANCE,
)


@pytest.fixture(autouse=True)
def _reset_tool_caches():
    from model_tools import _clear_tool_defs_cache
    from tools.registry import invalidate_check_fn_cache

    invalidate_check_fn_cache()
    _clear_tool_defs_cache()
    yield
    invalidate_check_fn_cache()
    _clear_tool_defs_cache()


def _make_agent(monkeypatch, tmp_path, *, config: str = "", task_id: str = ""):
    home = tmp_path / ".hermes"
    home.mkdir()
    if config:
        (home / "config.yaml").write_text(config, encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    if task_id:
        monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    else:
        monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)

    from run_agent import AIAgent

    return AIAgent(
        api_key="test",
        base_url="https://openrouter.ai/api/v1",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
    )


def test_unscoped_loop_foreground_selects_bounded_guidance(monkeypatch, tmp_path):
    agent = _make_agent(monkeypatch, tmp_path)

    assert "delegate_task" in agent.valid_tool_names
    assert "kanban_unblock" in agent.valid_tool_names
    assert "kanban_create" not in agent.valid_tool_names
    assert "kanban_decompose" not in agent.valid_tool_names
    assert agent._kanban_worker_guidance == KANBAN_FOREGROUND_GUIDANCE


def test_explicit_kanban_profile_selects_full_orchestrator_guidance(
    monkeypatch,
    tmp_path,
):
    agent = _make_agent(monkeypatch, tmp_path, config="toolsets:\n  - kanban\n")

    assert "kanban_create" in agent.valid_tool_names
    assert "kanban_decompose" in agent.valid_tool_names
    assert agent._kanban_worker_guidance == KANBAN_ORCHESTRATOR_GUIDANCE

    first = agent._build_system_prompt_parts()["stable"]
    second = agent._build_system_prompt_parts()["stable"]
    assert first == second
    assert "## Full Kanban orchestrator control" in first
    assert "# Kanban task execution protocol" not in first


def test_leaf_worker_selects_task_lifecycle_guidance(monkeypatch, tmp_path):
    agent = _make_agent(monkeypatch, tmp_path, task_id="t_leaf")

    assert "kanban_show" in agent.valid_tool_names
    assert "kanban_create" not in agent.valid_tool_names
    assert "kanban_decompose" not in agent.valid_tool_names
    assert agent._kanban_worker_guidance == KANBAN_GUIDANCE
