import asyncio
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace

import pytest


from gateway.config import Platform
from gateway.platforms.base import SendResult
from gateway.run import GatewayRunner
from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


class RecordingAdapter:
    def __init__(self, *, send_results=None):
        self.sent = []
        self.wakes = []
        self.send_results = list(send_results or [])

    async def send(self, chat_id, text, metadata=None):
        self.sent.append({"chat_id": chat_id, "text": text, "metadata": metadata or {}})
        if self.send_results:
            return self.send_results.pop(0)
        return None

    async def handle_message(self, event):
        self.wakes.append(event)


class DisconnectedAdapters(dict):
    """Expose a platform during collection, then simulate disconnect on get()."""

    def get(self, key, default=None):
        return None


async def _run_one_notifier_tick(monkeypatch, runner):
    real_sleep = asyncio.sleep

    async def fake_sleep(delay):
        if delay == 5:
            return None
        runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    await runner._kanban_notifier_watcher(interval=1)


async def _run_one_dispatcher_tick(monkeypatch, runner):
    real_sleep = asyncio.sleep

    async def fake_sleep(delay):
        if delay == 5:
            return None
        runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    await runner._kanban_dispatcher_watcher()


def _make_runner(adapter):
    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    runner.adapters = {Platform.TELEGRAM: adapter}
    runner._kanban_sub_fail_counts = {}
    return runner


def _create_completed_subscription(summary="done once"):
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="notify once", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid, platform="telegram", chat_id="chat-1")
        kb.complete_task(conn, tid, summary=summary)
        return tid
    finally:
        conn.close()


def _create_loop_root_and_child(conn, *, session_id=None):
    root = kb.create_task(
        conn,
        title="loop root",
        assignee="orchestrator",
        session_id=session_id,
    )
    child = kb.create_task(
        conn,
        title="loop child",
        assignee="worker",
        created_by=f"loop:{root}",
    )
    return root, child


def _unseen_terminal_events(tid):
    conn = kb.connect()
    try:
        _, events = kb.unseen_events_for_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-1",
            kinds=["completed", "blocked", "gave_up", "crashed", "timed_out"],
        )
        return events
    finally:
        conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("subscription_count", [0, 100, 1000])
async def test_idle_notifier_uses_one_closed_db_open_for_full_scan(
    monkeypatch,
    kanban_home,
    subscription_count,
):
    """Idle polls reuse metadata, never a live SQLite connection."""
    conn = kb.connect()
    try:
        rows = [
            (
                f"t_idle_{index}",
                f"idle {index}",
                "worker",
                "todo",
                1,
            )
            for index in range(subscription_count)
        ]
        with kb.write_txn(conn):
            conn.executemany(
                """
                INSERT INTO tasks
                    (id, title, assignee, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.executemany(
                """
                INSERT INTO kanban_notify_subs
                    (task_id, platform, chat_id, created_at)
                VALUES (?, 'telegram', 'chat-idle', 1)
                """,
                [(row[0],) for row in rows],
            )
    finally:
        conn.close()

    calls = {
        "connect": 0,
        "list_task_subs": 0,
        "list_workflow_subs": 0,
        "claim_task_sub": 0,
    }
    opened_connections = []
    real_connect = kb.connect
    real_list_task_subs = kb.list_notify_subs
    real_list_workflow_subs = kb.list_workflow_notify_subs
    real_claim_task_sub = kb.claim_unseen_events_for_sub

    class _TrackedConnection:
        def __init__(self, inner):
            self.inner = inner
            self.closed = False

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def close(self):
            self.closed = True
            self.inner.close()

    def _connect(*args, **kwargs):
        calls["connect"] += 1
        opened = _TrackedConnection(real_connect(*args, **kwargs))
        opened_connections.append(opened)
        return opened

    def _list_task_subs(*args, **kwargs):
        calls["list_task_subs"] += 1
        return real_list_task_subs(*args, **kwargs)

    def _list_workflow_subs(*args, **kwargs):
        calls["list_workflow_subs"] += 1
        return real_list_workflow_subs(*args, **kwargs)

    def _claim_task_sub(*args, **kwargs):
        calls["claim_task_sub"] += 1
        return real_claim_task_sub(*args, **kwargs)

    monkeypatch.setattr(kb, "connect", _connect)
    monkeypatch.setattr(kb, "list_notify_subs", _list_task_subs)
    monkeypatch.setattr(
        kb,
        "list_workflow_notify_subs",
        _list_workflow_subs,
    )
    monkeypatch.setattr(
        kb,
        "claim_unseen_events_for_sub",
        _claim_task_sub,
    )

    runner = _make_runner(RecordingAdapter())
    runner._kanban_notifier_profile = "default"
    runner._kanban_notifier_full_scan_seconds = 3600
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps == 1:
                assert opened_connections
                assert opened_connections[0].closed is True
            if interval_sleeps >= 12:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    await asyncio.wait_for(
        runner._kanban_notifier_watcher(interval=1),
        timeout=20,
    )

    assert interval_sleeps == 12
    assert calls == {
        "connect": 1,
        # The one full pass reads legacy rows for cutover, then task rows.
        "list_task_subs": 2,
        "list_workflow_subs": 1,
        "claim_task_sub": subscription_count,
    }
    assert len(opened_connections) == 1
    assert opened_connections[0].closed is True


@pytest.mark.asyncio
async def test_notifier_periodic_fallback_rescans_unchanged_board(
    monkeypatch,
    kanban_home,
):
    """The unchanged fast path still yields to bounded recovery scans."""
    calls = 0
    real_list = kb.list_workflow_notify_subs

    def _list(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real_list(*args, **kwargs)

    monkeypatch.setattr(kb, "list_workflow_notify_subs", _list)
    runner = _make_runner(RecordingAdapter())
    runner._kanban_notifier_profile = "default"
    runner._kanban_notifier_full_scan_seconds = 0
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps >= 2:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    await asyncio.wait_for(
        runner._kanban_notifier_watcher(interval=1),
        timeout=10,
    )

    assert calls == 2


@pytest.mark.asyncio
async def test_notifier_fingerprint_delivers_external_event_next_tick(
    monkeypatch,
    kanban_home,
):
    """A commit from another connection bypasses the unchanged fast path."""
    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="complete between ticks",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
        )
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._kanban_notifier_profile = "default"
    runner._kanban_notifier_full_scan_seconds = 3600
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps == 1:
                external = kb.connect()
                try:
                    assert kb.complete_task(
                        external,
                        task_id,
                        summary="committed between ticks",
                    )
                finally:
                    external.close()
            elif interval_sleeps >= 2:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    await asyncio.wait_for(
        runner._kanban_notifier_watcher(interval=1),
        timeout=10,
    )

    assert interval_sleeps == 2
    assert len(adapter.sent) == 1
    assert "committed between ticks" in adapter.sent[0]["text"]


@pytest.mark.asyncio
async def test_notifier_commit_after_scan_before_cache_store_forces_rescan(
    monkeypatch,
    kanban_home,
):
    """The cache stores the pre-scan fingerprint, preserving a late commit."""
    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="complete at scan boundary",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
        )
    finally:
        conn.close()

    real_connect = kb.connect
    real_list_workflow_subs = kb.list_workflow_notify_subs
    scan_count = 0
    commit_injected = False

    class _CommitOnCloseConnection:
        def __init__(self, inner):
            self.inner = inner

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def close(self):
            nonlocal commit_injected
            if not commit_injected:
                commit_injected = True
                external = real_connect()
                try:
                    assert kb.complete_task(
                        external,
                        task_id,
                        summary="committed after collection",
                    )
                finally:
                    external.close()
            self.inner.close()

    def _connect(*args, **kwargs):
        return _CommitOnCloseConnection(real_connect(*args, **kwargs))

    def _list_workflow_subs(*args, **kwargs):
        nonlocal scan_count
        scan_count += 1
        return real_list_workflow_subs(*args, **kwargs)

    monkeypatch.setattr(kb, "connect", _connect)
    monkeypatch.setattr(kb, "list_workflow_notify_subs", _list_workflow_subs)

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._kanban_notifier_profile = "default"
    runner._kanban_notifier_full_scan_seconds = 3600
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps >= 2:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    await asyncio.wait_for(
        runner._kanban_notifier_watcher(interval=1),
        timeout=10,
    )

    assert commit_injected is True
    assert interval_sleeps == 2
    assert scan_count == 2
    assert len(adapter.sent) == 1
    assert "committed after collection" in adapter.sent[0]["text"]


@pytest.mark.asyncio
async def test_notifier_scan_exception_closes_connection(
    monkeypatch,
    kanban_home,
):
    """A failed scan must release its per-tick SQLite connection."""
    real_connect = kb.connect
    opened_connections = []

    class _TrackedConnection:
        def __init__(self, inner):
            self.inner = inner
            self.closed = False

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def close(self):
            self.closed = True
            self.inner.close()

    def _connect(*args, **kwargs):
        opened = _TrackedConnection(real_connect(*args, **kwargs))
        opened_connections.append(opened)
        return opened

    def _raise_scan_error(*args, **kwargs):
        raise RuntimeError("forced notifier scan failure")

    monkeypatch.setattr(kb, "connect", _connect)
    monkeypatch.setattr(
        kb,
        "list_workflow_notify_subs",
        _raise_scan_error,
    )

    runner = _make_runner(RecordingAdapter())
    runner._kanban_notifier_profile = "default"
    await _run_one_notifier_tick(monkeypatch, runner)

    assert len(opened_connections) == 1
    assert opened_connections[0].closed is True


@pytest.mark.asyncio
async def test_notifier_claim_expiry_forces_retry_without_data_change(
    monkeypatch,
    kanban_home,
):
    """An unchanged DB is rescanned exactly when an orphaned lease expires."""
    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="orphaned notification lease",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
        )
        assert kb.complete_task(conn, task_id, summary="recover me")
        event_id = int(
            conn.execute(
                "SELECT MAX(id) FROM task_events WHERE task_id = ?",
                (task_id,),
            ).fetchone()[0]
        )
        with kb.write_txn(conn):
            conn.execute(
                """
                UPDATE kanban_notify_subs
                   SET pending_claim_token = 'orphaned',
                       pending_event_id = ?,
                       pending_expires_at = 1001
                 WHERE task_id = ?
                """,
                (event_id, task_id),
            )
    finally:
        conn.close()

    clock = [1000]
    monkeypatch.setattr(
        "gateway.kanban_watchers.time.time",
        lambda: clock[0],
    )
    claim_calls = 0
    real_claim = kb.claim_unseen_events_for_sub

    def _claim(*args, **kwargs):
        nonlocal claim_calls
        claim_calls += 1
        return real_claim(*args, **kwargs)

    monkeypatch.setattr(kb, "claim_unseen_events_for_sub", _claim)

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._kanban_notifier_profile = "default"
    runner._kanban_notifier_full_scan_seconds = 3600
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps == 1:
                clock[0] = 1001
            elif interval_sleeps >= 2:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    await asyncio.wait_for(
        runner._kanban_notifier_watcher(interval=1),
        timeout=10,
    )

    assert claim_calls == 2
    assert len(adapter.sent) == 1
    assert "recover me" in adapter.sent[0]["text"]


@pytest.mark.asyncio
async def test_dispatcher_enumerates_once_and_reuses_health_connection(
    monkeypatch,
    kanban_home,
    tmp_path,
    caplog,
):
    """Six stuck ticks use one board snapshot each and retain the warning."""
    import hermes_cli.config as config

    board_rows = [{"slug": f"board-{index}"} for index in range(3)]
    for board in board_rows:
        (tmp_path / f"{board['slug']}.db").touch()

    calls = {
        "list_boards": 0,
        "connect": 0,
        "dispatch": 0,
        "ready": 0,
        "review": 0,
        "close": 0,
    }

    class _Connection:
        def __init__(self, slug):
            self.slug = slug

        def close(self):
            calls["close"] += 1

    def _list_boards(*, include_archived=False):
        assert include_archived is False
        calls["list_boards"] += 1
        return board_rows

    def _connect(*, board):
        calls["connect"] += 1
        return _Connection(board)

    def _dispatch(conn, **_kwargs):
        calls["dispatch"] += 1
        return SimpleNamespace(spawned=[])

    def _ready(conn):
        calls["ready"] += 1
        return conn.slug == "board-0"

    def _review(_conn):
        calls["review"] += 1
        return False

    monkeypatch.setattr(
        config,
        "load_config",
        lambda: {
            "kanban": {
                "dispatch_in_gateway": True,
                "dispatch_interval_seconds": 1,
                "auto_decompose": False,
            }
        },
    )
    monkeypatch.setattr(kb, "list_boards", _list_boards)
    monkeypatch.setattr(kb, "connect", _connect)
    monkeypatch.setattr(kb, "dispatch_once", _dispatch)
    monkeypatch.setattr(kb, "has_spawnable_ready", _ready)
    monkeypatch.setattr(kb, "has_spawnable_review", _review)
    monkeypatch.setattr(kb, "reap_worker_zombies", lambda: [])
    monkeypatch.setattr(
        kb,
        "kanban_db_path",
        lambda board=None: tmp_path / f"{board}.db",
    )

    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def _sleep(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps >= 6:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    with caplog.at_level(logging.WARNING, logger="gateway.run"):
        await asyncio.wait_for(
            runner._kanban_dispatcher_watcher(),
            timeout=10,
        )

    assert interval_sleeps == 6
    assert calls == {
        "list_boards": 6,
        "connect": 18,
        "dispatch": 18,
        "ready": 18,
        # board-0 short-circuits after ready; the other two probe review.
        "review": 12,
        "close": 18,
    }
    warnings = [
        record.getMessage()
        for record in caplog.records
        if "kanban dispatcher stuck" in record.getMessage()
    ]
    assert len(warnings) == 1


@pytest.mark.asyncio
async def test_dispatcher_recovers_one_suppressed_inline_foreground_push(
    monkeypatch,
    kanban_home,
):
    """A missed foreground nudge is recovered once by the next board scan."""
    from agent import auxiliary_client
    import hermes_cli.config as config
    from hermes_cli import kanban_progress, profiles
    from tools import kanban_tools

    board = "recovery"
    kb.create_board(board)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.setattr(
        kanban_tools,
        "get_current_workflow_id",
        lambda _default="": "",
    )

    inline_calls = []

    def suppress_inline_push(
        specification_task_ids,
        *,
        ready_task_ids=None,
        board=None,
        conn=None,
        author=None,
    ):
        inline_calls.append(
            (
                list(specification_task_ids),
                list(ready_task_ids or ()),
                board,
                author,
            )
        )
        return {
            "specification_task_ids": list(specification_task_ids),
            "decomposition": [],
            "candidate_task_ids": [],
            "dispatch": {"spawned": []},
            "warnings": ["inline push suppressed by test"],
        }

    with monkeypatch.context() as inline_patch:
        inline_patch.setattr(
            kanban_progress,
            "decompose_and_dispatch",
            suppress_inline_push,
        )
        created = json.loads(
            kanban_tools._handle_create(
                {
                    "title": "Recover this vague foreground task",
                    "board": board,
                    "idempotency_key": "suppressed-inline-recovery",
                }
            )
        )

    assert created["ok"] is True
    task_id = created["task_id"]
    assert inline_calls == [
        ([task_id], [], board, "foreground-auto-decomposer")
    ]
    assert created["status"] == "triage"
    assert created["dispatch"]["spawned"] == []

    model_calls = []
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=json.dumps(
                        {
                            "fanout": False,
                            "rationale": "one worker-ready unit",
                            "title": "Recovered foreground task",
                            "body": "Implement and verify the recovered task.",
                            "assignee": "engineer",
                        }
                    )
                ),
                finish_reason="stop",
            )
        ]
    )

    def call_llm(*args, **kwargs):
        assert os.environ.get("HERMES_KANBAN_BOARD") is None
        assert kb.get_current_board() == board
        model_calls.append((args, kwargs))
        return response

    profile = SimpleNamespace(
        name="engineer",
        is_default=True,
        description="implementation",
        description_auto=False,
        model="test",
        provider="test",
        skill_count=0,
    )
    spawned = []

    def spawn(task, _workspace, board=None):
        spawned.append((task.id, board))
        return os.getpid()

    monkeypatch.setattr(auxiliary_client, "call_llm", call_llm)
    monkeypatch.setattr(profiles, "list_profiles", lambda: [profile])
    monkeypatch.setattr(profiles, "profile_exists", lambda _name: True)
    monkeypatch.setattr(
        profiles,
        "get_active_profile_name",
        lambda: "engineer",
    )
    monkeypatch.setattr(kb, "_default_spawn", spawn)
    monkeypatch.setattr(kb, "reap_worker_zombies", lambda: [])
    monkeypatch.setattr(
        config,
        "load_config",
        lambda: {
            "kanban": {
                "dispatch_in_gateway": True,
                "dispatch_interval_seconds": 1,
                "auto_decompose": True,
                "auto_decompose_per_tick": 3,
            }
        },
    )

    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    interval_sleeps = 0
    real_sleep = asyncio.sleep

    async def run_without_real_interval(delay):
        nonlocal interval_sleeps
        if delay != 5:
            interval_sleeps += 1
            if interval_sleeps >= 2:
                runner._running = False
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", run_without_real_interval)
    await asyncio.wait_for(
        runner._kanban_dispatcher_watcher(),
        timeout=10,
    )

    with kb.connect(board=board) as conn:
        tasks = kb.list_tasks(conn, limit=100)
        recovered = kb.get_task(conn, task_id)
        run_count = conn.execute(
            "SELECT COUNT(*) FROM task_runs WHERE task_id = ?",
            (task_id,),
        ).fetchone()[0]

    assert interval_sleeps == 2
    assert len(model_calls) == 1
    assert spawned == [(task_id, board)]
    assert [task.id for task in tasks] == [task_id]
    assert run_count == 1
    assert recovered is not None
    assert recovered.status == "running"
    assert recovered.needs_specification is False


def test_gateway_dispatcher_does_not_start_removed_loop_handoff_review_batch(tmp_path, monkeypatch):
    db_path = tmp_path / "dispatcher-loop-review.db"
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    with kb.connect() as conn:
        task_id = kb.create_task(
            conn,
            title="loop worker",
            assignee="worker",
            created_by="loop:t_looproot",
            tenant="tenant-a",
        )
        with kb.write_txn(conn):
            kb._append_event(
                conn,
                task_id,
                "loop_node_state",
                {"root_task_id": "t_looproot", "client_id": "worker", "active": True, "frontier": True},
            )
        assert kb.claim_task(conn, task_id, claimer="worker:1") is not None
        assert kb.complete_task(conn, task_id, summary="ready for review", metadata={"tests_run": ["pytest -q"]})

    runner = _make_runner(RecordingAdapter())
    asyncio.run(_run_one_dispatcher_tick(monkeypatch, runner))

    with kb.connect() as conn:
        events = [event for event in kb.list_events(conn, task_id) if event.kind == "loop_handoff_review_session"]

    assert events == []


def test_kanban_notifier_dedupes_board_slugs_pointing_to_same_db(tmp_path, monkeypatch):
    db_path = tmp_path / "shared-kanban.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    kb.write_board_metadata("alias-a", name="Alias A")
    kb.write_board_metadata("alias-b", name="Alias B")

    tid = _create_completed_subscription()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    assert "Kanban" in adapter.sent[0]["text"]
    assert tid in adapter.sent[0]["text"]


def test_direct_notifier_soft_send_failure_retries_without_advancing_cursors(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "direct-soft-send-failure.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    task_id = _create_completed_subscription(summary="retry this result")

    failed_adapter = RecordingAdapter(
        send_results=[
            SendResult(success=False, error="synthetic route rejection")
        ]
    )
    asyncio.run(
        _run_one_notifier_tick(
            monkeypatch,
            _make_runner(failed_adapter),
        )
    )

    assert len(failed_adapter.sent) == 1
    assert failed_adapter.wakes == []
    with kb.connect() as conn:
        sub = kb.list_notify_subs(conn, task_id)[0]
        assert sub["last_event_id"] == 0
        assert sub["last_notified_event_id"] == 0
        assert sub["pending_claim_token"] is None
    assert [event.kind for event in _unseen_terminal_events(task_id)] == [
        "completed"
    ]

    success_adapter = RecordingAdapter(
        send_results=[SendResult(success=True, message_id="retry-ok")]
    )
    asyncio.run(
        _run_one_notifier_tick(
            monkeypatch,
            _make_runner(success_adapter),
        )
    )

    assert len(success_adapter.sent) == 1
    assert len(success_adapter.wakes) == 1
    with kb.connect() as conn:
        assert kb.list_notify_subs(conn, task_id) == []


def test_loop_blocked_task_reenters_origin_subscription(tmp_path, monkeypatch):
    db_path = tmp_path / "loop-blocked-reentry.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root = kb.create_task(conn, title="loop root", assignee="orchestrator", tenant="tenant-a")
        tid = kb.create_task(
            conn,
            title="loop worker",
            assignee="worker",
            created_by=f"loop:{root}",
            tenant="tenant-a",
        )
        kb.add_notify_sub(conn, task_id=tid, platform="telegram", chat_id="chat-1")
        assert kb.claim_task(conn, tid, claimer="worker:1") is not None
        assert kb.block_task(conn, tid, reason="missing production credentials")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    text = adapter.sent[0]["text"]
    assert "blocked" in text.lower()
    assert tid in text
    assert "missing production credentials" in text


def test_kanban_notifier_delivers_descendant_block_once_to_tree_subscription(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "loop-descendant-block.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{root}", root),
            )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            thread_id="thread-1",
            notifier_profile="elephant",
            scope="descendants",
        )
        assert kb.block_task(conn, child, reason="needs-user: pick option A or B")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._kanban_notifier_profile = "elephant"
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert adapter.sent == [
        {
            "chat_id": "chat-1",
            "text": f"⏸ @worker Kanban {child} blocked: needs-user: pick option A or B",
            "metadata": {"thread_id": "thread-1"},
        }
    ]

    conn = kb.connect()
    try:
        subs = kb.list_notify_subs(conn, root)
    finally:
        conn.close()
    assert len(subs) == 1
    assert int(subs[0]["last_event_id"]) > 0


def test_kanban_notifier_delivers_descendant_completion_to_tree_subscription(tmp_path, monkeypatch):
    db_path = tmp_path / "loop-routine-child-complete.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{root}", root),
            )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb.complete_task(conn, child, summary="routine child done")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    assert f"Kanban {child} done" in adapter.sent[0]["text"]
    assert "routine child done" in adapter.sent[0]["text"]
    conn = kb.connect()
    try:
        subs = kb.list_notify_subs(conn, root)
    finally:
        conn.close()
    assert len(subs) == 1
    assert int(subs[0]["last_event_id"]) > 0


def test_descendant_subscription_survives_root_completion_for_dynamic_followup(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "loop-root-lifetime.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{root}", root),
            )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb.complete_task(conn, root, summary="initial root result")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    conn = kb.connect()
    try:
        assert len(kb.list_notify_subs(conn, root)) == 1
        assert kb.complete_task(conn, child, summary="dynamic follow-up done")
        mirrors = [
            event
            for event in kb.list_events(conn, root)
            if event.kind == "loop_descendant_completed"
        ]
        assert len(mirrors) == 1
    finally:
        conn.close()

    runner._running = True
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))
    assert len(adapter.wakes) == 2
    assert child in adapter.wakes[-1].text


def test_ordinary_descendant_subscription_cleans_up_after_completion(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "ordinary-descendant-cleanup.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="ordinary task",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb.complete_task(conn, task_id, summary="ordinary done")
    finally:
        conn.close()

    runner = _make_runner(RecordingAdapter())
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    conn = kb.connect()
    try:
        assert kb.list_notify_subs(conn, task_id) == []
    finally:
        conn.close()


def test_gateway_repairs_terminal_subscription_left_after_ack_crash(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "terminal-ack-crash-repair.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        task_id = kb.create_task(
            conn,
            title="already delivered ordinary task",
            assignee="worker",
        )
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb.complete_task(conn, task_id, summary="already delivered")
        _old, cursor, events, token = kb.claim_unseen_events_for_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
            kinds=("completed",),
        )
        assert [event.kind for event in events] == ["completed"]
        assert kb.complete_notify_claim(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-1",
            claimed_cursor=cursor,
            claim_token=token,
        )
        # Model a notifier process dying after ACK and before unsubscribe.
        assert len(kb.list_notify_subs(conn, task_id)) == 1
    finally:
        conn.close()

    adapter = RecordingAdapter()
    asyncio.run(_run_one_notifier_tick(monkeypatch, _make_runner(adapter)))

    assert adapter.sent == []
    assert adapter.wakes == []
    conn = kb.connect()
    try:
        assert kb.list_notify_subs(conn, task_id) == []
    finally:
        conn.close()


def test_archived_loop_root_descendant_subscription_cleans_up(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "archived-loop-root-cleanup.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, _child = _create_loop_root_and_child(conn)
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET created_by = ? WHERE id = ?",
                (f"loop:{root}", root),
            )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb.archive_task(conn, root)
    finally:
        conn.close()

    runner = _make_runner(RecordingAdapter())
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    conn = kb.connect()
    try:
        assert kb.list_notify_subs(conn, root) == []
    finally:
        conn.close()


def test_direct_root_boundary_delivers_recent_comments(tmp_path, monkeypatch):
    db_path = tmp_path / "loop-direct-root-comments.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root = kb.create_task(
            conn,
            title="single item loop",
            assignee="worker",
            created_by="loop_delegation:foreground",
        )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        kb.add_comment(
            conn,
            root,
            author="worker",
            body="Please review the parser edge case before creating work.",
        )
        assert kb.complete_task(conn, root, summary="single item complete")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    asyncio.run(_run_one_notifier_tick(monkeypatch, _make_runner(adapter)))

    assert len(adapter.wakes) == 1
    assert "Please review the parser edge case before creating work." in (
        adapter.wakes[0].text
    )
    with kb.connect() as conn:
        assert len(kb.list_notify_subs(conn, root)) == 1


def test_kanban_notifier_batches_two_child_boundaries_into_one_foreground_wake(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "loop-descendant-batch.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, completed_child = _create_loop_root_and_child(
            conn,
            session_id="foreground-session",
        )
        blocked_child = kb.create_task(
            conn,
            title="review the implementation",
            assignee="reviewer",
            created_by=f"loop:{root}",
        )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            thread_id="thread-1",
            scope="descendants",
        )
        kb.add_comment(
            conn,
            completed_child,
            author="worker",
            body="Please create a focused review task for the parser.",
        )
        kb.add_comment(
            conn,
            blocked_child,
            author="reviewer",
            body="Need the foreground to choose the compatibility target.",
        )
        assert kb.complete_task(
            conn,
            completed_child,
            summary="parser implementation is ready",
        )
        assert kb.block_task(
            conn,
            blocked_child,
            reason="compatibility target is unresolved",
        )
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 2
    sent_text = "\n".join(delivery["text"] for delivery in adapter.sent)
    assert completed_child in sent_text
    assert blocked_child in sent_text
    assert len(adapter.wakes) == 1
    wake = adapter.wakes[0]
    assert wake.internal is True
    assert wake.source.chat_id == "chat-1"
    assert wake.source.thread_id == "thread-1"
    assert "2 descendant task boundary event(s)" in wake.text
    assert completed_child in wake.text
    assert blocked_child in wake.text
    assert "Please create a focused review task for the parser." in wake.text
    assert "Need the foreground to choose the compatibility target." in wake.text
    assert "kanban_create" in wake.text


@pytest.mark.parametrize(
    ("chat_type", "thread_id"),
    [
        ("dm", None),
        ("group", None),
        ("thread", "thread-1"),
    ],
)
def test_kanban_notifier_preserves_subscription_chat_type_on_foreground_wake(
    chat_type,
    thread_id,
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / f"loop-descendant-{chat_type}-route.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(
            conn,
            session_id="foreground-session",
        )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id=f"{chat_type}-chat",
            chat_type=chat_type,
            thread_id=thread_id,
            scope="descendants",
        )
        persisted = kb.list_notify_subs(conn, root)
        assert len(persisted) == 1
        assert persisted[0]["chat_type"] == chat_type
        assert kb.complete_task(conn, child, summary="route me exactly")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.wakes) == 1
    source = adapter.wakes[0].source
    assert source.chat_id == f"{chat_type}-chat"
    assert source.chat_type == chat_type
    assert source.thread_id == thread_id


def test_kanban_notifier_rewinds_descendant_claim_when_foreground_wake_fails(
    tmp_path,
    monkeypatch,
):
    """A delivered text must not permanently consume a failed control wake."""

    db_path = tmp_path / "loop-descendant-wake-retry.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(
            conn,
            session_id="foreground-session",
        )
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        kb.add_comment(
            conn,
            child,
            author="worker",
            body="Create the review only after you inspect my result.",
        )
        assert kb.complete_task(conn, child, summary="ready for foreground")
    finally:
        conn.close()

    class _WakeFailsOnceAdapter(RecordingAdapter):
        def __init__(self):
            super().__init__()
            self.wake_attempts = 0

        async def handle_message(self, event):
            self.wake_attempts += 1
            if self.wake_attempts == 1:
                raise RuntimeError("foreground session temporarily unavailable")
            await super().handle_message(event)

    adapter = _WakeFailsOnceAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    conn = kb.connect()
    try:
        cursor, retry_events = kb.unseen_events_for_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            kinds=("loop_descendant_completed",),
        )
    finally:
        conn.close()
    assert [event.kind for event in retry_events] == [
        "loop_descendant_completed"
    ]
    assert cursor > 0

    runner._running = True
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert adapter.wake_attempts == 2
    assert len(adapter.wakes) == 1
    assert child in adapter.wakes[0].text
    assert "Create the review only after you inspect my result." in adapter.wakes[0].text


def test_kanban_notifier_routes_descendant_events_to_owning_profile(tmp_path, monkeypatch):
    db_path = tmp_path / "loop-descendant-profile-owner.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(conn)
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            notifier_profile="elephant",
            scope="descendants",
        )
        assert kb.block_task(conn, child, reason="product-decision: choose")
    finally:
        conn.close()

    wrong_adapter = RecordingAdapter()
    wrong_runner = _make_runner(wrong_adapter)
    wrong_runner._kanban_notifier_profile = "peacock"
    asyncio.run(_run_one_notifier_tick(monkeypatch, wrong_runner))

    assert wrong_adapter.sent == []
    conn = kb.connect()
    try:
        assert int(kb.list_notify_subs(conn, root)[0]["last_event_id"]) == 0
    finally:
        conn.close()

    owner_adapter = RecordingAdapter()
    owner_runner = _make_runner(owner_adapter)
    owner_runner._kanban_notifier_profile = "elephant"
    asyncio.run(_run_one_notifier_tick(monkeypatch, owner_runner))

    assert len(owner_adapter.sent) == 1
    assert owner_adapter.sent[0]["chat_id"] == "chat-1"
    assert f"Kanban {child} blocked" in owner_adapter.sent[0]["text"]
    assert "product-decision: choose" in owner_adapter.sent[0]["text"]


def test_kanban_notifier_delivers_descendant_gave_up_to_root_subscription(tmp_path, monkeypatch):
    db_path = tmp_path / "loop-descendant-gave-up.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        root, child = _create_loop_root_and_child(conn)
        kb.add_notify_sub(
            conn,
            task_id=root,
            platform="telegram",
            chat_id="chat-1",
            scope="descendants",
        )
        assert kb._record_task_failure(
            conn,
            child,
            "spawn failed repeatedly",
            outcome="spawn_failed",
            failure_limit=1,
        ) is True
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    text = adapter.sent[0]["text"]
    assert f"Kanban {child} gave up" in text
    assert "after repeated spawn_failed failures" in text
    assert "spawn failed repeatedly" in text


def test_kanban_notifier_claim_prevents_second_watcher_send(tmp_path, monkeypatch):
    db_path = tmp_path / "single-owner.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    tid = _create_completed_subscription()

    adapter1 = RecordingAdapter()
    adapter2 = RecordingAdapter()

    asyncio.run(_run_one_notifier_tick(monkeypatch, _make_runner(adapter1)))
    asyncio.run(_run_one_notifier_tick(monkeypatch, _make_runner(adapter2)))

    assert len(adapter1.sent) == 1
    assert adapter2.sent == []


def test_kanban_notifier_rewinds_claim_if_adapter_disconnects(tmp_path, monkeypatch):
    db_path = tmp_path / "adapter-disconnect.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    tid = _create_completed_subscription()

    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    runner.adapters = DisconnectedAdapters({Platform.TELEGRAM: RecordingAdapter()})
    runner._kanban_sub_fail_counts = {}

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert [ev.kind for ev in _unseen_terminal_events(tid)] == ["completed"]


def test_kanban_db_path_is_test_isolated_from_real_home():
    hermes_home = Path(kb.kanban_home())
    production_db = Path.home() / ".hermes" / "kanban.db"
    assert kb.kanban_db_path().resolve() != production_db.resolve()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="x", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid, platform="telegram", chat_id="chat-1")
    finally:
        conn.close()

    assert kb.kanban_db_path().resolve().is_relative_to(hermes_home.resolve())
    assert kb.kanban_db_path().resolve() != production_db.resolve()


class FailingAdapter:
    """Adapter whose send() always raises, simulating a transient send error."""

    def __init__(self):
        self.attempts = 0

    async def send(self, chat_id, text, metadata=None):
        self.attempts += 1
        raise RuntimeError("simulated send failure")


def test_kanban_notifier_rewinds_claim_on_send_exception(tmp_path, monkeypatch):
    """A raising adapter rewinds the claim so the next tick can retry.

    This is the second rewind path (distinct from the adapter-disconnect path
    in test_kanban_notifier_rewinds_claim_if_adapter_disconnects). Here the
    adapter is connected and the send call actually fires; the claim must
    still rewind so the event isn't lost when send() raises mid-tick.
    """
    db_path = tmp_path / "send-failure.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    tid = _create_completed_subscription()

    adapter = FailingAdapter()
    runner = _make_runner(adapter)

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    # Send was attempted (so we exercised the failure path, not just the
    # disconnect path) and the claim was rewound — the unseen-events query
    # still returns the event for retry on the next tick.
    assert adapter.attempts >= 1, "send should have been attempted at least once"
    assert [ev.kind for ev in _unseen_terminal_events(tid)] == ["completed"]


def test_gateway_partial_batch_checkpoints_visible_progress_and_failure_count(
    tmp_path,
    monkeypatch,
):
    db_path = tmp_path / "partial-visible-batch.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="partial batch", assignee="worker")
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-1",
        )
        kb._append_event(conn, tid, "crashed")
        kb._append_event(conn, tid, "timed_out", {"limit_seconds": 10})
    finally:
        conn.close()

    class _SecondEventFails(RecordingAdapter):
        def __init__(self):
            super().__init__()
            self.attempted = []

        async def send(self, chat_id, text, metadata=None):
            self.attempted.append(text)
            if "timed out" in text:
                raise RuntimeError("persistent second-event failure")
            await super().send(chat_id, text, metadata)

    adapter = _SecondEventFails()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))
    runner._running = True
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))
    runner._running = True
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert sum("crashed" in text for text in adapter.attempted) == 1
    assert sum("timed out" in text for text in adapter.attempted) == 3
    assert len(adapter.wakes) == 1
    assert "crashed" in adapter.wakes[0].text
    assert "timed out" in adapter.wakes[0].text
    key = (tid, "telegram", "chat-1", "")
    assert key not in runner._kanban_sub_fail_counts
    conn = kb.connect()
    try:
        assert kb.list_notify_subs(conn, tid) == []
    finally:
        conn.close()


def test_notifier_redelivers_same_kind_on_dispatch_cycle(tmp_path, monkeypatch):
    """A retry cycle (crashed → reclaimed → crashed) notifies the user twice.

    Before #21398 the notifier auto-unsubscribed on any terminal event kind
    (gave_up / crashed / timed_out), so the second crash in a respawn cycle
    silently dropped — the subscription was already gone. This test pins the
    new contract: subscription survives non-final terminal events; the
    cursor handles dedup.

    Two crashes ten seconds apart on the same task — both should land on
    the adapter.
    """
    db_path = tmp_path / "redeliver-cycle.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="cycle test", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid, platform="telegram", chat_id="chat-1")
        # First crash — fired by the dispatcher when the worker PID dies.
        kb._append_event(conn, tid, kind="crashed")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    # First crash delivered.
    assert len(adapter.sent) == 1
    assert "crashed" in adapter.sent[0]["text"].lower()

    # Subscription survives — the cursor advanced past event #1, but the
    # row is still there.
    conn = kb.connect()
    try:
        subs = kb.list_notify_subs(conn, tid)
        assert len(subs) == 1, (
            "Subscription must survive a crashed event so a respawn-cycle "
            "second crash also notifies the user (issue #21398)."
        )

        # Second crash — same task, same dispatcher (or a respawn). Append
        # another event to simulate the dispatcher firing crashed a second
        # time during retry.
        kb._append_event(conn, tid, kind="crashed")
    finally:
        conn.close()

    # New tick: the second event has a fresh id past the cursor advance,
    # so it gets claimed and delivered.
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 2, (
        f"Second crashed event should also notify; got {len(adapter.sent)} "
        f"deliveries (texts: {[d['text'] for d in adapter.sent]})"
    )
    assert "crashed" in adapter.sent[1]["text"].lower()


def test_notifier_owning_profile_adapter_no_default_fallback(tmp_path, monkeypatch):
    """A subscription owned by a secondary profile whose profile-adapter
    registry entry EXISTS but lacks this platform must NOT fall back to the
    default profile's same-platform adapter — the notifier must route through
    the shared ``_authorization_adapter`` chokepoint, which forbids that
    fallback (gateway/authz_mixin.py). Delivering via the default profile's bot
    is the exact cross-profile mis-delivery this whole change exists to fix
    (`[230002] Bot can NOT be out of the chat`).

    Mutation check: reverting kanban_watchers.py's adapter selection to the old
    inline ``if adapter is None: adapter = self.adapters.get(plat)`` fallback
    makes this test FAIL (the default adapter receives the delivery).
    """
    db_path = tmp_path / "profile-no-fallback.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="owned by beta", assignee="worker")
        # Subscription is owned by profile "beta".
        kb.add_notify_sub(
            conn, task_id=tid, platform="telegram", chat_id="chat-beta",
            notifier_profile="beta",
        )
        kb.complete_task(conn, tid, summary="done")
    finally:
        conn.close()

    default_adapter = RecordingAdapter()
    other_adapter = RecordingAdapter()
    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    # Default profile has a telegram adapter …
    runner.adapters = {Platform.TELEGRAM: default_adapter}
    # … and profile "beta" HAS a non-empty registry entry (so it passes the
    # notifier's upstream skip-filter, which only skips owning profiles with NO
    # adapter at all), but that entry does NOT contain a telegram adapter — beta
    # connected a different platform (discord). The telegram sub owned by beta
    # must therefore resolve to NO adapter, not silently borrow the default
    # profile's telegram bot.
    runner._profile_adapters = {"beta": {Platform.DISCORD: other_adapter}}
    runner._kanban_sub_fail_counts = {}

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    # The default profile's adapter must never receive beta's notification.
    assert default_adapter.sent == [], (
        "Owning-profile subscription must not fall back to the default "
        f"profile's adapter; got {default_adapter.sent!r}"
    )
    assert other_adapter.sent == [], (
        f"beta's discord adapter must not receive a telegram sub; got {other_adapter.sent!r}"
    )
    # The claim is rewound (adapter resolved to None → treated as disconnected),
    # so the event is still unseen and will deliver once beta's adapter connects.
    assert [ev.kind for ev in _unseen_terminal_events_for(tid, "chat-beta")] == ["completed"]


def _unseen_terminal_events_for(tid, chat_id):
    conn = kb.connect()
    try:
        _, events = kb.unseen_events_for_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id=chat_id,
            kinds=["completed", "blocked", "gave_up", "crashed", "timed_out"],
        )
        return events
    finally:
        conn.close()
