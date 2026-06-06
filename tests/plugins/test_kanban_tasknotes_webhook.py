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


def test_tasknotes_identity_fetch_uses_board_qualified_query_and_bearer_token(plugin_api, monkeypatch):
    requests: list = []
    monkeypatch.setenv("HERMES_TASKNOTES_API_TOKEN", "token-123")

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps({"data": {"tasks": []}}).encode("utf-8")

    def fake_urlopen(request, timeout):
        requests.append(request)
        assert timeout == 10
        return FakeResponse()

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    assert plugin_api._fetch_tasknotes_task_latest({"board": "default", "task_id": "t_boardscoped"}) is None

    assert len(requests) == 1
    request = requests[0]
    assert request.full_url == "http://tasknotes.local/api/tasks/query"
    assert request.get_method() == "POST"
    assert request.headers["Authorization"] == "Bearer token-123"
    assert request.headers["Content-type"] == "application/json"
    assert json.loads(request.data.decode("utf-8")) == {
        "type": "group",
        "id": "hermes-tasknotes-webhook-fetch",
        "conjunction": "and",
        "children": [
            {
                "type": "condition",
                "id": "hermes-board",
                "property": "user:hermesBoard",
                "operator": "is",
                "value": "default",
            },
            {
                "type": "condition",
                "id": "hermes-task-id",
                "property": "user:hermesTaskId",
                "operator": "is",
                "value": "t_boardscoped",
            },
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


def test_tasknotes_discovery_supports_top_level_payload_and_does_not_send_cursor(plugin_api, monkeypatch):
    requests: list = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(
                {
                    "tasks": [
                        {
                            "title": "Root payload task",
                            "hermesBoard": "default",
                            "hermesTaskId": "t_root_payload",
                        },
                        {
                            "title": "Missing frontmatter task",
                            "path": "TaskNotes/Tasks/inbox.md",
                        },
                    ],
                    "total": 2,
                    "filtered": 2,
                }
            ).encode("utf-8")

    def fake_urlopen(request, timeout):
        requests.append(request)
        return FakeResponse()

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    result = plugin_api._discover_tasknotes_tasks("default", cursor="next-page-token")

    assert [item["identity"] for item in result["tasks"]] == [{"board": "default", "task_id": "t_root_payload"}]
    assert result["cursor"] == {
        "requestCursor": "next-page-token",
        "nextCursor": None,
        "querySupportsCursor": False,
        "total": 2,
        "filtered": 2,
    }
    assert "next-page-token" not in requests[0].data.decode("utf-8")


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


def test_tasknotes_reconciliation_deduplicates_repeated_tasknotes_identities(client, plugin_api, monkeypatch):
    identity = {"board": "default", "task_id": "t_duplicate_note"}
    duplicate_task = {
        "title": "Duplicate TaskNotes row",
        "status": "ready",
        "contexts": ["peacock"],
        "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_duplicate_note"},
        "path": "TaskNotes/Tasks/default--t_duplicate_note.md",
    }
    discovered = {
        "tasks": [
            {"identity": identity, "task": duplicate_task},
            {"identity": dict(identity), "task": dict(duplicate_task)},
        ],
        "cursor": {"requestCursor": None, "nextCursor": None, "querySupportsCursor": False, "total": 2, "filtered": 2},
        "query": plugin_api._build_tasknotes_discovery_query("default"),
    }
    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_eligible_tasks", lambda board, cursor=None: discovered)

    response = client.post("/api/plugins/kanban/tasknotes/reconcile?board=default")

    assert response.status_code == 200
    body = response.json()
    assert body["eligibleTaskNotesCount"] == 2
    assert body["seen"] == [
        {"identity": identity, "queue_task_id": body["seen"][0]["queue_task_id"], "existed": False}
    ]
    assert body["recovered"] == [{"identity": identity, "queue_task_id": body["seen"][0]["queue_task_id"]}]
    with kb.connect(board="default") as conn:
        rows = conn.execute(
            "SELECT title, idempotency_key FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:default:t_duplicate_note",),
        ).fetchall()
    assert len(rows) == 1
    assert rows[0]["title"] == "Duplicate TaskNotes row"


def test_tasknotes_reconciliation_maps_same_task_id_to_board_qualified_queue_state(plugin_api):
    kb.init_db(board="other")
    default_queue_id = plugin_api._sync_tasknotes_task_to_queue(
        {"board": "default", "task_id": "t_shared_id"},
        {
            "title": "Default board task",
            "status": "ready",
            "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_shared_id"},
        },
    )
    other_queue_id = plugin_api._sync_tasknotes_task_to_queue(
        {"board": "other", "task_id": "t_shared_id"},
        {
            "title": "Other board task",
            "status": "done",
            "customProperties": {"hermesBoard": "other", "hermesTaskId": "t_shared_id"},
        },
    )

    assert default_queue_id != other_queue_id
    assert plugin_api._tasknotes_queue_task_id({"board": "default", "task_id": "t_shared_id"}) == default_queue_id
    assert plugin_api._tasknotes_queue_task_id({"board": "other", "task_id": "t_shared_id"}) == other_queue_id
    with kb.connect(board="default") as default_conn, kb.connect(board="other") as other_conn:
        default_row = default_conn.execute(
            "SELECT title, status FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:default:t_shared_id",),
        ).fetchone()
        other_row = other_conn.execute(
            "SELECT title, status FROM tasks WHERE idempotency_key = ?",
            ("tasknotes:other:t_shared_id",),
        ).fetchone()
    assert dict(default_row) == {"title": "Default board task", "status": "ready"}
    assert dict(other_row) == {"title": "Other board task", "status": "done"}


def test_tasknotes_reconciliation_recovers_deleted_tasknotes_without_duplicate_archived_rows(
    client, plugin_api, monkeypatch
):
    discovered = {
        "tasks": [
            {
                "identity": {"board": "default", "task_id": "t_reconcile_deleted"},
                "task": {
                    "title": "Deleted TaskNotes task",
                    "details": "Deleted upstream",
                    "status": "deleted",
                    "contexts": ["peacock"],
                    "customProperties": {"hermesBoard": "default", "hermesTaskId": "t_reconcile_deleted"},
                    "path": "TaskNotes/Tasks/default--t_reconcile_deleted.md",
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
    queue_task_id = first_body["seen"][0]["queue_task_id"]
    assert first_body["recovered"] == [
        {"identity": {"board": "default", "task_id": "t_reconcile_deleted"}, "queue_task_id": queue_task_id}
    ]
    assert second_body["recovered"] == []
    assert second_body["seen"] == [
        {"identity": {"board": "default", "task_id": "t_reconcile_deleted"}, "queue_task_id": queue_task_id, "existed": True}
    ]
    with kb.connect(board="default") as conn:
        rows = conn.execute(
            "SELECT id, status FROM tasks WHERE idempotency_key = ? ORDER BY created_at",
            ("tasknotes:default:t_reconcile_deleted",),
        ).fetchall()
    assert [(row["id"], row["status"]) for row in rows] == [(queue_task_id, "archived")]


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


def test_tasknotes_reconciliation_health_reports_failed_run(client, plugin_api, monkeypatch):
    def fail_discovery(board, cursor=None):
        raise plugin_api.HTTPException(status_code=502, detail="TaskNotes API fetch failed: timeout")

    monkeypatch.setattr(plugin_api, "_fetch_tasknotes_eligible_tasks", fail_discovery)

    reconcile = client.post("/api/plugins/kanban/tasknotes/reconcile?board=default&cursor=after-1")
    health = client.get("/api/plugins/kanban/tasknotes/reconcile/health?board=default")

    assert reconcile.status_code == 502
    assert health.status_code == 200
    body = health.json()
    assert body["ok"] is False
    assert body["cursor"] == {"requestCursor": "after-1", "nextCursor": None, "querySupportsCursor": False}
    assert body["lastRun"]["status"] == "failed"
    assert body["lastRun"]["eligibleTaskNotesCount"] == 0
    assert body["lastRun"]["seenCount"] == 0
    assert body["lastRun"]["recoveredCount"] == 0
    assert body["lastRun"]["error"] == "TaskNotes API fetch failed: timeout"


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



def _create_tasknotes_queue_task(*, title="Mirrored", body="Body", status="ready", priority=0, idempotency_key="tasknotes:default:t_writeback"):
    with kb.connect(board="default") as conn:
        task_id = kb.create_task(
            conn,
            title=title,
            body=body,
            assignee="peacock",
            created_by="test",
            initial_status="running",
            priority=priority,
            idempotency_key=idempotency_key,
        )
        conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
        conn.commit()
    return task_id


def _capture_tasknotes_writeback(plugin_api, monkeypatch, *, tasknotes_id="tn-writeback"):
    requests = []

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(self.payload).encode("utf-8")

    def fake_urlopen(request, timeout):
        requests.append(request)
        if request.get_method() == "POST":
            return FakeResponse({"data": {"tasks": [{"id": tasknotes_id}]}})
        return FakeResponse({"ok": True})

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)
    return requests


def test_dashboard_patch_writes_tasknotes_via_query_then_patch(client, plugin_api, monkeypatch):
    task_id = _create_tasknotes_queue_task()
    requests = _capture_tasknotes_writeback(plugin_api, monkeypatch)

    response = client.patch(
        f"/api/plugins/kanban/tasks/{task_id}?board=default",
        json={"title": "Dashboard title", "body": "Dashboard body", "priority": 7},
    )

    assert response.status_code == 200
    assert [req.get_method() for req in requests] == ["POST", "PATCH"]
    assert requests[0].full_url == "http://tasknotes.local/api/tasks/query"
    assert requests[1].full_url == "http://tasknotes.local/api/tasks/tn-writeback"
    assert json.loads(requests[1].data.decode("utf-8")) == {
        "title": "Dashboard title",
        "details": "Dashboard body",
        "priority": 7,
        "status": "ready",
    }


def test_tasknotes_writeback_fields_are_configurable(client, plugin_api, monkeypatch):
    monkeypatch.setenv("HERMES_TASKNOTES_WRITEBACK_FIELDS", "title,status")
    task_id = _create_tasknotes_queue_task(status="todo")
    requests = _capture_tasknotes_writeback(plugin_api, monkeypatch)

    response = client.patch(
        f"/api/plugins/kanban/tasks/{task_id}?board=default",
        json={"title": "Only title", "body": "Not sent", "priority": 9, "status": "ready"},
    )

    assert response.status_code == 200
    assert json.loads(requests[1].data.decode("utf-8")) == {"title": "Only title", "status": "ready"}


@pytest.mark.parametrize("value", ["0", "false", "no", "off", ""])
def test_tasknotes_writeback_falsey_env_disables_api_call(client, plugin_api, monkeypatch, value):
    monkeypatch.setenv("HERMES_TASKNOTES_WRITEBACK", value)
    task_id = _create_tasknotes_queue_task(idempotency_key="tasknotes:default:t_disabled")
    requests = _capture_tasknotes_writeback(plugin_api, monkeypatch)

    response = client.patch(
        f"/api/plugins/kanban/tasks/{task_id}?board=default",
        json={"title": "Disabled"},
    )

    assert response.status_code == 200
    assert requests == []


def test_tasknotes_sync_mode_reports_writeback_and_legacy_pull_opt_in(client, plugin_api, monkeypatch):
    response = client.get("/api/plugins/kanban/tasknotes/sync/mode")
    assert response.status_code == 200
    assert response.json()["mode"] == "api-writeback"
    assert response.json()["writebackEnabled"] is True
    assert response.json()["legacyDashboardSyncEnabled"] is False

    monkeypatch.setenv("HERMES_TASKNOTES_ENABLE_LEGACY_DASHBOARD_SYNC", "1")
    legacy = client.get("/api/plugins/kanban/tasknotes/sync/mode")
    assert legacy.status_code == 200
    assert legacy.json()["mode"] == "legacy-dashboard-sync"
    assert legacy.json()["legacyDashboardSyncEnabled"] is True


def test_tasknotes_writeback_only_for_tasknotes_idempotency_key_on_bulk_link_and_attachment(client, plugin_api, monkeypatch):
    tasknotes_id = _create_tasknotes_queue_task(idempotency_key="tasknotes:default:t_bulk_link_attach")
    plain_id = _create_tasknotes_queue_task(idempotency_key="plain-key")
    requests = _capture_tasknotes_writeback(plugin_api, monkeypatch)

    bulk = client.post(
        "/api/plugins/kanban/tasks/bulk?board=default",
        json={"ids": [tasknotes_id, plain_id], "priority": 3},
    )
    link = client.post(
        "/api/plugins/kanban/links?board=default",
        json={"parent_id": plain_id, "child_id": tasknotes_id},
    )
    upload = client.post(
        f"/api/plugins/kanban/tasks/{tasknotes_id}/attachments?board=default",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )

    assert bulk.status_code == 200
    assert link.status_code == 200
    assert upload.status_code == 200
    assert [req.get_method() for req in requests].count("PATCH") == 3
    assert all(req.full_url == "http://tasknotes.local/api/tasks/tn-writeback" for req in requests if req.get_method() == "PATCH")
