from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import patch

from agent.context_compressor import ContextCompressor
from agent.conversation_compression import (
    _append_planning_snapshots,
    compress_context,
)
from hermes_state import SessionDB


class _Store:
    def __init__(self, snapshot: str | None):
        self.snapshot = snapshot
        self.calls = 0

    def format_for_injection(self) -> str | None:
        self.calls += 1
        return self.snapshot


class _SuccessfulCompressor:
    _last_compress_aborted = False
    _last_summary_error = None
    _last_compression_made_progress = True
    _last_summary_fallback_used = False
    compression_count = 1
    last_compression_rough_tokens = 0
    last_prompt_tokens = 0
    last_completion_tokens = 0
    awaiting_real_usage_after_compression = False

    def compress(self, _messages, **_kwargs):
        return [
            {"role": "user", "content": "compressed summary"},
            {"role": "assistant", "content": "retained tail"},
        ]


def _make_agent(db: SessionDB):
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        from run_agent import AIAgent

        return AIAgent(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            quiet_mode=True,
            session_db=db,
            session_id="planning-snapshot-session",
            skip_context_files=True,
            skip_memory=True,
        )


def test_compression_combines_todo_and_work_map_in_one_continuation_payload():
    compressed = [{"role": "user", "content": "compressed summary"}]
    agent = SimpleNamespace(
        _todo_store=_Store("[todo snapshot]"),
        _work_map_store=_Store("[work map snapshot]"),
    )

    _append_planning_snapshots(compressed, agent)

    assert compressed == [
        {
            "role": "user",
            "content": "compressed summary\n\n[todo snapshot]\n\n[work map snapshot]",
        },
    ]
    assert agent._todo_store.calls == 1
    assert agent._work_map_store.calls == 1


def test_compression_snapshot_injection_tolerates_missing_or_empty_work_map_store():
    compressed = []
    agent = SimpleNamespace(_todo_store=_Store("[todo snapshot]"))

    _append_planning_snapshots(compressed, agent)

    assert compressed == [
        {
            "role": "user",
            "content": "[todo snapshot]",
            "_todo_snapshot_synthetic": True,
        }
    ]


def test_real_compression_path_restores_planning_state_without_role_adjacency(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("planning-snapshot-session", source="cli")
    agent = _make_agent(db)
    setattr(agent, "compression_in_place", True)
    setattr(agent, "context_compressor", _SuccessfulCompressor())
    setattr(agent, "_todo_store", _Store("[todo snapshot]"))
    setattr(agent, "_work_map_store", _Store("[work map snapshot]"))
    messages = [
        {"role": "user", "content": "original request"},
        {"role": "assistant", "content": "original answer"},
    ]

    compressed, _ = compress_context(
        agent,
        messages,
        "system",
        approx_tokens=100_000,
        force=True,
    )

    assert [message["role"] for message in compressed] == ["user", "assistant", "user"]
    assert compressed[-1]["content"] == "[todo snapshot]\n\n[work map snapshot]"
    assert all(
        left["role"] != right["role"]
        for left, right in zip(compressed, compressed[1:])
    )
    assert [
        {"role": message["role"], "content": message["content"]}
        for message in db.get_messages("planning-snapshot-session")
    ] == [
        {"role": message["role"], "content": message["content"]}
        for message in compressed
    ]
    db.close()


def test_work_map_only_snapshot_remains_synthetic_after_db_projection():
    assert ContextCompressor._is_synthetic_compression_user_turn(
        {
            "role": "user",
            "content": (
                "[Your active work map was preserved across context compression]\n"
                "- [verification] review | status=pending"
            ),
        }
    )
