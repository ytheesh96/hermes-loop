import inspect
import os
import sys
import types

from tui_gateway import slash_worker


def test_bind_session_env_overrides_stale_values(monkeypatch):
    calls = []
    fake_context = types.SimpleNamespace(
        set_session_vars=lambda **kwargs: calls.append(kwargs)
    )

    monkeypatch.setitem(sys.modules, "gateway.session_context", fake_context)
    monkeypatch.setenv("HERMES_SESSION_ID", "stale-session")
    monkeypatch.setenv("HERMES_TENANT", "stale-tenant")

    slash_worker._bind_session_env("fresh-session")

    assert os.environ["HERMES_SESSION_KEY"] == "fresh-session"
    assert os.environ["HERMES_SESSION_ID"] == "fresh-session"
    assert os.environ["HERMES_TENANT"] == "fresh-session"
    assert calls == [
        {
            "session_key": "fresh-session",
            "session_id": "fresh-session",
            "tenant": "fresh-session",
        }
    ]


def test_is_orphaned_true_when_ppid_changes():
    # Our parent went away and we were reparented to a subreaper/init.
    assert slash_worker._is_orphaned(1234, getppid=lambda: 999999) is True


def test_is_orphaned_false_when_direct_parent_is_unchanged():
    original_ppid = 1234
    assert slash_worker._is_orphaned(original_ppid, getppid=lambda: original_ppid) is False


def test_parent_death_watchdog_contract_has_no_create_time_plumbing():
    assert list(inspect.signature(slash_worker._is_orphaned).parameters) == [
        "original_ppid",
        "getppid",
    ]
    assert list(inspect.signature(slash_worker._start_parent_death_watchdog).parameters) == [
        "original_ppid",
    ]
