import asyncio
import json
import logging
import os
import sqlite3
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
        self.handled = []

    async def send(self, chat_id, text, metadata=None):
        self.sent.append({"chat_id": chat_id, "text": text, "metadata": metadata or {}})
        if self.send_results:
            return self.send_results.pop(0)
        return None

    async def handle_message(self, event):
        self.wakes.append(event)
        self.handled.append(event)


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
@pytest.mark.parametrize("subscription_count", [100, 1000])
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
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="periodic scan", assignee="worker")
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-periodic",
        )
    finally:
        conn.close()

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
    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="scan failure", assignee="worker")
        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform="telegram",
            chat_id="chat-failure",
        )
    finally:
        conn.close()

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
    with kb.connect() as conn:
        initial_sub = kb.list_notify_subs(conn, task_id)[0]
        initial_cursor = initial_sub["last_event_id"]
        initial_notified_cursor = initial_sub["last_notified_event_id"]

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
        assert sub["last_event_id"] == initial_cursor
        assert sub["last_notified_event_id"] == initial_notified_cursor
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
    assert "delegate_task" in wake.text
    assert "depends_on" in wake.text
    assert "blocks" in wake.text
    assert "kanban_unblock" in wake.text
    assert "kanban_create" not in wake.text


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
        initial_cursor = kb.list_notify_subs(conn, root)[0]["last_event_id"]
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
        assert (
            int(kb.list_notify_subs(conn, root)[0]["last_event_id"])
            == initial_cursor
        )
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


def test_kanban_notifier_replays_telegram_dm_topic_delivery_metadata(tmp_path, monkeypatch):
    db_path = tmp_path / "dm-topic-metadata.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(
            conn,
            title="dm topic task",
            assignee="worker",
            session_id="agent:main:telegram:dm:chat-1",
        )
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-1",
            thread_id="20197",
            delivery_metadata={
                "chat_type": "dm",
                "direct_messages_topic_id": "20197",
                "telegram_dm_topic_reply_fallback": True,
                "telegram_reply_to_message_id": "462",
                "thread_id": "20197",
            },
        )
        kb.complete_task(conn, tid, summary="done")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    assert adapter.sent[0]["metadata"] == {
        "chat_type": "dm",
        "direct_messages_topic_id": "20197",
        "telegram_dm_topic_reply_fallback": True,
        "telegram_reply_to_message_id": "462",
        "thread_id": "20197",
    }
    assert len(adapter.handled) == 1
    assert adapter.handled[0].source.chat_type == "dm"
    assert adapter.handled[0].source.thread_id == "20197"


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


def test_active_named_profile_subscription_is_delivered(tmp_path, monkeypatch):
    """A sub stamped with the gateway's own named profile uses self.adapters.

    Regression for #71340: on a standalone (non-multiplex) gateway running a
    named profile, _authorization_adapter() used to treat the active name as a
    multiplex secondary, find no _profile_adapters entry, fail closed, and
    rewind the claim forever — silent zero-delivery.
    """
    db_path = tmp_path / "actionable-block.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    reason = "AGE-39 — https://linear.example/AGE-39 — publishing verified."
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="approval", assignee="publisher")
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-1",
            notifier_profile="main",
        )
        kb.block_task(conn, tid, reason=reason, kind="needs_input")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._active_profile_name = lambda: "main"

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    message = adapter.sent[0]["text"]
    assert tid in message
    assert "blocked" in message


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

    # Upstream raised the notifier's give-up threshold from 3 to 12
    # (gateway/kanban_watchers.py MAX_SEND_FAILURES); tick until it trips.
    max_send_failures = 12
    adapter = _SecondEventFails()
    runner = _make_runner(adapter)
    for _ in range(max_send_failures):
        runner._running = True
        asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert sum("crashed" in text for text in adapter.attempted) == 1
    assert sum("timed out" in text for text in adapter.attempted) == max_send_failures
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
class ReportedFailureAdapter:
    """Adapter that REPORTS failure via SendResult(success=False) instead of
    raising — the exact contract the Telegram adapter uses for 'Not connected'
    and degraded-send paths."""

    def __init__(self):
        self.attempts = 0

    async def send(self, chat_id, text, metadata=None):
        self.attempts += 1
        from gateway.platforms.base import SendResult
        return SendResult(success=False, error="Not connected")


def test_kanban_notifier_rewinds_claim_on_reported_send_failure(tmp_path, monkeypatch):
    """A non-raising SendResult(success=False) must NOT advance the cursor.

    Regression for the silent-drop bug: the notifier used to discard send()'s
    return value, so a reported (not raised) failure — e.g. Telegram mid-
    reconnect after a gateway restart — fell through to the success branch,
    marked the event seen, and lost the notification forever. The event must
    remain unseen for retry, exactly like the raised-exception path.
    """
    db_path = tmp_path / "reported-failure.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()
    tid = _create_completed_subscription()

    adapter = ReportedFailureAdapter()
    runner = _make_runner(adapter)

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert adapter.attempts >= 1, "send should have been attempted"
    assert [ev.kind for ev in _unseen_terminal_events(tid)] == ["completed"], (
        "a reported send failure must rewind the claim, not silently drop the event"
    )


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


def test_notifier_delivers_subscription_owned_by_active_profile(tmp_path, monkeypatch):
    """A single-profile gateway stamps active profile but keeps adapters primary."""
    db_path = tmp_path / "active-profile-owner.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="owned by active profile", assignee="worker")
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-1",
            notifier_profile="dev",
        )
        kb.complete_task(conn, tid, summary="done")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)
    runner._active_profile_name = lambda: "dev"

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1
    assert tid in adapter.sent[0]["text"]


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


def test_notifier_claims_platform_only_a_secondary_profile_owns(tmp_path, monkeypatch):
    """A subscription owned by a secondary profile on a platform the DEFAULT
    profile never connected must still be claimed and delivered.

    Regression: the ``_collect()`` pre-filter built ``active_platforms``
    solely from ``self.adapters`` (the default profile). A sub owned by
    profile "beta" on "discord", where beta genuinely has a live discord
    adapter but the default profile has no discord adapter at all, was
    dropped by that pre-filter (``platform not in active_platforms``)
    before ``claim_unseen_events_for_sub`` ever ran — unlike the
    disconnected-adapter path, an unclaimed event is never rewound, so this
    was a permanent, silent notification loss, not a retryable one. This
    directly contradicts the feature's own purpose (routing notifications
    via the owning profile), and is the same cross-profile-adapter-lookup
    class the delivery-side chokepoint in
    ``test_notifier_owning_profile_adapter_no_default_fallback`` already
    guards — just one gate earlier.
    """
    db_path = tmp_path / "secondary-only-platform.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="owned by beta on discord", assignee="worker")
        kb.add_notify_sub(
            conn, task_id=tid, platform="discord", chat_id="chat-beta",
            notifier_profile="beta",
        )
        kb.complete_task(conn, tid, summary="done")
    finally:
        conn.close()

    beta_adapter = RecordingAdapter()
    runner = GatewayRunner.__new__(GatewayRunner)
    runner._running = True
    # Default profile has NO discord adapter at all.
    runner.adapters = {Platform.TELEGRAM: RecordingAdapter()}
    # Secondary profile "beta" has a live discord adapter.
    runner._profile_adapters = {"beta": {Platform.DISCORD: beta_adapter}}
    runner._kanban_sub_fail_counts = {}

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(beta_adapter.sent) == 1, (
        f"beta's discord adapter should have received the notification; got {beta_adapter.sent!r}"
    )


def test_notifier_wakeup_uses_subscription_chat_type(tmp_path, monkeypatch):
    db_path = tmp_path / "chat-type-wakeup.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(
            conn,
            title="dm requester",
            assignee="worker",
            session_id="origin-session",
        )
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-dm",
            chat_type="dm",
        )
        kb.complete_task(conn, tid, summary="done")
    finally:
        conn.close()

    adapter = RecordingAdapter()
    asyncio.run(_run_one_notifier_tick(monkeypatch, _make_runner(adapter)))

    assert len(adapter.sent) == 1
    assert len(adapter.handled) == 1
    assert adapter.handled[0].source.chat_type == "dm"

    # The wake must resume the creator's real DM session key — the whole bug
    # was that a hardcoded chat_type="group" made build_session_key() produce
    # a group-scoped key (a NEW session) instead of the ":dm:<chat_id>" shape
    # the original conversation runs under (#56580 / #68874).
    from gateway.session import build_session_key

    wake_key = build_session_key(adapter.handled[0].source)
    assert wake_key == "agent:main:telegram:dm:chat-dm"
    assert ":group:" not in wake_key


def test_auto_subscribe_persists_session_chat_type(tmp_path, monkeypatch):
    db_path = tmp_path / "auto-sub-chat-type.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import kanban_notify, kanban_tools

    # This fork's auto-subscribe body (and its config gate) lives in
    # tools/kanban_notify.py; kanban_tools._maybe_auto_subscribe delegates.
    monkeypatch.setattr(
        kanban_notify,
        "load_config",
        lambda: {"kanban": {"auto_subscribe_on_create": True}},
    )

    tokens = set_session_vars(
        platform="telegram",
        chat_id="chat-dm",
        chat_type="dm",
    )
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="auto sub", assignee="worker")

        assert kanban_tools._maybe_auto_subscribe(conn, tid) is True
        [sub] = kb.list_notify_subs(conn, task_id=tid)
        assert sub["chat_type"] == "dm"
    finally:
        conn.close()
        clear_session_vars(tokens)


def test_notify_sub_migration_adds_chat_type_to_legacy_table(tmp_path, monkeypatch):
    db_path = tmp_path / "legacy-notify-sub.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))

    legacy = sqlite3.connect(db_path)
    try:
        legacy.execute(
            """
            CREATE TABLE kanban_notify_subs (
                task_id       TEXT NOT NULL,
                platform      TEXT NOT NULL,
                chat_id       TEXT NOT NULL,
                thread_id     TEXT NOT NULL DEFAULT '',
                user_id       TEXT,
                notifier_profile TEXT,
                created_at    INTEGER NOT NULL,
                last_event_id INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (task_id, platform, chat_id, thread_id)
            )
            """
        )
        legacy.commit()
    finally:
        legacy.close()

    kb.init_db()
    conn = kb.connect()
    try:
        cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(kanban_notify_subs)")
        }
        assert "chat_type" in cols

        tid = kb.create_task(conn, title="legacy sub", assignee="worker")
        kb.add_notify_sub(
            conn,
            task_id=tid,
            platform="telegram",
            chat_id="chat-dm",
            chat_type="dm",
        )
        [sub] = kb.list_notify_subs(conn, task_id=tid)
        assert sub["chat_type"] == "dm"
    finally:
        conn.close()


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


def test_kanban_notifier_isolates_per_subscription_failure(tmp_path, monkeypatch):
    """One bad subscription must not block delivery for all others.

    Regression for #59269: when claim_unseen_events_for_sub raises for one
    subscription, the entire notifier tick used to abort — silently blocking
    delivery for every other subscription.
    """
    db_path = tmp_path / "isolation.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    # Create two tasks with subscriptions and complete both. The BAD task is
    # created first: list_notify_subs() has no ORDER BY, so SQLite's natural
    # scan returns insertion order — the failing subscription must be
    # processed BEFORE the good one or this test passes even without the
    # per-subscription isolation (the good delivery happens before the tick
    # aborts). A deterministic-order shim below removes the reliance on the
    # scan order entirely.
    conn = kb.connect()
    try:
        tid_bad = kb.create_task(conn, title="bad task", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid_bad, platform="telegram", chat_id="chat-bad")
        kb.complete_task(conn, tid_bad, summary="done")

        tid_good = kb.create_task(conn, title="good task", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid_good, platform="telegram", chat_id="chat-good")
        kb.complete_task(conn, tid_good, summary="done")
    finally:
        conn.close()

    original_claim = kb.claim_unseen_events_for_sub

    def selective_claim(conn, task_id, **kwargs):
        if task_id == tid_bad:
            raise RuntimeError("simulated DB corruption for bad task")
        return original_claim(conn, task_id=task_id, **kwargs)

    monkeypatch.setattr(kb, "claim_unseen_events_for_sub", selective_claim)

    # Force the failing subscription to be iterated FIRST regardless of the
    # unordered SELECT's scan order.
    original_list = kb.list_notify_subs

    def bad_first(conn, task_id=None):
        subs = original_list(conn, task_id)
        return sorted(subs, key=lambda s: 0 if s["task_id"] == tid_bad else 1)

    monkeypatch.setattr(kb, "list_notify_subs", bad_first)

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    # The good task must still be delivered despite the bad task failing.
    assert len(adapter.sent) == 1
    assert tid_good in adapter.sent[0]["text"]


def test_notifier_delivers_block_loop_detected_triage_ping(tmp_path, monkeypatch):
    """A `block_loop_detected` event must reach the subscriber as a triage ping.

    Regression for the silent-triage gap (PR #62712): kanban_db routes a task
    to `triage` after BLOCK_RECURRENCE_LIMIT re-blocks for the same cause and
    emits ONLY a `block_loop_detected` event — no `blocked`/`status` event.
    Before `block_loop_detected` joined TERMINAL_KINDS with its own message
    branch, that one transition (the whole point of which is to force human
    attention) produced zero notification and the task stalled in triage
    silently.
    """
    db_path = tmp_path / "block-loop.db"
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="loops forever", assignee="worker")
        kb.add_notify_sub(conn, task_id=tid, platform="telegram", chat_id="chat-1")
        kb._append_event(
            conn, tid, "block_loop_detected",
            {"reason": "needs credentials", "kind": "needs_input",
             "recurrences": 2, "limit": kb.BLOCK_RECURRENCE_LIMIT},
        )
    finally:
        conn.close()

    adapter = RecordingAdapter()
    runner = _make_runner(adapter)

    asyncio.run(_run_one_notifier_tick(monkeypatch, runner))

    assert len(adapter.sent) == 1, "block_loop_detected must produce a notification"
    text = adapter.sent[0]["text"]
    assert "TRIAGE" in text
    assert tid in text
    assert "needs credentials" in text
    # Cursor advanced: the event is claimed and not re-delivered.
    conn = kb.connect()
    try:
        _, remaining = kb.unseen_events_for_sub(
            conn, task_id=tid, platform="telegram", chat_id="chat-1",
            kinds=["block_loop_detected"],
        )
    finally:
        conn.close()
    assert remaining == []
