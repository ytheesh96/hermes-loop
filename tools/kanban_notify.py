"""Shared Kanban notification subscription helper."""
from __future__ import annotations

import logging
import os
from typing import Any

from hermes_cli.config import cfg_get, load_config

logger = logging.getLogger(__name__)


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
        from gateway.session_context import get_session_env

        platform = get_session_env("HERMES_SESSION_PLATFORM", "")
        chat_id = get_session_env("HERMES_SESSION_CHAT_ID", "")
        if bool(platform) != bool(chat_id):
            return False
        if not platform and not chat_id:
            session_key = get_session_env("HERMES_SESSION_KEY", "")
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
            notifier_profile=os.environ.get("HERMES_PROFILE"),
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
