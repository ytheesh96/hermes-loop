from __future__ import annotations

import json
import sys
import types

from model_tools import get_tool_definitions
from tools.work_map_tool import WorkMapStore, work_map_tool


def test_work_map_store_normalizes_defaults_and_merges_by_stable_id():
    store = WorkMapStore(persist=False)

    replaced = store.write(
        [
            {"id": "alpha", "content": "  Draft one  ", "status": "pending"},
            {"id": "alpha", "content": " Final loop map ", "status": "pending"},
            {
                "id": "beta",
                "content": "Blocked handoff",
                "status": "blocked",
                "kind": "publish-gate",
                "attention": " needs-orchestrator ",
                "verification_state": " pending ",
                "dispatchable": "false",
            },
        ]
    )

    assert [item["id"] for item in replaced] == ["alpha", "beta"]
    assert replaced[0]["content"] == "Final loop map"
    assert replaced[0]["kind"] == "session-step"
    assert replaced[0]["status"] == "pending"
    assert replaced[1]["kind"] == "publish-gate"
    assert replaced[1]["dispatchable"] is False
    assert replaced[1]["attention"] == "needs-orchestrator"
    assert replaced[1]["verification_state"] == "pending"

    merged = store.write(
        [
            {"id": "alpha", "status": "in_progress", "attention": "needs-orchestrator"},
            {"id": "gamma", "content": "Ship Loop Work Map", "status": "completed", "kind": "verification"},
        ],
        merge=True,
    )

    assert [item["id"] for item in merged] == ["alpha", "beta", "gamma"]
    assert merged[0]["status"] == "in_progress"
    assert merged[0]["attention"] == "needs-orchestrator"
    assert merged[2]["kind"] == "verification"
    assert merged[2]["status"] == "completed"
    assert store.read() == merged


def test_work_map_store_handoff_marks_needs_orchestrator_and_stays_in_injection():
    store = WorkMapStore(task_id="t_123", board="board-1", persist=False)
    store.write([{"id": "loop-1", "content": "Finalize handoff", "status": "in_progress"}])

    assert store.record_completion("loop-1", evidence="ready for review") is True

    item = store.read()[0]
    assert item["status"] == "completed"
    assert item["attention"] == "needs-orchestrator"
    assert item["verification_state"] == "needs-orchestrator"
    assert item["evidence"] == "ready for review"

    injection = store.format_for_injection()
    assert injection is not None
    assert "Finalize handoff" in injection
    assert "verification=needs-orchestrator" in injection


def test_work_map_store_block_handoff_sets_attention_and_verification_state():
    store = WorkMapStore(task_id="t_456", board="board-1", persist=False)
    store.write([{"id": "loop-2", "content": "Investigate failure", "status": "pending"}])

    assert store.record_block("loop-2", reason="needs a reviewer") is True

    item = store.read()[0]
    assert item["status"] == "blocked"
    assert item["attention"] == "needs-orchestrator"
    assert item["verification_state"] == "needs-orchestrator"
    assert item["evidence"] == "needs a reviewer"
    assert "Investigate failure" in (store.format_for_injection() or "")


def test_work_map_tool_serializes_snapshot_and_summary():
    store = WorkMapStore(persist=False)
    payload = json.loads(
        work_map_tool(
            work_map=[
                {"id": "alpha", "content": "Draft loop map", "status": "pending"},
                {"id": "beta", "content": "Review handoff", "status": "blocked"},
            ],
            store=store,
        )
    )

    assert [item["id"] for item in payload["work_map"]] == ["alpha", "beta"]
    assert payload["summary"]["total"] == 2
    assert payload["summary"]["completed"] == 0
    assert payload["summary"]["blocked"] == 1
    assert payload["events"]


def test_work_map_store_does_not_persist_when_disabled(monkeypatch):
    fake_db = types.ModuleType("hermes_cli.kanban_db")

    def _fail(*args, **kwargs):  # pragma: no cover - should never be called
        raise AssertionError("persist=False should not touch kanban_db")

    setattr(fake_db, "connect", _fail)
    setattr(fake_db, "add_comment", _fail)
    monkeypatch.setitem(sys.modules, "hermes_cli.kanban_db", fake_db)

    store = WorkMapStore(task_id="t_789", board="board-1", persist=False)
    store.write([{"id": "alpha", "content": "Draft", "status": "pending"}])

    assert store.record_block("alpha", reason="review required") is True
    assert store.read()[0]["status"] == "blocked"


def test_work_map_is_in_normal_model_tool_definitions():
    names = {tool["function"]["name"] for tool in get_tool_definitions(["hermes-cli"], quiet_mode=True)}

    assert "work_map" in names
    assert "todo" in names
