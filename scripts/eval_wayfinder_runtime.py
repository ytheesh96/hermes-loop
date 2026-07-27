#!/usr/bin/env python3
"""Run bounded Wayfinder checks through fresh Hermes one-shot processes.

This is deliberately an execution harness, not a classifier benchmark.  Each
case starts a new Hermes process against a disposable local OpenAI-compatible
server, records the provider conversation (including tool calls/results), and
checks the resulting sandbox.  The local server is deterministic; no hosted
provider or user files are needed.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SKILL_SOURCE = ROOT / "skills" / "software-development" / "wayfinder-pre-spec"
MODEL = "local-wayfinder"


class Case:
    def __init__(self, case_id: str, prompt: str, expected: str):
        self.id = case_id
        self.prompt = prompt
        self.expected = expected

CASES = (
    Case(
        "ambiguous_architecture",
        "Design the authentication architecture for this application. Decide between session cookies, JWTs, and passkeys, then implement the best option.",
        "wayfinder",
    ),
    Case(
        "clear_implementation",
        "Add a file named artifacts/runtime-artifact.txt containing exactly implemented to this sandbox.",
        "implementation",
    ),
    Case(
        "explicit_loop",
        "Use Loop to implement the already-approved runtime artifact change in this sandbox.",
        "loop",
    ),
    Case(
        "minor_ambiguity",
        "Add a short README note saying runtime artifacts are disposable, following the repository's existing README heading convention.",
        "implementation",
    ),
)


def _tool_call(name: str, arguments: dict[str, Any], call_id: str) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def _completion(*, content: str | None = None, calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    return {
        "id": "eval-response",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL,
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


class LocalModel(http.server.ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], case: Case):
        self.case = case
        self.requests: list[dict[str, Any]] = []
        self.responses: list[dict[str, Any]] = []
        super().__init__(address, _Handler)


class _Handler(http.server.BaseHTTPRequestHandler):
    server: LocalModel

    def log_message(self, *_args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        self.server.requests.append(body)
        turn_number = sum(1 for request in self.server.requests if request.get("messages"))
        response = self._response(body, turn_number)
        self.server.responses.append(response)
        encoded = json.dumps(response).encode("utf-8")
        self.send_response(200)
        if body.get("stream"):
            payload = self._stream_payload(response)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _stream_payload(self, response: dict[str, Any]) -> bytes:
        choice = response["choices"][0]
        message = choice["message"]
        deltas: list[dict[str, Any]] = []
        if message.get("tool_calls"):
            deltas.append({"role": "assistant", "tool_calls": message["tool_calls"]})
        elif message.get("content"):
            deltas.append({"role": "assistant", "content": message["content"]})
        else:
            deltas.append({"role": "assistant", "content": None})
        chunks = []
        for delta in deltas:
            chunks.append({"id": response["id"], "object": "chat.completion.chunk", "model": MODEL, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
        chunks.append({"id": response["id"], "object": "chat.completion.chunk", "model": MODEL, "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}]})
        chunks.append({"id": response["id"], "object": "chat.completion.chunk", "model": MODEL, "choices": [], "usage": response.get("usage")})
        return b"".join(b"data: " + json.dumps(chunk).encode("utf-8") + b"\n\n" for chunk in chunks) + b"data: [DONE]\n\n"

    def _response(self, body: dict[str, Any], request_number: int) -> dict[str, Any]:
        case = self.server.case
        if case.expected == "wayfinder":
            if request_number == 1:
                return _completion(calls=[_tool_call("skills_list", {}, "call-skills")])
            if request_number == 2:
                return _completion(calls=[_tool_call("skill_view", {"name": "wayfinder-pre-spec"}, "call-view")])
            if request_number == 3:
                return _completion(calls=[_tool_call("read_file", {"path": "README.md"}, "call-read")])
            return _completion(content="I inspected the repository first. The choice between session cookies, JWTs, and passkeys changes security and product behavior; which option should the foreground approve? No production change was made.")
        if case.expected == "loop":
            if request_number == 1:
                return _completion(calls=[_tool_call("delegate_task", {"mode": "loop", "tasks": [{"id": "runtime-artifact", "title": "Implement the approved runtime artifact change"}], "context": "Approved implementation; preserve the sandbox boundary and verify the result."}, "call-loop")])
            return _completion(content="The approved implementation was routed through the ordinary durable Loop primitive.")
        if case.id == "minor_ambiguity":
            if request_number == 1:
                return _completion(calls=[_tool_call("read_file", {"path": "README.md"}, "call-read")])
            if request_number == 2:
                return _completion(calls=[_tool_call("write_file", {"path": "README.md", "content": "# Fixture\n\nRuntime artifacts are disposable.\n"}, "call-write")])
            return _completion(content="I inspected the existing heading convention and added the small README note in the foreground.")
        if request_number == 1:
            return _completion(calls=[_tool_call("write_file", {"path": "artifacts/runtime-artifact.txt", "content": "implemented"}, "call-write")])
        return _completion(content="Implemented the bounded request in the sandbox.")


def _text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def _snapshot(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _tool_events(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    seen_results: set[tuple[Any, Any, Any]] = set()
    for request_number, request in enumerate(requests, 1):
        for message_index, message in enumerate(request.get("messages", [])):
            if message.get("role") == "tool":
                result_key = (message.get("tool_call_id") or message_index, message.get("name"), message.get("content"))
                if result_key in seen_results:
                    continue
                seen_results.add(result_key)
                event = {"request": request_number, "phase": "result", "name": message.get("name"), "content": str(message.get("content", ""))[:500]}
                try:
                    result = json.loads(message.get("content", ""))
                except (TypeError, json.JSONDecodeError):
                    result = {}
                if isinstance(result, dict):
                    for key in ("workflow_id", "loop_item_id", "session_id"):
                        if result.get(key):
                            event[key] = result[key]
                events.append(event)
        for tool in request.get("_response_tool_calls", []):
            events.append({"request": request_number, "phase": "call", "name": tool["function"]["name"], "arguments": json.loads(tool["function"]["arguments"])})
    return events


def _trace_payload(requests: list[dict[str, Any]], response_tools: list[list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    compact: list[dict[str, Any]] = []
    for body, tools in zip(requests, response_tools):
        system = next((m.get("content", "") for m in body.get("messages", []) if m.get("role") == "system"), "")
        compact.append({
            "model": body.get("model"),
            "system_contains_wayfinder_skill": "wayfinder-pre-spec" in str(system),
            "system_excerpt": str(system)[max(0, str(system).find("wayfinder-pre-spec") - 120):str(system).find("wayfinder-pre-spec") + 300] if "wayfinder-pre-spec" in str(system) else "",
            "message_roles": [m.get("role") for m in body.get("messages", [])],
            "tool_names": [t.get("function", {}).get("name") for t in body.get("tools", []) if isinstance(t, dict)],
            "response_tool_calls": tools,
        })
    return compact, _tool_events([dict(body, _response_tool_calls=tools) for body, tools in zip(requests, response_tools)])


def _expected_checks(case: Case, evidence: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, bool]:
    names = [event.get("name") for event in events]
    calls = [event for event in events if event.get("phase") == "call"]
    results = [event for event in events if event.get("phase") == "result"]
    skill_discovery = any(name in {"skills_list", "skill_view"} for name in names) or any(
        row.get("system_contains_wayfinder_skill") for row in evidence.get("requests", [])
    )
    hook_events = evidence.get("hook_events", [])
    tool_trace = bool(hook_events) and (
        bool(calls and results)
        or (case.expected == "loop" and any(name == "delegate_task" for name in names))
    )
    checks = {
        "fresh_process": evidence.get("fresh_process") is True and evidence.get("session_id"),
        "returncode": evidence.get("returncode") == 0,
        "skill_discovery": skill_discovery if case.expected == "wayfinder" else not any(name in {"skills_list", "skill_view"} for name in names),
        "tool_trace": bool(tool_trace),
        "production_unchanged": evidence.get("sandbox_changed") is False if case.expected == "wayfinder" or case.expected == "loop" else True,
        "foreground_choice": "choice" in evidence.get("final_text", "").lower() if case.expected == "wayfinder" else True,
        "bounded_write": case.expected != "implementation" or evidence.get("sandbox_changed") is True,
        "loop_route": case.expected != "loop" or (
            bool(evidence.get("workflow_id"))
            and any(
                event.get("name") == "delegate_task"
                and event.get("phase") == "call"
                and event.get("arguments", {}).get("mode") == "loop"
                for event in events
            )
        ),
    }
    if case.expected == "wayfinder":
        call_names = [event.get("name") for event in calls]
        checks["inspect_before_choice"] = call_names[:3] == ["skills_list", "skill_view", "read_file"]
    if case.id == "minor_ambiguity":
        checks["inspected_convention"] = names[:2] == ["read_file", "read_file"] or "read_file" in names
        checks["foreground_only"] = not any(name in {"delegate_task", "skills_list", "skill_view"} for name in names)
    return {key: bool(value) for key, value in checks.items()}


def evaluate_trace(case: Case, evidence: dict[str, Any]) -> dict[str, Any]:
    checks = _expected_checks(case, evidence, evidence.get("tool_events", []))
    failed = [name for name, passed in checks.items() if not passed]
    return {"id": case.id, "passed": not failed, "checks": checks, "failed_checks": failed}


def blocker_report(command: list[str], *, returncode: int, stderr: str, home: str) -> dict[str, Any]:
    return {"status": "blocked", "command": command, "returncode": returncode, "stderr": stderr[-4000:], "home": home}


def _run_case(case: Case, timeout: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix=f".hermes-wayfinder-{case.id}-", dir=ROOT) as tmp:
        root = Path(tmp)
        home = root / "hermes-home"
        sandbox = root / "sandbox"
        (home / "skills" / "software-development").mkdir(parents=True)
        shutil.copytree(SKILL_SOURCE, home / "skills" / "software-development" / "wayfinder-pre-spec")
        trace_path = home / "tool-hooks.jsonl"
        plugin_dir = home / "plugins" / "eval_trace"
        plugin_dir.mkdir(parents=True)
        (plugin_dir / "plugin.yaml").write_text("name: eval_trace\n", encoding="utf-8")
        (plugin_dir / "__init__.py").write_text(
            "import json\n"
            "import os\n"
            "from pathlib import Path\n\n"
            "def _on_post_tool_call(**kwargs):\n"
            "    event = {\n"
            "        key: kwargs.get(key)\n"
            "        for key in (\"tool_name\", \"task_id\", \"session_id\", \"tool_call_id\", \"duration_ms\", \"status\")\n"
            "    }\n"
            "    event[\"args\"] = kwargs.get(\"args\", {})\n"
            "    event[\"result\"] = str(kwargs.get(\"result\", \"\"))[:500]\n"
            "    with Path(os.environ[\"HERMES_EVAL_TRACE\"]).open(\"a\", encoding=\"utf-8\") as stream:\n"
            "        stream.write(json.dumps(event, sort_keys=True) + \"\\n\")\n\n"
            "def register(ctx):\n"
            "    ctx.register_hook(\"post_tool_call\", _on_post_tool_call)\n",
            encoding="utf-8",
        )
        sandbox.mkdir()
        (sandbox / "README.md").write_text("# Fixture\n\nExisting convention.\n", encoding="utf-8")
        before = _snapshot(sandbox)
        server = LocalModel(("127.0.0.1", 0), case)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        (home / "config.yaml").write_text(
            "model:\n"
            f"  default: {MODEL}\n"
            "  provider: custom:local\n"
            "  api_mode: chat_completions\n"
            "custom_providers:\n"
            "  - name: local\n"
            f"    base_url: http://127.0.0.1:{port}/v1\n"
            "    api_key: local-key\n"
            f"    model: {MODEL}\n"
            "plugins:\n"
            "  enabled:\n"
            "    - eval_trace\n",
            encoding="utf-8",
        )
        usage = home / "usage.json"
        command = [sys.executable, "-m", "hermes_cli.main", "--provider", "custom:local", "--model", MODEL, "-z", case.prompt, "--toolsets", "all", "--usage-file", str(usage)]
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("HERMES_KANBAN_")
            and not key.startswith("HERMES_WORKFLOW_")
            and key not in {"TERMINAL_CWD", "HERMES_SESSION_KEY", "HERMES_TASK_ID"}
        }
        env.update({
            "HERMES_HOME": str(home),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "HERMES_KANBAN_DB": str(root / "kanban.db"),
            "HERMES_KANBAN_BOARD": "eval",
            "HERMES_EVAL_TRACE": str(trace_path),
        })
        try:
            completed = subprocess.run(command, cwd=sandbox, env=env, text=True, capture_output=True, timeout=timeout, check=False)
            fresh = True
        except subprocess.TimeoutExpired as exc:
            completed = subprocess.CompletedProcess(command, 124, _text(exc.stdout), _text(exc.stderr) or "timeout")
            fresh = True
        except OSError as exc:
            completed = subprocess.CompletedProcess(command, 127, "", str(exc))
            fresh = False
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
        after = _snapshot(sandbox)
        response_tools = [
            response.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])
            if response.get("choices") else []
            for response in server.responses
        ]
        compact, events = _trace_payload(server.requests, response_tools)
        hook_events: list[dict[str, Any]] = []
        if trace_path.is_file():
            for line in trace_path.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    hook_events.append(event)
        session_id = None
        if usage.is_file():
            try:
                session_id = json.loads(usage.read_text(encoding="utf-8")).get("session_id")
            except (OSError, json.JSONDecodeError):
                pass
        evidence = {
            "fresh_process": fresh,
            "returncode": completed.returncode,
            "session_id": session_id,
            "workflow_id": next((event.get("workflow_id") for event in events if event.get("workflow_id")), None),
            "requests": compact,
            "tool_events": events,
            "hook_events": hook_events,
            "sandbox_changed": before != after,
            "changed_paths": sorted(set(before) ^ set(after) | {path for path in before.keys() & after.keys() if before[path] != after[path]}),
            "final_text": _text(completed.stdout).strip(),
            "stderr": _text(completed.stderr)[-4000:],
        }
        result = evaluate_trace(case, evidence)
        result["evidence"] = evidence
        if completed.returncode != 0:
            result["blocker"] = blocker_report(command, returncode=completed.returncode, stderr=completed.stderr, home=str(home))
        return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", choices=[case.id for case in CASES])
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    selected = [case for case in CASES if not args.case or case.id in args.case]
    results = [_run_case(case, args.timeout) for case in selected]
    payload = {"status": "passed" if all(result["passed"] for result in results) else "blocked_or_failed", "cases": results}
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if payload["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
