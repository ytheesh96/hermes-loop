from hermes_cli import kanban_db as kb
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


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


def test_tui_auto_subscribe_prefers_loop_origin_session_tip(monkeypatch, tmp_path):
    """Loop graph re-entry belongs to the root session lineage, not the repairing session."""
    home = tmp_path / ".hermes"
    home.mkdir()
    token = set_hermes_home_override(home)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.delenv("HERMES_SESSION_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()

    from gateway.session_context import reset_session_vars_for_tests, set_session_vars
    from hermes_state import SessionDB
    from tools.kanban_notify import maybe_auto_subscribe

    db = SessionDB()
    try:
        db.create_session("loop-root-session", source="tui")
        db.end_session("loop-root-session", "compression")
        db.create_session(
            "loop-tip-session",
            source="tui",
            parent_session_id="loop-root-session",
        )
    finally:
        db.close()

    tokens = set_session_vars(
        session_key="repair-session",
        session_id="repair-session",
        tenant="repair-session",
    )
    try:
        with kb.connect() as conn:
            task_id = kb.create_task(
                conn,
                title="notify loop origin",
                assignee="worker",
                tenant="loop-root-session",
                session_id="repair-session",
            )
            assert maybe_auto_subscribe(conn, task_id) is True
            subs = kb.list_notify_subs(conn, task_id)
    finally:
        del tokens
        reset_session_vars_for_tests()
        reset_hermes_home_override(token)

    assert len(subs) == 1
    assert subs[0]["platform"] == "tui"
    assert subs[0]["chat_id"] == "loop-tip-session"
