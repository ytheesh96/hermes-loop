from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _capture_publishes(monkeypatch):
    from hermes_cli import kanban_live_events as live

    frames: list[dict] = []
    monkeypatch.setattr(live, "_publish_frame", lambda frame: frames.append(frame) or True)
    monkeypatch.setenv("HERMES_KANBAN_EVENT_PUBLISHER_URL", "ws://events.example/pub")
    return frames


def _event_payload(frame: dict) -> dict:
    assert frame["jsonrpc"] == "2.0"
    assert frame["method"] == "event"
    return frame["params"]["payload"]


def test_task_event_append_emits_loop_source_changed_with_identity(kanban_home, monkeypatch):
    frames = _capture_publishes(monkeypatch)
    conn = kb.connect()
    try:
        workflow_id = kb.create_workflow(
            conn,
            workflow_id="wf-live-task",
            title="Live task workflow",
            tenant="tenant-a",
        )
        tid = kb.create_task(
            conn,
            title="Loop row",
            assignee="worker",
            tenant="tenant-a",
            session_id="source-session-1",
            workflow_id=workflow_id,
        )
    finally:
        conn.close()

    source_frames = [f for f in frames if f["params"]["type"] == "loop.source_changed"]
    assert source_frames, "task creation should invalidate open Loop source caches"
    payload = _event_payload(source_frames[-1])
    assert payload["schema_version"] == 1
    assert payload["event"] == "loop.source_changed"
    assert payload["tenant"] == "tenant-a"
    assert payload["affected_task_ids"] == [tid]
    assert "task_created" in payload["changed_kinds"]
    assert payload["source_session_id"] == "source-session-1"
    assert isinstance(payload["latest_task_event_id"], int)
    assert "body" not in payload

    loopagent_frames = [f for f in frames if f["params"]["type"] == "loopagent.task.upsert"]
    assert loopagent_frames, "task creation should also push a renderable Loopagent row"
    loopagent_payload = _event_payload(loopagent_frames[-1])
    assert loopagent_payload["event"] == "loopagent.task.upsert"
    assert loopagent_payload["workflow_id"] == workflow_id
    assert loopagent_payload["task_id"] == tid
    assert loopagent_payload["task_title"] == "Loop row"
    assert loopagent_payload["task_status"] == "ready"
    assert loopagent_payload["source_session_id"] == "source-session-1"
    assert loopagent_payload["logical_session_id"] == "source-session-1"
    assert loopagent_payload["current_session_id"] == "source-session-1"
    assert loopagent_payload["lineage_session_ids"] == ["source-session-1"]
    assert loopagent_payload["is_root_task"] is True
    assert loopagent_payload["parent_task_ids"] == []
    assert loopagent_payload["latest_task_event_id"] == payload["latest_task_event_id"]
    assert loopagent_payload["task"]["id"] == tid
    assert loopagent_payload["task"]["workflow_id"] == workflow_id

    upsert_frames = [f for f in frames if f["params"]["type"] == "loopagent.task.upsert"]
    assert upsert_frames, "task creation should also publish a row upsert event"
    upsert = _event_payload(upsert_frames[-1])
    assert upsert["event"] == "loopagent.task.upsert"
    assert upsert["workflow_id"] == workflow_id
    assert upsert["tenant"] == "tenant-a"
    assert upsert["task_id"] == tid
    assert upsert["source_session_id"] == "source-session-1"
    assert upsert["task_title"] == "Loop row"
    assert upsert["task_status"] == "ready"
    assert upsert["latest_task_event_id"] == payload["latest_task_event_id"]
    assert upsert["latest_task_event_revision"] == payload["latest_task_event_id"]
    assert upsert["latest_task_event_kind"] == "created"
    assert upsert["task"]["id"] == tid
    assert upsert["task"]["workflow_id"] == workflow_id
    assert upsert["task"]["title"] == "Loop row"
    assert upsert["task"]["status"] == "ready"
    assert upsert["latest_task_event"]["kind"] == "created"
    assert "body" not in upsert["task"]


def test_worker_terminal_event_emits_namespaced_completion(kanban_home, monkeypatch, all_assignees_spawnable):
    frames = _capture_publishes(monkeypatch)
    conn = kb.connect()
    try:
        workflow_id = kb.create_workflow(
            conn,
            workflow_id="wf-live-worker",
            title="Live worker workflow",
            tenant="tenant-a",
        )
        tid = kb.create_task(
            conn,
            title="Ship thing",
            assignee="peacock",
            tenant="tenant-a",
            workflow_id=workflow_id,
        )
        res = kb.dispatch_once(conn, spawn_fn=lambda task, workspace: 4242)
        assert [item[0] for item in res.spawned] == [tid]
        run_id = kb.get_task(conn, tid).current_run_id
        assert kb.complete_task(
            conn,
            tid,
            summary="implemented backend events",
            metadata={"worker_session_id": "worker-sess-1", "tests_run": 3, "tests_passed": 3},
            expected_run_id=run_id,
        )
    finally:
        conn.close()

    worker_frames = [f for f in frames if f["params"]["type"] == "kanban.worker.complete"]
    assert worker_frames, "completion should produce a live worker terminal event"
    payload = _event_payload(worker_frames[-1])
    assert payload["event"] == "kanban.worker.complete"
    assert payload["task_id"] == tid
    assert payload["run_id"] == run_id
    assert payload["profile"] == "peacock"
    assert payload["worker_session_id"] == "worker-sess-1"
    assert payload["task_title"] == "Ship thing"
    assert payload["task_status"] == "done"
    assert payload["run_status"] == "completed"
    assert payload["outcome"] == "completed"
    assert payload["safe_summary"] == "implemented backend events"
    assert payload["tests_run"] == 3
    assert payload["tests_passed"] == 3
    assert "metadata" not in payload

    loopagent_frames = [f for f in frames if f["params"]["type"] == "loopagent.worker.upsert"]
    assert loopagent_frames, "completion should also push a renderable Loopagent worker row"
    loopagent_payload = _event_payload(loopagent_frames[-1])
    assert loopagent_payload["event"] == "loopagent.worker.upsert"
    assert loopagent_payload["workflow_id"] == workflow_id
    assert loopagent_payload["task_id"] == tid
    assert loopagent_payload["run_id"] == run_id
    assert loopagent_payload["task_title"] == "Ship thing"
    assert loopagent_payload["task_status"] == "done"
    assert loopagent_payload["run_status"] == "completed"
    assert loopagent_payload["worker_session_id"] == "worker-sess-1"
    assert loopagent_payload["worker"]["task_id"] == tid
    assert loopagent_payload["worker"]["workflow_id"] == workflow_id
    assert loopagent_payload["worker"]["run_id"] == run_id
    assert loopagent_payload["worker"]["summary_preview"] == "implemented backend events"
    assert loopagent_payload["task"]["workflow_id"] == workflow_id

    upsert_frames = [f for f in frames if f["params"]["type"] == "loopagent.worker.upsert"]
    assert upsert_frames, "completion should also publish a worker row upsert event"
    upsert = _event_payload(upsert_frames[-1])
    assert upsert["event"] == "loopagent.worker.upsert"
    assert upsert["workflow_id"] == workflow_id
    assert upsert["task_id"] == tid
    assert upsert["run_id"] == run_id
    assert upsert["worker_session_id"] == "worker-sess-1"
    assert upsert["task_title"] == "Ship thing"
    assert upsert["task_status"] == "done"
    assert upsert["run_status"] == "completed"
    assert upsert["outcome"] == "completed"
    assert upsert["latest_task_event_kind"] == "completed"
    assert upsert["safe_summary"] == "implemented backend events"
    assert upsert["worker"]["task_id"] == tid
    assert upsert["worker"]["workflow_id"] == workflow_id
    assert upsert["worker"]["run_id"] == run_id
    assert upsert["worker"]["status"] == "completed"
    assert upsert["worker"]["outcome"] == "completed"
    assert upsert["worker"]["summary_preview"] == "implemented backend events"
    assert upsert["worker"]["recent_task_events"][-1]["kind"] == "completed"
    assert upsert["task"]["status"] == "done"
    assert upsert["task"]["workflow_id"] == workflow_id


def test_auto_give_up_emits_source_invalidation_and_safe_worker_terminal_event(
    kanban_home,
    monkeypatch,
    all_assignees_spawnable,
):
    frames = _capture_publishes(monkeypatch)
    conn = kb.connect()
    raw_sensitive = "token=sk-live-very-secret-value"
    try:
        tid = kb.create_task(
            conn,
            title="Breaker task",
            assignee="peacock",
            tenant="tenant-a",
            session_id="source-session-1",
        )
        res = kb.dispatch_once(conn, spawn_fn=lambda task, workspace: 4242)
        assert [item[0] for item in res.spawned] == [tid]
        task = kb.get_task(conn, tid)
        assert task is not None
        run_id = task.current_run_id

        frames.clear()
        blocked = kb._record_task_failure(
            conn,
            tid,
            error=f"spawn exploded with {raw_sensitive}",
            outcome="spawn_failed",
            release_claim=True,
            end_run=True,
            failure_limit=1,
        )
        assert blocked is True
        task = kb.get_task(conn, tid)
        assert task is not None
        assert task.status == "blocked"
    finally:
        conn.close()

    frame_types = [f["params"]["type"] for f in frames]
    assert "loop.source_changed" in frame_types
    assert "kanban.worker.gave_up" in frame_types

    source_payload = _event_payload([f for f in frames if f["params"]["type"] == "loop.source_changed"][-1])
    assert source_payload["affected_task_ids"] == [tid]
    assert source_payload["affected_run_ids"] == [run_id]
    assert source_payload["source_session_id"] == "source-session-1"
    assert "run_failed" in source_payload["changed_kinds"]

    worker_payload = _event_payload([f for f in frames if f["params"]["type"] == "kanban.worker.gave_up"][-1])
    assert worker_payload["event"] == "kanban.worker.gave_up"
    assert worker_payload["task_id"] == tid
    assert worker_payload["run_id"] == run_id
    assert worker_payload["task_status"] == "blocked"
    assert worker_payload["run_status"] == "failed"
    assert worker_payload["outcome"] == "gave_up"
    assert worker_payload["error_preview"]
    assert raw_sensitive not in worker_payload["error_preview"]
    assert raw_sensitive not in json.dumps(frames)

    task_upsert = _event_payload([f for f in frames if f["params"]["type"] == "loopagent.task.upsert"][-1])
    assert task_upsert["task_id"] == tid
    assert task_upsert["run_id"] == run_id
    assert task_upsert["source_session_id"] == "source-session-1"
    assert task_upsert["task_status"] == "blocked"
    assert task_upsert["latest_task_event_kind"] == "gave_up"

    worker_upsert = _event_payload([f for f in frames if f["params"]["type"] == "loopagent.worker.upsert"][-1])
    assert worker_upsert["task_id"] == tid
    assert worker_upsert["run_id"] == run_id
    assert worker_upsert["task_status"] == "blocked"
    assert worker_upsert["run_status"] == "failed"
    assert worker_upsert["outcome"] == "gave_up"
    assert worker_upsert["worker"]["error_preview"]
    assert raw_sensitive not in json.dumps(worker_upsert)


def test_worker_callback_bridge_emits_structured_tool_events(kanban_home, monkeypatch, all_assignees_spawnable):
    frames = _capture_publishes(monkeypatch)
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Use tools", assignee="peacock", tenant="tenant-a")
        kb.dispatch_once(conn, spawn_fn=lambda task, workspace: 4242)
        task = kb.get_task(conn, tid)
        run_id = task.current_run_id
    finally:
        conn.close()

    from hermes_cli.kanban_live_events import KanbanWorkerEventBridge

    bridge = KanbanWorkerEventBridge.from_env(
        task_id=tid,
        run_id=run_id,
        board="default",
        profile="peacock",
        worker_session_id="worker-sess-1",
    )
    bridge.tool_start("call-1", "read_file", {"path": "/tmp/example.txt"})
    bridge.tool_progress("tool.output", "read_file", "read 12 lines", None)
    bridge.tool_complete("call-1", "terminal", {}, json.dumps({"exit_code": 0, "output": "secret raw output must not appear"}))

    types = [f["params"]["type"] for f in frames]
    assert "kanban.worker.tool_start" in types
    assert "kanban.worker.tool_progress" in types
    assert "kanban.worker.tool_complete" in types
    assert "loopagent.worker.upsert" in types
    complete_payload = _event_payload([f for f in frames if f["params"]["type"] == "kanban.worker.tool_complete"][-1])
    assert complete_payload["tool_call_id"] == "call-1"
    assert complete_payload["tool_name"] == "terminal"
    assert complete_payload["exit_code"] == 0
    assert complete_payload["success"] is True
    assert "secret raw output" not in json.dumps(complete_payload)

    loopagent_payload = _event_payload([f for f in frames if f["params"]["type"] == "loopagent.worker.upsert"][-1])
    assert loopagent_payload["event"] == "loopagent.worker.upsert"
    assert loopagent_payload["task_id"] == tid
    assert loopagent_payload["run_id"] == run_id
    assert loopagent_payload["worker_session_id"] == "worker-sess-1"
    assert loopagent_payload["current_tool"] == "terminal"
    assert loopagent_payload["summary_preview"] == "terminal exited 0"


def test_worker_heartbeat_current_tool_and_session_reach_loopagent_payload_and_run_metadata(
    kanban_home,
    monkeypatch,
    all_assignees_spawnable,
):
    frames = _capture_publishes(monkeypatch)
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Show active tool", assignee="peacock", tenant="tenant-a")
        kb.dispatch_once(conn, spawn_fn=lambda task, workspace: 4242)
        task = kb.get_task(conn, tid)
        run_id = task.current_run_id
        frames.clear()

        assert kb.heartbeat_worker(
            conn,
            tid,
            expected_run_id=run_id,
            current_tool="search_files",
            worker_session_id="worker-sess-1",
        )
        run = kb.latest_run(conn, tid)
        assert run.metadata["current_tool"] == "search_files"
        assert run.metadata["last_tool"] == "search_files"
        assert run.metadata["worker_session_id"] == "worker-sess-1"
    finally:
        conn.close()

    worker_payload = _event_payload([f for f in frames if f["params"]["type"] == "kanban.worker.heartbeat"][-1])
    assert worker_payload["current_tool"] == "search_files"
    assert worker_payload["worker_session_id"] == "worker-sess-1"

    loopagent_payload = _event_payload([f for f in frames if f["params"]["type"] == "loopagent.worker.upsert"][-1])
    assert loopagent_payload["event"] == "loopagent.worker.upsert"
    assert loopagent_payload["task_id"] == tid
    assert loopagent_payload["run_id"] == run_id
    assert loopagent_payload["worker_session_id"] == "worker-sess-1"
    assert loopagent_payload["current_tool"] == "search_files"
    assert loopagent_payload["worker"]["worker_session_id"] == "worker-sess-1"
    assert loopagent_payload["worker"]["current_tool"] == "search_files"
