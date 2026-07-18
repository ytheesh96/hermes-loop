from __future__ import annotations

import contextlib
import sqlite3
import threading
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def workflow_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_path = tmp_path / "kanban.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb._INITIALIZED_PATHS.discard(str(db_path.resolve()))
    kb.init_db(db_path)
    yield db_path
    kb._INITIALIZED_PATHS.discard(str(db_path.resolve()))


def _connect(db_path: Path):
    return contextlib.closing(kb.connect(db_path))


def _append_boundary(
    conn: sqlite3.Connection,
    task_id: str,
    kind: str = "completed",
    **payload,
) -> int:
    with kb.write_txn(conn):
        return kb._append_event(conn, task_id, kind, payload or None)


def _workflow_route() -> dict[str, str]:
    return {
        "notifier_profile": "elephant",
        "platform": "telegram",
        "chat_id": "chat-1",
        "thread_id": "thread-1",
    }


def test_create_workflow_is_idempotent(workflow_db: Path) -> None:
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Implement auth",
            origin_session_id="session-1",
            tenant="tenant-1",
            shared_context="Keep compatibility",
            idempotency_key="request-123",
        )
        repeated = kb.create_workflow(
            conn,
            title="Ignored retry title",
            idempotency_key="request-123",
        )

        assert workflow_id.startswith("wf_")
        assert repeated == workflow_id
        workflow = kb.get_workflow(conn, workflow_id)
        assert workflow is not None
        assert workflow.title == "Implement auth"
        assert workflow.origin_session_id == "session-1"
        assert workflow.tenant == "tenant-1"
        assert workflow.shared_context == "Keep compatibility"
        assert workflow.status == "open"
        assert workflow.revision == 0

        with pytest.raises(ValueError, match="already belongs"):
            kb.create_workflow(
                conn,
                workflow_id="wf_conflict",
                idempotency_key="request-123",
            )


def test_task_inherits_parent_workflow_and_rejects_conflicts(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        first_workflow = kb.create_workflow(conn, workflow_id="wf_first")
        second_workflow = kb.create_workflow(conn, workflow_id="wf_second")
        first_parent = kb.create_task(
            conn,
            title="First parent",
            workflow_id=first_workflow,
        )
        second_parent = kb.create_task(
            conn,
            title="Second parent",
            workflow_id=second_workflow,
        )

        inherited = kb.create_task(
            conn,
            title="Inherited child",
            parents=[first_parent],
        )
        assert kb.get_task(conn, inherited).workflow_id == first_workflow

        with pytest.raises(ValueError, match="conflicts with parent workflow"):
            kb.create_task(
                conn,
                title="Explicit conflict",
                parents=[first_parent],
                workflow_id=second_workflow,
            )

        with pytest.raises(ValueError, match="different workflows"):
            kb.create_task(
                conn,
                title="Cross-workflow join",
                parents=[first_parent, second_parent],
            )


def test_workflow_close_rejects_unfinished_tasks_and_fresh_followups(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(
            conn,
            workflow_id="wf_guarded_close",
        )
        task_id = kb.create_task(
            conn,
            title="Finish before close",
            workflow_id=workflow_id,
            idempotency_key="stable-task",
        )

        with pytest.raises(kb.WorkflowNotClosableError) as exc_info:
            kb.close_workflow(conn, workflow_id)
        assert exc_info.value.workflow_id == workflow_id
        assert exc_info.value.task_blockers == [
            {
                "id": task_id,
                "title": "Finish before close",
                "status": "ready",
            }
        ]
        assert exc_info.value.plan_blockers == []
        assert kb.get_workflow(conn, workflow_id).status == "open"

        assert kb.complete_task(conn, task_id, summary="finished")
        assert kb.close_workflow(conn, workflow_id)
        assert kb.get_workflow(conn, workflow_id).status == "closed"

        # An exact retried create remains idempotent after closure, but a
        # genuinely new follow-up cannot race into the closed workflow.
        assert kb.create_task(
            conn,
            title="Finish before close",
            workflow_id=workflow_id,
            idempotency_key="stable-task",
        ) == task_id
        with pytest.raises(ValueError, match="new tasks require open"):
            kb.create_task(
                conn,
                title="Too-late follow-up",
                workflow_id=workflow_id,
            )


def test_workflow_close_cannot_race_a_stale_followup_create(
    workflow_db: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(
            conn,
            workflow_id="wf_close_create_race",
        )

    creator_read_open = threading.Event()
    workflow_closed = threading.Event()
    original_get_workflow = kb.get_workflow
    create_outcome: dict[str, object] = {}

    def pause_after_creator_preflight(
        conn: sqlite3.Connection,
        candidate_workflow_id: str,
    ):
        workflow = original_get_workflow(conn, candidate_workflow_id)
        if (
            threading.current_thread().name == "workflow-followup-creator"
            and candidate_workflow_id == workflow_id
            and not creator_read_open.is_set()
        ):
            assert workflow is not None and workflow.status == "open"
            creator_read_open.set()
            assert workflow_closed.wait(timeout=5)
        return workflow

    monkeypatch.setattr(kb, "get_workflow", pause_after_creator_preflight)

    def create_followup() -> None:
        try:
            with _connect(workflow_db) as conn:
                create_outcome["task_id"] = kb.create_task(
                    conn,
                    title="Concurrent follow-up",
                    workflow_id=workflow_id,
                )
        except BaseException as exc:  # propagated through the shared outcome
            create_outcome["error"] = exc

    creator = threading.Thread(
        target=create_followup,
        name="workflow-followup-creator",
    )
    creator.start()
    assert creator_read_open.wait(timeout=5)

    try:
        with _connect(workflow_db) as conn:
            assert kb.close_workflow(conn, workflow_id)
    finally:
        workflow_closed.set()

    creator.join(timeout=5)
    assert not creator.is_alive()
    assert "task_id" not in create_outcome
    assert isinstance(create_outcome.get("error"), ValueError)
    assert "new tasks require open" in str(create_outcome["error"])

    with _connect(workflow_db) as conn:
        workflow = kb.get_workflow(conn, workflow_id)
        assert workflow is not None and workflow.status == "closed"
        assert kb.workflow_task_ids(conn, workflow_id) == []


def test_workflow_close_rejects_unarchived_plan_nodes(
    workflow_db: Path,
) -> None:
    from hermes_cli import loop_graph

    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(
            conn,
            workflow_id="wf_plan_guard",
        )
        created = loop_graph.apply_patch(
            conn,
            workflow_id,
            expected_revision=0,
            mutation_id="add-plan-node",
            operations=[
                {
                    "op": "add_node",
                    "client_id": "possible-review",
                    "title": "Possible review",
                }
            ],
        )

        with pytest.raises(kb.WorkflowNotClosableError) as exc_info:
            kb.close_workflow(conn, workflow_id)
        assert exc_info.value.task_blockers == []
        assert exc_info.value.plan_blockers == [
            {
                "node_id": created["created"][0]["task_id"],
                "title": "Possible review",
                "status": "scheduled",
            }
        ]
        assert kb.get_workflow(conn, workflow_id).status == "open"

        loop_graph.apply_patch(
            conn,
            workflow_id,
            expected_revision=created["graph_revision"],
            mutation_id="archive-plan-node",
            operations=[
                {
                    "op": "archive_node",
                    "task_id": created["created"][0]["task_id"],
                }
            ],
        )
        assert kb.close_workflow(conn, workflow_id)


def test_workflow_membership_is_immutable_once_assigned(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        first_workflow = kb.create_workflow(conn, workflow_id="wf_first")
        second_workflow = kb.create_workflow(conn, workflow_id="wf_second")
        task_id = kb.create_task(
            conn,
            title="Immutable member",
            workflow_id=first_workflow,
        )

        with pytest.raises(
            sqlite3.IntegrityError,
            match="workflow membership is immutable",
        ):
            with kb.write_txn(conn):
                conn.execute(
                    "UPDATE tasks SET workflow_id = ? WHERE id = ?",
                    (second_workflow, task_id),
                )

        with pytest.raises(
            sqlite3.IntegrityError,
            match="workflow membership is immutable",
        ):
            with kb.write_txn(conn):
                conn.execute(
                    "UPDATE tasks SET workflow_id = NULL WHERE id = ?",
                    (task_id,),
                )

        assert kb.get_task(conn, task_id).workflow_id == first_workflow


def test_workflow_claim_orders_multiple_tasks_and_limits_batch_to_twenty(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_batch")
        tasks = [
            kb.create_task(conn, title=f"Task {index}", workflow_id=workflow_id)
            for index in range(2)
        ]
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        expected_ids = [
            _append_boundary(
                conn,
                tasks[index % 2],
                sequence=index,
            )
            for index in range(25)
        ]

        old_cursor, cursor, events, token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert old_cursor == 0
        assert [event.id for event in events] == expected_ids[:20]
        assert [event.payload["sequence"] for event in events] == list(range(20))
        assert [event.task_id for event in events] == [
            tasks[index % 2] for index in range(20)
        ]
        assert cursor == expected_ids[19]
        assert token
        assert kb.complete_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            claim_token=token,
            **route,
        )

        old_cursor_2, cursor_2, events_2, token_2 = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert old_cursor_2 == cursor
        assert [event.id for event in events_2] == expected_ids[20:]
        assert cursor_2 == expected_ids[-1]
        assert token_2


def test_ready_workflow_claim_defers_and_coalesces_completions_until_settled(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_settled")
        parent = kb.create_task(
            conn,
            title="Produce input",
            workflow_id=workflow_id,
        )
        child = kb.create_task(
            conn,
            title="Consume input",
            parents=[parent],
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )

        assert kb.complete_task(conn, parent, summary="Input is ready")
        assert kb.get_task(conn, child).status == "ready"
        parent_completion_id = conn.execute(
            "SELECT id FROM task_events WHERE task_id = ? AND kind = 'completed'",
            (parent,),
        ).fetchone()["id"]

        assert kb.claim_ready_workflow_events_for_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        ) == (0, 0, [], None)
        deferred_sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert deferred_sub["last_event_id"] == 0
        assert deferred_sub["last_notified_event_id"] == 0
        assert deferred_sub["pending_claim_token"] is None
        assert deferred_sub["pending_event_id"] is None
        assert deferred_sub["pending_expires_at"] is None

        assert kb.complete_task(conn, child, summary="Consumed input")
        old_cursor, cursor, events, token = (
            kb.claim_ready_workflow_events_for_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert old_cursor == 0
        assert [(event.task_id, event.kind) for event in events] == [
            (parent, "completed"),
            (child, "completed"),
        ]
        assert events[0].id == parent_completion_id
        assert cursor == events[-1].id
        assert token
        assert kb.complete_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            claim_token=token,
            **route,
        )
        settled_sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert settled_sub["last_event_id"] == cursor
        assert settled_sub["pending_claim_token"] is None


def test_ready_workflow_claim_wakes_when_only_scheduled_work_remains(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_scheduled")
        finishing_task = kb.create_task(
            conn,
            title="Finish automatic work",
            workflow_id=workflow_id,
        )
        scheduled_task = kb.create_task(
            conn,
            title="Wait for its scheduled time",
            workflow_id=workflow_id,
            initial_status="scheduled",
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )

        assert kb.complete_task(conn, finishing_task, summary="Finished")
        assert kb.get_task(conn, scheduled_task).status == "scheduled"
        old_cursor, cursor, events, token = (
            kb.claim_ready_workflow_events_for_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )

        assert old_cursor == 0
        assert [(event.task_id, event.kind) for event in events] == [
            (finishing_task, "completed")
        ]
        assert cursor == events[-1].id
        assert token


def test_ready_workflow_claim_delivers_blocker_while_work_can_continue(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_blocked")
        blocked_task = kb.create_task(
            conn,
            title="Needs foreground input",
            workflow_id=workflow_id,
        )
        runnable_peer = kb.create_task(
            conn,
            title="Independent automatic work",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )

        assert kb.block_task(
            conn,
            blocked_task,
            reason="Choose an API compatibility policy",
            kind="needs_input",
        )
        assert kb.get_task(conn, runnable_peer).status == "ready"
        old_cursor, cursor, events, token = (
            kb.claim_ready_workflow_events_for_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )

        assert old_cursor == 0
        assert [(event.task_id, event.kind) for event in events] == [
            (blocked_task, "blocked")
        ]
        assert cursor == events[0].id
        assert token


def test_workflow_claim_lease_is_exclusive_expirable_and_token_bound(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_lease")
        task_id = kb.create_task(
            conn,
            title="Lease task",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        event_id = _append_boundary(conn, task_id)

        old_cursor, cursor, events, first_token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                lease_seconds=60,
                **route,
            )
        )
        assert [event.id for event in events] == [event_id]
        assert first_token

        assert kb.claim_unseen_events_for_workflow_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        ) == (old_cursor, old_cursor, [], None)
        assert not kb.complete_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            claim_token="wrong-token",
            **route,
        )
        assert not kb.release_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            old_cursor=old_cursor,
            claim_token="wrong-token",
            **route,
        )

        with kb.write_txn(conn):
            conn.execute(
                "UPDATE workflow_notify_subs SET pending_expires_at = 0 "
                "WHERE workflow_id = ?",
                (workflow_id,),
            )
        reclaimed_old, reclaimed_cursor, reclaimed_events, reclaimed_token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert reclaimed_old == old_cursor
        assert reclaimed_cursor == cursor
        assert [event.id for event in reclaimed_events] == [event_id]
        assert reclaimed_token and reclaimed_token != first_token
        assert not kb.release_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            old_cursor=old_cursor,
            claim_token=first_token,
            **route,
        )
        assert kb.complete_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=reclaimed_cursor,
            claim_token=reclaimed_token,
            **route,
        )


def test_visible_checkpoint_does_not_acknowledge_foreground_delivery(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_visible")
        task_id = kb.create_task(
            conn,
            title="Visible checkpoint",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        event_id = _append_boundary(conn, task_id)
        old_cursor, cursor, events, token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert [event.id for event in events] == [event_id]

        kb.mark_workflow_notify_visible_through(
            conn,
            workflow_id=workflow_id,
            event_id=cursor,
            **route,
        )
        sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert sub["last_notified_event_id"] == cursor
        assert sub["last_event_id"] == old_cursor
        assert sub["pending_claim_token"] == token

        assert kb.release_workflow_notify_claim(
            conn,
            workflow_id=workflow_id,
            claimed_cursor=cursor,
            old_cursor=old_cursor,
            claim_token=token,
            **route,
        )
        _, retry_cursor, retry_events, retry_token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert retry_cursor == cursor
        assert [event.id for event in retry_events] == [event_id]
        assert retry_token
        assert kb.list_workflow_notify_subs(
            conn,
            workflow_id,
        )[0]["last_notified_event_id"] == cursor


def test_archived_legacy_root_backfills_archived_workflow(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        root = kb.create_task(conn, title="Legacy root")
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{root}", root),
            )
        child = kb.create_task(
            conn,
            title="Legacy child",
            created_by=f"loop:{root}",
        )
        assert kb.archive_task(conn, root)

    kb.init_db(workflow_db)

    with _connect(workflow_db) as conn:
        workflow = kb.get_workflow(conn, root)
        assert workflow is not None
        assert workflow.status == "archived"
        assert workflow.closed_at is not None
        assert workflow.legacy_root_task_id == root
        assert kb.get_task(conn, root).workflow_id == root
        assert kb.get_task(conn, child).workflow_id == root


def test_missing_legacy_identity_root_still_backfills_workflow(
    workflow_db: Path,
) -> None:
    missing_root = "legacy-loop-without-root"
    with _connect(workflow_db) as conn:
        member = kb.create_task(
            conn,
            title="Only durable member",
            body="Recovered shared context",
            created_by=f"loop:{missing_root}",
            session_id="legacy-session",
        )

    kb.init_db(workflow_db)

    with _connect(workflow_db) as conn:
        workflow = kb.get_workflow(conn, missing_root)
        assert workflow is not None
        assert workflow.status == "open"
        assert workflow.title == "Only durable member"
        assert workflow.shared_context == "Recovered shared context"
        assert workflow.origin_session_id == "legacy-session"
        assert workflow.legacy_root_task_id is None
        assert kb.get_task(conn, member).workflow_id == missing_root


def test_identity_only_legacy_root_is_archived_and_detached(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        root = kb.create_task(conn, title="Legacy mailbox root")
        child = kb.create_task(
            conn,
            title="Real work",
            created_by=f"loop:{root}",
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ?, idempotency_key = ? WHERE id = ?",
                (f"loop:{root}", f"loop-root:{root}", root),
            )
            conn.execute(
                "INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
                (child, root),
            )

    kb.init_db(workflow_db)

    with _connect(workflow_db) as conn:
        assert kb.get_task(conn, root).status == "archived"
        assert kb.get_task(conn, child).status != "archived"
        assert kb.parent_ids(conn, root) == []
        assert kb.get_task(conn, root).workflow_id == root
        assert kb.get_task(conn, child).workflow_id == root


def test_real_legacy_aggregate_task_is_preserved_as_ordinary_work(
    workflow_db: Path,
) -> None:
    with _connect(workflow_db) as conn:
        aggregate = kb.create_task(conn, title="Integrate real outputs")
        child = kb.create_task(
            conn,
            title="Implementation",
            created_by=f"loop:{aggregate}",
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{aggregate}", aggregate),
            )
            conn.execute(
                "INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
                (child, aggregate),
            )

    kb.init_db(workflow_db)

    with _connect(workflow_db) as conn:
        assert kb.get_task(conn, aggregate).status != "archived"
        assert kb.parent_ids(conn, aggregate) == [child]
        assert kb.get_task(conn, aggregate).workflow_id == aggregate
        assert kb.get_task(conn, child).workflow_id == aggregate


def test_cutover_replaces_drained_legacy_route_without_replay_or_loss(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_cutover")
        tasks = [
            kb.create_task(
                conn,
                title=f"Legacy member {index}",
                workflow_id=workflow_id,
            )
            for index in range(2)
        ]
        for task_id in tasks:
            kb.add_notify_sub(
                conn,
                task_id=task_id,
                **route,
            )
        delivered_ids = [
            _append_boundary(conn, tasks[0], summary="first"),
            _append_boundary(conn, tasks[1], "blocked", reason="second"),
        ]
        for task_id, delivered_id in zip(tasks, delivered_ids):
            kb.advance_notify_cursor(
                conn,
                task_id=task_id,
                new_cursor=delivered_id,
                platform=route["platform"],
                chat_id=route["chat_id"],
                thread_id=route["thread_id"],
            )
        high_water = conn.execute(
            "SELECT MAX(id) FROM task_events"
        ).fetchone()[0]

        assert kb.cutover_legacy_workflow_route(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        assert all(kb.list_notify_subs(conn, task_id) == [] for task_id in tasks)
        workflow_sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert workflow_sub["last_event_id"] == high_water
        assert workflow_sub["last_notified_event_id"] == high_water
        assert kb.claim_unseen_events_for_workflow_sub(
            conn,
            workflow_id=workflow_id,
            **route,
        ) == (high_water, high_water, [], None)

        new_event_id = _append_boundary(
            conn,
            tasks[0],
            summary="after cutover",
        )
        old_cursor, cursor, events, token = (
            kb.claim_unseen_events_for_workflow_sub(
                conn,
                workflow_id=workflow_id,
                **route,
            )
        )
        assert old_cursor == high_water
        assert cursor == new_event_id
        assert [event.id for event in events] == [new_event_id]
        assert token


def test_cutover_refuses_live_legacy_claim(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_live_claim")
        task_id = kb.create_task(
            conn,
            title="Legacy claimed member",
            workflow_id=workflow_id,
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            **route,
        )
        event_id = _append_boundary(conn, task_id)
        old_cursor, cursor, events, token = kb.claim_unseen_events_for_sub(
            conn,
            task_id=task_id,
            platform=route["platform"],
            chat_id=route["chat_id"],
            thread_id=route["thread_id"],
            kinds=("completed",),
        )
        assert [event.id for event in events] == [event_id]
        assert token

        assert not kb.cutover_legacy_workflow_route(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        assert kb.list_workflow_notify_subs(conn, workflow_id) == []
        assert len(kb.list_notify_subs(conn, task_id)) == 1

        assert kb.complete_notify_claim(
            conn,
            task_id=task_id,
            platform=route["platform"],
            chat_id=route["chat_id"],
            thread_id=route["thread_id"],
            claimed_cursor=cursor,
            claim_token=token,
        )
        assert old_cursor == 0
        assert kb.cutover_legacy_workflow_route(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        assert kb.list_notify_subs(conn, task_id) == []
        workflow_sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert workflow_sub["last_event_id"] >= event_id


def test_cutover_existing_workflow_route_ignores_unrelated_global_events(
    workflow_db: Path,
) -> None:
    route = _workflow_route()
    with _connect(workflow_db) as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf_existing_route")
        member = kb.create_task(
            conn,
            title="Workflow member",
            workflow_id=workflow_id,
        )
        unrelated = kb.create_task(conn, title="Unrelated task")
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            start_cursor=0,
            **route,
        )
        kb.add_notify_sub(conn, task_id=member, **route)
        _append_boundary(conn, unrelated, summary="unrelated high-water")

        assert kb.cutover_legacy_workflow_route(
            conn,
            workflow_id=workflow_id,
            **route,
        )
        assert kb.list_notify_subs(conn, member) == []
        workflow_sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert workflow_sub["last_event_id"] == 0
