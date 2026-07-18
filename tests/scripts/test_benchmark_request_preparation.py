from contextlib import contextmanager

import pytest

from scripts import benchmark_request_preparation as benchmark


def test_interleaved_comparison_balances_order_and_checks_every_pair(
    monkeypatch,
):
    state = {"legacy": False}
    calls = []

    @contextmanager
    def legacy_mode():
        state["legacy"] = True
        try:
            yield
        finally:
            state["legacy"] = False

    def factory():
        def run():
            calls.append("legacy" if state["legacy"] else "current")
            return {"request": ["same", 1]}

        return run

    monkeypatch.setattr(benchmark.gc, "collect", lambda: 0)
    stats = benchmark._interleaved_comparison(
        factory,
        legacy_mode_factory=legacy_mode,
        repeats=3,
        warmups=0,
        seed=7,
    )

    # Odd repeat counts round up so first-position order remains balanced.
    assert stats.pairs == 4
    assert stats.equal_pairs == 4
    first_modes = calls[::2]
    assert first_modes.count("current") == 2
    assert first_modes.count("legacy") == 2
    assert state["legacy"] is False


def test_interleaved_comparison_rejects_compact_json_order_drift(monkeypatch):
    state = {"legacy": False}

    @contextmanager
    def legacy_mode():
        state["legacy"] = True
        try:
            yield
        finally:
            state["legacy"] = False

    def factory():
        def run():
            if state["legacy"]:
                return {"first": 1, "second": 2}
            return {"second": 2, "first": 1}

        return run

    monkeypatch.setattr(benchmark.gc, "collect", lambda: 0)
    with pytest.raises(
        AssertionError,
        match="current and legacy prepared compact JSON differ",
    ):
        benchmark._interleaved_comparison(
            factory,
            legacy_mode_factory=legacy_mode,
            repeats=2,
            warmups=0,
            seed=7,
        )
    assert state["legacy"] is False


def test_xai_legacy_and_current_prepare_identical_full_request(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    current = benchmark._prepare_xai_sample(3)()
    with benchmark._legacy_xai_mode():
        legacy = benchmark._prepare_xai_sample(3)()

    assert benchmark._compact_json(current) == benchmark._compact_json(legacy)
    assert current["extra_headers"]["x-grok-conv-id"] == "benchmark-xai-3"
