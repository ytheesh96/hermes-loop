#!/usr/bin/env python3
"""Offline A/B benchmark for LLM request preparation.

The conversation case runs the real ``run_conversation`` prologue up to the
transport boundary. The xAI case runs the real Responses kwargs builder over
nested tool schemas. Comparison mode verifies compact JSON byte order as well
as timing, so an optimization cannot silently change the request prefix.

Run from the repository root:

    python scripts/benchmark_request_preparation.py
    python scripts/benchmark_request_preparation.py --compare-legacy
"""

from __future__ import annotations

import argparse
import copy
import gc
import json
import random
import statistics
import sys
import time
from contextlib import AbstractContextManager, contextmanager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import run_agent  # noqa: E402


MESSAGE_COUNTS = (100, 1_000, 5_000)
TOOL_COUNTS = (50, 100, 300)


class _RequestBoundary(BaseException):
    """Stop a benchmark turn immediately before network I/O."""


Sample = Callable[[], dict[str, Any]]
SampleFactory = Callable[[], Sample]
ModeFactory = Callable[[], AbstractContextManager[Any]]


@dataclass(frozen=True)
class _InterleavedStats:
    pairs: int
    equal_pairs: int
    current_wins: int
    legacy_median_ms: float
    current_median_ms: float
    median_reduction_pct: float
    paired_median_reduction_pct: float


def _tool_definition(index: int) -> dict[str, Any]:
    value_schema: dict[str, Any] = {
        "type": "string",
        "description": f"Argument for benchmark tool {index}",
    }
    if index % 3 == 0:
        value_schema.update({
            "enum": ["plain", f"owner/model-{index}"],
            "pattern": "^[a-z0-9/_-]+$",
            "format": "regex",
        })
    return {
        "type": "function",
        "function": {
            "name": f"benchmark_tool_{index}",
            "description": "Representative nested request-preparation schema.",
            "parameters": {
                "type": "object",
                "properties": {
                    "value": value_schema,
                    "options": {
                        "type": "array",
                        "items": {
                            "anyOf": [
                                {"type": "integer"},
                                {"type": "string"},
                            ]
                        },
                    },
                },
                "required": ["value"],
            },
        },
    }


def _history(message_count: int) -> list[dict[str, Any]]:
    if message_count % 4:
        raise ValueError("message_count must be divisible by four")

    messages: list[dict[str, Any]] = []
    for cycle in range(message_count // 4):
        call_id = f"call_{cycle}"
        messages.extend([
            {
                "role": "user",
                "content": f"User request {cycle} with stable benchmark text.",
            },
            {
                "role": "assistant",
                "content": "",
                "reasoning": f"Reasoning summary {cycle}",
                "finish_reason": "tool_calls",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "benchmark_tool_0",
                        "arguments": json.dumps(
                            {"b": cycle, "a": "value"},
                            separators=(",", ":"),
                        ),
                    },
                }],
            },
            {
                "role": "tool",
                "name": "benchmark_tool_0",
                "tool_call_id": call_id,
                "content": f"Tool result {cycle}",
            },
            {
                "role": "assistant",
                "content": f"Completed benchmark cycle {cycle}.",
                "reasoning": f"Final reasoning {cycle}",
                "finish_reason": "stop",
            },
        ])
    return messages


def _agent_with_tools(
    tools: list[dict[str, Any]],
    *,
    xai: bool,
) -> run_agent.AIAgent:
    with (
        patch("run_agent.get_tool_definitions", return_value=tools),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
        patch("hermes_logging.setup_logging"),
        patch("tools.env_probe.warm_environment_probe_async"),
    ):
        agent = run_agent.AIAgent(
            model="benchmark-model",
            provider="custom",
            api_mode="chat_completions",
            base_url="http://127.0.0.1:1/v1",
            api_key="benchmark-token",
            quiet_mode=True,
            max_iterations=1,
            skip_context_files=True,
            skip_memory=True,
        )

    if xai:
        agent.model = "grok-4.3"
        agent.provider = "xai-oauth"
        agent.api_mode = "codex_responses"
        agent.base_url = "https://api.x.ai/v1"
        agent._base_url_lower = agent.base_url.lower()
        agent._base_url_hostname = "api.x.ai"

    agent._cached_system_prompt = "You are Hermes. Keep this prefix stable."
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    agent._cleanup_task_resources = lambda _task_id: None
    agent._persist_session = lambda _messages, _history=None: None
    agent._save_trajectory = lambda _messages, _user_message, _completed: None
    return agent


def _prepare_conversation_sample(message_count: int) -> Sample:
    agent = _agent_with_tools([_tool_definition(0)], xai=False)
    history = _history(message_count)
    captured: dict[str, Any] = {}

    def stop_before_network(api_kwargs: dict[str, Any]) -> None:
        captured["api_kwargs"] = api_kwargs
        raise _RequestBoundary

    agent._interruptible_api_call = stop_before_network

    def execute() -> dict[str, Any]:
        captured.clear()
        try:
            agent.run_conversation(
                "Current benchmark request.",
                conversation_history=history,
            )
        except _RequestBoundary:
            pass
        else:
            raise AssertionError("benchmark did not reach the transport boundary")
        return captured["api_kwargs"]

    return execute


@contextmanager
def _legacy_conversation_mode():
    """Recreate the two redundant message-history walks."""
    import agent.conversation_loop as conversation_loop

    current_message_estimate = conversation_loop.estimate_messages_tokens_rough
    current_request_estimate = conversation_loop.estimate_request_tokens_rough

    def legacy_message_estimate(messages: list[dict[str, Any]]) -> int:
        sum(len(str(message)) for message in messages)
        return current_message_estimate(messages)

    def legacy_request_estimate(
        messages: list[dict[str, Any]],
        **kwargs: Any,
    ) -> int:
        kwargs.pop("messages_tokens", None)
        return current_request_estimate(messages, **kwargs)

    with (
        patch.object(
            conversation_loop,
            "estimate_messages_tokens_rough",
            legacy_message_estimate,
        ),
        patch.object(
            conversation_loop,
            "estimate_request_tokens_rough",
            legacy_request_estimate,
        ),
    ):
        yield


def _prepare_xai_sample(tool_count: int) -> Sample:
    agent = _agent_with_tools(
        [_tool_definition(index) for index in range(tool_count)],
        xai=True,
    )
    agent.session_id = f"benchmark-xai-{tool_count}"

    def execute() -> dict[str, Any]:
        kwargs = agent._build_api_kwargs([
            {"role": "system", "content": "You are Hermes."},
            {"role": "user", "content": "Run the benchmark."},
        ])
        if len(kwargs.get("tools") or []) != tool_count:
            raise AssertionError("Responses conversion dropped benchmark tools")
        return kwargs

    return execute


@contextmanager
def _legacy_xai_mode():
    """Recreate deepcopy plus the two mutating sanitizer passes."""
    from tools import schema_sanitizer

    def legacy_copy(
        source: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], int]:
        copied = copy.deepcopy(source)
        copied, patterns = schema_sanitizer.strip_pattern_and_format(copied)
        copied, enums = schema_sanitizer.strip_slash_enum(copied)
        return copied, patterns + enums

    with patch.object(
        schema_sanitizer,
        "copy_and_strip_xai_unsupported",
        legacy_copy,
    ):
        yield


def _compact_json(value: dict[str, Any]) -> str:
    """Serialize exactly as a compact JSON request, preserving key order."""
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _timed_sample(
    fn: Sample,
    *,
    legacy: bool,
    legacy_mode_factory: ModeFactory,
) -> tuple[float, dict[str, Any]]:
    mode = legacy_mode_factory() if legacy else nullcontext()
    with mode:
        gc.collect()
        started = time.perf_counter_ns()
        result = fn()
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
    return elapsed_ms, result


def _interleaved_comparison(
    factory: SampleFactory,
    *,
    legacy_mode_factory: ModeFactory,
    repeats: int,
    warmups: int,
    seed: int,
    reuse_runners: bool = False,
) -> _InterleavedStats:
    """Run balanced A/B pairs and reject compact-JSON request drift."""
    pairs = repeats + repeats % 2
    orders = ["current-first"] * (pairs // 2)
    orders += ["legacy-first"] * (pairs // 2)
    random.Random(seed).shuffle(orders)
    shared = (
        {"current": factory(), "legacy": factory()}
        if reuse_runners
        else None
    )

    for index in range(warmups):
        order = (
            ("current", "legacy")
            if index % 2 == 0
            else ("legacy", "current")
        )
        runners = shared or {mode: factory() for mode in order}
        for mode in order:
            _timed_sample(
                runners[mode],
                legacy=mode == "legacy",
                legacy_mode_factory=legacy_mode_factory,
            )

    current_samples: list[float] = []
    legacy_samples: list[float] = []
    paired_reductions: list[float] = []
    current_wins = 0

    for order_name in orders:
        order = (
            ("current", "legacy")
            if order_name == "current-first"
            else ("legacy", "current")
        )
        runners = shared or {mode: factory() for mode in order}
        pair_times: dict[str, float] = {}
        pair_json: dict[str, str] = {}
        for mode in order:
            elapsed_ms, request = _timed_sample(
                runners[mode],
                legacy=mode == "legacy",
                legacy_mode_factory=legacy_mode_factory,
            )
            pair_times[mode] = elapsed_ms
            pair_json[mode] = _compact_json(request)

        if pair_json["current"] != pair_json["legacy"]:
            raise AssertionError(
                "current and legacy prepared compact JSON differ"
            )
        current_samples.append(pair_times["current"])
        legacy_samples.append(pair_times["legacy"])
        if pair_times["current"] < pair_times["legacy"]:
            current_wins += 1
        paired_reductions.append(
            (pair_times["legacy"] - pair_times["current"])
            / pair_times["legacy"]
            * 100
        )

    current_median = statistics.median(current_samples)
    legacy_median = statistics.median(legacy_samples)
    return _InterleavedStats(
        pairs=pairs,
        equal_pairs=pairs,
        current_wins=current_wins,
        legacy_median_ms=legacy_median,
        current_median_ms=current_median,
        median_reduction_pct=(
            (legacy_median - current_median) / legacy_median * 100
        ),
        paired_median_reduction_pct=statistics.median(paired_reductions),
    )


def _median_ms(factory: SampleFactory, repeats: int) -> float:
    samples = []
    for _ in range(repeats):
        elapsed, _request = _timed_sample(
            factory(),
            legacy=False,
            legacy_mode_factory=nullcontext,
        )
        samples.append(elapsed)
    return statistics.median(samples)


def _print_comparison(label: str, stats: _InterleavedStats) -> None:
    print(
        f"{label}"
        f"  legacy={stats.legacy_median_ms:8.3f} ms"
        f"  current={stats.current_median_ms:8.3f} ms"
        f"  reduction={stats.median_reduction_pct:6.1f}%"
        f"  paired={stats.paired_median_reduction_pct:6.1f}%"
        f"  wins={stats.current_wins}/{stats.pairs}"
        f"  equal={stats.equal_pairs}/{stats.pairs}"
    )


def _run_cases(
    *,
    title: str,
    counts: tuple[int, ...],
    label: str,
    factory_for_count: Callable[[int], SampleFactory],
    legacy_mode_factory: ModeFactory,
    args: argparse.Namespace,
    seed_offset: int = 0,
    reuse_runners: bool = False,
) -> None:
    print(title)
    for count in counts:
        factory = factory_for_count(count)
        case_label = f"{label}={count:>5}"
        if not args.compare_legacy:
            print(
                f"{case_label}"
                f"  median={_median_ms(factory, args.repeats):8.3f} ms"
            )
            continue
        stats = _interleaved_comparison(
            factory,
            legacy_mode_factory=legacy_mode_factory,
            repeats=args.repeats,
            warmups=args.warmups,
            seed=args.seed + seed_offset + count,
            reuse_runners=reuse_runners,
        )
        _print_comparison(case_label, stats)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--warmups", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260718)
    parser.add_argument("--compare-legacy", action="store_true")
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    if args.warmups < 0:
        parser.error("--warmups must be non-negative")

    _run_cases(
        title="conversation pre-network request preparation",
        counts=MESSAGE_COUNTS,
        label="messages",
        factory_for_count=lambda count: (
            lambda: _prepare_conversation_sample(count)
        ),
        legacy_mode_factory=_legacy_conversation_mode,
        args=args,
    )
    print()
    _run_cases(
        title="xAI Responses kwargs preparation",
        counts=TOOL_COUNTS,
        label="tools",
        factory_for_count=lambda count: lambda: _prepare_xai_sample(count),
        legacy_mode_factory=_legacy_xai_mode,
        args=args,
        seed_offset=1_000_000,
        reuse_runners=True,
    )


if __name__ == "__main__":
    main()
