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
    tenant: str | None = None,
    session_id: str | None = None,
) -> str:
    task_id = kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by=f"loop:{root_task_id}",
        parents=parents,
        tenant=tenant,
        session_id=session_id,
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


def test_completion_records_durable_handoff_with_audit_identifiers(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a", session_id="origin-session")
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:123")
        assert claimed is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="backend contract tests are ready",
            metadata={
                "worker_session_id": "worker-session-1",
                "artifacts": ["/tmp/contract.log"],
                "changed_files": ["hermes_cli/kanban_db.py"],
                "tests_run": 2,
            },
        )

        handoffs = kb.list_loop_handoffs(conn, root_task_id="t_looproot")

    assert len(handoffs) == 1
    handoff = handoffs[0]
    assert handoff["handoff_kind"] == "worker_completed"
    assert handoff["state"] == "queued"
    assert handoff["tenant"] == "tenant-a"
    assert handoff["root_task_id"] == "t_looproot"
    assert handoff["task_id"] == task_id
    assert handoff["run_id"] is not None
    assert handoff["source_event_id"] is not None
    assert handoff["worker_profile"] == "implementation-worker"
    assert handoff["worker_session_id"] == "worker-session-1"
    assert handoff["originating_session_id"] == "origin-session"
    assert handoff["summary"] == "backend contract tests are ready"
    assert handoff["artifacts"] == ["/tmp/contract.log"]
    assert handoff["changed_files"] == ["hermes_cli/kanban_db.py"]
    assert handoff["verification_status"] == "unknown"
    assert handoff["parent_state_snapshot"] == []
    assert handoff["child_state_snapshot"] == []


def test_block_records_durable_handoff_reason(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop blocker", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:456") is not None

        assert kb.block_task(conn, task_id, reason="needs product decision")

        handoffs = kb.list_loop_handoffs(conn, tenant="tenant-a", state="queued")

    assert len(handoffs) == 1
    assert handoffs[0]["handoff_kind"] == "worker_blocked"
    assert handoffs[0]["reason"] == "needs product decision"
    assert handoffs[0]["attention"] == "needs-orchestrator"


def test_duplicate_handoff_trigger_is_idempotent(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="done once")
        first = kb.list_loop_handoffs(conn)[0]

        with kb.write_txn(conn):
            kb._record_loop_handoff(
                conn,
                task_id,
                root_task_id="t_looproot",
                handoff_kind="worker_completed",
                run_id=first["run_id"],
                source_event_id=first["source_event_id"],
                summary="duplicate should not overwrite",
                metadata={"artifacts": ["/tmp/other.log"]},
                created_cards=None,
            )
        handoffs = kb.list_loop_handoffs(conn)

    assert len(handoffs) == 1
    assert handoffs[0]["id"] == first["id"]
    assert handoffs[0]["summary"] == "done once"
    assert handoffs[0]["artifacts"] == []


def test_claim_loop_handoff_batch_serializes_per_tenant_root_and_orders_dependencies(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer=f"worker:{parent_id}") is not None
        assert kb.complete_task(conn, parent_id, summary=f"done {parent_id}")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        other_id = _loop_node(conn, root_task_id="t_otherroot", title="other root", tenant="tenant-a")
        for task_id in (child_id, other_id):
            assert kb.claim_task(conn, task_id, claimer=f"worker:{task_id}") is not None
            assert kb.complete_task(conn, task_id, summary=f"done {task_id}")

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session-1",
            limit=10,
        )
        blocked_by_active = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session-2",
            limit=10,
        )
        other_batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_otherroot",
            reviewer_session_id="review-session-3",
            limit=10,
        )

    assert [handoff["task_id"] for handoff in batch] == [parent_id, child_id]
    assert {handoff["state"] for handoff in batch} == {"assigned"}
    assert {handoff["reviewer_session_id"] for handoff in batch} == {"review-session-1"}
    assert blocked_by_active == []
    assert [handoff["task_id"] for handoff in other_batch] == [other_id]


def test_loop_handoffs_survive_reconnect_and_expose_status_api(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="persisted")

    kb._INITIALIZED_PATHS.clear()
    with kb.connect() as conn:
        pending = kb.list_loop_handoffs(conn, state="queued")
        status = kb.loop_handoff_status(conn, tenant="tenant-a", root_task_id="t_looproot")

    assert len(pending) == 1
    assert pending[0]["task_id"] == task_id
    assert status == {
        "tenant": "tenant-a",
        "root_task_id": "t_looproot",
        "pending_count": 1,
        "active_count": 0,
        "terminal_count": 0,
        "total_count": 1,
    }
