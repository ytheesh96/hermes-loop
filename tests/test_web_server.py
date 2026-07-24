"""Test that start_server configures ws-ping keepalive.

The server now uses uvicorn.Server directly (not uvicorn.run) so we stub
Config + Server + asyncio.run to capture kwargs without starting an event loop.
"""

import asyncio
import contextlib
import json

import pytest
import uvicorn

from hermes_cli import web_server


def _stub_uvicorn(monkeypatch):
    """Replace uvicorn.Config/Server with fakes so start_server returns
    immediately.  Returns a dict with captured Config kwargs."""
    captured: dict = {}

    class _FakeConfig:
        loaded = True
        host = "127.0.0.1"
        port = 8000
        _loop_factory = None

        def __init__(self, *args, **kwargs):
            captured.update(kwargs)

        def load(self):
            pass

        def get_loop_factory(self):
            return self._loop_factory

        class lifespan_class:
            should_exit = False
            state: dict = {}

            def __init__(self, *a, **kw):
                pass

            async def startup(self):
                pass

            async def shutdown(self):
                pass

    class _FakeServer:
        should_exit = False
        started = True
        servers: list = []
        lifespan = None

        @staticmethod
        def capture_signals():
            return contextlib.nullcontext()

        async def startup(self, sockets=None):
            pass

        async def main_loop(self):
            pass

        async def shutdown(self, sockets=None):
            pass

    monkeypatch.setattr(uvicorn, "Config", _FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", lambda config: _FakeServer())
    return captured


def test_start_server_applies_process_local_ssh_bootstrap_state(monkeypatch):
    captured = _stub_uvicorn(monkeypatch)

    web_server.start_server(
        host="127.0.0.1",
        port=0,
        open_browser=False,
        ssh_session_token="s" * 64,
        ssh_owner_nonce="0123456789abcdef",
    )

    assert web_server._SESSION_TOKEN == "s" * 64
    assert web_server._SSH_OWNER_NONCE == "0123456789abcdef"
    assert captured["port"] == 0


def test_start_server_disables_ws_ping_on_loopback(monkeypatch):
    """Loopback binds (the Desktop case) MUST disable uvicorn's protocol-level
    keepalive ping so an event-loop stall can never trigger a false disconnect.

    uvicorn's ws ping runs on the same event loop as agent turns. A single
    synchronous GIL-holding call on a worker thread can starve that loop for
    minutes, so the loop can't process the pong and uvicorn kills an
    otherwise-healthy local connection (#53773 "event loop stalled 226.3s",
    #48445/#50005). On loopback there is no network/proxy path where a
    half-open connection can occur — a dead local client tears the socket down
    with a real FIN/RST that surfaces as WebSocketDisconnect regardless — so
    the ping provides no liveness value and only harms. Assert it is disabled.
    """
    captured = _stub_uvicorn(monkeypatch)

    # Loopback bind => no auth gate, so this reaches the Config constructor.
    web_server.start_server(host="127.0.0.1", port=0, open_browser=False)

    assert captured["ws_ping_interval"] is None
    assert captured["ws_ping_timeout"] is None


def test_start_server_enables_ws_ping_for_half_open_detection(monkeypatch):
    """Non-loopback (public) binds MUST keep the ws ping enabled so half-open
    connections (reverse-proxy 524, dropped Cloudflare Tunnel) raise
    WebSocketDisconnect into the reaping path (#32377).

    The invariant asserted here is that ping stays enabled (non-None, positive)
    and the timeout is never shorter than the interval — not a frozen literal,
    which churns every time the window is retuned. Loopback disables the ping
    (see test_start_server_disables_ws_ping_on_loopback); this covers the
    public-bind half-open case, so the auth gate is active here.
    """
    captured = _stub_uvicorn(monkeypatch)

    # Non-loopback bind so the _is_loopback branch selects the enabled-ping
    # window. Neutralize the auth gate so start_server reaches uvicorn.Config
    # without requiring a registered provider (a real public bind would raise
    # SystemExit here). The ping window keys off the host, not the auth flag.
    monkeypatch.setattr(web_server, "should_require_auth", lambda *a, **k: False)
    web_server.start_server(host="0.0.0.0", port=0, open_browser=False)

    assert captured["ws_ping_interval"] and captured["ws_ping_interval"] > 0
    assert captured["ws_ping_timeout"] and captured["ws_ping_timeout"] > 0
    assert captured["ws_ping_timeout"] >= captured["ws_ping_interval"]


def test_hydrates_compacted_loop_graph_read_for_desktop_panel(monkeypatch):
    def fake_read(args):
        assert args["board"] == "developer"
        assert args["workflow_id"] == "wf_demo"
        assert "root_task_id" not in args
        return json.dumps(
            {
                "ok": True,
                "workflow_id": "wf_demo",
                "graph_revision": 3,
                "nodes": [{"task_id": "t_child", "title": "Visible Loop row"}],
            }
        )

    monkeypatch.setattr(web_server, "_read_loop_graph_for_dashboard", fake_read)

    messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-1",
                    "function": {
                        "name": "loop_graph",
                        "arguments": json.dumps(
                            {
                                "action": "read",
                                "board": "developer",
                                "workflow_id": "wf_demo",
                                "include_nodes": True,
                            }
                        ),
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "tool_name": "loop_graph",
            "content": "[loop_graph] action=read board=developer (547 chars result)",
        },
    ]

    hydrated = web_server._hydrate_compacted_loop_graph_messages(messages)
    payload = json.loads(hydrated[1]["content"])

    assert payload["workflow_id"] == "wf_demo"
    assert "root_task_id" not in payload
    assert payload["nodes"][0]["title"] == "Visible Loop row"
    assert messages[1]["content"].startswith("[loop_graph]")


def test_loop_graph_legacy_records_are_detected_but_emitted_canonically():
    legacy = {
        "ok": True,
        "root_task_id": "wf_legacy",
        "graph_revision": 4,
        "pending_handoffs": [{"task_id": "t_child"}],
        "nodes": [
            {
                "task_id": "t_child",
                "root_task_id": "wf_legacy",
                "handoff": {"state": "pending"},
                "attention": "needs-orchestrator",
                "verification_state": "unknown",
            }
        ],
    }
    assert web_server._content_is_structured_loop_graph_result(
        json.dumps(legacy)
    )

    call = {
        "id": "call-legacy",
        "function": {
            "name": "loop_graph",
            "arguments": json.dumps(
                {
                    "action": "read",
                    "root_task_id": "wf_legacy",
                    "include_nodes": True,
                }
            ),
        },
    }
    args = web_server._loop_graph_call_args(call)
    assert args == {
        "action": "read",
        "workflow_id": "wf_legacy",
        "include_nodes": True,
    }

    snapshot = web_server._latest_loop_graph_snapshot_for_dashboard(
        [
            {"role": "assistant", "content": "", "tool_calls": [call]},
            {
                "role": "tool",
                "tool_name": "loop_graph",
                "tool_call_id": "call-legacy",
                "content": json.dumps(legacy),
            },
        ]
    )
    summary_args = json.loads(
        snapshot[0]["tool_calls"][0]["function"]["arguments"]
    )
    payload = json.loads(snapshot[1]["content"])

    assert summary_args["workflow_id"] == "wf_legacy"
    assert "root_task_id" not in summary_args
    assert payload["workflow_id"] == "wf_legacy"
    assert "root_task_id" not in payload
    assert "pending_handoffs" not in payload
    assert "root_task_id" not in payload["nodes"][0]
    assert "handoff" not in payload["nodes"][0]
    assert "attention" not in payload["nodes"][0]
    assert "verification_state" not in payload["nodes"][0]


def test_loop_graph_routes_name_workflow_and_deprecate_root_alias():
    routes = [
        route
        for route in web_server.app.routes
        if getattr(route, "path", "") == "/api/loop-graph/{workflow_id}"
    ]
    assert {method for route in routes for method in route.methods} >= {
        "GET",
        "PATCH",
    }
    for route in routes:
        aliases = {
            parameter.name: parameter
            for parameter in route.dependant.query_params
        }
        assert aliases["root_task_id"].field_info.deprecated is True


def test_removed_loop_handoff_routes_are_absent():
    paths = {getattr(route, "path", "") for route in web_server.app.routes}

    assert not any("loop-handoffs" in path for path in paths)


@pytest.mark.asyncio
async def test_loop_graph_endpoints_use_workflow_membership(monkeypatch, tmp_path):
    from pathlib import Path

    from hermes_cli import kanban_db as kb

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb._INITIALIZED_PATHS.clear()

    conn = kb.connect()
    try:
        workflow_id = kb.create_workflow(
            conn,
            title="Web workflow",
            origin_session_id="session-a",
        )
        member_id = kb.create_task(
            conn,
            title="Workflow member",
            assignee="worker",
            workflow_id=workflow_id,
        )
        kb.create_task(
            conn,
            title="Legacy-looking non-member",
            assignee="worker",
            created_by=f"loop:{member_id}",
        )
    finally:
        conn.close()

    read = await web_server.read_loop_graph_endpoint(
        workflow_id,
        include_nodes=True,
    )
    assert read["workflow_id"] == workflow_id
    assert "root_task_id" not in read
    assert "pending_handoffs" not in read
    assert [node["task_id"] for node in read["nodes"]] == [member_id]
    assert all("root_task_id" not in node for node in read["nodes"])

    patch = await web_server.patch_loop_graph_endpoint(
        workflow_id,
        web_server.LoopGraphPatchRequest(
            expected_revision=read["graph_revision"],
            mutation_id="web-workflow-patch-1",
            operations=[
                {
                    "op": "add_node",
                    "title": "Workflow plan node",
                    "client_id": "draft-1",
                }
            ],
        ),
    )
    assert patch["workflow_id"] == workflow_id
    assert "root_task_id" not in patch

    legacy_read = web_server._read_loop_graph_for_dashboard(
        {
            "action": "read",
            "root_task_id": workflow_id,
            "include_nodes": True,
        }
    )
    legacy_payload = json.loads(legacy_read)
    assert legacy_payload["workflow_id"] == workflow_id
    assert "root_task_id" not in legacy_payload
    assert {node["title"] for node in legacy_payload["nodes"]} == {
        "Workflow member",
        "Workflow plan node",
    }


def test_start_server_runs_on_uvicorns_loop_factory(monkeypatch):
    """The dashboard/desktop backend must serve uvicorn on the loop *uvicorn*
    selects, not the interpreter default.

    On Windows ``asyncio.run`` defaults to a ProactorEventLoop, but uvicorn's
    socket-serving stack forces a SelectorEventLoop on win32
    (``uvicorn/loops/asyncio.py``). Serving on the proactor loop binds a socket
    that never accepts — the backend prints "Skipping web UI build" and hangs
    forever with the port LISTENING but no TCP handshake (#50641). We fix that
    by routing the serve call through ``uvicorn._compat.asyncio_run`` with
    ``config.get_loop_factory()`` — exactly what ``uvicorn.Server.run`` does.

    This asserts the behavioral contract: on Windows the loop factory the runner
    receives is the one uvicorn's own Config produced, and bare ``asyncio.run``
    is never the serve path when the loop-factory runner exists.
    """
    _stub_uvicorn(monkeypatch)

    # The fix only changes behavior on win32; simulate it so the Windows branch
    # is actually exercised on a POSIX CI host.
    monkeypatch.setattr(web_server.sys, "platform", "win32")

    # The fake Config (installed by _stub_uvicorn) returns its ``_loop_factory``
    # from get_loop_factory(). Pin a sentinel so we can assert it is threaded
    # through to the runner unchanged.
    sentinel_factory = object()
    monkeypatch.setattr(uvicorn.Config, "_loop_factory", sentinel_factory, raising=False)

    seen: dict = {}

    def _fake_runner(coro, *, loop_factory=None):
        seen["loop_factory"] = loop_factory
        coro.close()  # drain without an event loop

    monkeypatch.setattr("uvicorn._compat.asyncio_run", _fake_runner, raising=False)

    # Bare asyncio.run must NOT be the serve path on Windows when the
    # loop-factory runner is importable.
    called_bare = {"hit": False}

    def _guard_asyncio_run(coro):
        called_bare["hit"] = True
        coro.close()
        return None

    monkeypatch.setattr(asyncio, "run", _guard_asyncio_run)

    web_server.start_server(host="127.0.0.1", port=0, open_browser=False)

    assert seen.get("loop_factory") is sentinel_factory, (
        "start_server must pass uvicorn's get_loop_factory() result to the "
        "runner so Windows serves on a SelectorEventLoop"
    )
    assert called_bare["hit"] is False, (
        "start_server must not fall back to bare asyncio.run when uvicorn's "
        "loop-factory runner is available"
    )


def test_start_server_keeps_bare_asyncio_run_on_posix(monkeypatch):
    """POSIX behavior must be byte-for-byte unchanged: serve via the plain
    ``asyncio.run(_serve())`` path, never the Windows loop-factory branch.

    The #50641 fix is intentionally win32-scoped to keep the blast radius
    minimal — Python's default loop on POSIX is already a SelectorEventLoop
    (or uvloop), which is what uvicorn serves on, so there is nothing to fix.
    """
    _stub_uvicorn(monkeypatch)
    monkeypatch.setattr(web_server.sys, "platform", "linux")

    # If the Windows branch were taken, the loop-factory runner would fire.
    runner_called = {"hit": False}

    def _fake_runner(coro, *, loop_factory=None):
        runner_called["hit"] = True
        coro.close()

    monkeypatch.setattr("uvicorn._compat.asyncio_run", _fake_runner, raising=False)

    bare_called = {"hit": False}

    def _fake_asyncio_run(coro):
        bare_called["hit"] = True
        coro.close()
        return None

    monkeypatch.setattr(asyncio, "run", _fake_asyncio_run)

    web_server.start_server(host="127.0.0.1", port=0, open_browser=False)

    assert bare_called["hit"] is True, "POSIX must serve via bare asyncio.run"
    assert runner_called["hit"] is False, (
        "POSIX must not take the Windows loop-factory branch"
    )
