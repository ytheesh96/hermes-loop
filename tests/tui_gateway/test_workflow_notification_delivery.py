from __future__ import annotations

import threading
from types import SimpleNamespace
from typing import Any

import pytest

from hermes_cli import kanban_db as kb
from tui_gateway import server


@pytest.fixture
def workflow_db(monkeypatch: pytest.MonkeyPatch, tmp_path):
    db_path = tmp_path / "kanban.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    monkeypatch.setattr(
        server,
        "_tui_kanban_board_slugs",
        lambda _kb: [_kb.DEFAULT_BOARD],
    )
    yield db_path
    kb._INITIALIZED_PATHS.clear()


def _session(session_key: str, *, agent: Any = None) -> dict[str, Any]:
    return {
        "agent": agent,
        "session_key": session_key,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
    }


def _workflow_sub(conn, workflow_id: str) -> dict[str, Any]:
    rows = kb.list_workflow_notify_subs(conn, workflow_id)
    assert len(rows) == 1
    return rows[0]


@pytest.mark.parametrize(
    ("kind", "payload", "expected_task_id", "expected_evidence"),
    [
        (
            "completed",
            {"summary": "implementation complete"},
            "task-direct",
            "implementation complete",
        ),
        (
            "blocked",
            {"reason": "waiting for input"},
            "task-direct",
            "waiting for input",
        ),
        (
            "gave_up",
            {"error": "worker failed repeatedly"},
            "task-direct",
            "worker failed repeatedly",
        ),
        (
            "loop_descendant_completed",
            {
                "source_task_id": "task-child",
                "summary": "review complete",
                "title": "Review the change",
            },
            "task-child",
            "review complete",
        ),
        (
            "loop_descendant_blocked",
            {
                "source_task_id": "task-child",
                "reason": "dependency unavailable",
            },
            "task-child",
            "dependency unavailable",
        ),
        (
            "loop_descendant_gave_up",
            {
                "source_task_id": "task-child",
                "error": "reviewer failed repeatedly",
            },
            "task-child",
            "reviewer failed repeatedly",
        ),
    ],
)
def test_tui_boundary_prompts_use_authoritative_evidence_fast_path(
    kind,
    payload,
    expected_task_id,
    expected_evidence,
):
    payload["comments"] = [
        {"author": "worker", "body": "Use this bounded handoff evidence."}
    ]
    message = server._format_tui_kanban_notification(
        {},
        SimpleNamespace(
            title="Direct task",
            assignee="worker",
            result="result fallback",
        ),
        SimpleNamespace(kind=kind, task_id="task-direct", payload=payload),
    )

    assert message is not None
    assert expected_evidence in message
    assert "comment from worker: Use this bounded handoff evidence." in message
    assert (
        "Treat the bounded event evidence and comments above as authoritative"
        in message
    )
    assert "decide in this turn and call delegate_task" in message
    assert "depends_on" in message
    assert "blocks" in message
    assert "kanban_unblock" in message
    assert "kanban_create" not in message
    assert 'loop_graph(action="close")' in message
    assert (
        f'Call kanban_show(task_id="{expected_task_id}") only when required '
        "evidence is missing or stale."
    ) in message
    assert (
        "Do not update a session todo, load skills, inspect source, import "
        "private handlers, or use terminal as preflight."
    ) in message
    assert "Read kanban_show" not in message
    assert "comments are advisory" not in message


def test_tui_boundary_prompt_bounds_authoritative_comments():
    comments = [
        {"author": f"worker-{index}", "body": f"comment-{index}"} for index in range(4)
    ]
    message = server._format_tui_kanban_notification(
        {},
        SimpleNamespace(title="Bound evidence", assignee="worker", result=None),
        SimpleNamespace(
            kind="completed",
            task_id="task-bounded",
            payload={
                "summary": f"{'s' * 250}\nsecond line is not foreground evidence",
                "comments": comments,
            },
        ),
    )

    assert message is not None
    assert "s" * 200 in message
    assert "s" * 201 not in message
    assert "second line is not foreground evidence" not in message
    assert "comment-0" not in message
    assert all(f"comment-{index}" in message for index in range(1, 4))


def test_dispatch_isolates_workflows_then_falls_back_to_legacy_task(
    monkeypatch: pytest.MonkeyPatch,
    workflow_db,
):
    session_key = "workflow-tui-session"
    with kb.connect() as conn:
        workflow_ids = [
            kb.create_workflow(conn, workflow_id="wf-alpha"),
            kb.create_workflow(conn, workflow_id="wf-beta"),
        ]
        workflow_tasks = {
            workflow_ids[0]: kb.create_task(
                conn,
                title="alpha task",
                assignee="worker",
                workflow_id=workflow_ids[0],
            ),
            workflow_ids[1]: kb.create_task(
                conn,
                title="beta task",
                assignee="reviewer",
                workflow_id=workflow_ids[1],
            ),
        }
        for workflow_id in workflow_ids:
            kb.add_workflow_notify_sub(
                conn,
                workflow_id=workflow_id,
                platform="tui",
                chat_id=session_key,
            )

        # A mirror-shaped row is deliberately excluded. Workflow delivery
        # consumes only ordinary task boundaries.
        with kb.write_txn(conn):
            kb._append_event(
                conn,
                workflow_tasks[workflow_ids[0]],
                "loop_descendant_completed",
                {"summary": "mirror-only payload"},
            )
        assert kb.complete_task(
            conn,
            workflow_tasks[workflow_ids[0]],
            summary="alpha complete",
        )
        assert kb.block_task(
            conn,
            workflow_tasks[workflow_ids[1]],
            reason="beta needs input",
        )

        legacy_task = kb.create_task(
            conn,
            title="legacy migration task",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=legacy_task,
            platform="tui",
            chat_id=session_key,
        )
        assert kb.complete_task(conn, legacy_task, summary="legacy complete")

    original_root_lookup = kb.loop_root_for_task
    original_mirror_lookup = kb.loop_root_mirrored_source_event_ids
    monkeypatch.setattr(
        kb,
        "loop_root_for_task",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("workflow delivery must not resolve a root task")
        ),
    )
    monkeypatch.setattr(
        kb,
        "loop_root_mirrored_source_event_ids",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("workflow delivery must not inspect root mirrors")
        ),
    )

    dispatches: list[tuple[str, dict[str, Any]]] = []

    def _dispatch(_sid, session, text, **kwargs):
        dispatches.append((text, kwargs))
        session["running"] = False
        callback = kwargs.get("completion_callback")
        if callback is not None:
            callback(True)
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    session = _session(session_key)

    server._dispatch_tui_kanban_notifications("sid", session)
    assert len(dispatches) == 1
    first_workflow = dispatches[0][1]["workflow_id"]
    assert first_workflow in workflow_ids
    assert workflow_tasks[first_workflow] in dispatches[0][0]
    assert all(
        workflow_tasks[other] not in dispatches[0][0]
        for other in workflow_ids
        if other != first_workflow
    )
    assert legacy_task not in dispatches[0][0]
    assert "mirror-only payload" not in dispatches[0][0]

    server._dispatch_tui_kanban_notifications("sid", session)
    assert len(dispatches) == 2
    second_workflow = dispatches[1][1]["workflow_id"]
    assert {first_workflow, second_workflow} == set(workflow_ids)
    assert workflow_tasks[second_workflow] in dispatches[1][0]
    assert workflow_tasks[first_workflow] not in dispatches[1][0]
    assert legacy_task not in dispatches[1][0]

    # Once no workflow batch is pending, the unchanged direct-task consumer
    # remains available solely for routes awaiting migration.
    monkeypatch.setattr(kb, "loop_root_for_task", original_root_lookup)
    monkeypatch.setattr(
        kb,
        "loop_root_mirrored_source_event_ids",
        original_mirror_lookup,
    )
    server._dispatch_tui_kanban_notifications("sid", session)
    assert len(dispatches) == 3
    assert "workflow_id" not in dispatches[2][1]
    assert legacy_task in dispatches[2][0]

    with kb.connect() as conn:
        for workflow_id in workflow_ids:
            sub = _workflow_sub(conn, workflow_id)
            assert int(sub["last_event_id"]) > 0
            assert int(sub["last_notified_event_id"]) == int(
                sub["last_event_id"]
            )
        assert kb.list_notify_subs(conn, legacy_task) == []


def test_workflow_batch_emits_one_structured_foreground_resume_boundary(
    monkeypatch: pytest.MonkeyPatch,
    workflow_db,
):
    session_key = "workflow-boundary-session"
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf-boundary")
        first_task = kb.create_task(
            conn,
            title="Implement dynamic handoff",
            assignee="worker",
            workflow_id=workflow_id,
        )
        second_task = kb.create_task(
            conn,
            title="Review dynamic handoff",
            assignee="reviewer",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=session_key,
        )
        assert kb.complete_task(conn, first_task, summary="implementation complete")
        assert kb.complete_task(conn, second_task, summary="review complete")

    emitted = []
    dispatches = []

    def _dispatch(_sid, session, text, **kwargs):
        dispatches.append((text, kwargs))
        session["running"] = False
        kwargs["completion_callback"](True)
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda *args, **_kwargs: emitted.append(args),
    )

    server._dispatch_tui_kanban_notifications("sid", _session(session_key))

    status_updates = [args for args in emitted if args[0] == "status.update"]
    assert len(status_updates) == 1
    payload = status_updates[0][2]
    assert payload == {
        "kind": "workflow",
        "status": "foreground_resumed",
        "text": (
            "Implement dynamic handoff completed + 1 more · "
            "foreground resumed"
        ),
        "workflow_id": workflow_id,
        "event_id": payload["event_id"],
    }
    assert len(dispatches) == 1
    assert first_task in dispatches[0][0]
    assert second_task in dispatches[0][0]
    assert workflow_id not in dispatches[0][0]
    assert dispatches[0][1]["workflow_id"] == workflow_id

    with kb.connect() as conn:
        sub = _workflow_sub(conn, workflow_id)
        assert int(sub["last_event_id"]) == payload["event_id"]
        assert int(sub["last_notified_event_id"]) == payload["event_id"]
        assert sub["pending_claim_token"] is None


def test_compression_alias_subscriptions_deliver_closed_workflow_boundary_once(
    monkeypatch: pytest.MonkeyPatch,
    workflow_db,
):
    old_session_key = "workflow-session-before-compression"
    session_key = "workflow-session-after-compression"
    session_db = server._get_db()
    session_db.create_session(old_session_key, source="tui")
    session_db.end_session(old_session_key, "compression")
    session_db.create_session(
        session_key,
        source="tui",
        parent_session_id=old_session_key,
    )
    assert session_db.resolve_resume_session_id(old_session_key) == session_key

    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf-compression-alias")
        already_acked_task = kb.create_task(
            conn,
            title="Previously delivered boundary",
            assignee="worker",
            workflow_id=workflow_id,
        )
        task_id = kb.create_task(
            conn,
            title="Complete once across compression aliases",
            assignee="worker",
            workflow_id=workflow_id,
        )
        assert kb.complete_task(
            conn,
            already_acked_task,
            summary="delivered before compression",
        )
        acked_cursor = int(
            conn.execute(
                "SELECT MAX(id) FROM task_events WHERE task_id = ? AND kind = ?",
                (already_acked_task, "completed"),
            ).fetchone()[0]
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=old_session_key,
            start_cursor=acked_cursor,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=session_key,
        )
        assert kb.complete_task(conn, task_id, summary="one logical boundary")
        kb.close_workflow(conn, workflow_id)

    dispatches = []

    def _dispatch(_sid, session, text, **kwargs):
        dispatches.append((text, kwargs))
        session["running"] = False
        kwargs["completion_callback"](True)
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    session = _session(session_key)

    server._dispatch_tui_kanban_notifications("sid", session)
    server._dispatch_tui_kanban_notifications("sid", session)

    assert len(dispatches) == 1
    assert task_id in dispatches[0][0]
    assert already_acked_task not in dispatches[0][0]
    with kb.connect() as conn:
        assert kb.list_workflow_notify_subs(conn, workflow_id) == []


def test_visible_checkpoint_survives_failed_turn_without_ack(
    monkeypatch: pytest.MonkeyPatch,
    workflow_db,
):
    session_key = "workflow-retry-session"
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf-retry")
        task_id = kb.create_task(
            conn,
            title="retry workflow task",
            assignee="worker",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=session_key,
        )
        assert kb.complete_task(
            conn,
            task_id,
            summary="foreground must retry this boundary",
        )

    callbacks = []
    dispatches = []
    emitted = []

    def _dispatch(_sid, _session, text, **kwargs):
        dispatches.append((text, kwargs))
        callbacks.append(kwargs["completion_callback"])
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda *args, **_kwargs: emitted.append(args),
    )
    session = _session(session_key)

    server._dispatch_tui_kanban_notifications("sid", session)
    assert len(dispatches) == 1
    assert dispatches[0][1]["workflow_id"] == workflow_id
    with kb.connect() as conn:
        sub = _workflow_sub(conn, workflow_id)
        visible_cursor = int(sub["last_notified_event_id"])
        assert visible_cursor > 0
        assert int(sub["last_event_id"]) == 0
        assert sub["pending_claim_token"]

    # A failed agent turn releases only the delivery lease. The independently
    # persisted visible checkpoint prevents a duplicate status line on retry.
    session["running"] = False
    callbacks.pop(0)(False)
    with kb.connect() as conn:
        sub = _workflow_sub(conn, workflow_id)
        assert int(sub["last_event_id"]) == 0
        assert int(sub["last_notified_event_id"]) == visible_cursor
        assert sub["pending_claim_token"] is None

    server._dispatch_tui_kanban_notifications("sid", session)
    assert len(dispatches) == 2
    status_updates = [args for args in emitted if args[0] == "status.update"]
    assert len(status_updates) == 1

    session["running"] = False
    callbacks.pop(0)(True)
    with kb.connect() as conn:
        sub = _workflow_sub(conn, workflow_id)
        assert int(sub["last_event_id"]) == visible_cursor
        assert int(sub["last_notified_event_id"]) == visible_cursor
        assert sub["pending_claim_token"] is None


def test_notification_dispatch_forwards_workflow_and_completion_callback(
    monkeypatch: pytest.MonkeyPatch,
):
    observed = {}
    completions = []

    def _submit(_rid, _sid, _session, text, **kwargs):
        observed["text"] = text
        observed.update(kwargs)

    monkeypatch.setattr(server, "_run_prompt_submit", _submit)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)

    assert server._dispatch_notification_text(
        "sid",
        _session("dispatch-session"),
        "workflow boundary",
        emit_status=False,
        preclaimed=True,
        completion_callback=completions.append,
        workflow_id="wf-dispatch",
    )
    assert observed["text"] == "workflow boundary"
    assert observed["workflow_id"] == "wf-dispatch"
    observed["completion_callback"](True)
    assert completions == [True]


def test_workflow_id_is_bound_for_exact_agent_turn_and_then_cleared(
    monkeypatch: pytest.MonkeyPatch,
):
    from gateway.session_context import (
        get_current_workflow_id,
        reset_session_vars_for_tests,
    )
    from tools.process_registry import process_registry

    observed = []
    completions = []

    class _Agent:
        def run_conversation(
            self,
            _prompt,
            conversation_history=None,
            stream_callback=None,
            **_kwargs,
        ):
            observed.append(get_current_workflow_id())
            return {"final_response": "", "messages": []}

    class _ImmediateThread:
        def __init__(self, target=None, daemon=None):
            self._target = target

        def start(self):
            self._target()

    reset_session_vars_for_tests()
    session = _session("context-session", agent=_Agent())
    session["running"] = True
    server._sessions["sid-context"] = session
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_sync_agent_model_with_config",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(server, "_register_session_cwd", lambda *_args: None)
    monkeypatch.setattr(server, "make_stream_renderer", lambda _cols: None)
    monkeypatch.setattr(server, "render_message", lambda _raw, _cols: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        server,
        "_persist_tui_turn_entries",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        process_registry,
        "drain_notifications",
        lambda **_kwargs: [],
    )

    try:
        server._run_prompt_submit(
            "rid",
            "sid-context",
            session,
            "workflow wake",
            completion_callback=completions.append,
            workflow_id="wf-context",
        )
        assert observed == ["wf-context"]
        assert completions == [True]
        assert get_current_workflow_id() == ""
    finally:
        server._sessions.pop("sid-context", None)
        reset_session_vars_for_tests()


def test_compression_coalescing_preserves_distinct_thread_routes(
    monkeypatch: pytest.MonkeyPatch,
    workflow_db,
):
    session_key = "workflow-thread-route-session"
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf-thread-routes")
        task_id = kb.create_task(
            conn,
            title="Preserve thread routes",
            assignee="worker",
            workflow_id=workflow_id,
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=session_key,
            thread_id="thread-a",
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id=session_key,
            thread_id="thread-b",
        )
        assert kb.complete_task(conn, task_id, summary="both threads")

    dispatches = []

    def _dispatch(_sid, session, text, **kwargs):
        dispatches.append((text, kwargs))
        session["running"] = False
        kwargs["completion_callback"](True)
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)

    server._dispatch_tui_kanban_notifications("sid", _session(session_key))

    assert len(dispatches) == 1
    with kb.connect() as conn:
        rows = kb.list_workflow_notify_subs(conn, "wf-thread-routes")
        assert {row["thread_id"] for row in rows} == {"thread-a", "thread-b"}
        assert sum(int(row["last_event_id"]) > 0 for row in rows) == 1


def test_coalescing_rejects_distinct_route_identity(workflow_db):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, workflow_id="wf-route-guard")
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id="chat-a",
            thread_id="thread-a",
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            platform="tui",
            chat_id="chat-b",
            thread_id="thread-b",
        )

        assert (
            kb.coalesce_workflow_notify_sub_routes(
                conn,
                workflow_id=workflow_id,
                canonical_notifier_profile=None,
                canonical_platform="tui",
                canonical_chat_id="chat-a",
                canonical_thread_id="thread-a",
                aliases=[(None, "tui", "chat-b", "thread-b")],
            )
            is None
        )
        rows = kb.list_workflow_notify_subs(conn, workflow_id)
        assert {(row["chat_id"], row["thread_id"]) for row in rows} == {
            ("chat-a", "thread-a"),
            ("chat-b", "thread-b"),
        }


@pytest.mark.parametrize(
    ("alias_profile", "alias_platform", "alias_thread"),
    [
        ("profile-b", "tui", "thread-a"),
        ("profile-a", "telegram", "thread-a"),
        ("profile-a", "tui", "thread-b"),
    ],
)
def test_coalescing_rejects_profile_platform_and_thread_aliases(
    workflow_db,
    alias_profile,
    alias_platform,
    alias_thread,
):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn)
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            notifier_profile="profile-a",
            platform="tui",
            chat_id="chat-a",
            thread_id="thread-a",
        )
        kb.add_workflow_notify_sub(
            conn,
            workflow_id=workflow_id,
            notifier_profile=alias_profile,
            platform=alias_platform,
            chat_id="chat-b",
            thread_id=alias_thread,
        )

        assert (
            kb.coalesce_workflow_notify_sub_routes(
                conn,
                workflow_id=workflow_id,
                canonical_notifier_profile="profile-a",
                canonical_platform="tui",
                canonical_chat_id="chat-a",
                canonical_thread_id="thread-a",
                aliases=[
                    (
                        alias_profile,
                        alias_platform,
                        "chat-b",
                        alias_thread,
                    )
                ],
            )
            is None
        )
        assert len(kb.list_workflow_notify_subs(conn, workflow_id)) == 2


def test_unrelated_tui_session_route_is_not_claimed(workflow_db, monkeypatch):
    session_key = "workflow-matching-session"
    unrelated_key = "workflow-unrelated-session"
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn)
        task_id = kb.create_task(
            conn,
            title="Only matching session",
            assignee="worker",
            workflow_id=workflow_id,
        )
        for chat_id in (session_key, unrelated_key):
            kb.add_workflow_notify_sub(
                conn,
                workflow_id=workflow_id,
                platform="tui",
                chat_id=chat_id,
            )
        assert kb.complete_task(conn, task_id, summary="matching session only")

    dispatches = []

    def _dispatch(_sid, session, text, **kwargs):
        dispatches.append((text, kwargs))
        session["running"] = False
        kwargs["completion_callback"](True)
        return True

    monkeypatch.setattr(server, "_dispatch_notification_text", _dispatch)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    server._dispatch_tui_kanban_notifications("sid", _session(session_key))

    assert len(dispatches) == 1
    with kb.connect() as conn:
        rows = kb.list_workflow_notify_subs(conn, workflow_id)
        unrelated = next(row for row in rows if row["chat_id"] == unrelated_key)
        assert int(unrelated["last_event_id"]) == 0
