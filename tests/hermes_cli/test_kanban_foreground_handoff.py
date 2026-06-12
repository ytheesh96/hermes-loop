from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_HOME", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    return home


def _loop_node(
    conn,
    *,
    root_task_id: str = "t_looproot",
    title: str = "loop worker node",
    parents: tuple[str, ...] = (),
) -> str:
    task_id = kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by=f"loop:{root_task_id}",
        parents=parents,
    )
    with kb.write_txn(conn):
        kb._append_event(
            conn,
            task_id,
            "loop_node_state",
            {
                "root_task_id": root_task_id,
                "client_id": title.replace(" ", "-"),
                "active": bool(not parents),
                "frontier": bool(not parents),
            },
        )
    return task_id


def _handoff_events(conn, task_id: str):
    return [event for event in kb.list_events(conn, task_id) if event.kind == "loop_foreground_handoff"]


def test_completing_loop_node_emits_compact_foreground_handoff_event(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn)
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:123")
        assert claimed is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="backend contract tests are ready",
            metadata={"artifacts": ["/tmp/contract.log"]},
        )

        handoffs = _handoff_events(conn, task_id)

    assert len(handoffs) == 1
    payload = handoffs[0].payload
    assert payload == {
        "root_task_id": "t_looproot",
        "handoff_kind": "worker_completed",
        "attention": "needs-orchestrator",
        "verification_state": "needs-orchestrator",
        "run_id": handoffs[0].run_id,
        "summary": "backend contract tests are ready",
        "artifacts": ["/tmp/contract.log"],
    }


def test_blocking_loop_node_emits_pending_foreground_handoff_reason(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop blocker")
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:456")
        assert claimed is not None

        assert kb.block_task(conn, task_id, reason="needs product decision")

        handoffs = _handoff_events(conn, task_id)

    assert len(handoffs) == 1
    assert handoffs[0].payload == {
        "root_task_id": "t_looproot",
        "handoff_kind": "worker_blocked",
        "attention": "needs-orchestrator",
        "verification_state": "needs-orchestrator",
        "run_id": handoffs[0].run_id,
        "reason": "needs product decision",
    }


def test_non_loop_completion_and_block_do_not_emit_foreground_handoff_events(kanban_home):
    with kb.connect() as conn:
        completed_task = kb.create_task(conn, title="plain worker", assignee="worker")
        blocked_task = kb.create_task(conn, title="plain blocker", assignee="worker")
        assert kb.claim_task(conn, completed_task, claimer="plain:1") is not None
        assert kb.claim_task(conn, blocked_task, claimer="plain:2") is not None

        assert kb.complete_task(conn, completed_task, summary="normal completion")
        assert kb.block_task(conn, blocked_task, reason="normal block")

        completed_events = _handoff_events(conn, completed_task)
        blocked_events = _handoff_events(conn, blocked_task)

    assert completed_events == []
    assert blocked_events == []


def test_loop_completion_does_not_promote_downstream_until_foreground_release(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,))
        initial_child = kb.get_task(conn, child_id)
        assert initial_child is not None
        assert initial_child.status == "todo"
        assert kb.claim_task(conn, parent_id, claimer="worker-host:789") is not None

        assert kb.complete_task(conn, parent_id, summary="parent done but awaiting orchestrator")

        child = kb.get_task(conn, child_id)

    assert child is not None
    assert child.status == "todo"
