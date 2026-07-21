"""Kanban <-> Projects integration: project-linked tasks get a deterministic
worktree path + branch instead of the random ``wt/<task-id>`` fallback."""

from __future__ import annotations

import os
import subprocess

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import projects_db as pdb


@pytest.fixture
def kanban_conn(tmp_path):
    c = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        yield c
    finally:
        c.close()


def _make_project(name="Web App", repo="/tmp/webapp"):
    with pdb.connect_closing() as pc:
        pid = pdb.create_project(pc, name=name, folders=[repo])
        return pdb.get_project(pc, pid)


def _init_repo(path):
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "test@example.com"], check=True)
    (path / "README.md").write_text("test\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "init"], check=True)


def test_project_linked_task_gets_deterministic_worktree_and_branch(kanban_conn):
    proj = _make_project()
    tid = kb.create_task(kanban_conn, title="Add login", project_id=proj.slug)
    task = kb.get_task(kanban_conn, tid)

    assert task.project_id == proj.id
    assert task.project_repo_path == os.path.realpath(proj.primary_path)
    assert task.workspace_kind == "worktree"
    # Worktree dir anchored under the project's primary repo, keyed on task id.
    assert task.workspace_path == os.path.join(proj.primary_path, ".worktrees", tid)
    # Deterministic branch: <slug>/<task-id>-<title-slug>. NOT a random wt/...
    assert task.branch_name == f"{proj.slug}/{tid}-add-login"
    assert not task.branch_name.startswith("wt/")


def test_explicit_branch_overrides_project_default(kanban_conn):
    proj = _make_project()
    tid = kb.create_task(
        kanban_conn,
        title="x",
        project_id=proj.slug,
        workspace_kind="worktree",
        branch_name="feature/custom",
    )
    task = kb.get_task(kanban_conn, tid)
    assert task.branch_name == "feature/custom"


def test_unlinked_task_unchanged(kanban_conn):
    tid = kb.create_task(kanban_conn, title="plain")
    task = kb.get_task(kanban_conn, tid)

    assert task.project_id is None
    assert task.project_repo_path is None
    assert task.workspace_kind == "scratch"
    # No branch is persisted — the worker still owns the wt/<id> fallback for
    # genuinely ad-hoc worktree tasks, but unlinked scratch tasks have none.
    assert task.branch_name is None


def test_unknown_project_id_falls_back_gracefully(kanban_conn):
    # A project id that doesn't resolve must not crash task creation; the task
    # is created as-is (scratch) and project_id stays unset.
    tid = kb.create_task(kanban_conn, title="x", project_id="does-not-exist")
    task = kb.get_task(kanban_conn, tid)
    assert task.workspace_kind == "scratch"
    assert task.project_id is None
    assert task.project_repo_path is None


def test_project_linked_dir_rejects_workspace_from_different_repo(kanban_conn, tmp_path):
    expected_repo = tmp_path / "expected"
    wrong_repo = tmp_path / "wrong"
    _init_repo(expected_repo)
    _init_repo(wrong_repo)
    proj = _make_project(repo=str(expected_repo))
    tid = kb.create_task(
        kanban_conn,
        title="Run in the expected repository",
        project_id=proj.slug,
        workspace_kind="dir",
        workspace_path=str(wrong_repo),
    )
    task = kb.get_task(kanban_conn, tid)

    with pytest.raises(ValueError, match="does not belong to project"):
        kb.resolve_workspace(task)


def test_dispatch_blocks_project_linked_non_git_dir_before_spawn(
    kanban_conn, tmp_path, all_assignees_spawnable
):
    expected_repo = tmp_path / "expected"
    wrong_dir = tmp_path / "not-a-repo"
    _init_repo(expected_repo)
    wrong_dir.mkdir()
    proj = _make_project(repo=str(expected_repo))
    tid = kb.create_task(
        kanban_conn,
        title="Run in the expected repository",
        assignee="worker",
        project_id=proj.slug,
        workspace_kind="dir",
        workspace_path=str(wrong_dir),
        max_retries=1,
    )
    spawn_calls = []

    result = kb.dispatch_once(
        kanban_conn,
        spawn_fn=lambda task, workspace: spawn_calls.append((task.id, workspace)),
    )
    task = kb.get_task(kanban_conn, tid)

    assert spawn_calls == []
    assert result.auto_blocked == [tid]
    assert task.status == "blocked"
    assert str(wrong_dir) in task.last_failure_error
    assert str(expected_repo) in task.last_failure_error


def test_project_linked_dir_accepts_primary_checkout(kanban_conn, tmp_path):
    repo = tmp_path / "repo"
    _init_repo(repo)
    proj = _make_project(repo=str(repo))
    tid = kb.create_task(
        kanban_conn,
        title="Run in the primary checkout",
        project_id=proj.slug,
        workspace_kind="dir",
        workspace_path=str(repo),
    )

    assert kb.resolve_workspace(kb.get_task(kanban_conn, tid)) == repo


def test_project_linked_dir_accepts_sibling_worktree(kanban_conn, tmp_path):
    repo = tmp_path / "repo"
    linked = tmp_path / "linked"
    _init_repo(repo)
    subprocess.run(
        ["git", "-C", str(repo), "worktree", "add", "-qb", "test-linked", str(linked)],
        check=True,
    )
    proj = _make_project(repo=str(repo))
    tid = kb.create_task(
        kanban_conn,
        title="Run in a valid sibling worktree",
        project_id=proj.slug,
        workspace_kind="dir",
        workspace_path=str(linked),
    )
    task = kb.get_task(kanban_conn, tid)

    assert kb.resolve_workspace(task) == linked


def test_dispatch_blocks_wrong_project_worktree_before_spawn(
    kanban_conn, tmp_path, all_assignees_spawnable
):
    expected_repo = tmp_path / "expected"
    wrong_repo = tmp_path / "wrong"
    _init_repo(expected_repo)
    _init_repo(wrong_repo)
    proj = _make_project(repo=str(expected_repo))
    tid = kb.create_task(
        kanban_conn,
        title="Run in the expected repository",
        assignee="worker",
        project_id=proj.slug,
        workspace_kind="worktree",
        workspace_path=str(wrong_repo),
        max_retries=1,
    )
    spawn_calls = []

    result = kb.dispatch_once(
        kanban_conn,
        spawn_fn=lambda task, workspace: spawn_calls.append((task.id, workspace)),
    )
    task = kb.get_task(kanban_conn, tid)

    assert spawn_calls == []
    assert result.auto_blocked == [tid]
    assert task.status == "blocked"
    assert str(wrong_repo) in task.last_failure_error
    assert str(expected_repo) in task.last_failure_error
    assert not (wrong_repo / ".worktrees" / tid).exists()
