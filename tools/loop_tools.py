"""Loop graph tool — compact cross-surface patch/read surface."""
from __future__ import annotations

import json
from typing import Any

from tools.registry import registry, tool_error


def _check_loop_enabled() -> bool:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        value = (cfg.get("loop") or {}).get("enabled", True)
        return bool(value)
    except Exception:
        return True


def _handle_loop_graph(args: dict[str, Any], **_kwargs) -> str:
    from hermes_cli import kanban_db as kb
    from hermes_cli import loop_graph as graph

    root_task_id = str(args.get("root_task_id") or "").strip()
    if not root_task_id:
        return tool_error("root_task_id is required")
    action = str(args.get("action") or "read").strip().lower()
    board = args.get("board")
    conn = kb.connect(board=board)
    try:
        try:
            if action == "read":
                include_nodes = bool(args.get("include_nodes", False))
                return json.dumps(
                    graph.read_graph(conn, root_task_id, include_nodes=include_nodes),
                    ensure_ascii=False,
                )
            if action == "patch":
                if "expected_revision" not in args:
                    return tool_error("expected_revision is required for patch")
                mutation_id = str(args.get("mutation_id") or "").strip()
                operations = args.get("operations")
                return json.dumps(
                    graph.apply_patch(
                        conn,
                        root_task_id,
                        expected_revision=int(args.get("expected_revision")),
                        mutation_id=mutation_id,
                        operations=operations,
                    ),
                    ensure_ascii=False,
                )
            return tool_error("action must be 'read' or 'patch'")
        except graph.LoopError as exc:
            return json.dumps(graph.error_response(exc, conn, root_task_id), ensure_ascii=False)
        except ValueError as exc:
            return tool_error(str(exc))
    finally:
        conn.close()


LOOP_GRAPH_SCHEMA = {
    "name": "loop_graph",
    "description": (
        "Read or patch the triage-backed Loop graph. Patch operations create/update/archive "
        "real Kanban triage tasks and dependency links with expected_revision + mutation_id guards. "
        "Responses are compact: success/error plus graph revision data."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["read", "patch"]},
            "root_task_id": {"type": "string", "description": "Kanban task id for the Loop root."},
            "include_nodes": {"type": "boolean", "description": "For read only, include compact dependency-derived nodes."},
            "expected_revision": {"type": "integer", "description": "For patch, graph_revision from the last read."},
            "mutation_id": {"type": "string", "description": "For patch, caller-stable idempotency key for this mutation."},
            "operations": {
                "type": "array",
                "description": (
                    "Patch ops: add_node, update_node, archive_node, set_parents, mark_node, validate. "
                    "add_node supports client_id/title/body/parents/suggested_owner/active/frontier; "
                    "set_parents uses task_id plus parent task ids or earlier client_ids."
                ),
                "items": {"type": "object"},
            },
            "board": {
                "type": "string",
                "description": "Optional Kanban board slug override; omit for current/pinned board.",
            },
        },
        "required": ["action", "root_task_id"],
    },
}


registry.register(
    name="loop_graph",
    toolset="loop",
    schema=LOOP_GRAPH_SCHEMA,
    handler=_handle_loop_graph,
    check_fn=_check_loop_enabled,
    emoji="🔁",
)
