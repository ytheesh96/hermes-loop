from __future__ import annotations

from types import SimpleNamespace

from agent.conversation_compression import _append_planning_snapshots


class _Store:
    def __init__(self, snapshot: str | None):
        self.snapshot = snapshot
        self.calls = 0

    def format_for_injection(self) -> str | None:
        self.calls += 1
        return self.snapshot


def test_compression_appends_todo_and_work_map_injection_snapshots():
    compressed = [{"role": "user", "content": "compressed summary"}]
    agent = SimpleNamespace(
        _todo_store=_Store("[todo snapshot]"),
        _work_map_store=_Store("[work map snapshot]"),
    )

    _append_planning_snapshots(compressed, agent)

    assert compressed == [
        {"role": "user", "content": "compressed summary"},
        {"role": "user", "content": "[todo snapshot]"},
        {"role": "user", "content": "[work map snapshot]"},
    ]
    assert agent._todo_store.calls == 1
    assert agent._work_map_store.calls == 1


def test_compression_snapshot_injection_tolerates_missing_or_empty_work_map_store():
    compressed = []
    agent = SimpleNamespace(_todo_store=_Store("[todo snapshot]"))

    _append_planning_snapshots(compressed, agent)

    assert compressed == [{"role": "user", "content": "[todo snapshot]"}]
