"""Loop graph tool — compact cross-surface patch/read surface."""
from __future__ import annotations

import json
import os
import time
from typing import Any

from tools.registry import registry, tool_error
from gateway.session_context import get_logical_session_id, get_session_env


def _check_loop_enabled() -> bool:
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        value = (cfg.get("loop") or {}).get("enabled", True)
        return bool(value)
    except Exception:
        return True


def _json_ok(**payload: Any) -> str:
    return json.dumps({"ok": True, **payload}, ensure_ascii=False)


def _json_error(error: str, message: str) -> str:
    return json.dumps({"ok": False, "error": error, "message": message}, ensure_ascii=False)


def _require_activation(args: dict[str, Any]) -> str | None:
    activation = args.get("activation")
    if activation is True:
        return None
    if isinstance(activation, str) and activation.strip() in {
        "explicit_user_request",
        "approved",
        "dispatch_approved",
        "test",
    }:
        return None
    return _json_error(
        "activation_required",
        "Durable Loop mutations require activation='explicit_user_request' (or an equivalent explicit approval marker).",
    )


def _require_proof_packet(args: dict[str, Any]) -> str | None:
    proof = args.get("proof_packet")
    if isinstance(proof, dict) and proof:
        return None
    return _json_error(
        "proof_packet_required",
        "Durable Loop mutations require a non-empty proof_packet so the workflow has an auditable handoff/resume record.",
    )


def _require_durable_mutation_contract(args: dict[str, Any]) -> str | None:
    return _require_activation(args) or _require_proof_packet(args)


def _connect(board: Any = None):
    from hermes_cli import kanban_db as kb

    return kb, kb.connect(board=board)


def _task_summary(kb: Any, conn: Any, task: Any) -> dict[str, Any]:
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "assignee": task.assignee,
        "tenant": task.tenant,
        "session_id": task.session_id,
        "created_by": task.created_by,
        "parents": kb.parent_ids(conn, task.id),
        "children": kb.child_ids(conn, task.id),
        "completed_at": task.completed_at,
    }


def _latest_summary(kb: Any, conn: Any, task_id: str) -> str | None:
    run = kb.latest_run(conn, task_id)
    if run and run.summary:
        return run.summary
    task = kb.get_task(conn, task_id)
    return task.result if task else None


def _build_body(
    objective: str,
    acceptance_criteria: Any,
    proof_packet: dict[str, Any],
    context: Any = None,
) -> str:
    lines = ["**Goal**", objective.strip()]
    if context:
        lines.extend(["", "**Context**", str(context).strip()])
    lines.extend(["", "**Acceptance criteria**"])
    if isinstance(acceptance_criteria, (list, tuple)) and acceptance_criteria:
        lines.extend(f"- [ ] {str(item).strip()}" for item in acceptance_criteria if str(item).strip())
    else:
        lines.append("- [ ] Durable Loop work has a clear handoff/result.")
    lines.extend([
        "",
        "**Loop delegation proof packet**",
        json.dumps(proof_packet, ensure_ascii=False, sort_keys=True),
    ])
    return "\n".join(lines).strip() + "\n"


def _parse_execution(args: dict[str, Any]) -> dict[str, Any]:
    raw = args.get("execution") or {}
    if not isinstance(raw, dict):
        raw = {}
    mode = str(raw.get("mode") or args.get("mode") or "async").strip().lower()
    if mode not in {"async", "sync"}:
        mode = "async"
    wait_until = str(raw.get("wait_until") or "created").strip().lower()
    if wait_until == "all_done":
        wait_until = "done"
    if wait_until not in {"created", "dispatched", "first_result", "done", "blocked", "review_ready"}:
        wait_until = "created"
    try:
        timeout_seconds = float(raw.get("timeout_seconds") or 0)
    except (TypeError, ValueError):
        timeout_seconds = 0.0
    timeout_seconds = max(0.0, min(timeout_seconds, 30.0))
    return {"mode": mode, "wait_until": wait_until, "timeout_seconds": timeout_seconds}


def _wait_condition(status: str, wait_until: str) -> bool:
    if wait_until == "created":
        return True
    if wait_until == "dispatched":
        return status in {"running", "blocked", "review", "done"}
    if wait_until == "first_result":
        return status in {"blocked", "review", "done"}
    if wait_until == "done":
        return status == "done"
    if wait_until == "blocked":
        return status == "blocked"
    if wait_until == "review_ready":
        return status == "review"
    return True


def _wait_for_loop_item(kb: Any, conn: Any, task_id: str, execution: dict[str, Any]) -> tuple[Any, bool]:
    task = kb.get_task(conn, task_id)
    if not task or execution["mode"] != "sync":
        return task, True
    deadline = time.time() + float(execution.get("timeout_seconds") or 0)
    wait_until = str(execution.get("wait_until") or "created")
    while True:
        task = kb.get_task(conn, task_id)
        if not task or _wait_condition(task.status, wait_until):
            return task, True
        if time.time() >= deadline:
            return task, False
        time.sleep(0.05)


def _loop_item_id(args: dict[str, Any]) -> str:
    return str(args.get("loop_item_id") or args.get("task_id") or args.get("loop_handle") or "").strip()


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


def _handle_loop_create(args: dict[str, Any], **_kwargs) -> str:
    guard = _require_durable_mutation_contract(args)
    if guard:
        return guard
    objective = str(args.get("objective") or args.get("title") or "").strip()
    if not objective:
        return tool_error("objective is required")
    assignee = str(args.get("assignee") or "").strip()
    if not assignee:
        return tool_error("assignee is required for durable Loop work")
    proof_packet = dict(args.get("proof_packet") or {})
    execution = _parse_execution(args)
    board = args.get("board")
    tenant = args.get("tenant") or get_session_env("HERMES_TENANT", "") or get_logical_session_id()
    session_id = args.get("session_id") or get_logical_session_id()
    parents = args.get("parents") or []
    if isinstance(parents, str):
        parents = [parents]
    if not isinstance(parents, (list, tuple)):
        return tool_error("parents must be a list of task ids")
    workspace_kind = str(args.get("workspace_kind") or "scratch")
    triage = bool(args.get("triage", False))
    try:
        kb, conn = _connect(board=board)
        try:
            task_id = kb.create_task(
                conn,
                title=objective,
                body=_build_body(
                    objective,
                    args.get("acceptance_criteria"),
                    proof_packet,
                    args.get("body") or args.get("context"),
                ),
                assignee=assignee,
                created_by=f"loop_delegation:{os.environ.get('HERMES_PROFILE') or 'agent'}",
                workspace_kind=workspace_kind,
                workspace_path=args.get("workspace_path"),
                branch_name=args.get("branch_name"),
                tenant=tenant,
                priority=int(args.get("priority") or 0),
                parents=tuple(str(p).strip() for p in parents if str(p).strip()),
                triage=triage,
                idempotency_key=args.get("idempotency_key"),
                max_runtime_seconds=(int(args["max_runtime_seconds"]) if args.get("max_runtime_seconds") is not None else None),
                skills=args.get("skills"),
                goal_mode=bool(args.get("goal_mode", False)),
                goal_max_turns=(int(args["goal_max_turns"]) if args.get("goal_max_turns") is not None else None),
                initial_status=str(args.get("initial_status") or "running"),
                session_id=session_id,
                board=board,
            )
            if triage:
                with kb.write_txn(conn):
                    conn.execute(
                        "UPDATE tasks SET created_by = ? "
                        "WHERE id = ? AND status = 'triage' "
                        "AND created_by LIKE 'loop_delegation:%'",
                        (f"loop:{task_id}", task_id),
                    )
            task, completed = _wait_for_loop_item(kb, conn, task_id, execution)
            if task is None:
                return tool_error(f"created task {task_id} could not be read back")
            from tools.kanban_notify import maybe_auto_subscribe

            subscribed = maybe_auto_subscribe(conn, task_id)
            warnings: list[str] = []
            if execution["mode"] == "sync" and not completed:
                warnings.append("sync wait timed out; durable Loop work continues asynchronously")
            if execution["mode"] == "sync" and completed and task.status in {"done", "blocked", "review"}:
                foreground_reentry = "completed_in_tool_result"
            elif execution["mode"] == "sync" and not completed:
                foreground_reentry = "will_continue_async"
            else:
                foreground_reentry = str(args.get("foreground_reentry") or "on_final_or_blocker")
            return _json_ok(
                loop_item_id=task_id,
                status=task.status,
                assignee=task.assignee,
                parents=kb.parent_ids(conn, task_id),
                children=kb.child_ids(conn, task_id),
                proof_packet=proof_packet,
                resume_payload=args.get("resume_payload"),
                execution=execution,
                foreground_reentry=foreground_reentry,
                approval_required=False,
                subscribed=subscribed,
                warnings=warnings,
                summary=_latest_summary(kb, conn, task_id),
            )
        finally:
            conn.close()
    except ValueError as exc:
        return tool_error(f"loop_create: {exc}")
    except Exception as exc:
        return tool_error(f"loop_create: {exc}")


def _handle_loop_status(args: dict[str, Any], **_kwargs) -> str:
    task_id = _loop_item_id(args)
    if not task_id:
        return tool_error("loop_item_id is required")
    try:
        kb, conn = _connect(board=args.get("board"))
        try:
            task = kb.get_task(conn, task_id)
            if task is None:
                return tool_error(f"unknown Loop item: {task_id}")
            return _json_ok(
                item=_task_summary(kb, conn, task),
                comments=[{"id": c.id, "author": c.author, "body": c.body, "created_at": c.created_at} for c in kb.list_comments(conn, task_id)],
                events=[{"id": e.id, "kind": e.kind, "payload": e.payload, "created_at": e.created_at, "run_id": e.run_id} for e in kb.list_events(conn, task_id)[-20:]],
                runs=[r.__dict__ for r in kb.list_runs(conn, task_id)],
                handoffs=kb.list_loop_handoffs(conn, task_id=task_id),
                summary=_latest_summary(kb, conn, task_id),
            )
        finally:
            conn.close()
    except Exception as exc:
        return tool_error(f"loop_status: {exc}")


def _handle_loop_list_queue(args: dict[str, Any], **_kwargs) -> str:
    try:
        limit = max(1, min(int(args.get("limit") or 50), 200))
    except (TypeError, ValueError):
        return tool_error("limit must be an integer")
    try:
        kb, conn = _connect(board=args.get("board"))
        try:
            rows = kb.list_tasks(
                conn,
                assignee=args.get("assignee"),
                status=args.get("status"),
                tenant=args.get("tenant"),
                session_id=args.get("session_id"),
                include_archived=bool(args.get("include_archived", False)),
                limit=limit,
            )
            return _json_ok(items=[_task_summary(kb, conn, task) for task in rows], count=len(rows), limit=limit)
        finally:
            conn.close()
    except Exception as exc:
        return tool_error(f"loop_list_queue: {exc}")


def _handle_loop_update(args: dict[str, Any], **_kwargs) -> str:
    guard = _require_durable_mutation_contract(args)
    if guard:
        return guard
    task_id = _loop_item_id(args)
    if not task_id:
        return tool_error("loop_item_id is required")
    note = str(args.get("note") or "").strip()
    if not note:
        return tool_error("note is required")
    try:
        kb, conn = _connect(board=args.get("board"))
        try:
            task = kb.get_task(conn, task_id)
            if task is None:
                return tool_error(f"unknown Loop item: {task_id}")
            comment_id = kb.add_comment(conn, task_id, author=os.environ.get("HERMES_PROFILE") or "loop_delegation", body=note)
            return _json_ok(loop_item_id=task_id, status=task.status, comment_id=comment_id, proof_packet=args.get("proof_packet"), warnings=[])
        finally:
            conn.close()
    except Exception as exc:
        return tool_error(f"loop_update: {exc}")


def _handle_loop_block(args: dict[str, Any], **_kwargs) -> str:
    guard = _require_durable_mutation_contract(args)
    if guard:
        return guard
    task_id = _loop_item_id(args)
    reason = str(args.get("reason") or "").strip()
    if not task_id:
        return tool_error("loop_item_id is required")
    if not reason:
        return tool_error("reason is required")
    metadata = dict(args.get("metadata") or {})
    metadata.setdefault("proof_packet", args.get("proof_packet"))
    try:
        kb, conn = _connect(board=args.get("board"))
        try:
            ok = kb.block_task(conn, task_id, reason=reason, summary=args.get("summary") or reason, metadata=metadata)
            if not ok:
                return tool_error(f"could not block {task_id} (unknown id or not running/ready)")
            task = kb.get_task(conn, task_id)
            run = kb.latest_run(conn, task_id)
            return _json_ok(loop_item_id=task_id, status=task.status if task else "blocked", run_id=run.id if run else None, foreground_reentry="on_blocker", proof_packet=args.get("proof_packet"), warnings=[])
        finally:
            conn.close()
    except Exception as exc:
        return tool_error(f"loop_block: {exc}")


def _handle_loop_request_review(args: dict[str, Any], **_kwargs) -> str:
    guard = _require_durable_mutation_contract(args)
    if guard:
        return guard
    task_id = _loop_item_id(args)
    if not task_id:
        return tool_error("loop_item_id is required")
    summary = str(args.get("summary") or args.get("reason") or "").strip()
    if not summary:
        return tool_error("summary or reason is required")
    reviewer = str(args.get("reviewer") or "reviewer-qa").strip() or "reviewer-qa"
    metadata = dict(args.get("metadata") or {})
    metadata.setdefault("proof_packet", args.get("proof_packet"))
    try:
        kb, conn = _connect(board=args.get("board"))
        try:
            ok = kb.request_review_task(
                conn,
                task_id,
                reviewer=reviewer,
                review_kind=args.get("review_kind") or "loop_delegation_review",
                resume_mode=args.get("resume_mode"),
                reason=args.get("reason"),
                summary=summary,
                metadata=metadata,
            )
            if not ok:
                return tool_error(f"could not request review for {task_id} (unknown id or terminal state)")
            task = kb.get_task(conn, task_id)
            run = kb.latest_run(conn, task_id)
            return _json_ok(loop_item_id=task_id, status=task.status if task else "review", reviewer=reviewer, run_id=run.id if run else None, foreground_reentry="on_review", proof_packet=args.get("proof_packet"), warnings=[])
        finally:
            conn.close()
    except Exception as exc:
        return tool_error(f"loop_request_review: {exc}")


LOOP_GRAPH_SCHEMA = {
    "name": "loop_graph",
    "description": (
        "Read or patch the scheduled-task-backed Loop graph. Patch operations create/update/archive "
        "real Kanban planning tasks and dependency links with expected_revision + mutation_id guards. "
        "Responses are compact: success/error plus graph revision data."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["read", "patch"]},
            "root_task_id": {"type": "string", "description": "Loop identity / session tenant id (legacy field name; not a Kanban root task)."},
            "include_nodes": {"type": "boolean", "description": "For read only, include compact dependency-derived nodes."},
            "expected_revision": {"type": "integer", "description": "For patch, graph_revision from the last read."},
            "mutation_id": {"type": "string", "description": "For patch, caller-stable idempotency key for this mutation."},
            "operations": {
                "type": "array",
                "description": (
                    "Patch ops: add_node, update_node, archive_node/delete_node, "
                    "set_parents, mark_node, resolve_handoff, validate. add_node/update_node/mark_node support "
                    "client_id/title/body/parents/suggested_owner/status/active/frontier plus graph metadata "
                    "branch_kind ('alternative' or 'required'), decision_group_id, and selection_state; "
                    "status defaults to scheduled so planning options are visible but "
                    "non-dispatchable. "
                    "Parent option nodes to the root/current frontier so they stay connected "
                    "in Loop overview/detail graphs. resolve_handoff records foreground "
                    "approval/rejection without promoting downstream rows."
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



_ACTIVATION_PROOF_PROPERTIES = {
    "activation": {
        "type": ["string", "boolean"],
        "description": "Required for mutations: explicit_user_request, approved, dispatch_approved, test, or true.",
    },
    "proof_packet": {
        "type": "object",
        "description": "Required non-empty audit packet explaining the evidence/authorization for this mutation.",
    },
}


LOOP_CREATE_SCHEMA = {
    "name": "loop_create",
    "description": (
        "Create durable Loop work as a narrow Kanban-backed row. Supports async immediate "
        "return and bounded sync waits; mutating use requires activation + proof_packet."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "objective": {"type": "string", "description": "Work objective / task title."},
            "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
            "assignee": {"type": "string", "description": "Profile that should execute the durable work."},
            "tenant": {"type": "string"},
            "parents": {"type": "array", "items": {"type": "string"}},
            "idempotency_key": {"type": "string", "description": "Stable caller key to avoid duplicate durable rows."},
            "execution": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["async", "sync"]},
                    "wait_until": {"type": "string", "enum": ["created", "dispatched", "first_result", "done", "blocked", "review_ready"]},
                    "timeout_seconds": {"type": "number", "minimum": 0, "maximum": 30},
                },
            },
            "resume_payload": {"type": "object"},
            "board": {"type": "string"},
            "workspace_kind": {"type": "string", "enum": ["scratch", "dir", "worktree"]},
            "workspace_path": {"type": "string"},
            "priority": {"type": "integer"},
            "skills": {"type": "array", "items": {"type": "string"}},
            "goal_mode": {"type": "boolean"},
            "goal_max_turns": {"type": "integer"},
            "max_runtime_seconds": {"type": "integer"},
            **_ACTIVATION_PROOF_PROPERTIES,
        },
        "required": ["objective", "assignee", "activation", "proof_packet"],
    },
}


LOOP_STATUS_SCHEMA = {
    "name": "loop_status",
    "description": "Read one durable Loop item plus recent events, comments, runs, and handoffs.",
    "parameters": {
        "type": "object",
        "properties": {
            "loop_item_id": {"type": "string"},
            "board": {"type": "string"},
        },
        "required": ["loop_item_id"],
    },
}


LOOP_LIST_QUEUE_SCHEMA = {
    "name": "loop_list_queue",
    "description": "List durable Loop/Kanban queue rows with compact status filters.",
    "parameters": {
        "type": "object",
        "properties": {
            "tenant": {"type": "string"},
            "assignee": {"type": "string"},
            "status": {"type": "string"},
            "session_id": {"type": "string"},
            "include_archived": {"type": "boolean"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            "board": {"type": "string"},
        },
    },
}


LOOP_UPDATE_SCHEMA = {
    "name": "loop_update",
    "description": "Append an auditable note to a durable Loop item; requires activation + proof_packet.",
    "parameters": {
        "type": "object",
        "properties": {
            "loop_item_id": {"type": "string"},
            "note": {"type": "string"},
            "board": {"type": "string"},
            **_ACTIVATION_PROOF_PROPERTIES,
        },
        "required": ["loop_item_id", "note", "activation", "proof_packet"],
    },
}


LOOP_BLOCK_SCHEMA = {
    "name": "loop_block",
    "description": "Block a durable Loop item with an auditable reason; requires activation + proof_packet.",
    "parameters": {
        "type": "object",
        "properties": {
            "loop_item_id": {"type": "string"},
            "reason": {"type": "string"},
            "summary": {"type": "string"},
            "metadata": {"type": "object"},
            "board": {"type": "string"},
            **_ACTIVATION_PROOF_PROPERTIES,
        },
        "required": ["loop_item_id", "reason", "activation", "proof_packet"],
    },
}


LOOP_REQUEST_REVIEW_SCHEMA = {
    "name": "loop_request_review",
    "description": "Move a durable Loop item into review with a reviewer profile; requires activation + proof_packet.",
    "parameters": {
        "type": "object",
        "properties": {
            "loop_item_id": {"type": "string"},
            "reviewer": {"type": "string"},
            "summary": {"type": "string"},
            "reason": {"type": "string"},
            "metadata": {"type": "object"},
            "review_kind": {"type": "string"},
            "resume_mode": {"type": "string"},
            "board": {"type": "string"},
            **_ACTIVATION_PROOF_PROPERTIES,
        },
        "required": ["loop_item_id", "summary", "activation", "proof_packet"],
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

registry.register(
    name="loop_create",
    toolset="loop_delegation",
    schema=LOOP_CREATE_SCHEMA,
    handler=_handle_loop_create,
    check_fn=_check_loop_enabled,
    emoji="🔁",
)

registry.register(
    name="loop_status",
    toolset="loop_delegation",
    schema=LOOP_STATUS_SCHEMA,
    handler=_handle_loop_status,
    check_fn=_check_loop_enabled,
    emoji="🔎",
)

registry.register(
    name="loop_list_queue",
    toolset="loop_delegation",
    schema=LOOP_LIST_QUEUE_SCHEMA,
    handler=_handle_loop_list_queue,
    check_fn=_check_loop_enabled,
    emoji="📋",
)

registry.register(
    name="loop_update",
    toolset="loop_delegation",
    schema=LOOP_UPDATE_SCHEMA,
    handler=_handle_loop_update,
    check_fn=_check_loop_enabled,
    emoji="📝",
)

registry.register(
    name="loop_block",
    toolset="loop_delegation",
    schema=LOOP_BLOCK_SCHEMA,
    handler=_handle_loop_block,
    check_fn=_check_loop_enabled,
    emoji="⛔",
)

registry.register(
    name="loop_request_review",
    toolset="loop_delegation",
    schema=LOOP_REQUEST_REVIEW_SCHEMA,
    handler=_handle_loop_request_review,
    check_fn=_check_loop_enabled,
    emoji="🔍",
)
