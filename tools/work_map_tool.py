#!/usr/bin/env python3
"""Work Map tool module.

A light-weight planning surface that mirrors the todo tool's low-friction API
but carries richer state for task graphs, ownership, and verification handoff.
State is kept in-memory per agent/session and, when running under a Kanban
worker, mirrored into the current task's comment stream as JSON blocks so the
snapshot survives compression and can be recovered from the board history.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from tools.registry import registry, tool_error

VALID_STATUSES = {"pending", "in_progress", "completed", "cancelled", "blocked"}
VALID_KINDS = {"goal", "decision", "session-step", "worker-task", "verification", "publish-gate"}
VALID_VERIFICATION_STATES = {"pending", "needs-orchestrator", "approved", "rejected", "done"}
MAX_WORK_MAP_CONTENT_CHARS = 4000
MAX_WORK_MAP_ITEMS = 256
MAX_EVENTS = 64
WORK_MAP_INJECTION_HEADER = (
    "[Your active work map was preserved across context compression]"
)
_TRUNCATION_MARKER = "… [truncated]"
_SNAPSHOT_MARKER = "WORK_MAP_SNAPSHOT"
_EVENT_MARKER = "WORK_MAP_EVENT"


def _is_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass
class WorkMapEvent:
    kind: str
    item_id: Optional[str]
    payload: Dict[str, Any]
    created_at: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "item_id": self.item_id,
            "payload": self.payload,
            "created_at": self.created_at,
        }


class WorkMapStore:
    """In-memory work-map state with bounded persistence hooks."""

    def __init__(self, *, task_id: Optional[str] = None, board: Optional[str] = None, persist: bool = True):
        self._items: List[Dict[str, Any]] = []
        self._events: List[WorkMapEvent] = []
        self._task_id = (task_id or os.environ.get("HERMES_KANBAN_TASK", "")).strip() or None
        self._board = (board or os.environ.get("HERMES_KANBAN_BOARD", "")).strip() or None
        self._persist_enabled = bool(persist)

    def write(self, work_map: List[Dict[str, Any]], merge: bool = False) -> List[Dict[str, Any]]:
        if not merge:
            items = [self._validate(item) for item in self._dedupe_by_id(work_map)]
            self._items = items
            self._push_event("snapshot_replaced", None, {"count": len(items)})
            self._trim_items()
            self._persist_snapshot()
            return self.read()

        existing = {item["id"]: item for item in self._items}
        for raw in self._dedupe_by_id(work_map):
            item_id = str(raw.get("id", "")).strip()
            if not item_id:
                continue
            if item_id in existing:
                before = dict(existing[item_id])
                updated = self._apply_merge(existing[item_id], raw)
                existing[item_id] = updated
                self._push_event("item_updated", item_id, {"before": before, "after": dict(updated)})
            else:
                validated = self._validate(raw)
                existing[validated["id"]] = validated
                self._items.append(validated)
                self._push_event("item_created", validated["id"], {"item": dict(validated)})

        rebuilt: List[Dict[str, Any]] = []
        seen: set[str] = set()
        for item in self._items:
            current = existing.get(item["id"], item)
            if current["id"] not in seen:
                rebuilt.append(current)
                seen.add(current["id"])
        self._items = rebuilt
        self._trim_items()
        self._persist_snapshot()
        return self.read()

    def read(self) -> List[Dict[str, Any]]:
        return [dict(item) for item in self._items]

    def events(self) -> List[Dict[str, Any]]:
        return [ev.to_dict() for ev in self._events[-MAX_EVENTS:]]

    def has_items(self) -> bool:
        return bool(self._items)

    def format_for_injection(self) -> Optional[str]:
        if not self._items:
            return None

        active = [
            item for item in self._items
            if item["status"] in {"pending", "in_progress", "blocked"}
            or item.get("attention")
            or item.get("verification_state") in {"needs-orchestrator", "pending"}
        ]
        if not active:
            return None

        lines = [WORK_MAP_INJECTION_HEADER]
        for item in active:
            bits = [f"[{item.get('kind') or 'session-step'}]", item["content"]]
            if item.get("status"):
                bits.append(f"status={item['status']}")
            if item.get("attention"):
                bits.append(f"attention={item['attention']}")
            if item.get("verification_state"):
                bits.append(f"verification={item['verification_state']}")
            if item.get("parent_id"):
                bits.append(f"parent={item['parent_id']}")
            lines.append("- " + " | ".join(bits))
        return "\n".join(lines)

    def record_completion(self, item_id: str, *, evidence: Optional[str] = None) -> bool:
        return self._record_handoff(
            item_id,
            status="completed",
            event_kind="worker_completed",
            evidence=evidence,
        )

    def record_block(self, item_id: str, *, reason: Optional[str] = None) -> bool:
        return self._record_handoff(
            item_id,
            status="blocked",
            event_kind="worker_blocked",
            evidence=reason,
        )

    def _record_handoff(self, item_id: str, *, status: str, event_kind: str, evidence: Optional[str]) -> bool:
        item_id = str(item_id).strip()
        if not item_id:
            return False
        for idx, item in enumerate(self._items):
            if item["id"] != item_id:
                continue
            before = dict(item)
            item["status"] = status
            item["attention"] = "needs-orchestrator"
            item["verification_state"] = "needs-orchestrator"
            if evidence:
                item["evidence"] = self._cap_content(str(evidence).strip())
            self._items[idx] = item
            self._push_event(event_kind, item_id, {"before": before, "after": dict(item)})
            self._persist_snapshot(extra_event={"kind": event_kind, "item_id": item_id, "payload": {"before": before, "after": dict(item)}})
            return True
        return False

    def _apply_merge(self, current: Dict[str, Any], raw: Dict[str, Any]) -> Dict[str, Any]:
        next_item = dict(current)
        for key in ("content", "status", "kind", "parent_id", "attention", "evidence", "kanban_task_id", "verification_state"):
            if key not in raw:
                continue
            value = raw.get(key)
            if key == "content" and value:
                next_item[key] = self._cap_content(str(value).strip())
            elif key == "status" and value:
                status = str(value).strip().lower()
                if status in VALID_STATUSES:
                    next_item[key] = status
            elif key == "kind" and value:
                kind = str(value).strip().lower()
                if kind in VALID_KINDS:
                    next_item[key] = kind
            elif key in {"parent_id", "attention", "evidence", "kanban_task_id", "verification_state"}:
                text = str(value).strip()
                next_item[key] = text or None
        return self._normalize_item(next_item)

    def _persist_snapshot(self, *, extra_event: Optional[Dict[str, Any]] = None) -> None:
        if not self._persist_enabled or not self._task_id:
            return
        try:
            payload = {
                "work_map": self.read(),
                "summary": self._summary(),
                "events": self.events(),
                "task_id": self._task_id,
                "board": self._board,
            }
            from hermes_cli import kanban_db
            with kanban_db.connect(board=self._board) as conn:
                body = self._wrap_block(_SNAPSHOT_MARKER, payload)
                kanban_db.add_comment(conn, self._task_id, "work_map", body)
                if extra_event:
                    kanban_db.add_comment(
                        conn,
                        self._task_id,
                        "work_map",
                        self._wrap_block(_EVENT_MARKER, extra_event),
                    )
        except Exception:
            pass

    @staticmethod
    def _wrap_block(marker: str, payload: Dict[str, Any]) -> str:
        return f"{marker}\n```json\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n```"

    def _summary(self) -> Dict[str, int]:
        summary = {"total": len(self._items), "pending": 0, "in_progress": 0, "completed": 0, "cancelled": 0, "blocked": 0}
        for item in self._items:
            status = item.get("status")
            if status in summary:
                summary[status] += 1
        return summary

    def _push_event(self, kind: str, item_id: Optional[str], payload: Dict[str, Any]) -> None:
        self._events.append(WorkMapEvent(kind=kind, item_id=item_id, payload=payload, created_at=int(time.time())))
        if len(self._events) > MAX_EVENTS:
            self._events = self._events[-MAX_EVENTS:]

    def _trim_items(self) -> None:
        if len(self._items) > MAX_WORK_MAP_ITEMS:
            self._items = self._items[:MAX_WORK_MAP_ITEMS]

    @staticmethod
    def _cap_content(content: str) -> str:
        if len(content) > MAX_WORK_MAP_CONTENT_CHARS:
            keep = MAX_WORK_MAP_CONTENT_CHARS - len(_TRUNCATION_MARKER)
            return content[:keep] + _TRUNCATION_MARKER
        return content

    @classmethod
    def _normalize_item(cls, item: Dict[str, Any]) -> Dict[str, Any]:
        item_id = str(item.get("id", "")).strip() or "?"
        content = str(item.get("content", "")).strip() or "(no description)"
        content = cls._cap_content(content)
        status = str(item.get("status", "pending")).strip().lower()
        if status not in VALID_STATUSES:
            status = "pending"
        kind = str(item.get("kind", "session-step")).strip().lower() or "session-step"
        if kind not in VALID_KINDS:
            kind = "session-step"
        out: Dict[str, Any] = {
            "id": item_id,
            "content": content,
            "status": status,
            "kind": kind,
        }
        for key in ("parent_id", "attention", "evidence", "kanban_task_id", "verification_state"):
            value = item.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                out[key] = text
        if item.get("dispatchable") is not None:
            out["dispatchable"] = _is_truthy(item.get("dispatchable"))
        return out

    @classmethod
    def _validate(cls, item: Dict[str, Any]) -> Dict[str, Any]:
        return cls._normalize_item(item)

    @staticmethod
    def _dedupe_by_id(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        last_index: Dict[str, int] = {}
        for i, item in enumerate(items):
            item_id = str(item.get("id", "")).strip() or "?"
            last_index[item_id] = i
        return [items[i] for i in sorted(last_index.values())]


def _summary_for(items: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    summary = {"total": 0, "pending": 0, "in_progress": 0, "completed": 0, "cancelled": 0, "blocked": 0}
    for item in items:
        summary["total"] += 1
        status = str(item.get("status", "")).strip().lower()
        if status in summary:
            summary[status] += 1
    return summary


def work_map_tool(
    work_map: Optional[List[Dict[str, Any]]] = None,
    merge: bool = False,
    store: Optional[WorkMapStore] = None,
) -> str:
    if store is None:
        return tool_error("WorkMapStore not initialized")

    if work_map is not None:
        items = store.write(work_map, merge)
    else:
        items = store.read()

    return json.dumps(
        {
            "work_map": items,
            "summary": _summary_for(items),
            "events": store.events(),
        },
        ensure_ascii=False,
    )


def check_work_map_requirements() -> bool:
    return True


WORK_MAP_SCHEMA = {
    "name": "work_map",
    "description": (
        "Track the session work map for task graphs, ownership, and verification handoffs. "
        "Call with no parameters to read the current snapshot.\n\n"
        "Writing:\n"
        "- Provide 'work_map' array to create/update items\n"
        "- merge=false (default): replace the entire snapshot\n"
        "- merge=true: update existing items by id, append new ones\n\n"
        "Each item: {id: string, content: string, status: pending|in_progress|completed|cancelled|blocked, "
        "kind: goal|decision|session-step|worker-task|verification|publish-gate, parent_id?, attention?, evidence?, "
        "kanban_task_id?, verification_state?, dispatchable?}\n"
        "List order is priority. Use attention=needs-orchestrator and verification_state=needs-orchestrator for worker handoffs.\n"
        "Always returns the full current snapshot."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "work_map": {
                "type": "array",
                "description": "Work map items to write. Omit to read current snapshot.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "content": {"type": "string"},
                        "status": {"type": "string", "enum": sorted(VALID_STATUSES)},
                        "kind": {"type": "string", "enum": sorted(VALID_KINDS)},
                        "parent_id": {"type": "string"},
                        "attention": {"type": "string"},
                        "evidence": {"type": "string"},
                        "kanban_task_id": {"type": "string"},
                        "verification_state": {"type": "string"},
                        "dispatchable": {"type": "boolean"},
                    },
                    "required": ["id", "content", "status"],
                },
            },
            "merge": {"type": "boolean", "default": False},
        },
    },
}


registry.register(
    name="work_map",
    toolset="todo",
    schema=WORK_MAP_SCHEMA,
    handler=lambda args, **kw: work_map_tool(
        work_map=args.get("work_map"),
        merge=args.get("merge", False),
        store=kw.get("store"),
    ),
    check_fn=check_work_map_requirements,
)
