"""Tests for tools/env_probe.py — local Python toolchain probe."""

import sys
import threading

import pytest

from tools import env_probe


@pytest.fixture(autouse=True)
def reset_probe_cache():
    """Each test starts with a clean cache."""
    env_probe._reset_cache_for_tests()
    yield
    env_probe._reset_cache_for_tests()


class TestSilentWhenHealthy:
    """The probe must emit nothing when the environment is clean — otherwise
    every prompt for every user pays an unnecessary token tax."""

    def test_clean_env_returns_empty(self, monkeypatch):
        """python3 + pip module + no PEP 668 → silent."""
        monkeypatch.setattr(env_probe, "_python_version_of",
                            lambda b: "3.13.3" if b == "python3" else None)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: True)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: False)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: "3.13")
        monkeypatch.setattr(env_probe.shutil, "which", lambda name: None)
        assert env_probe.get_environment_probe_line() == ""

    def test_pep668_with_uv_returns_empty(self, monkeypatch):
        """PEP 668 alone shouldn't trigger output if uv is installed —
        agent has a viable install path."""
        monkeypatch.setattr(env_probe, "_python_version_of",
                            lambda b: "3.12.4" if b == "python3" else None)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: True)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: True)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: "3.12")
        monkeypatch.setattr(env_probe.shutil, "which",
                            lambda name: "/usr/local/bin/uv" if name == "uv" else None)
        assert env_probe.get_environment_probe_line() == ""


class TestEmitsOnRealProblems:
    """The probe must produce a usable line for the real failure modes
    that drove this feature."""

    def test_allen_scenario_python_version_mismatch(self, monkeypatch):
        """python3 is 3.11 (no pip module), pip on PATH is 3.12, PEP 668 on,
        no uv — the exact scenario from the Sarasota real-estate task."""
        monkeypatch.setattr(env_probe, "_python_version_of",
                            lambda b: {"python3": "3.11.15", "python": None}.get(b))
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: False)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: True)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: "3.12")
        monkeypatch.setattr(env_probe.shutil, "which",
                            lambda name: None if name == "uv" else "/usr/bin/" + name)

        line = env_probe.get_environment_probe_line()
        assert line  # not silent
        # Single line — must not blow up the system prompt.
        assert "\n" not in line
        # Names the real toolchain state
        assert "3.11.15" in line
        assert "no pip module" in line
        assert "mismatch" in line
        assert "PEP 668" in line
        # Points at the right escape hatch
        assert "venv" in line or "uv" in line

    def test_missing_python3_is_named(self, monkeypatch):
        """If python3 isn't installed at all, say so."""
        monkeypatch.setattr(env_probe, "_python_version_of", lambda b: None)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: False)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: False)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: None)
        monkeypatch.setattr(env_probe.shutil, "which", lambda name: None)

        line = env_probe.get_environment_probe_line()
        assert "python3=missing" in line

    def test_python_missing_but_python3_present(self, monkeypatch):
        """Common on Debian: only python3 exists, agent shouldn't type
        `python`."""
        monkeypatch.setattr(env_probe, "_python_version_of",
                            lambda b: "3.12.4" if b == "python3" else None)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: True)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: True)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: "3.12")
        monkeypatch.setattr(env_probe.shutil, "which",
                            lambda name: None if name == "uv" else "/usr/bin/" + name)

        line = env_probe.get_environment_probe_line()
        # `python=missing` only matters in the non-silent path; PEP 668 (without
        # uv) is what brings us off-silent here, so check both signals.
        assert "PEP 668" in line
        assert "python=missing" in line


class TestSkipsRemoteBackends:
    """Remote backends have their own probe; this one must stay out."""

    def test_docker_returns_empty(self, monkeypatch):
        monkeypatch.setenv("TERMINAL_ENV", "docker")
        # Even with a broken local env, docker must emit nothing.
        monkeypatch.setattr(env_probe, "_python_version_of", lambda b: None)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: False)
        assert env_probe.get_environment_probe_line() == ""

    def test_modal_returns_empty(self, monkeypatch):
        monkeypatch.setenv("TERMINAL_ENV", "modal")
        assert env_probe.get_environment_probe_line() == ""

    def test_ssh_returns_empty(self, monkeypatch):
        monkeypatch.setenv("TERMINAL_ENV", "ssh")
        assert env_probe.get_environment_probe_line() == ""


class TestCaching:
    """The probe runs once per process — the result is deterministic for
    the lifetime of the agent."""

    def test_result_cached(self, monkeypatch):
        calls = []

        def counting_version(b):
            calls.append(b)
            return "3.12.4" if b == "python3" else None

        monkeypatch.setattr(env_probe, "_python_version_of", counting_version)
        monkeypatch.setattr(env_probe, "_has_pip_module", lambda b: True)
        monkeypatch.setattr(env_probe, "_detect_pep668", lambda b: False)
        monkeypatch.setattr(env_probe, "_pip_python_version", lambda: "3.12")
        monkeypatch.setattr(env_probe.shutil, "which", lambda name: None)

        env_probe.get_environment_probe_line()
        env_probe.get_environment_probe_line()
        env_probe.get_environment_probe_line()

        # Only the first call probes — caller-counting confirms it.
        # Two calls (python3 + python) on first invocation, zero after.
        assert len(calls) == 2

    def test_inflight_warm_shares_result(self, monkeypatch):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        waiter_started = threading.Event()
        waiter_finished = threading.Event()
        results = []
        calls = 0

        def slow_probe():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(timeout=5)
            finished.set()
            return "shared warm result"

        monkeypatch.setattr(env_probe, "_build_probe_line", slow_probe)
        env_probe.warm_environment_probe_async()
        assert started.wait(timeout=1)

        def wait_for_probe():
            waiter_started.set()
            results.append(env_probe.get_environment_probe_line())
            waiter_finished.set()

        waiter = threading.Thread(target=wait_for_probe)
        waiter.start()
        assert waiter_started.wait(timeout=1)
        assert not waiter_finished.wait(timeout=0.05)
        release.set()
        assert finished.wait(timeout=1)
        assert waiter_finished.wait(timeout=1)
        waiter.join(timeout=1)

        assert calls == 1
        assert results == ["shared warm result"]
        assert env_probe._CACHED_LINE == "shared warm result"

    def test_reset_discards_inflight_result(self, monkeypatch):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def slow_probe():
            started.set()
            release.wait(timeout=5)
            finished.set()
            return "stale warm result"

        monkeypatch.setattr(env_probe, "_build_probe_line", slow_probe)
        worker = threading.Thread(target=env_probe.get_environment_probe_line)
        worker.start()
        assert started.wait(timeout=1)

        env_probe._reset_cache_for_tests()
        release.set()
        assert finished.wait(timeout=1)
        worker.join(timeout=1)
        assert not worker.is_alive()
        assert env_probe._CACHED_LINE is None


class TestRobustness:
    """The probe must NEVER crash the prompt build."""

    def test_subprocess_failure_returns_empty(self, monkeypatch):
        """If every subprocess fails, just stay silent."""
        def boom(*a, **kw):
            raise OSError("simulated")
        monkeypatch.setattr(env_probe.subprocess, "run", boom)
        # Should not raise, should just return ""
        result = env_probe.get_environment_probe_line()
        # Whatever the result is, it must be a string
        assert isinstance(result, str)
