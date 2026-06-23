from hermes_cli import kanban_db as kb


def test_tui_auto_subscribe_uses_current_session_id_when_session_key_is_stale(monkeypatch, tmp_path):
    """Compression/resume can leave a stale session-key context; re-entry must target the live session."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_SESSION_ID", "new-session")
    monkeypatch.setenv("HERMES_SESSION_KEY", "old-session")
    monkeypatch.delenv("HERMES_SESSION_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()

    from gateway.session_context import reset_session_vars_for_tests, set_session_vars
    from tools.kanban_notify import maybe_auto_subscribe

    tokens = set_session_vars(session_key="old-session", session_id="old-session")
    try:
        with kb.connect() as conn:
            task_id = kb.create_task(
                conn,
                title="notify me",
                assignee="worker",
                session_id="new-session",
            )
            assert maybe_auto_subscribe(conn, task_id) is True
            subs = kb.list_notify_subs(conn, task_id)
    finally:
        reset_session_vars_for_tests()

    assert len(subs) == 1
    assert subs[0]["platform"] == "tui"
    assert subs[0]["chat_id"] == "new-session"
