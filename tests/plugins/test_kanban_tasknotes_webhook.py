from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db as kb


def _load_plugin_api():
    repo_root = Path(__file__).resolve().parents[2]
    plugin_file = repo_root / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location(
        f"hermes_dashboard_plugin_kanban_tasknotes_webhook_{id(plugin_file)}", plugin_file
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def plugin_api(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_TASKNOTES_WEBHOOK_SECRET", "webhook-secret")
    monkeypatch.setenv("HERMES_TASKNOTES_BASE_URL", "http://tasknotes.local")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db(board="default")
    return _load_plugin_api()


@pytest.fixture
def client(plugin_api):
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/kanban")
    return TestClient(app)


def _signed_headers(payload: dict, *, delivery_id: str = "del-1", secret: str = "webhook-secret") -> dict:
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {
        "X-TaskNotes-Delivery-ID": delivery_id,
        "X-TaskNotes-Signature": signature,
    }


def _post_webhook(client: TestClient, payload: dict, *, delivery_id: str = "del-1"):
    return client.post(
        "/api/plugins/kanban/tasknotes/webhook",
        content=json.dumps(payload, separators=(",", ":")),
        headers={"Content-Type": "application/json", **_signed_headers(payload, delivery_id=delivery_id)},
    )


def test_tasknotes_webhook_fetches_latest_task_before_queue_mutation(client, plugin_api, monkeypatch):
    calls: list[dict] = []

    def fake_fetch(identity):
        calls.append(identity)
        return {
            "title": "Authoritative title from API",
            "details": "Authoritative body",
            "status": "ready",
            "priority": "5",
            "contexts": ["peacock"],
            "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_api12345"},
            "path": "TaskNotes/Tasks/default--t_api12345.md",
        }

    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_task_latest", fake_fetch)
    payload = {
        "event": "task.updated",
        "data": {
            "updatedTask": {
                "title": "Stale webhook title",
                "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_api12345"},
                "path": "TaskNotes/Tasks/default--t_api12345.md",
            }
        },
    }

    response = _post_webhook(client, payload)

    assert response.status_code == 202
    assert response.json()["processed"] is True
    assert calls == [{"board": "default", "task_id": "t_api12345"}]
    with kb.connect(board="default") as conn:
        row = conn.execute(
            "SELECT title, body, assignee, idempotency_key FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:default:t_api12345",),
        ).fetchone()
    assert row is not None
    assert row["title"] == "Authoritative title from API"
    assert row["body"] == "Authoritative body"
    assert row["assignee"] == "peacock"


def test_tasknotes_webhook_duplicate_delivery_does_not_mutate_queue_twice(client, plugin_api, monkeypatch):
    fetch_count = 0

    def fake_fetch(identity):
        nonlocal fetch_count
        fetch_count += 1
        return {
            "title": "Task",
            "status": "ready",
            "customProperties": {"hermesBoard": identity["board"], "hermesTaskId": identity["task_id"]},
            "path": f"TaskNotes/Tasks/{identity['board']}--{identity['task_id']}.md",
        }

    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_task_latest", fake_fetch)
    payload = {
        "event": "task.created",
        "data": {
            "task": {
                "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_dup1234"},
                "path": "TaskNotes/Tasks/default--t_dup1234.md",
            }
        },
    }

    first = _post_webhook(client, payload, delivery_id="same-delivery")
    second = _post_webhook(client, payload, delivery_id="same-delivery")

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["duplicate"] is True
    assert fetch_count == 1
    with kb.connect(board="default") as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:default:t_dup1234",),
        ).fetchone()[0]
    assert count == 1


def test_tasknotes_webhook_rejects_bad_signature(client):
    payload = {"event": "task.updated", "data": {}}
    response = client.post(
        "/api/plugins/kanban/tasknotes/webhook",
        json=payload,
        headers={"X-TaskNotes-Delivery-ID": "bad", "X-TaskNotes-Signature": "nope"},
    )

    assert response.status_code == 401


def test_tasknotes_webhook_ignores_unsupported_and_malformed_events(client, plugin_api, monkeypatch):
    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_task_latest", lambda identity: pytest.fail("should not fetch"))

    unsupported = _post_webhook(
        client,
        {"event": "time.started", "data": {"task": {}}},
        delivery_id="unsupported",
    )
    malformed = _post_webhook(
        client,
        {"event": "task.updated", "data": {"task": {"title": "No identity"}}},
        delivery_id="malformed",
    )

    assert unsupported.status_code == 202
    assert unsupported.json()["ignored"] == "unsupported-event"
    assert malformed.status_code == 400


def test_tasknotes_webhook_delivery_state_is_persisted_for_diagnostics(client, plugin_api, monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_fetch_tasknotes_task_latest",
        lambda identity: {
            "title": "Task",
            "status": "ready",
            "customProperties": {"hermesBoard": identity["board"], "hermesTaskId": identity["task_id"]},
            "path": f"TaskNotes/Tasks/{identity['board']}--{identity['task_id']}.md",
        },
    )
    payload = {
        "event": "task.completed",
        "data": {
            "completedTask": {
                "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_diag123"},
                "path": "TaskNotes/Tasks/default--t_diag123.md",
            }
        },
    }

    response = _post_webhook(client, payload, delivery_id="diag-delivery")

    assert response.status_code == 202
    db_path = Path(kb.kanban_db_path(board="default"))
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT delivery_id, event, status, hermes_board, hermes_task_id FROM tasknotes_webhook_deliveries WHERE delivery_id = ?",
            ("diag-delivery",),
        ).fetchone()
    assert row == ("diag-delivery", "task.completed", "processed", "default", "t_diag123")


def test_tasknotes_api_fetch_uses_documented_query_shape(plugin_api, monkeypatch):
    requests: list = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(
                {
                    "data": {
                        "tasks": [
                            {
                                "title": "Task from documented data.tasks shape",
                                "customProperties": {
                                    "hermesBoard": "default",
                                    "hermesTaskId": "t_api_shape",
                                },
                            }
                        ],
                        "total": 1,
                        "filtered": 1,
                    }
                }
            ).encode("utf-8")

    def fake_urlopen(request, timeout):
        requests.append(request)
        assert timeout == 10
        return FakeResponse()

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    task = plugin_api._fetch_tasknotes_task_latest({"board": "default", "task_id": "t_api_shape"})

    assert task["title"] == "Task from documented data.tasks shape"
    assert len(requests) == 1
    body = json.loads(requests[0].data.decode("utf-8"))
    assert [child["property"] for child in body["children"]] == [
        "user:hermesBoard",
        "user:hermesTaskId",
    ]


def test_tasknotes_discovery_builds_deterministic_board_query(plugin_api):
    query = plugin_api._build_tasknotes_discovery_query("default")

    assert query == {
        "type": "group",
        "id": "hermes-tasknotes-discovery",
        "conjunction": "and",
        "children": [
            {
                "type": "condition",
                "id": "hermes-board",
                "property": "user:hermesBoard",
                "operator": "is",
                "value": "default",
            }
        ],
    }


def test_tasknotes_discovery_enumerates_eligible_tasks_and_surfaces_cursor(plugin_api, monkeypatch):
    requests: list = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(
                {
                    "data": {
                        "tasks": [
                            {
                                "title": "Eligible",
                                "customProperties": {
                                    "hermesBoard": "default",
                                    "hermesTaskId": "t_eligible1",
                                },
                            },
                            {
                                "title": "Wrong board",
                                "customProperties": {
                                    "hermesBoard": "other",
                                    "hermesTaskId": "t_wrongboard",
                                },
                            },
                            {"title": "Missing id", "customProperties": {"hermesBoard": "default"}},
                            {
                                "title": "Path identity",
                                "path": "TaskNotes/Tasks/default--t_path123.md",
                            },
                        ],
                        "total": 4,
                        "filtered": 4,
                    }
                }
            ).encode("utf-8")

    def fake_urlopen(request, timeout):
        requests.append(request)
        assert timeout == 10
        return FakeResponse()

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    result = plugin_api._discover_tasknotes_tasks("default", cursor="ignored-by-mvp")

    assert [item["identity"] for item in result["tasks"]] == [
        {"board": "default", "task_id": "t_eligible1"},
        {"board": "default", "task_id": "t_path123"},
    ]
    assert result["cursor"] == {
        "requestCursor": "ignored-by-mvp",
        "nextCursor": None,
        "querySupportsCursor": False,
        "total": 4,
        "filtered": 4,
    }
    body = json.loads(requests[0].data.decode("utf-8"))
    assert body == plugin_api._build_tasknotes_discovery_query("default")


def test_tasknotes_discovery_endpoint_is_read_only(client, plugin_api, monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_discover_tasknotes_tasks",
        lambda board, cursor=None: {
            "tasks": [{"identity": {"board": board, "task_id": "t_readonly"}, "task": {"title": "Read-only"}}],
            "cursor": {
                "requestCursor": cursor,
                "nextCursor": None,
                "querySupportsCursor": False,
                "total": 1,
                "filtered": 1,
            },
            "query": plugin_api._build_tasknotes_discovery_query(board),
        },
    )

    response = client.get("/api/plugins/kanban/tasknotes/discovery?board=default&cursor=abc")

    assert response.status_code == 200
    assert response.json()["tasks"][0]["identity"] == {"board": "default", "task_id": "t_readonly"}
    with kb.connect(board="default") as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0


def test_tasknotes_reconciliation_recovers_missed_webhook_without_duplicates(client, plugin_api, monkeypatch):
    discovered = {
        "tasks": [
            {
                "identity": {"board": "default", "task_id": "t_reconcile_missed"},
                "task": {
                    "title": "Missed webhook task",
                    "details": "Recovered by reconciliation",
                    "status": "ready",
                    "contexts": ["peacock"],
                    "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_reconcile_missed"},
                    "path": "TaskNotes/Tasks/default--t_reconcile_missed.md",
                },
            }
        ],
        "cursor": {"requestCursor": None, "nextCursor": None, "querySupportsCursor": False, "total": 1, "filtered": 1},
        "query": plugin_api._build_tasknotes_discovery_query("default"),
    }
    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_eligible_tasks", lambda board, cursor=None: discovered)

    first = client.post("/api/plugins/kanban/tasknotes/reconcile?board=default")
    second = client.post("/api/plugins/kanban/tasknotes/reconcile?board=default")

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["recovered"] == [
        {"identity": {"board": "default", "task_id": "t_reconcile_missed"}, "queue_task_id": first_body["seen"][0]["queue_task_id"]}
    ]
    assert second_body["recovered"] == []
    assert second_body["seen"][0]["identity"] == {"board": "default", "task_id": "t_reconcile_missed"}
    assert second_body["seen"][0]["existed"] is True
    assert second_body["cursor"]["querySupportsCursor"] is False
    with kb.connect(board="default") as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:default:t_reconcile_missed",),
        ).fetchone()[0]
    assert count == 1


def test_tasknotes_reconciliation_health_reports_last_run_and_cursor(client, plugin_api, monkeypatch):
    discovered = {
        "tasks": [],
        "cursor": {"requestCursor": "ignored", "nextCursor": None, "querySupportsCursor": False, "total": 0, "filtered": 0},
        "query": plugin_api._build_tasknotes_discovery_query("default"),
    }
    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_eligible_tasks", lambda board, cursor=None: discovered)

    reconcile = client.post("/api/plugins/kanban/tasknotes/reconcile?board=default&cursor=ignored")
    health = client.get("/api/plugins/kanban/tasknotes/reconcile/health?board=default")

    assert reconcile.status_code == 200
    assert health.status_code == 200
    body = health.json()
    assert body["ok"] is True
    assert body["lastRun"]["status"] == "ok"
    assert body["lastRun"]["eligibleTaskNotesCount"] == 0
    assert body["lastRun"]["recoveredCount"] == 0
    assert body["cursor"] == discovered["cursor"]


def test_tasknotes_reconciliation_rejects_unqualified_identities(plugin_api):
    assert plugin_api._extract_tasknotes_webhook_identity(
        {"customProperties": {"hermesTaskId": "t_missing_board"}}
    ) is None
    assert plugin_api._extract_tasknotes_webhook_identity(
        {"path": "TaskNotes/Tasks/default--not-a-hermes-task.md"}
    ) is None


def test_tasknotes_in_progress_status_maps_to_hermes_running(plugin_api):
    assert plugin_api._tasknotes_status_to_queue_status({"status": "in-progress"}) == "running"


@pytest.mark.parametrize("task", [{"status": "mystery"}, {}])
def test_tasknotes_status_fallback_is_ready_not_synthetic_running(plugin_api, task):
    assert plugin_api._tasknotes_status_to_queue_status(task) == "ready"

    identity = {"board": "default", "task_id": f"t_fallback_{len(task)}"}
    plugin_api._sync_tasknotes_task_to_queue(
        identity,
        {
            "title": "Fallback status task",
            "customProperties": {"hermesBoard": identity["board"], "hermesTaskId": identity["task_id"]},
            **task,
        },
    )

    with kb.connect(board="default") as conn:
        row = conn.execute(
            "SELECT status FROM tasks WHERE idempotency_key = ?",
            (f"tasknotes:{identity['board']}:{identity['task_id']}",),
        ).fetchone()
    assert row is not None
    assert row["status"] == "ready"
