"""Shared Kanban notification subscription helper."""
from __future__ import annotations

import contextlib
import logging
import os
from typing import Any

from hermes_cli.config import cfg_get, load_config

logger = logging.getLogger(__name__)


def _active_profile_name() -> str | None:
    if profile := os.environ.get("HERMES_PROFILE"):
        return profile
    try:
        from hermes_cli.profiles import get_active_profile_name

        return get_active_profile_name() or None
    except Exception:
        return None


def _known_session_tip(session_id: str) -> str:
    """Resolve a persisted session id to its live compression tip.

    Returns an empty string when *session_id* is not a SessionDB row. Kanban
    tenants may be arbitrary labels, so callers must distinguish "unknown
    tenant" from "known session whose tip is itself".
    """
    key = str(session_id or "").strip()
    if not key:
        return ""
    try:
        from hermes_state import SessionDB
    except Exception:
        return ""
    db = SessionDB()
    try:
        if not db.get_session(key):
            return ""
        return str(db.resolve_resume_session_id(key) or key)
    except Exception:
        return ""
    finally:
        with contextlib.suppress(Exception):
            db.close()


def _tui_notification_session_key(conn: Any, task_id: str, fallback: str) -> str:
    """Return the TUI session that should receive task re-entry.

    Loop graph tasks store their true origin in ``tenant`` (the Loop root
    session lineage). Prefer that persisted origin over whichever foreground
    session happened to activate/repair the task, then resolve compression
    continuations to the current tip.
    """
    try:
        from hermes_cli import kanban_db as kb

        task = kb.get_task(conn, task_id)
    except Exception:
        task = None
    if task is not None:
        tenant_tip = _known_session_tip(getattr(task, "tenant", None) or "")
        if tenant_tip:
            return tenant_tip
        task_session = str(getattr(task, "session_id", None) or "").strip()
        if task_session:
            return _known_session_tip(task_session) or task_session
    return fallback


def maybe_auto_subscribe(conn: Any, task_id: str) -> bool:
    """Auto-subscribe the current gateway/TUI session to a Kanban task."""
    try:
        cfg = load_config()
        if not cfg_get(cfg, "kanban", "auto_subscribe_on_create", default=True):
            return False
    except Exception:
        pass

    platform = ""
    chat_id = ""
    try:
        from gateway.session_context import get_logical_session_id, get_session_env

        platform = get_session_env("HERMES_SESSION_PLATFORM", "")
        chat_id = get_session_env("HERMES_SESSION_CHAT_ID", "")
        if bool(platform) != bool(chat_id):
            return False
        if not platform and not chat_id:
            session_key = _tui_notification_session_key(
                conn,
                task_id,
                str(get_logical_session_id("") or ""),
            )
            if not session_key:
                return False
            platform = "tui"
            chat_id = session_key

        from hermes_cli import kanban_db as kb

        kb.add_notify_sub(
            conn,
            task_id=task_id,
            platform=platform,
            chat_id=chat_id,
            thread_id=get_session_env("HERMES_SESSION_THREAD_ID", "") or None,
            user_id=get_session_env("HERMES_SESSION_USER_ID", "") or None,
            notifier_profile=_active_profile_name(),
        )
        return True
    except Exception as exc:
        logger.warning(
            "maybe_auto_subscribe failed: %r (platform=%r key_set=%r)",
            exc,
            platform,
            bool(chat_id),
        )
        return False
