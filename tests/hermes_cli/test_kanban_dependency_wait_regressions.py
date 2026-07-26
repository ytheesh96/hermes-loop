"""Regression coverage for Loop context and typed dependency waits."""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_decompose as decomp


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def test_latest_workflow_context_correction_survives_bounded_read(kanban_home):
    """A later appended correction must remain visible to the decomposer."""
    stale_context = "STALE INSTRUCTION: use the original unsafe path.\n" + ("x" * 2100)
    correction = "CORRECTION: use the safe replacement path and ignore the stale instruction."

    with kb.connect() as conn:
        first = kb.create_loop_skeleton_graph(
            conn,
            nodes=[{"client_id": "first", "title": "First node"}],
            shared_context=stale_context,
            idempotency_scope="first-fragment",
        )
        workflow_id = first["workflow_id"]
        second = kb.create_loop_skeleton_graph(
            conn,
            workflow_id=workflow_id,
            nodes=[{"client_id": "second", "title": "Second node"}],
            shared_context=correction,
            idempotency_scope="second-fragment",
        )
        task = kb.get_task(conn, second["items"][0]["task_id"])
        assert task is not None
        rendered = decomp._live_graph_context(conn, task, workflow_id)

    assert correction in rendered


def test_textual_dependency_language_does_not_create_graph_edge(kanban_home):
    """Only explicit parent ids create topology; prose remains task content."""
    with kb.connect() as conn:
        task_id = kb.create_task(
            conn,
            title="Wait for upstream clarification",
            body="This task depends on upstream clarification before it can proceed.",
        )

        assert kb.parent_ids(conn, task_id) == []
        task = kb.get_task(conn, task_id)

    assert task is not None
    assert task.status == "ready"


def test_dependency_wait_is_not_repromoted_without_explicit_parent(kanban_home):
    """A dependency wait must not cycle through ready on a parentless task."""
    with kb.connect() as conn:
        task_id = kb.create_task(conn, title="Wait for external dependency")
        assert kb.claim_task(conn, task_id, claimer="worker:dependency") is not None
        assert kb.block_task(
            conn,
            task_id,
            kind="dependency",
            reason="waiting for external dependency",
        )
        assert kb.get_task(conn, task_id).status == "todo"

        promoted = kb.recompute_ready(conn)
        task = kb.get_task(conn, task_id)

    assert promoted == 0
    assert task is not None and task.status == "todo"


def test_dependency_wait_recurrence_escalates_after_repeated_loop(kanban_home):
    """Repeated dependency waits cannot evade the unblock-loop breaker."""
    with kb.connect() as conn:
        parent_id = kb.create_task(conn, title="Already resolved prerequisite")
        task_id = kb.create_task(
            conn,
            title="Repeated dependency wait",
            parents=[parent_id],
        )
        assert kb.complete_task(conn, parent_id, summary="prerequisite resolved")

        for _ in range(kb.BLOCK_RECURRENCE_LIMIT):
            assert kb.claim_task(conn, task_id, claimer="worker:dependency") is not None
            assert kb.block_task(
                conn,
                task_id,
                kind="dependency",
                reason="waiting for an unrepresented dependency",
            )
            if _ + 1 < kb.BLOCK_RECURRENCE_LIMIT:
                assert kb.recompute_ready(conn) == 1

        task = kb.get_task(conn, task_id)
        events = kb.list_events(conn, task_id)

    assert task is not None
    assert task.status == "triage"
    assert task.block_kind == "dependency"
    assert task.block_recurrences == kb.BLOCK_RECURRENCE_LIMIT
    assert any(event.kind == "block_loop_detected" for event in events)
