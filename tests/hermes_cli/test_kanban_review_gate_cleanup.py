from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _block_for_review(conn, task_id: str, reason: str) -> None:
    assert kb.claim_task(conn, task_id)
    current = kb.get_task(conn, task_id)
    assert current is not None
    assert kb.block_task(conn, task_id, reason=reason, expected_run_id=current.current_run_id)


def _age_latest_block(conn, task_id: str, seconds: int) -> None:
    conn.execute(
        """
        UPDATE task_events
           SET created_at = ?
         WHERE id = (
             SELECT id FROM task_events
              WHERE task_id = ? AND kind = 'blocked'
              ORDER BY id DESC LIMIT 1
         )
        """,
        (int(time.time()) - seconds, task_id),
    )
    conn.commit()


def test_review_gate_cleanup_dry_run_finds_only_verified_smoke_artifacts(kanban_home: Path) -> None:
    with kb.connect() as conn:
        artifact = kb.create_task(
            conn,
            title="smoke review gate fixture",
            body="synthetic demo artifact from dashboard smoke test",
            assignee="peacock",
            created_by="smoke-test",
            idempotency_key="smoke-review-gate-fixture",
        )
        _block_for_review(conn, artifact, "review-required: demo fixture needs fake sign-off")
        _age_latest_block(conn, artifact, 9 * 24 * 3600)

        real = kb.create_task(
            conn,
            title="real feature review gate with tests",
            body="Production task mentions tests but has no automation provenance.",
            assignee="peacock",
            created_by="vaitheesh",
        )
        _block_for_review(conn, real, "review-required: please review the real feature tests")
        _age_latest_block(conn, real, 9 * 24 * 3600)

        resolved = kb.create_task(
            conn,
            title="old smoke fixture already resolved",
            assignee="peacock",
            created_by="smoke-test",
        )
        assert kb.complete_task(conn, resolved, result="historical resolved gate should stay visible")

        result = kb.cleanup_stale_review_gate_artifacts(
            conn,
            older_than_seconds=7 * 24 * 3600,
            apply=False,
        )

        assert result["dry_run"] is True
        assert [c["task_id"] for c in result["candidates"]] == [artifact]
        artifact_task = kb.get_task(conn, artifact)
        real_task = kb.get_task(conn, real)
        resolved_task = kb.get_task(conn, resolved)
        assert artifact_task is not None and artifact_task.status == "blocked"
        assert real_task is not None and real_task.status == "blocked"
        assert resolved_task is not None and resolved_task.status == "done"


def test_review_gate_cleanup_apply_archives_fixture_and_writes_checkpoint(kanban_home: Path) -> None:
    with kb.connect() as conn:
        artifact = kb.create_task(
            conn,
            title="demo review gate fixture",
            body="synthetic stale artifact",
            assignee="peacock",
            created_by="pytest-fixture",
        )
        _block_for_review(conn, artifact, "review-required: smoke artifact sign-off")
        _age_latest_block(conn, artifact, 9 * 24 * 3600)

        result = kb.cleanup_stale_review_gate_artifacts(
            conn,
            older_than_seconds=7 * 24 * 3600,
            apply=True,
            author="test-maintenance",
        )

        assert result["dry_run"] is False
        assert result["applied_task_ids"] == [artifact]
        assert result["integrity_before"] == "ok"
        assert result["integrity_after"] == "ok"
        checkpoint = Path(result["checkpoint_path"])
        assert checkpoint.exists()
        archived_task = kb.get_task(conn, artifact)
        assert archived_task is not None and archived_task.status == "archived"
        comments = kb.list_comments(conn, artifact)
        assert any("cleanup-review-gates --apply" in c.body for c in comments)

        backup = sqlite3.connect(checkpoint)
        backup.row_factory = sqlite3.Row
        try:
            row = backup.execute("SELECT status FROM tasks WHERE id = ?", (artifact,)).fetchone()
            assert row["status"] == "blocked"
            assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            backup.close()


def test_review_gate_cleanup_apply_json_shape_is_serializable(kanban_home: Path) -> None:
    with kb.connect() as conn:
        result = kb.cleanup_stale_review_gate_artifacts(conn, apply=False)
    encoded = json.dumps(result, sort_keys=True)
    assert '"candidates"' in encoded
