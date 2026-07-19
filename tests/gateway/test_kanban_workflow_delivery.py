from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.kanban_watchers import (
    GatewayKanbanWatchersMixin,
    _descendant_wake_message,
    _direct_boundary_comment_context,
)
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource, build_session_key


class _RecordingAdapter:
    def __init__(
        self,
        *,
        wake_failures: int = 0,
        send_result: SendResult | None = None,
    ):
        self.visible: list[tuple[str, str, dict[str, Any]]] = []
        self.internal: list[Any] = []
        self._wake_failures = wake_failures
        self._send_result = send_result

    async def send(
        self,
        chat_id: str,
        text: str,
        *,
        metadata: dict[str, Any],
    ) -> SendResult | None:
        self.visible.append((chat_id, text, metadata))
        return self._send_result

    async def handle_message(self, event: Any) -> None:
        if self._wake_failures:
            self._wake_failures -= 1
            raise RuntimeError("synthetic wake failure")
        self.internal.append(event)


class _ForegroundAdapter(BasePlatformAdapter):
    """Real Base adapter used to exercise busy-session turn handoff."""

    def __init__(self):
        super().__init__(
            PlatformConfig(
                enabled=True,
                token="test",
                typing_indicator=False,
                extra={"group_sessions_per_user": False},
            ),
            Platform.TELEGRAM,
        )
        self.visible: list[tuple[str, str, dict[str, Any]]] = []
        self.busy_started = asyncio.Event()
        self.release_busy = asyncio.Event()
        self.workflow_started: dict[str, asyncio.Event] = {}
        self.workflow_release: dict[str, asyncio.Event] = {}
        self.processed_workflows: list[tuple[str, str]] = []
        self.set_message_handler(self._handle)

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(
        self,
        chat_id: str,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> SendResult:
        self.visible.append((chat_id, content, metadata or {}))
        return SendResult(success=True, message_id=f"visible-{len(self.visible)}")

    async def get_chat_info(self, chat_id: str) -> dict[str, str]:
        return {"id": chat_id}

    async def _handle(self, event: MessageEvent) -> None:
        if event.text == "busy":
            self.busy_started.set()
            await self.release_busy.wait()
            return None
        workflow_id = str(event.metadata.get("workflow_id") or "")
        started = self.workflow_started.setdefault(
            workflow_id, asyncio.Event()
        )
        started.set()
        release = self.workflow_release.get(workflow_id)
        if release is not None:
            await release.wait()
        self.processed_workflows.append((workflow_id, event.text))
        return None

    def block_workflow(self, workflow_id: str) -> None:
        self.workflow_started.setdefault(workflow_id, asyncio.Event())
        self.workflow_release[workflow_id] = asyncio.Event()

    def busy_event(self, chat_id: str = "shared-chat") -> MessageEvent:
        return MessageEvent(
            text="busy",
            message_type=MessageType.TEXT,
            source=SessionSource(
                platform=Platform.TELEGRAM,
                chat_id=chat_id,
                chat_type="group",
            ),
        )


class _WorkflowDeliveryRunner(GatewayKanbanWatchersMixin):
    def __init__(self, adapter: Any | None = None):
        self._adapter = adapter

    def _authorization_adapter(
        self,
        _platform: Platform,
        _profile: str | None,
    ) -> Any | None:
        return self._adapter

    async def _deliver_kanban_artifacts(self, **_kwargs: Any) -> None:
        return None


@pytest.fixture
def workflow_delivery_db(monkeypatch, tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_PROFILE", "orchestrator")
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)

    from hermes_cli import kanban_db as kb

    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    conn = kb.connect()
    try:
        yield conn
    finally:
        conn.close()


def _completed_member(
    conn,
    *,
    workflow_id: str,
    title: str,
    summary: str,
    comment_author: str | None = None,
    comment_body: str | None = None,
) -> str:
    from hermes_cli import kanban_db as kb

    task_id = kb.create_task(
        conn,
        title=title,
        assignee="worker",
        workflow_id=workflow_id,
        initial_status="running",
    )
    if comment_author and comment_body:
        kb.add_comment(conn, task_id, comment_author, comment_body)
    assert kb.complete_task(conn, task_id, summary=summary)
    return task_id


def _subscribe(
    conn,
    *,
    workflow_id: str,
    chat_id: str = "shared-chat",
) -> None:
    from hermes_cli import kanban_db as kb

    kb.add_workflow_notify_sub(
        conn,
        workflow_id=workflow_id,
        notifier_profile="orchestrator",
        platform="telegram",
        chat_id=chat_id,
        chat_type="group",
    )


def _claim_delivery(conn, *, workflow_id: str) -> dict[str, Any]:
    from hermes_cli import kanban_db as kb

    sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    old_cursor, cursor, events, claim_token = kb.claim_unseen_events_for_workflow_sub(
        conn,
        workflow_id=workflow_id,
        notifier_profile=sub["notifier_profile"],
        platform=sub["platform"],
        chat_id=sub["chat_id"],
        thread_id=sub.get("thread_id") or "",
        limit=20,
    )
    assert events
    assert claim_token
    return {
        "delivery_kind": "workflow",
        "sub": sub,
        "old_cursor": old_cursor,
        "cursor": cursor,
        "claim_token": claim_token,
        "events": events,
        "tasks": {
            str(event.task_id): kb.get_task(conn, event.task_id) for event in events
        },
        "workflow": kb.get_workflow(conn, workflow_id),
        "workflow_id": workflow_id,
        "board": kb.DEFAULT_BOARD,
    }


async def _deliver(
    delivery: dict[str, Any],
    adapter: Any,
    *,
    runner: _WorkflowDeliveryRunner | None = None,
) -> None:
    runner = runner or _WorkflowDeliveryRunner()
    await runner._deliver_kanban_workflow_batch(
        delivery=delivery,
        adapter=adapter,
        platform=Platform.TELEGRAM,
        route_profile="orchestrator",
        fail_counts={},
        max_send_failures=3,
    )


async def _deliver_routes(
    deliveries: list[dict[str, Any]],
    adapter: Any,
    *,
    runner: _WorkflowDeliveryRunner | None = None,
) -> None:
    runner = runner or _WorkflowDeliveryRunner(adapter)
    await runner._deliver_kanban_workflow_routes(
        deliveries=deliveries,
        platform_type=Platform,
        notifier_profile="orchestrator",
        fail_counts={},
        max_send_failures=3,
    )


@pytest.mark.asyncio
async def test_two_member_boundaries_coalesce_into_one_workflow_wake_with_comments(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    workflow_id = kb.create_workflow(conn, title="Review and follow up")
    first = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Implement parser",
        summary="Parser implementation complete",
        comment_author="worker-a",
        comment_body="Please review the quoted-field edge case.",
    )
    second = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Add tests",
        summary="Regression tests complete",
        comment_author="worker-b",
        comment_body="Follow-up can reuse the new fixture.",
    )
    _subscribe(conn, workflow_id=workflow_id)
    delivery = _claim_delivery(conn, workflow_id=workflow_id)
    adapter = _RecordingAdapter()

    await _deliver(delivery, adapter)

    assert len(adapter.visible) == 1
    visible_text = adapter.visible[0][1]
    assert first in visible_text
    assert second in visible_text
    assert len(adapter.internal) == 1
    wake = adapter.internal[0]
    assert wake.internal is True
    assert wake.metadata["workflow_id"] == workflow_id
    assert workflow_id not in wake.text
    assert first in wake.text
    assert second in wake.text
    assert (
        "comment from worker-a: Please review the quoted-field edge case." in wake.text
    )
    assert "comment from worker-b: Follow-up can reuse the new fixture." in wake.text
    assert 'loop_graph(action="close")' in wake.text
    assert "refuses unfinished workflow members" in wake.text
    assert "Read each changed task with kanban_show" not in wake.text
    assert "authoritative for this boundary" in wake.text
    assert "Call kanban_show only when required evidence is missing" in wake.text
    assert (
        "make one decision and call delegate_task, kanban_unblock, or loop_graph "
        "directly"
    ) in wake.text
    assert "depends_on" in wake.text
    assert "blocks" in wake.text
    assert "kanban_create" not in wake.text
    assert "Durable Loop tasks are the plan" in wake.text
    assert "update a session todo" in wake.text
    assert "inspect source" in wake.text
    assert "use terminal as preflight" in wake.text

    sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert sub["last_event_id"] == delivery["cursor"]
    assert sub["last_notified_event_id"] == delivery["cursor"]
    assert sub["pending_claim_token"] is None


@pytest.mark.asyncio
async def test_wake_failure_releases_lease_without_replaying_visible_boundaries(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    workflow_id = kb.create_workflow(conn, title="Retry wake only")
    task_id = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Produce evidence",
        summary="Evidence is ready",
        comment_author="worker",
        comment_body="The foreground should see this once.",
    )
    _subscribe(conn, workflow_id=workflow_id)
    first_delivery = _claim_delivery(conn, workflow_id=workflow_id)
    first_adapter = _RecordingAdapter(wake_failures=1)

    await _deliver(first_delivery, first_adapter)

    assert len(first_adapter.visible) == 1
    assert first_adapter.internal == []
    after_failure = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert after_failure["last_event_id"] == first_delivery["old_cursor"]
    assert after_failure["last_notified_event_id"] == first_delivery["cursor"]
    assert after_failure["pending_claim_token"] is None

    retry_delivery = _claim_delivery(conn, workflow_id=workflow_id)
    retry_adapter = _RecordingAdapter()
    await _deliver(retry_delivery, retry_adapter)

    assert retry_adapter.visible == []
    assert len(retry_adapter.internal) == 1
    assert task_id in retry_adapter.internal[0].text
    after_retry = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert after_retry["last_event_id"] == retry_delivery["cursor"]
    assert after_retry["last_notified_event_id"] == retry_delivery["cursor"]
    assert after_retry["pending_claim_token"] is None


@pytest.mark.asyncio
async def test_two_workflows_sharing_one_chat_receive_separate_internal_wakes(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    first_workflow = kb.create_workflow(conn, title="First workflow")
    second_workflow = kb.create_workflow(conn, title="Second workflow")
    first_task = _completed_member(
        conn,
        workflow_id=first_workflow,
        title="First task",
        summary="First done",
    )
    second_task = _completed_member(
        conn,
        workflow_id=second_workflow,
        title="Second task",
        summary="Second done",
    )
    _subscribe(conn, workflow_id=first_workflow)
    _subscribe(conn, workflow_id=second_workflow)
    first_delivery = _claim_delivery(conn, workflow_id=first_workflow)
    second_delivery = _claim_delivery(conn, workflow_id=second_workflow)
    adapter = _RecordingAdapter()

    await _deliver(first_delivery, adapter)
    await _deliver(second_delivery, adapter)

    assert len(adapter.internal) == 2
    by_workflow = {event.metadata["workflow_id"]: event for event in adapter.internal}
    assert set(by_workflow) == {first_workflow, second_workflow}
    assert first_task in by_workflow[first_workflow].text
    assert second_task not in by_workflow[first_workflow].text
    assert second_task in by_workflow[second_workflow].text
    assert first_task not in by_workflow[second_workflow].text


@pytest.mark.asyncio
async def test_negative_send_result_releases_claim_without_advancing_cursors(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    workflow_id = kb.create_workflow(conn, title="Retry failed visible send")
    first_task = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Deliver first result",
        summary="First ready",
    )
    second_task = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Deliver second result",
        summary="Second ready",
    )
    _subscribe(conn, workflow_id=workflow_id)
    delivery = _claim_delivery(conn, workflow_id=workflow_id)
    adapter = _RecordingAdapter(
        send_result=SendResult(success=False, error="synthetic rejection")
    )

    await _deliver(delivery, adapter)

    assert len(adapter.visible) == 1
    assert first_task in adapter.visible[0][1]
    assert second_task in adapter.visible[0][1]
    assert adapter.internal == []
    sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert sub["last_event_id"] == delivery["old_cursor"]
    assert sub["last_notified_event_id"] == delivery["old_cursor"]
    assert sub["pending_claim_token"] is None

    retry = _claim_delivery(conn, workflow_id=workflow_id)
    assert retry["old_cursor"] == delivery["old_cursor"]
    assert retry["cursor"] == delivery["cursor"]
    assert retry["claim_token"] != delivery["claim_token"]

    success_adapter = _RecordingAdapter()
    await _deliver(retry, success_adapter)
    assert len(success_adapter.visible) == 1
    assert first_task in success_adapter.visible[0][1]
    assert second_task in success_adapter.visible[0][1]
    assert len(success_adapter.internal) == 1
    completed = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert completed["last_event_id"] == retry["cursor"]
    assert completed["last_notified_event_id"] == retry["cursor"]
    assert completed["pending_claim_token"] is None


def test_descendant_wake_uses_supplied_evidence_before_conditional_show():
    wake_text = _descendant_wake_message(
        root_task_id="t_root",
        board="default",
        events=[
            SimpleNamespace(
                kind="loop_descendant_completed",
                payload={
                    "source_task_id": "t_child",
                    "source_kind": "completed",
                    "title": "Implement parser",
                    "summary": "Parser is ready",
                    "comments": [
                        {
                            "author": "worker",
                            "body": "Please review the quoted-field case.",
                        }
                    ],
                },
            )
        ],
    )

    assert "Parser is ready" in wake_text
    assert "Please review the quoted-field case." in wake_text
    assert "Read each changed task with kanban_show" not in wake_text
    assert "authoritative for this boundary" in wake_text
    assert "Call kanban_show only when required evidence is missing" in wake_text


def test_direct_boundary_context_uses_conditional_show_guidance():
    context = _direct_boundary_comment_context(
        [
            SimpleNamespace(
                id=1,
                task_id="t_direct",
                kind="completed",
                payload={
                    "summary": "Implementation is ready",
                    "comments": [
                        {
                            "author": "worker",
                            "body": "The edge-case evidence is attached.",
                        }
                    ],
                },
            )
        ]
    )

    assert "Implementation is ready" in context
    assert "The edge-case evidence is attached." in context
    assert "Read the task with kanban_show before deciding" not in context
    assert "authoritative for this boundary" in context
    assert "Call kanban_show only when required evidence is missing" in context


@pytest.mark.asyncio
async def test_busy_workflow_wake_renews_lease_and_acks_only_after_exact_turn(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    workflow_id = kb.create_workflow(conn, title="Queued foreground wake")
    task_id = _completed_member(
        conn,
        workflow_id=workflow_id,
        title="Wait for foreground",
        summary="Worker finished",
    )
    _subscribe(conn, workflow_id=workflow_id)
    delivery = _claim_delivery(conn, workflow_id=workflow_id)

    # Make renewal observable without waiting for the production 30-minute
    # lease. The watcher must extend this exact claim while the wake is queued.
    short_expiry = int(time.time()) + 1
    conn.execute(
        "UPDATE workflow_notify_subs SET pending_expires_at = ? "
        "WHERE workflow_id = ?",
        (short_expiry, workflow_id),
    )
    conn.commit()

    adapter = _ForegroundAdapter()
    await adapter.handle_message(adapter.busy_event())
    await asyncio.wait_for(adapter.busy_started.wait(), timeout=1.0)

    runner = _WorkflowDeliveryRunner()
    runner._workflow_receipt_renew_interval_seconds = 0.01
    runner._workflow_notify_lease_seconds = 30
    delivery_task = asyncio.create_task(
        _deliver(delivery, adapter, runner=runner)
    )

    session_key = build_session_key(
        adapter.busy_event().source,
        group_sessions_per_user=False,
    )
    for _ in range(100):
        pending = adapter._pending_messages.get(session_key)
        if pending is not None and pending.metadata.get("workflow_id") == workflow_id:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("workflow wake was not queued behind the busy foreground turn")

    before_release = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert before_release["last_event_id"] == delivery["old_cursor"]
    assert before_release["pending_claim_token"] == delivery["claim_token"]
    assert adapter.processed_workflows == []

    await asyncio.sleep(0.05)
    renewed = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert renewed["pending_expires_at"] > short_expiry
    assert renewed["last_event_id"] == delivery["old_cursor"]
    claim_again = kb.claim_unseen_events_for_workflow_sub(
        conn,
        workflow_id=workflow_id,
        notifier_profile="orchestrator",
        platform="telegram",
        chat_id="shared-chat",
        thread_id="",
    )
    assert claim_again == (
        delivery["old_cursor"],
        delivery["old_cursor"],
        [],
        None,
    )

    adapter.release_busy.set()
    await asyncio.wait_for(delivery_task, timeout=2.0)

    assert [item[0] for item in adapter.processed_workflows] == [workflow_id]
    assert task_id in adapter.processed_workflows[0][1]
    completed = kb.list_workflow_notify_subs(conn, workflow_id)[0]
    assert completed["last_event_id"] == delivery["cursor"]
    assert completed["pending_claim_token"] is None
    await adapter.cancel_background_tasks()


@pytest.mark.asyncio
async def test_blocked_workflow_route_does_not_delay_an_independent_route(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    blocked_workflow = kb.create_workflow(conn, title="Blocked route")
    independent_workflow = kb.create_workflow(conn, title="Independent route")
    _completed_member(
        conn,
        workflow_id=blocked_workflow,
        title="Wait on route A",
        summary="Route A complete",
    )
    _completed_member(
        conn,
        workflow_id=independent_workflow,
        title="Finish on route B",
        summary="Route B complete",
    )
    _subscribe(conn, workflow_id=blocked_workflow, chat_id="route-a")
    _subscribe(conn, workflow_id=independent_workflow, chat_id="route-b")
    blocked_delivery = _claim_delivery(conn, workflow_id=blocked_workflow)
    independent_delivery = _claim_delivery(
        conn,
        workflow_id=independent_workflow,
    )

    adapter = _ForegroundAdapter()
    adapter.block_workflow(blocked_workflow)
    route_task = asyncio.create_task(
        _deliver_routes(
            [blocked_delivery, independent_delivery],
            adapter,
        )
    )

    await asyncio.wait_for(
        adapter.workflow_started[blocked_workflow].wait(),
        timeout=1.0,
    )
    for _ in range(100):
        independent_sub = kb.list_workflow_notify_subs(
            conn,
            independent_workflow,
        )[0]
        if (
            independent_sub["last_event_id"]
            == independent_delivery["cursor"]
            and any(
                workflow_id == independent_workflow
                for workflow_id, _text in adapter.processed_workflows
            )
        ):
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("independent route was delayed by the blocked route")

    assert not route_task.done()
    blocked_sub = kb.list_workflow_notify_subs(conn, blocked_workflow)[0]
    assert blocked_sub["last_event_id"] == blocked_delivery["old_cursor"]
    assert blocked_sub["pending_claim_token"] == blocked_delivery["claim_token"]
    assert independent_sub["last_event_id"] == independent_delivery["cursor"]
    assert independent_sub["pending_claim_token"] is None

    adapter.workflow_release[blocked_workflow].set()
    await asyncio.wait_for(route_task, timeout=1.0)
    blocked_sub = kb.list_workflow_notify_subs(conn, blocked_workflow)[0]
    assert blocked_sub["last_event_id"] == blocked_delivery["cursor"]
    assert blocked_sub["pending_claim_token"] is None
    await adapter.cancel_background_tasks()


@pytest.mark.asyncio
async def test_workflow_route_concurrency_is_bounded(workflow_delivery_db):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    workflows = [
        kb.create_workflow(conn, title=f"Concurrent route {index}")
        for index in range(3)
    ]
    for index, workflow_id in enumerate(workflows):
        _completed_member(
            conn,
            workflow_id=workflow_id,
            title=f"Route {index}",
            summary=f"Route {index} complete",
        )
        _subscribe(
            conn,
            workflow_id=workflow_id,
            chat_id=f"bounded-route-{index}",
        )
    deliveries = [
        _claim_delivery(conn, workflow_id=workflow_id)
        for workflow_id in workflows
    ]

    adapter = _ForegroundAdapter()
    for workflow_id in workflows:
        adapter.block_workflow(workflow_id)
    runner = _WorkflowDeliveryRunner(adapter)
    runner._workflow_notifier_max_concurrency = 2
    route_task = asyncio.create_task(
        _deliver_routes(
            deliveries,
            adapter,
            runner=runner,
        )
    )

    for workflow_id in workflows[:2]:
        await asyncio.wait_for(
            adapter.workflow_started[workflow_id].wait(),
            timeout=1.0,
        )
    assert not adapter.workflow_started[workflows[2]].is_set()

    adapter.workflow_release[workflows[0]].set()
    await asyncio.wait_for(
        adapter.workflow_started[workflows[2]].wait(),
        timeout=1.0,
    )
    for workflow_id in workflows[1:]:
        adapter.workflow_release[workflow_id].set()
    await asyncio.wait_for(route_task, timeout=1.0)

    assert {item[0] for item in adapter.processed_workflows} == set(workflows)
    await adapter.cancel_background_tasks()


@pytest.mark.asyncio
async def test_workflow_route_fifo_acks_each_lease_only_after_its_turn(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    first_workflow = kb.create_workflow(conn, title="First on route")
    second_workflow = kb.create_workflow(conn, title="Second on route")
    _completed_member(
        conn,
        workflow_id=first_workflow,
        title="First turn",
        summary="First complete",
    )
    _completed_member(
        conn,
        workflow_id=second_workflow,
        title="Second turn",
        summary="Second complete",
    )
    _subscribe(conn, workflow_id=first_workflow, chat_id="ordered-route")
    _subscribe(conn, workflow_id=second_workflow, chat_id="ordered-route")
    first_delivery = _claim_delivery(conn, workflow_id=first_workflow)
    second_delivery = _claim_delivery(conn, workflow_id=second_workflow)

    adapter = _ForegroundAdapter()
    adapter.block_workflow(first_workflow)
    adapter.block_workflow(second_workflow)
    route_task = asyncio.create_task(
        _deliver_routes(
            [first_delivery, second_delivery],
            adapter,
        )
    )

    await asyncio.wait_for(
        adapter.workflow_started[first_workflow].wait(),
        timeout=1.0,
    )
    assert not adapter.workflow_started[second_workflow].is_set()
    for workflow_id, delivery in (
        (first_workflow, first_delivery),
        (second_workflow, second_delivery),
    ):
        sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert sub["last_event_id"] == delivery["old_cursor"]
        assert sub["pending_claim_token"] == delivery["claim_token"]

    adapter.workflow_release[first_workflow].set()
    await asyncio.wait_for(
        adapter.workflow_started[second_workflow].wait(),
        timeout=1.0,
    )
    first_sub = kb.list_workflow_notify_subs(conn, first_workflow)[0]
    second_sub = kb.list_workflow_notify_subs(conn, second_workflow)[0]
    assert first_sub["last_event_id"] == first_delivery["cursor"]
    assert first_sub["pending_claim_token"] is None
    assert second_sub["last_event_id"] == second_delivery["old_cursor"]
    assert second_sub["pending_claim_token"] == second_delivery["claim_token"]

    adapter.workflow_release[second_workflow].set()
    await asyncio.wait_for(route_task, timeout=1.0)
    assert [item[0] for item in adapter.processed_workflows] == [
        first_workflow,
        second_workflow,
    ]
    second_sub = kb.list_workflow_notify_subs(conn, second_workflow)[0]
    assert second_sub["last_event_id"] == second_delivery["cursor"]
    assert second_sub["pending_claim_token"] is None
    await adapter.cancel_background_tasks()


@pytest.mark.asyncio
async def test_busy_queue_keeps_distinct_workflow_wakes_as_separate_fifo_turns(
    workflow_delivery_db,
):
    from hermes_cli import kanban_db as kb

    conn = workflow_delivery_db
    first_workflow = kb.create_workflow(conn, title="First queued workflow")
    second_workflow = kb.create_workflow(conn, title="Second queued workflow")
    first_task = _completed_member(
        conn,
        workflow_id=first_workflow,
        title="First member",
        summary="First complete",
    )
    second_task = _completed_member(
        conn,
        workflow_id=second_workflow,
        title="Second member",
        summary="Second complete",
    )
    _subscribe(conn, workflow_id=first_workflow)
    _subscribe(conn, workflow_id=second_workflow)
    first_delivery = _claim_delivery(conn, workflow_id=first_workflow)
    second_delivery = _claim_delivery(conn, workflow_id=second_workflow)

    adapter = _ForegroundAdapter()
    adapter.block_workflow(first_workflow)
    adapter.block_workflow(second_workflow)
    await adapter.handle_message(adapter.busy_event())
    await asyncio.wait_for(adapter.busy_started.wait(), timeout=1.0)

    first_delivery_task = asyncio.create_task(
        _deliver(first_delivery, adapter)
    )
    session_key = build_session_key(
        adapter.busy_event().source,
        group_sessions_per_user=False,
    )
    for _ in range(100):
        pending = adapter._pending_messages.get(session_key)
        if (
            pending is not None
            and pending.metadata.get("workflow_id") == first_workflow
        ):
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("first workflow wake was not queued")

    second_delivery_task = asyncio.create_task(
        _deliver(second_delivery, adapter)
    )
    for _ in range(100):
        if len(adapter.visible) >= 2:
            break
        await asyncio.sleep(0.01)

    for workflow_id, delivery in (
        (first_workflow, first_delivery),
        (second_workflow, second_delivery),
    ):
        sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert sub["last_event_id"] == delivery["old_cursor"]
        assert sub["pending_claim_token"] == delivery["claim_token"]

    adapter.release_busy.set()
    await asyncio.wait_for(
        adapter.workflow_started[first_workflow].wait(),
        timeout=1.0,
    )
    assert not adapter.workflow_started[second_workflow].is_set()

    # Both exact claims remain held while the first receipt is unresolved.
    for workflow_id, delivery in (
        (first_workflow, first_delivery),
        (second_workflow, second_delivery),
    ):
        claim_again = kb.claim_unseen_events_for_workflow_sub(
            conn,
            workflow_id=workflow_id,
            notifier_profile="orchestrator",
            platform="telegram",
            chat_id="shared-chat",
            thread_id="",
        )
        assert claim_again == (
            delivery["old_cursor"],
            delivery["old_cursor"],
            [],
            None,
        )

    adapter.workflow_release[first_workflow].set()
    await asyncio.wait_for(first_delivery_task, timeout=1.0)
    await asyncio.wait_for(
        adapter.workflow_started[second_workflow].wait(),
        timeout=1.0,
    )

    first_sub = kb.list_workflow_notify_subs(conn, first_workflow)[0]
    second_sub = kb.list_workflow_notify_subs(conn, second_workflow)[0]
    assert first_sub["last_event_id"] == first_delivery["cursor"]
    assert second_sub["last_event_id"] == second_delivery["old_cursor"]
    assert second_sub["pending_claim_token"] == second_delivery["claim_token"]

    adapter.workflow_release[second_workflow].set()
    await asyncio.wait_for(second_delivery_task, timeout=1.0)

    assert [item[0] for item in adapter.processed_workflows] == [
        first_workflow,
        second_workflow,
    ]
    first_text = adapter.processed_workflows[0][1]
    second_text = adapter.processed_workflows[1][1]
    assert first_task in first_text
    assert second_task not in first_text
    assert second_task in second_text
    assert first_task not in second_text
    for workflow_id, delivery in (
        (first_workflow, first_delivery),
        (second_workflow, second_delivery),
    ):
        sub = kb.list_workflow_notify_subs(conn, workflow_id)[0]
        assert sub["last_event_id"] == delivery["cursor"]
        assert sub["pending_claim_token"] is None
    await adapter.cancel_background_tasks()
