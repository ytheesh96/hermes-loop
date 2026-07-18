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


def _loop_root_node(conn, *, title: str = "loop root node") -> str:
    task_id = kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by="loop:pending-root",
    )
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET created_by = ? WHERE id = ?", (f"loop:{task_id}", task_id))
        kb._append_event(
            conn,
            task_id,
            "loop_node_state",
            {
                "root_task_id": task_id,
                "client_id": title.replace(" ", "-"),
                "active": True,
                "frontier": True,
            },
        )
    return task_id


def _loop_child_node(conn, root_task_id: str, *, title: str = "loop child node") -> str:
    return kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by=f"loop:{root_task_id}",
    )


def _handoff_events(conn, task_id: str):
    return [event for event in kb.list_events(conn, task_id) if event.kind == "loop_foreground_handoff"]


def test_loop_root_completion_does_not_create_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_root_node(conn)
        assert kb.claim_task(conn, task_id, claimer="worker-host:root") is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="implementation done",
            metadata={"artifacts": ["/tmp/result.txt"]},
        )

        task = kb.get_task(conn, task_id)
        assert task is not None
        assert task.status == "done"
        assert _handoff_events(conn, task_id) == []


def test_explicit_foreground_block_metadata_stays_plain_blocker(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn)
        child_id = _loop_child_node(conn, root_id)
        kb.recompute_ready(conn)
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(
            conn,
            child_id,
            reason="product-decision: pick launch region",
            summary="launch region is unresolved",
            metadata={
                "foreground_handoff": True,
                "handoff_kind": "product_decision",
                "artifacts": ["/tmp/launch.md"],
            },
        )

        task = kb.get_task(conn, child_id)
        assert task is not None
        assert task.status == "blocked"
        assert _handoff_events(conn, child_id) == []


def test_legacy_loop_handoff_review_batching_helpers_are_removed():
    assert not hasattr(kb, "_record_loop_handoff")
    assert not hasattr(kb, "list_loop_handoffs")
    assert not hasattr(kb, "claim_next_loop_handoff_review_batch")
    assert not hasattr(kb, "run_next_loop_handoff_review_batch")
