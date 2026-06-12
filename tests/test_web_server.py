import json

import uvicorn

from hermes_cli import web_server


def test_start_server_enables_ws_ping_for_half_open_detection(monkeypatch):
    """WS ping must be configured so half-open connections (reverse-proxy 524,
    dropped tunnels) raise WebSocketDisconnect into the reaping path (#32377)."""
    captured = {}
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))

    # Loopback bind => no auth gate, so this reaches uvicorn.run without setup.
    web_server.start_server(host="127.0.0.1", port=0, open_browser=False)

    assert captured["ws_ping_interval"] == 20.0
    assert captured["ws_ping_timeout"] == 20.0


def test_hydrates_compacted_loop_graph_read_for_desktop_panel(monkeypatch):
    def fake_read(args):
        assert args["board"] == "developer"
        assert args["root_task_id"] == "t_root"
        return json.dumps(
            {
                "ok": True,
                "root_task_id": "t_root",
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
                                "root_task_id": "t_root",
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

    assert payload["root_task_id"] == "t_root"
    assert payload["nodes"][0]["title"] == "Visible Loop row"
    assert messages[1]["content"].startswith("[loop_graph]")
