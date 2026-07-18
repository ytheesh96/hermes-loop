"""Canonical transcript comparison used by gateway persistence paths."""

from __future__ import annotations

import json
from typing import Any, Dict


_TURN_PERSISTENCE_COMPARE_KEYS = (
    "role",
    "content",
    "tool_call_id",
    "tool_calls",
    "tool_name",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
    "observed",
)

_STRUCTURED_KEYS = {
    "tool_calls",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
}


def _json_fingerprint(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        return repr(value)


def turn_persistence_fingerprint(message: Dict[str, Any]) -> tuple:
    """Return a stable DB-facing fingerprint for transcript de-duplication."""
    role = message.get("role")
    items = []
    for key in _TURN_PERSISTENCE_COMPARE_KEYS:
        value = message.get(key)
        if (
            key == "content"
            and role in {"user", "assistant"}
            and isinstance(value, str)
        ):
            try:
                from agent.memory_manager import sanitize_context

                value = sanitize_context(value).strip()
            except Exception:
                value = value.strip()
        elif key in _STRUCTURED_KEYS:
            value = _json_fingerprint(value) if value not in (None, "") else None
        elif key == "observed":
            value = bool(value)
        items.append((key, value))
    return tuple(items)
