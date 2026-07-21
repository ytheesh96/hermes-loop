"""Execution-boundary checks for Kanban worker skill/tool compatibility."""
from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(kb, "DEFAULT_CRASH_GRACE_SECONDS", 0)
    return home


def _write_worker_skill(home: Path, body: str) -> Path:
    skill_md = home / "skills" / "devops" / "kanban-worker" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text(
        "---\nname: kanban-worker\ndescription: test lifecycle\n---\n\n" + body,
        encoding="utf-8",
    )
    return skill_md


def test_worker_skill_contract_allows_spawn_without_optional_skill(
    kanban_home, monkeypatch
):
    captured = {}

    class FakeProc:
        pid = 122

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    with kb.connect() as conn:
        task_id = kb.create_task(conn, title="injected guidance only", assignee="default")
        task = kb.get_task(conn, task_id)
        workspace = kb.resolve_workspace(task)

    assert kb._default_spawn(task, str(workspace)) == 122
    assert "--skills" not in captured["cmd"], (
        "workers without an installed or task-scoped skill must rely on the "
        f"injected lifecycle guidance, not an unresolved preload: {captured['cmd']}"
    )


def test_worker_skill_contract_accepts_current_task_scoped_tools_and_historical_names(
    kanban_home, monkeypatch
):
    _write_worker_skill(
        kanban_home,
        """
Call `kanban_show()` first. Leave context with `kanban_comment(body=\"done\")`,
then finish with `kanban_complete(summary=\"done\")`. For a genuine blocker,
call `kanban_block(reason=\"blocked\")`. The old kanban_request_review tool is retired.
""",
    )
    captured = {}

    class FakeProc:
        pid = 123

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    with kb.connect() as conn:
        task_id = kb.create_task(conn, title="valid contract", assignee="default")
        task = kb.get_task(conn, task_id)
        workspace = kb.resolve_workspace(task)

    assert kb._default_spawn(task, str(workspace)) == 123
    assert captured["cmd"][captured["cmd"].index("--skills") + 1] == "kanban-worker"


def test_worker_skill_contract_reports_skill_path_symbol_and_remediation_before_spawn(
    kanban_home, monkeypatch
):
    skill_md = _write_worker_skill(
        kanban_home,
        """
When implementation is ready, call
`kanban_request_review(summary=\"review this\")`.
Also create fixes with `kanban_create(title=\"fix\")`.
""",
    )
    popen_calls = []
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: popen_calls.append((a, k)))

    with kb.connect() as conn:
        task_id = kb.create_task(
            conn,
            title="drifted contract",
            assignee="default",
            max_retries=3,
        )
        task = kb.get_task(conn, task_id)
        workspace = kb.resolve_workspace(task)

        with pytest.raises(kb.KanbanSkillContractError) as exc_info:
            kb._default_spawn(task, str(workspace))

    message = str(exc_info.value)
    assert str(skill_md) in message
    assert "kanban_request_review" in message
    assert "kanban_create" in message
    assert "kanban_comment" in message
    assert "kanban_complete" in message
    assert "foreground" in message.lower()
    assert popen_calls == []


def test_dispatch_blocks_drifted_worker_skill_on_first_preflight_failure(
    kanban_home, monkeypatch, all_assignees_spawnable
):
    skill_md = _write_worker_skill(
        kanban_home,
        "Call `kanban_request_review(summary=\"review this\")` when done.\n",
    )
    popen_calls = []
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: popen_calls.append((a, k)))

    with kb.connect() as conn:
        task_id = kb.create_task(
            conn,
            title="blocked before misleading work",
            assignee="default",
            max_retries=5,
        )
        result = kb.dispatch_once(conn, failure_limit=5)
        task = kb.get_task(conn, task_id)
        runs = kb.list_runs(conn, task_id)

    assert result.auto_blocked == [task_id]
    assert task.status == "blocked"
    assert task.consecutive_failures == 1
    assert str(skill_md) in task.last_failure_error
    assert "kanban_request_review" in task.last_failure_error
    assert runs[-1].outcome == "gave_up"
    assert popen_calls == []


def test_dispatch_blocks_drifted_explicit_task_skill_before_spawn(
    kanban_home, monkeypatch, all_assignees_spawnable
):
    skill_md = kanban_home / "skills" / "review-policy" / "SKILL.md"
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text(
        "---\nname: review-policy\ndescription: test task skill\n---\n\n"
        "Create the follow-up with `kanban_create(title=\"fix review\")`.\n",
        encoding="utf-8",
    )
    popen_calls = []
    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: popen_calls.append((a, k)))

    with kb.connect() as conn:
        task_id = kb.create_task(
            conn,
            title="task-scoped drift",
            assignee="default",
            skills=["review-policy"],
            max_retries=5,
        )
        result = kb.dispatch_once(conn, failure_limit=5)
        task = kb.get_task(conn, task_id)
        runs = kb.list_runs(conn, task_id)

    assert result.auto_blocked == [task_id]
    assert task.status == "blocked"
    assert task.consecutive_failures == 1
    assert str(skill_md) in task.last_failure_error
    assert "kanban_create" in task.last_failure_error
    assert "foreground" in task.last_failure_error.lower()
    assert runs[-1].outcome == "gave_up"
    assert popen_calls == []
