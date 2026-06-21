from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_BOARD", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_HOME", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb._INITIALIZED_PATHS.clear()
    kb.init_db()
    return home


def _loop_node(
    conn,
    *,
    root_task_id: str = "t_looproot",
    title: str = "loop worker node",
    parents: tuple[str, ...] = (),
    tenant: str | None = None,
    session_id: str | None = None,
) -> str:
    task_id = kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by=f"loop:{root_task_id}",
        parents=parents,
        tenant=tenant,
        session_id=session_id,
    )
    with kb.write_txn(conn):
        kb._append_event(
            conn,
            task_id,
            "loop_node_state",
            {
                "root_task_id": root_task_id,
                "client_id": title.replace(" ", "-"),
                "active": bool(not parents),
                "frontier": bool(not parents),
            },
        )
    return task_id


def _loop_root_node(
    conn,
    *,
    title: str = "loop root node",
    tenant: str | None = None,
    session_id: str | None = None,
) -> str:
    task_id = _loop_node(
        conn,
        root_task_id="pending-root",
        title=title,
        tenant=tenant,
        session_id=session_id,
    )
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET created_by = ? WHERE id = ?", (f"loop:{task_id}", task_id))
        kb._append_event(
            conn,
            task_id,
            "loop_node_state",
            {
                "root_task_id": task_id,
                "client_id": title.replace(" ", "-"),
                "active": True,
                "frontier": True,
            },
        )
    return task_id


def _handoff_events(conn, task_id: str):
    return [event for event in kb.list_events(conn, task_id) if event.kind == "loop_foreground_handoff"]


def _parented_loop_closeout(
    conn,
    *,
    title: str = "loop root closeout",
    tenant: str | None = None,
) -> tuple[str, tuple[str, str]]:
    parent_a = kb.create_task(conn, title="implementation gate", assignee="implementation-worker", tenant=tenant)
    parent_b = kb.create_task(conn, title="qa gate", assignee="implementation-worker", tenant=tenant)
    assert kb.claim_task(conn, parent_a, claimer="worker-host:parent-a") is not None
    assert kb.complete_task(conn, parent_a, summary="implementation gate done")
    assert kb.claim_task(conn, parent_b, claimer="worker-host:parent-b") is not None
    assert kb.complete_task(conn, parent_b, summary="qa gate done")
    closeout_id = kb.create_task(
        conn,
        title=title,
        assignee="implementation-worker",
        created_by="loop:pending-root",
        parents=(parent_a, parent_b),
        tenant=tenant,
    )
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET created_by = ? WHERE id = ?", (f"loop:{closeout_id}", closeout_id))
        for task_id in (parent_a, parent_b):
            conn.execute("UPDATE tasks SET created_by = ? WHERE id = ?", (f"loop:{closeout_id}", task_id))
        kb._append_event(
            conn,
            closeout_id,
            "loop_node_state",
            {
                "root_task_id": closeout_id,
                "client_id": "root-closeout",
                "active": True,
                "frontier": True,
            },
        )
    return closeout_id, (parent_a, parent_b)


def test_completing_loop_root_node_emits_compact_foreground_handoff_event(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_root_node(conn)
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:123")
        assert claimed is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="backend contract tests are ready",
            metadata={"artifacts": ["/tmp/contract.log"]},
        )

        handoffs = _handoff_events(conn, task_id)

    assert len(handoffs) == 1
    payload = handoffs[0].payload
    assert payload == {
        "root_task_id": task_id,
        "handoff_kind": "worker_completed",
        "attention": "needs-orchestrator",
        "verification_state": "needs-orchestrator",
        "run_id": handoffs[0].run_id,
        "summary": "backend contract tests are ready",
        "artifacts": ["/tmp/contract.log"],
    }



def test_routine_child_completion_records_run_but_no_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_node(conn, root_task_id="t_looproot", title="loop root")
        child_id = _loop_node(conn, root_task_id="t_looproot", title="routine child", parents=(root_id,))
        assert kb.claim_task(conn, root_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, root_id, summary="root released child work")
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (child_id,))
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.complete_task(
            conn,
            child_id,
            summary="routine child evidence is stored on the run",
            metadata={"changed_files": ["worker.py"], "tests_run": ["pytest child"]},
        )

        child_events = _handoff_events(conn, child_id)
        child_handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        runs = kb.list_runs(conn, child_id)

    assert child_events == []
    assert child_handoffs == []
    assert runs[-1].summary == "routine child evidence is stored on the run"
    assert runs[-1].metadata["changed_files"] == ["worker.py"]


def test_parent_free_loop_child_completion_records_run_but_no_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="first decomposed child")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.complete_task(conn, child_id, summary="parent-free child finished")

        assert _handoff_events(conn, child_id) == []
        assert kb.list_loop_handoffs(conn, task_id=child_id) == []
        runs = kb.list_runs(conn, child_id)

    assert runs[-1].summary == "parent-free child finished"


def test_loop_child_gave_up_creates_one_foreground_attention_handoff(kanban_home, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "default")
    with kb.connect() as conn:
        root_id = _loop_node(
            conn,
            root_task_id="t_looproot",
            title="loop root",
            tenant="tenant-a",
            session_id="foreground-session",
        )
        child_id = _loop_node(
            conn,
            root_task_id="t_looproot",
            title="startup-failing child",
            parents=(root_id,),
            tenant="tenant-a",
        )
        assert kb.claim_task(conn, root_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, root_id, summary="root released child work")
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (child_id,))
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        tripped = kb._record_task_failure(
            conn,
            child_id,
            "worker exited before lifecycle tool call",
            outcome="spawn_failed",
            failure_limit=1,
            release_claim=True,
            end_run=True,
        )
        duplicate_tick = kb._record_task_failure(
            conn,
            child_id,
            "worker exited before lifecycle tool call",
            outcome="spawn_failed",
            failure_limit=1,
            release_claim=True,
            end_run=True,
        )

        handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        events = _handoff_events(conn, child_id)
        task = kb.get_task(conn, child_id)

    assert tripped is True
    assert duplicate_tick is True
    assert task is not None
    assert task.status == "blocked"
    assert len(handoffs) == 1
    handoff = handoffs[0]
    assert handoff["handoff_kind"] == "worker_gave_up"
    assert handoff["state"] == "queued"
    assert handoff["root_task_id"] == "t_looproot"
    assert handoff["task_id"] == child_id
    assert handoff["tenant"] == "tenant-a"
    assert handoff["originating_session_id"] == "foreground-session"
    assert handoff["reason"] == "Loop child task gave up after spawn_failed before completing or blocking."
    assert handoff["worker_metadata"]["failed_task_id"] == child_id
    assert handoff["worker_metadata"]["loop_root_task_id"] == "t_looproot"
    assert handoff["worker_metadata"]["board"] == "default"
    assert handoff["worker_metadata"]["tenant"] == "tenant-a"
    assert handoff["worker_metadata"]["originating_session_id"] == "foreground-session"
    assert handoff["worker_metadata"]["latest_failure"]["trigger_outcome"] == "spawn_failed"
    assert handoff["worker_metadata"]["latest_failure"]["failures"] == 1
    assert len(events) == 1
    assert events[0].payload["handoff_kind"] == "worker_gave_up"


def test_loop_child_protocol_violation_retry_then_gave_up_records_one_attention_handoff(
    kanban_home,
    monkeypatch,
):
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "default")
    with kb.connect() as conn:
        root_id = _loop_node(
            conn,
            root_task_id="t_looproot",
            title="loop root",
            tenant="tenant-a",
            session_id="foreground-session",
        )
        child_id = _loop_node(
            conn,
            root_task_id="t_looproot",
            title="protocol-violating child",
            parents=(root_id,),
            tenant="tenant-a",
        )
        assert kb.claim_task(conn, root_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, root_id, summary="root released child work")
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (child_id,))

        assert kb.claim_task(conn, child_id, claimer="worker-host:child-1") is not None
        first_tripped = kb._record_task_failure(
            conn,
            child_id,
            "worker exited before kanban_complete/kanban_block",
            outcome="protocol_violation",
            failure_limit=2,
            release_claim=True,
            end_run=True,
            event_payload_extra={"failure_evidence": "missing lifecycle tool call"},
        )
        after_first = kb.get_task(conn, child_id)
        first_events = [event.kind for event in kb.list_events(conn, child_id)]

        assert after_first is not None and after_first.status == "ready"
        assert first_tripped is False
        assert "protocol_violation" in first_events
        assert "gave_up" not in first_events
        assert kb.list_loop_handoffs(conn, task_id=child_id) == []

        assert kb.claim_task(conn, child_id, claimer="worker-host:child-2") is not None
        second_tripped = kb._record_task_failure(
            conn,
            child_id,
            "worker exited before kanban_complete/kanban_block",
            outcome="protocol_violation",
            failure_limit=2,
            release_claim=True,
            end_run=True,
            event_payload_extra={"failure_evidence": "missing lifecycle tool call"},
        )
        duplicate_tick = kb._record_task_failure(
            conn,
            child_id,
            "worker exited before kanban_complete/kanban_block",
            outcome="protocol_violation",
            failure_limit=2,
            release_claim=True,
            end_run=True,
            event_payload_extra={"failure_evidence": "missing lifecycle tool call"},
        )

        runs = kb.list_runs(conn, child_id)
        gave_up_events = [event for event in kb.list_events(conn, child_id) if event.kind == "gave_up"]
        handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        task = kb.get_task(conn, child_id)
        proof_packet = kb.build_loop_handoff_proof_packet(conn, handoffs[0]["id"])

    assert second_tripped is True
    assert duplicate_tick is True
    assert task is not None and task.status == "blocked"
    assert [run.outcome for run in runs] == ["protocol_violation", "gave_up"]
    assert len(gave_up_events) == 2
    assert len(handoffs) == 1
    handoff = handoffs[0]
    assert handoff["handoff_kind"] == "worker_gave_up"
    assert handoff["root_task_id"] == "t_looproot"
    assert handoff["task_id"] == child_id
    assert handoff["tenant"] == "tenant-a"
    assert handoff["originating_session_id"] == "foreground-session"
    assert handoff["reason"] == (
        "Loop child task gave up after protocol_violation before completing or blocking."
    )
    metadata = handoff["worker_metadata"]
    assert metadata["failed_task_id"] == child_id
    assert metadata["loop_root_task_id"] == "t_looproot"
    assert metadata["board"] == "default"
    assert metadata["tenant"] == "tenant-a"
    assert metadata["originating_session_id"] == "foreground-session"
    assert metadata["latest_failure"] == {
        "failures": 2,
        "effective_limit": 2,
        "limit_source": "dispatcher",
        "error": "worker exited before kanban_complete/kanban_block",
        "trigger_outcome": "protocol_violation",
        "failure_evidence": "missing lifecycle tool call",
    }
    assert proof_packet["worker"]["reason"] == handoff["reason"]
    assert proof_packet["worker"]["metadata"] == metadata
    assert proof_packet["evidence"]["verification_state"] == "needs-orchestrator"
    assert proof_packet["audit_ids"]["source_event_kind"] == "gave_up"


def test_non_loop_gave_up_does_not_create_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        task_id = kb.create_task(conn, title="plain failing task", assignee="worker")
        assert kb.claim_task(conn, task_id, claimer="plain:1") is not None

        assert kb._record_task_failure(
            conn,
            task_id,
            "plain worker failed to start",
            outcome="spawn_failed",
            failure_limit=1,
            release_claim=True,
            end_run=True,
        )

        assert kb.list_loop_handoffs(conn, task_id=task_id) == []
        assert _handoff_events(conn, task_id) == []


def test_decomposed_loop_children_inherit_root_routing_for_failure_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = kb.create_task(
            conn,
            title="loop triage root",
            assignee="decomposer",
            created_by="loop:t_looproot",
            tenant="tenant-a",
            triage=True,
            session_id="foreground-session",
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root_id,
            root_assignee="orchestrator",
            children=[{"title": "implementation child", "assignee": "worker"}],
            author="decomposer",
        )
        assert isinstance(child_ids, list)
        child_id = child_ids[0]
        child = kb.get_task(conn, child_id)
        created_events = [event for event in kb.list_events(conn, child_id) if event.kind == "created"]
        assert created_events
        created_event = created_events[-1]
        assert created_event.payload is not None

    assert child is not None
    assert child.created_by == "loop:t_looproot"
    assert child.session_id == "foreground-session"
    assert created_event.payload["from_decompose_of"] == root_id
    assert created_event.payload["loop_root_task_id"] == "t_looproot"


def test_blocking_loop_root_node_emits_pending_foreground_handoff_reason(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_root_node(conn, title="loop blocker")
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:456")
        assert claimed is not None

        assert kb.block_task(conn, task_id, reason="needs product decision")

        handoffs = _handoff_events(conn, task_id)

    assert len(handoffs) == 1
    assert handoffs[0].payload == {
        "root_task_id": task_id,
        "handoff_kind": "worker_blocked",
        "attention": "needs-orchestrator",
        "verification_state": "needs-orchestrator",
        "run_id": handoffs[0].run_id,
        "reason": "needs product decision",
    }


def test_routine_loop_child_block_records_run_but_no_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="routine blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(conn, child_id, reason="blocked on unit test failure")

        assert _handoff_events(conn, child_id) == []
        assert kb.list_loop_handoffs(conn, task_id=child_id) == []
        runs = kb.list_runs(conn, child_id)

    assert runs[-1].summary == "blocked on unit test failure"


def test_review_required_loop_child_block_emits_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="review blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(conn, child_id, reason="review-required: verify branch before merge")

        handoffs = _handoff_events(conn, child_id)
        durable_handoffs = kb.list_loop_handoffs(conn, task_id=child_id)

    assert len(handoffs) == 1
    payload = handoffs[0].payload
    assert payload is not None
    assert payload["root_task_id"] == root_id
    assert payload["handoff_kind"] == "worker_blocked"
    assert payload["reason"] == "review-required: verify branch before merge"
    assert len(durable_handoffs) == 1
    assert durable_handoffs[0]["reason"] == "review-required: verify branch before merge"


def test_structured_loop_child_block_metadata_emits_and_persists_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="structured blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(
            conn,
            child_id,
            reason="blocked waiting on launch-region decision",
            summary="launch region decision is unresolved",
            metadata={
                "foreground_handoff": True,
                "handoff_kind": "blocked_waiting",
                "changed_files": ["launch.py"],
                "artifacts": ["/tmp/launch-plan.md"],
                "worker_session_id": "worker-session-42",
            },
        )

        handoffs = _handoff_events(conn, child_id)
        durable_handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        raw_handoff = conn.execute(
            """
            SELECT summary, reason, worker_metadata_json, artifacts_json, changed_files_json
              FROM loop_handoffs
             WHERE task_id = ?
            """,
            (child_id,),
        ).fetchone()
        runs = kb.list_runs(conn, child_id)

    assert len(handoffs) == 1
    payload = handoffs[0].payload
    assert payload is not None
    assert payload["root_task_id"] == root_id
    assert payload["handoff_kind"] == "worker_blocked"
    assert payload["summary"] == "launch region decision is unresolved"
    assert payload["reason"] == "blocked waiting on launch-region decision"
    assert payload["worker_session_id"] == "worker-session-42"
    assert payload["artifacts"] == ["/tmp/launch-plan.md"]
    assert len(durable_handoffs) == 1
    handoff = durable_handoffs[0]
    assert handoff["summary"] == "launch region decision is unresolved"
    assert handoff["reason"] == "blocked waiting on launch-region decision"
    assert handoff["worker_metadata"] is not None
    assert handoff["worker_metadata"]["foreground_handoff"] is True
    assert handoff["artifacts"] == ["/tmp/launch-plan.md"]
    assert handoff["changed_files"] == ["launch.py"]
    assert raw_handoff is not None
    assert raw_handoff["summary"] == "launch region decision is unresolved"
    assert raw_handoff["reason"] == "blocked waiting on launch-region decision"
    assert json.loads(raw_handoff["worker_metadata_json"])["handoff_kind"] == "blocked_waiting"
    assert json.loads(raw_handoff["artifacts_json"]) == ["/tmp/launch-plan.md"]
    assert json.loads(raw_handoff["changed_files_json"]) == ["launch.py"]
    assert runs[-1].summary == "launch region decision is unresolved"
    assert runs[-1].metadata is not None
    assert runs[-1].metadata["handoff_kind"] == "blocked_waiting"


def test_loop_child_decision_request_emits_handoff_without_blocking_worker(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="decision worker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:decision") is not None
        run_id = kb.get_task(conn, child_id).current_run_id

        result = kb.request_loop_foreground_decision(
            conn,
            child_id,
            question="Which parser strategy should the worker implement?",
            options=[
                {"label": "Strict parser", "tradeoff": "More validation"},
                {"label": "Lenient parser", "tradeoff": "Faster migration"},
            ],
            recommendation="Strict parser",
            summary="Foreground must choose parser strategy.",
            reason="The choice affects acceptance criteria.",
            metadata={"changed_files": ["parser.py"], "worker_session_id": "worker-session-77"},
            expected_run_id=run_id,
        )

        task = kb.get_task(conn, child_id)
        handoffs = _handoff_events(conn, child_id)
        durable_handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        decision_events = [
            event for event in kb.list_events(conn, child_id)
            if event.kind == "loop_decision_requested"
        ]

    assert result["ok"] is True
    assert task.status == "running"
    assert task.current_run_id == run_id
    assert len(decision_events) == 1
    assert decision_events[0].payload["handoff_kind"] == "worker_decision_requested"
    assert decision_events[0].payload["question"] == "Which parser strategy should the worker implement?"
    assert len(handoffs) == 1
    assert handoffs[0].payload["root_task_id"] == root_id
    assert handoffs[0].payload["handoff_kind"] == "worker_decision_requested"
    assert handoffs[0].payload["summary"] == "Foreground must choose parser strategy."
    assert len(durable_handoffs) == 1
    handoff = durable_handoffs[0]
    assert handoff["id"] == result["handoff"]["id"]
    assert handoff["state"] == "queued"
    assert handoff["worker_metadata"]["decision_request"] is True
    assert handoff["worker_metadata"]["question"] == "Which parser strategy should the worker implement?"
    assert handoff["worker_metadata"]["options"][0]["label"] == "Strict parser"
    assert handoff["worker_metadata"]["recommendation"] == "Strict parser"
    assert handoff["changed_files"] == ["parser.py"]
    assert handoff["worker_session_id"] == "worker-session-77"


def test_record_decision_closes_decision_handoff_without_releasing_loop_root(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="decision worker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:decision") is not None
        run_id = kb.get_task(conn, child_id).current_run_id
        result = kb.request_loop_foreground_decision(
            conn,
            child_id,
            question="Pick the implementation path.",
            options=["Path A", "Path B"],
            recommendation="Path B",
            summary="Foreground decision needed.",
            expected_run_id=run_id,
        )
        handoff_id = result["handoff"]["id"]

        action = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff_id,
            action="record_decision",
            actor="foreground-orchestrator",
            reason="Choose Path B; it preserves the existing API contract.",
        )
        handoff = kb.list_loop_handoffs(conn, task_id=child_id)[0]
        status = kb.loop_handoff_status(
            conn,
            tenant=handoff["tenant"],
            root_task_id=root_id,
        )
        root = kb.get_task(conn, root_id)
        child = kb.get_task(conn, child_id)

    assert action["ok"] is True
    assert action["outcome"] == "decision_recorded"
    assert handoff["state"] == "closed"
    assert handoff["verification_state"] == "decision-recorded"
    assert handoff["verification_status"] == "passed"
    assert handoff["decision_actor"] == "foreground-orchestrator"
    assert handoff["decision_reason"] == "Choose Path B; it preserves the existing API contract."
    assert status["approved_count"] == 0
    assert status["decision_recorded_count"] == 1
    assert status["resolved_count"] == 1
    assert status["quiet_green"] is True
    assert root.status == "ready"
    assert child.status == "running"
    assert child.current_run_id == run_id


def test_blocked_waiting_prefix_loop_child_block_emits_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="neutral blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(conn, child_id, reason="blocked-waiting: sample data path is unavailable")

        handoffs = _handoff_events(conn, child_id)
        durable_handoffs = kb.list_loop_handoffs(conn, task_id=child_id)

    assert len(handoffs) == 1
    assert handoffs[0].payload["root_task_id"] == root_id
    assert handoffs[0].payload["reason"] == "blocked-waiting: sample data path is unavailable"
    assert len(durable_handoffs) == 1
    assert durable_handoffs[0]["reason"] == "blocked-waiting: sample data path is unavailable"


def test_unblocking_loop_child_supersedes_pending_block_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root", tenant="tenant-a")
        child_id = _loop_node(conn, root_task_id=root_id, title="manual rescue blocker", tenant="tenant-a")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None
        assert kb.block_task(conn, child_id, reason="review-required: foreground should inspect this")
        handoff = kb.list_loop_handoffs(conn, task_id=child_id)[0]

        assert kb.unblock_task(conn, child_id)
        reviewed = kb.list_loop_handoffs(conn, task_id=child_id)[0]
        superseded_events = [
            event for event in kb.list_events(conn, child_id)
            if event.kind == "loop_handoff_superseded"
        ]
        conn.execute(
            """
            UPDATE loop_handoffs
               SET state = 'queued',
                   attention = 'needs-orchestrator',
                   verification_state = 'needs-orchestrator',
                   verification_status = 'unknown'
             WHERE id = ?
            """,
            (handoff["id"],),
        )

        next_child = _loop_node(conn, root_task_id=root_id, title="next reviewer blocker", tenant="tenant-a")
        assert kb.claim_task(conn, next_child, claimer="worker-host:next") is not None
        assert kb.block_task(conn, next_child, reason="review-required: still needs foreground")
        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id=root_id,
            reviewer_session_id="review-session-1",
            limit=10,
        )
        post_claim_first = kb.list_loop_handoffs(conn, task_id=child_id)[0]

    assert reviewed["id"] == handoff["id"]
    assert reviewed["state"] == "cancelled_superseded"
    assert reviewed["attention"] is None
    assert reviewed["verification_state"] == "superseded"
    assert superseded_events and superseded_events[-1].payload["handoff_ids"] == [handoff["id"]]
    assert post_claim_first["state"] == "cancelled_superseded"
    assert [item["task_id"] for item in batch] == [next_child]


def test_loop_child_block_with_arbitrary_metadata_does_not_emit_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="ordinary structured blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(
            conn,
            child_id,
            reason="blocked on flaky unit test",
            summary="unit test needs local diagnosis",
            metadata={"foreground_handoff": True, "handoff_kind": "routine_note"},
        )

        assert _handoff_events(conn, child_id) == []
        assert kb.list_loop_handoffs(conn, task_id=child_id) == []
        runs = kb.list_runs(conn, child_id)

    assert runs[-1].summary == "unit test needs local diagnosis"
    assert runs[-1].metadata is not None
    assert runs[-1].metadata["handoff_kind"] == "routine_note"


def test_product_decision_prefix_loop_child_block_emits_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root")
        child_id = _loop_node(conn, root_task_id=root_id, title="product blocker")
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None

        assert kb.block_task(conn, child_id, reason="product-decision: pick copy")
        handoffs = _handoff_events(conn, child_id)

    assert len(handoffs) == 1
    payload = handoffs[0].payload
    assert payload is not None
    assert payload["root_task_id"] == root_id
    assert payload["reason"] == "product-decision: pick copy"


def test_non_loop_completion_and_block_do_not_emit_foreground_handoff_events(kanban_home):
    with kb.connect() as conn:
        completed_task = kb.create_task(conn, title="plain worker", assignee="worker")
        blocked_task = kb.create_task(conn, title="plain blocker", assignee="worker")
        assert kb.claim_task(conn, completed_task, claimer="plain:1") is not None
        assert kb.claim_task(conn, blocked_task, claimer="plain:2") is not None

        assert kb.complete_task(conn, completed_task, summary="normal completion")
        assert kb.block_task(conn, blocked_task, reason="normal block")

        completed_events = _handoff_events(conn, completed_task)
        blocked_events = _handoff_events(conn, blocked_task)

    assert completed_events == []
    assert blocked_events == []


def test_loop_completion_does_not_promote_downstream_until_foreground_release(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,))
        initial_child = kb.get_task(conn, child_id)
        assert initial_child is not None
        assert initial_child.status == "todo"
        assert kb.claim_task(conn, parent_id, claimer="worker-host:789") is not None

        assert kb.complete_task(conn, parent_id, summary="parent done but awaiting orchestrator")

        child = kb.get_task(conn, child_id)

    assert child is not None
    assert child.status == "todo"


def test_completion_records_durable_handoff_with_audit_identifiers(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a", session_id="origin-session")
        claimed = kb.claim_task(conn, task_id, claimer="worker-host:123")
        assert claimed is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="backend contract tests are ready",
            metadata={
                "worker_session_id": "worker-session-1",
                "artifacts": ["/tmp/contract.log"],
                "changed_files": ["hermes_cli/kanban_db.py"],
                "tests_run": 2,
            },
        )

        handoffs = kb.list_loop_handoffs(conn, root_task_id="t_looproot")

    assert len(handoffs) == 1
    handoff = handoffs[0]
    assert handoff["handoff_kind"] == "worker_completed"
    assert handoff["intent"] == "approve"
    assert handoff["target_actor"] == "orchestrator"
    assert handoff["queue_state"] == "open"
    assert handoff["state"] == "queued"
    assert handoff["tenant"] == "tenant-a"
    assert handoff["root_task_id"] == "t_looproot"
    assert handoff["task_id"] == task_id
    assert handoff["run_id"] is not None
    assert handoff["source_event_id"] is not None
    assert handoff["worker_profile"] == "implementation-worker"
    assert handoff["worker_session_id"] == "worker-session-1"
    assert handoff["originating_session_id"] == "origin-session"
    assert handoff["summary"] == "backend contract tests are ready"
    assert handoff["artifacts"] == ["/tmp/contract.log"]
    assert handoff["changed_files"] == ["hermes_cli/kanban_db.py"]
    assert handoff["payload"]["changed_files"] == ["hermes_cli/kanban_db.py"]
    assert handoff["verification_status"] == "unknown"
    assert handoff["parent_state_snapshot"] == []
    assert handoff["child_state_snapshot"] == []


def test_legacy_foreground_target_actor_normalizes_to_orchestrator(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None

        assert kb.complete_task(
            conn,
            task_id,
            summary="legacy foreground spelling should not leak",
            metadata={"target_actor": "foreground"},
        )

        handoff = kb.list_loop_handoffs(conn, root_task_id="t_looproot")[0]

    assert handoff["target_actor"] == "orchestrator"
    assert handoff["payload"]["worker_metadata"]["target_actor"] == "foreground"


def test_block_records_durable_handoff_reason(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop blocker", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:456") is not None

        assert kb.block_task(conn, task_id, reason="needs product decision")

        handoffs = kb.list_loop_handoffs(conn, tenant="tenant-a", state="queued")

    assert len(handoffs) == 1
    assert handoffs[0]["handoff_kind"] == "worker_blocked"
    assert handoffs[0]["intent"] == "unblock"
    assert handoffs[0]["target_actor"] == "orchestrator"
    assert handoffs[0]["queue_state"] == "open"
    assert handoffs[0]["reason"] == "needs product decision"
    assert handoffs[0]["attention"] == "needs-orchestrator"


def test_resolve_handoff_records_neutral_resolution_fields(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop decision", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:456") is not None
        assert kb.block_task(conn, task_id, reason="product-decision: choose a path")
        handoff = kb.list_loop_handoffs(conn, tenant="tenant-a", state="queued")[0]

        result = kb.resolve_handoff(
            conn,
            handoff["id"],
            action="choose-option-a",
            actor="foreground",
            resolution_summary="Use option A for the demo.",
            payload={"selected": "A"},
        )
        resolved = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        events = [event for event in kb.list_events(conn, task_id) if event.kind == "handoff_resolved"]

    assert result["ok"] is True
    assert result["queue_state"] == "resolved"
    assert resolved["queue_state"] == "resolved"
    assert resolved["resolution_action"] == "choose_option_a"
    assert resolved["resolved_by"] == "orchestrator"
    assert resolved["resolution_summary"] == "Use option A for the demo."
    assert resolved["payload"]["resolution_payload"] == {"selected": "A"}
    assert len(events) == 1


def test_duplicate_handoff_trigger_is_idempotent(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="done once")
        first = kb.list_loop_handoffs(conn)[0]

        with kb.write_txn(conn):
            kb._record_loop_handoff(
                conn,
                task_id,
                root_task_id="t_looproot",
                handoff_kind="worker_completed",
                run_id=first["run_id"],
                source_event_id=first["source_event_id"],
                summary="duplicate should not overwrite",
                metadata={"artifacts": ["/tmp/other.log"]},
                created_cards=None,
            )
        handoffs = kb.list_loop_handoffs(conn)

    assert len(handoffs) == 1
    assert handoffs[0]["id"] == first["id"]
    assert handoffs[0]["summary"] == "done once"
    assert handoffs[0]["artifacts"] == []


def test_claim_loop_handoff_batch_serializes_per_tenant_root_and_orders_dependencies(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer=f"worker:{parent_id}") is not None
        assert kb.complete_task(conn, parent_id, summary=f"done {parent_id}")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        other_id = _loop_node(conn, root_task_id="t_otherroot", title="other root", tenant="tenant-a")
        for task_id in (child_id, other_id):
            assert kb.claim_task(conn, task_id, claimer=f"worker:{task_id}") is not None
            assert kb.complete_task(conn, task_id, summary=f"done {task_id}")

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session-1",
            limit=10,
        )
        blocked_by_active = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session-2",
            limit=10,
        )
        other_batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_otherroot",
            reviewer_session_id="review-session-3",
            limit=10,
        )

    assert [handoff["task_id"] for handoff in batch] == [parent_id]
    assert {handoff["state"] for handoff in batch} == {"assigned"}
    assert {handoff["reviewer_session_id"] for handoff in batch} == {"review-session-1"}
    assert blocked_by_active == []
    assert [handoff["task_id"] for handoff in other_batch] == [other_id]


def test_root_completion_review_card_omits_duplicate_visible_summary(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="epistemic decision root", tenant="tenant-a")
        assert kb.claim_task(conn, root_id, claimer="worker:root") is not None
        assert kb.complete_task(
            conn,
            root_id,
            summary="Root adjudication complete: choose C with tests passing",
        )

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id=root_id,
            reviewer_session_id="origin-session",
            limit=10,
        )

    message = kb._render_loop_handoff_review_message(
        tenant="tenant-a",
        root_task_id=root_id,
        batch_id="loop-review:tenant-a:root:1",
        handoffs=batch,
    )
    payload = json.loads(message)

    assert payload["visible_cards"] == [
        {
            "task_title": "epistemic decision root",
            "summary": None,
            "action": "Open drawer",
            "payload_ref": f"loop_handoff:{batch[0]['id']}",
        }
    ]
    assert batch[0]["summary"] == "Root adjudication complete: choose C with tests passing"
    assert batch[0]["proof_packet"]["worker"]["summary"] == (
        "Root adjudication complete: choose C with tests passing"
    )


def test_attention_review_card_keeps_visible_summary(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root", tenant="tenant-a")
        child_id = _loop_node(conn, root_task_id=root_id, title="needs attention", tenant="tenant-a")
        assert kb.claim_task(conn, child_id, claimer="worker:child") is not None
        assert kb.block_task(conn, child_id, reason="review-required: proof gap needs foreground")

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id=root_id,
            reviewer_session_id="origin-session",
            limit=10,
        )

    message = kb._render_loop_handoff_review_message(
        tenant="tenant-a",
        root_task_id=root_id,
        batch_id="loop-review:tenant-a:root:1",
        handoffs=batch,
    )
    payload = json.loads(message)

    assert payload["visible_cards"][0]["task_title"] == "needs attention"
    assert payload["visible_cards"][0]["summary"] == "review-required: proof gap needs foreground"


def test_followup_created_child_handoff_does_not_block_later_foreground_handoff(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_root_node(conn, title="loop root", tenant="tenant-a")
        first_child = _loop_node(conn, root_task_id=root_id, title="first reviewer blocker", tenant="tenant-a")
        assert kb.claim_task(conn, first_child, claimer="worker:first") is not None
        assert kb.block_task(conn, first_child, reason="review-required: first gap needs followup")
        first_handoff = kb.list_loop_handoffs(conn, task_id=first_child)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            first_handoff["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=False,
            reason="turn first gap into follow-up work",
            followups=[{
                "kind": "test",
                "title": "Add first gap regression",
                "assignee": "implementation-worker",
                "body": "Cover the first reviewer gap.",
            }],
        )
        reviewed_first = kb.list_loop_handoffs(conn, task_id=first_child)[0]

        conn.execute(
            """
            UPDATE loop_handoffs
               SET state = 'assigned', attention = 'needs-orchestrator'
             WHERE id = ?
            """,
            (first_handoff["id"],),
        )

        second_child = _loop_node(conn, root_task_id=root_id, title="second reviewer blocker", tenant="tenant-a")
        assert kb.claim_task(conn, second_child, claimer="worker:second") is not None
        assert kb.block_task(conn, second_child, reason="review-required: second gap needs review")

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id=root_id,
            reviewer_session_id="review-session-2",
            limit=10,
        )

    assert result["outcome"] == "followups_created"
    assert reviewed_first["state"] == "closed"
    assert reviewed_first["attention"] is None
    assert reviewed_first["verification_state"] == "followups-created"
    assert [handoff["task_id"] for handoff in batch] == [second_child]


def test_loop_handoffs_survive_reconnect_and_expose_status_api(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="persisted")

    kb._INITIALIZED_PATHS.clear()
    with kb.connect() as conn:
        pending = kb.list_loop_handoffs(conn, state="queued")
        status = kb.loop_handoff_status(conn, tenant="tenant-a", root_task_id="t_looproot")

    assert len(pending) == 1
    assert pending[0]["task_id"] == task_id
    assert status | {
        "approved_count": 0,
        "escalated_count": 0,
        "needs_attention_count": 1,
        "quiet_green": False,
    } == status
    assert {
        key: status[key]
        for key in ("tenant", "root_task_id", "pending_count", "active_count", "terminal_count", "total_count")
    } == {
        "tenant": "tenant-a",
        "root_task_id": "t_looproot",
        "pending_count": 1,
        "active_count": 0,
        "terminal_count": 0,
        "total_count": 1,
    }


def test_claimed_reviewer_batch_includes_compact_proof_packets_and_detail_ref(kanban_home):
    with kb.connect() as conn:
        body = "Build thing.\n\nAcceptance criteria: tests pass and artifact exists"
        task_id = _loop_node(conn, tenant="tenant-a", session_id="origin-session")
        conn.execute("UPDATE tasks SET body = ? WHERE id = ?", (body, task_id))
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="implementation complete",
            metadata={
                "worker_session_id": "worker-session-1",
                "artifacts": ["/tmp/proof.log"],
                "changed_files": ["src/app.py"],
                "tests_run": ["pytest -q (passed)"],
            },
        )

        batch = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session-1",
        )
        packet = batch[0]["proof_packet"]
        details = kb.get_loop_handoff_details(conn, packet["handoff_id"])

    assert packet["packet_kind"] == "loop_handoff_proof_packet"
    assert packet["task"]["body"] == body
    assert packet["task"]["acceptance_criteria"] == "tests pass and artifact exists"
    assert packet["worker"]["summary"] == "implementation complete"
    assert packet["worker"]["transcript_session_id"] == "worker-session-1"
    assert packet["evidence"]["artifacts"] == ["/tmp/proof.log"]
    assert packet["evidence"]["changed_files"] == ["src/app.py"]
    assert packet["audit_ids"]["detail_ref"] == f"loop_handoff:{packet['handoff_id']}"
    assert details["proof_packet"]["handoff_id"] == packet["handoff_id"]
    assert len(details["events"]) >= 1


def test_handoff_details_expose_safe_transcript_and_artifact_metadata(kanban_home, tmp_path):
    proof = tmp_path / "proof.log"
    proof.write_text("A" * 5000 + "SECRET_AFTER_BOUND", encoding="utf-8")
    outside_secret = tmp_path / "outside-secret.txt"
    outside_secret.write_text("MUST_NOT_LEAK", encoding="utf-8")

    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a", session_id="origin-session")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="implementation complete",
            metadata={
                "worker_session_id": "worker-session-1",
                "artifacts": [str(proof), str(outside_secret)],
                "changed_files": ["src/app.py"],
            },
        )
        handoff = kb.list_loop_handoffs(conn)[0]
        details = kb.get_loop_handoff_details(conn, handoff["id"])

    assert details["detail_semantics"] == {
        "artifact_content": kb.LOOP_HANDOFF_ARTIFACT_DETAIL_POLICY,
        "transcript_content": "metadata_only",
    }
    assert details["transcript"]["worker_session_id"] == "worker-session-1"
    assert details["transcript"]["originating_session_id"] == "origin-session"
    assert details["transcript"]["content_preview"] is None

    artifacts = {item["path"]: item for item in details["artifact_details"]}
    assert artifacts[str(proof)] == {
        "path": str(proof),
        "content_preview": None,
        "content_policy": kb.LOOP_HANDOFF_ARTIFACT_DETAIL_POLICY,
    }
    assert artifacts[str(outside_secret)]["content_preview"] is None
    assert "MUST_NOT_LEAK" not in str(details)




def test_review_message_transcript_card_is_minimal_with_payload_reference(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="Reviewable worker", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:root") is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="Line one is visible.\nLine two stays out of the transcript card.",
            metadata={"changed_files": ["secretly-large-diff.py"], "tests_run": ["pytest -q"]},
        )
        handoff = kb.claim_loop_handoff_batch(
            conn,
            tenant="tenant-a",
            root_task_id="t_looproot",
            reviewer_session_id="review-session",
            limit=10,
        )[0]

    message = kb._render_loop_handoff_review_message(
        tenant="tenant-a",
        root_task_id="t_looproot",
        batch_id="batch-1",
        handoffs=[handoff],
    )

    assert "Reviewable worker" in message
    assert "Line one is visible." in message
    assert "Open drawer" in message
    assert "Line two stays out" not in message
    assert "secretly-large-diff.py" not in message
    assert "proof_packets" not in message
    assert f"loop_handoff:{handoff['id']}" in message
    assert "Accept" not in message
    assert "Reject" not in message
    assert "Escalate" not in message

def test_scheduler_claims_next_handoff_into_stable_review_session(kanban_home):
    from hermes_state import SessionDB

    session_db = SessionDB()
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        other_id = _loop_node(conn, title="other root", root_task_id="t_otherroot", tenant="tenant-a")
        conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (child_id,))
        for task_id in (parent_id, child_id, other_id):
            assert kb.claim_task(conn, task_id, claimer=f"worker:{task_id}") is not None
            assert kb.complete_task(conn, task_id, summary=f"done {task_id}", metadata={"tests_run": ["pytest -q"]})

        first = kb.claim_next_loop_handoff_review_batch(conn, session_db=session_db, limit=10)
        blocked_same_root = kb.claim_next_loop_handoff_review_batch(conn, session_db=session_db, limit=10)
        messages = session_db.get_messages(first["reviewer_session_id"])
        handoffs = kb.list_loop_handoffs(conn, tenant="tenant-a", root_task_id="t_looproot")
        events = [event for event in kb.list_events(conn, parent_id) if event.kind == "loop_handoff_review_session"]

    assert first is not None
    assert first["tenant"] == "tenant-a"
    assert first["root_task_id"] == "t_looproot"
    assert first["reviewer_session_id"] == kb.loop_handoff_reviewer_session_id("tenant-a", "t_looproot")
    assert [handoff["task_id"] for handoff in first["handoffs"]] == [parent_id]
    assert first["review_message_id"] is not None
    assert {handoff["reviewer_session_id"] for handoff in handoffs} == {first["reviewer_session_id"]}
    assert {handoff["review_run_id"] for handoff in handoffs} == {first["review_message_id"]}
    assert messages and messages[0]["role"] == "user"
    assert "Open drawer" in messages[0]["content"]
    assert "loop_handoff_proof_packet" not in messages[0]["content"]
    assert str(first["handoffs"][0]["id"]) in messages[0]["content"]
    assert blocked_same_root is not None
    assert blocked_same_root["root_task_id"] == "t_otherroot"
    assert events and events[-1].payload["reviewer_session_id"] == first["reviewer_session_id"]
    assert events[-1].payload["review_run_id"] == first["review_message_id"]
    prompt = kb._loop_handoff_review_runner_prompt(first)
    assert "payload_ref" in prompt
    assert "drawer/API" in prompt
    assert "review_loop_handoff_autonomous_action" in prompt
    assert "Treat worker blocks as neutral unresolved blockers" in prompt
    assert "Escalate to the user only when" in prompt
    assert "Do not finish with prose" in prompt
    assert "durable action returns ok" in prompt
    assert "proof packets" not in prompt


def test_scheduler_default_review_session_db_matches_reviewer_profile(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    reviewer_home = kanban_home / "profiles" / "reviewer-qa"
    reviewer_home.mkdir(parents=True)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    monkeypatch.setattr(kb, "_loop_handoff_reviewer_profile", lambda: "reviewer-qa")

    with kb.connect() as conn:
        task_id = _loop_node(conn, title="profile-routed reviewable node", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="ready for reviewer profile", metadata={"tests_run": ["pytest -q"]})

        batch = kb.claim_next_loop_handoff_review_batch(conn, limit=10)

    assert batch is not None
    reviewer_db = SessionDB(db_path=reviewer_home / "state.db")
    default_db = SessionDB(db_path=kanban_home / "state.db")

    reviewer_messages = reviewer_db.get_messages(batch["reviewer_session_id"])
    default_messages = default_db.get_messages(batch["reviewer_session_id"])

    assert reviewer_messages and "kanban_loop_handoff_review_batch" in reviewer_messages[0]["content"]
    assert default_messages == []


def test_scheduler_routes_live_originating_session_instead_of_synthetic_review(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB
    from hermes_cli import kanban_live_events

    origin_session_id = "20260615_origin_live"
    published_messages = []
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    monkeypatch.setattr(
        kanban_live_events,
        "emit_session_message_appended",
        lambda **kwargs: published_messages.append(kwargs) or True,
    )
    session_db = SessionDB()
    session_db.create_session(origin_session_id, "tui", model="gpt-test")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="live foreground handoff node",
            tenant=origin_session_id,
            session_id=origin_session_id,
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="ready for originating session", metadata={"tests_run": ["pytest -q"]})

        batch = kb.claim_next_loop_handoff_review_batch(conn, limit=10)
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        events = [event for event in kb.list_events(conn, task_id) if event.kind == "loop_handoff_review_session"]

    synthetic_session_id = kb.loop_handoff_reviewer_session_id(origin_session_id, "t_looproot")
    messages = session_db.get_messages(origin_session_id)

    assert batch is not None
    assert batch["reviewer_session_id"] == origin_session_id
    assert batch["reviewer_profile"] == "default"
    assert batch["review_route"] == "foreground"
    assert handoff["reviewer_session_id"] == origin_session_id
    assert handoff["review_run_id"] == batch["review_message_id"]
    assert session_db.get_session(synthetic_session_id) is None
    assert messages and "kanban_loop_handoff_review_batch" in messages[0]["content"]
    assert published_messages
    assert published_messages[-1]["session_id"] == origin_session_id
    assert published_messages[-1]["message_id"] == batch["review_message_id"]
    assert published_messages[-1]["reason"] == "loop_handoff_review_batch"
    assert published_messages[-1]["metadata"]["review_route"] == "foreground"
    assert events
    assert events[-1].payload is not None
    assert events[-1].payload["review_route"] == "foreground"


def test_scheduler_defers_live_originating_session_while_busy(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    origin_session_id = "20260615_origin_busy"
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    session_db = SessionDB()
    session_db.create_session(origin_session_id, "tui", model="gpt-test")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="busy foreground handoff node",
            tenant=origin_session_id,
            session_id=origin_session_id,
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(
            conn,
            task_id,
            summary="ready for busy origin",
            metadata={"tests_run": ["pytest -q"]},
        )

        batch = kb.claim_next_loop_handoff_review_batch(
            conn,
            limit=10,
            session_busy=lambda session_id: session_id == origin_session_id,
        )
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        events = [
            event
            for event in kb.list_events(conn, task_id)
            if event.kind == "loop_handoff_review_session"
        ]

    synthetic_session_id = kb.loop_handoff_reviewer_session_id(
        origin_session_id, "t_looproot"
    )

    assert batch is None
    assert handoff["state"] == "queued"
    assert handoff["reviewer_session_id"] is None
    assert handoff["review_run_id"] is None
    assert session_db.get_messages(origin_session_id) == []
    assert session_db.get_session(synthetic_session_id) is None
    assert events == []


def test_scheduler_routes_originating_compression_root_to_live_tip(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    root_session_id = "20260615_origin_root"
    tip_session_id = "20260615_origin_tip"
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    session_db = SessionDB()
    session_db.create_session(root_session_id, "tui", model="gpt-test")
    session_db.end_session(root_session_id, "compression")
    session_db.create_session(tip_session_id, "tui", parent_session_id=root_session_id, model="gpt-test")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="compressed foreground handoff node",
            tenant=root_session_id,
            session_id=root_session_id,
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="ready for compression tip", metadata={"tests_run": ["pytest -q"]})

        batch = kb.claim_next_loop_handoff_review_batch(conn, limit=10)
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]

    assert batch is not None
    assert batch["reviewer_session_id"] == tip_session_id
    assert batch["review_route"] == "foreground"
    assert handoff["reviewer_session_id"] == tip_session_id
    assert session_db.get_messages(root_session_id) == []
    tip_messages = session_db.get_messages(tip_session_id)
    assert tip_messages and "kanban_loop_handoff_review_batch" in tip_messages[0]["content"]


def test_background_scheduler_defers_live_foreground_handoff_until_idle_boundary(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    session_db = SessionDB()
    session_db.create_session("foreground-live", "tui", model="gpt-test")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="foreground-owned handoff",
            tenant="tenant-a",
            session_id="foreground-live",
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="ready for foreground owner")

        deferred = kb.run_next_loop_handoff_review_batch(
            conn,
            session_db=session_db,
            defer_live_foreground=True,
            review_runner=lambda batch: pytest.fail("live foreground handoff should not spawn a reviewer subprocess"),
        )
        handoff_before_idle = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        calls = []
        drained = kb.run_next_loop_handoff_review_batch(
            conn,
            session_db=session_db,
            required_live_session_id="foreground-live",
            session_busy=lambda candidate: str(candidate) != "foreground-live",
            review_runner=lambda batch: calls.append(batch) or {"ok": True, "mode": "foreground_idle_boundary"},
        )
        handoff_after_idle = kb.list_loop_handoffs(conn, task_id=task_id)[0]

    assert deferred is None
    assert handoff_before_idle["state"] in {"recorded", "queued", "batched"}
    assert drained is not None
    assert drained["review_route"] == "foreground"
    assert drained["reviewer_session_id"] == "foreground-live"
    assert calls and calls[0]["reviewer_session_id"] == "foreground-live"
    assert handoff_after_idle["state"] == "assigned"


def test_background_scheduler_uses_durable_dedicated_route_after_origin_session_ends(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    session_db = SessionDB()
    session_db.create_session("foreground-ended", "tui", model="gpt-test")
    session_db.end_session("foreground-ended", "closed")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="ended foreground fallback",
            tenant="tenant-a",
            session_id="foreground-ended",
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="needs fallback reviewer")

        calls = []
        batch = kb.run_next_loop_handoff_review_batch(
            conn,
            session_db=session_db,
            defer_live_foreground=True,
            review_runner=lambda claimed: calls.append(claimed) or {"ok": True, "mode": "subprocess"},
        )
        events = [event for event in kb.list_events(conn, task_id) if event.kind == "loop_handoff_review_session"]
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]

    assert batch is not None
    assert batch["review_route"] == "dedicated"
    assert batch["reviewer_session_id"] == kb.loop_handoff_reviewer_session_id("tenant-a", "t_looproot")
    assert calls and calls[0]["review_route"] == "dedicated"
    assert handoff["reviewer_session_id"] == batch["reviewer_session_id"]
    assert events
    assert events[-1].payload is not None
    assert events[-1].payload["review_route"] == "dedicated"


def test_idle_boundary_does_not_claim_another_live_session_handoff(kanban_home, monkeypatch):
    import hermes_state
    from hermes_state import SessionDB

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", kanban_home / "state.db")
    session_db = SessionDB()
    session_db.create_session("foreground-a", "tui", model="gpt-test")
    session_db.create_session("foreground-b", "tui", model="gpt-test")

    with kb.connect() as conn:
        task_id = _loop_node(
            conn,
            title="foreign foreground handoff",
            tenant="tenant-a",
            session_id="foreground-a",
        )
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="belongs to session a")

        result = kb.run_next_loop_handoff_review_batch(
            conn,
            session_db=session_db,
            required_live_session_id="foreground-b",
            session_busy=lambda candidate: str(candidate) != "foreground-b",
            review_runner=lambda batch: pytest.fail("session b must not claim session a's handoff"),
        )
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]

    assert result is None
    assert handoff["state"] in {"recorded", "queued", "batched"}


def test_review_runner_uses_claimed_reviewer_profile(monkeypatch, tmp_path):
    captured = {}

    class _FakePopen:
        def __init__(self, cmd, **kwargs):
            captured["cmd"] = cmd
            captured["env"] = kwargs.get("env", {})
            self.pid = 4242

    default_home = tmp_path / ".hermes"
    default_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(default_home))
    monkeypatch.setattr(kb, "_resolve_hermes_argv", lambda: ["hermes"])
    monkeypatch.setattr("subprocess.Popen", _FakePopen)

    result = kb.start_loop_handoff_review_process(
        {
            "tenant": "tenant-a",
            "root_task_id": "t_looproot",
            "reviewer_session_id": "origin-session",
            "reviewer_profile": "default",
            "review_batch_id": "batch-1",
            "handoffs": [],
        }
    )

    assert result["profile"] == "default"
    assert captured["cmd"][:4] == ["hermes", "-p", "default", "--resume"]
    assert captured["cmd"][4] == "origin-session"
    assert captured["env"]["HERMES_HOME"] == str(default_home)
    assert captured["env"]["HERMES_KANBAN_DB"] == str(default_home / "kanban.db")


def test_review_batch_runner_executes_after_claim_and_closes_handoff(kanban_home):
    from hermes_state import SessionDB

    session_db = SessionDB()
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="reviewable loop node", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="done with passing evidence", metadata={"tests_run": ["pytest -q"]})

        calls = []

        def review_runner(batch):
            calls.append(batch)
            messages = session_db.get_messages(batch["reviewer_session_id"])
            assert messages and "kanban_loop_handoff_review_batch" in messages[0]["content"]
            return kb.review_loop_handoff_autonomous_action(
                conn,
                batch["handoffs"][0]["id"],
                action="approve_release",
                actor="reviewer-qa",
                evidence_passed=True,
                reason="runner processed proof packet",
            )

        result = kb.run_next_loop_handoff_review_batch(
            conn,
            session_db=session_db,
            review_runner=review_runner,
        )
        reviewed = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        run_events = [event for event in kb.list_events(conn, task_id) if event.kind == "loop_handoff_review_run"]

    assert calls and calls[0]["reviewer_session_id"] == kb.loop_handoff_reviewer_session_id("tenant-a", "t_looproot")
    assert result["ok"] is True
    assert result["runner_result"]["outcome"] == "approved"
    assert reviewed["state"] == "closed"
    assert reviewed["verification_state"] == "approved"
    assert run_events and run_events[-1].payload["runner_outcome"] == "approved"


def test_autonomous_approve_release_is_audited_and_promotes_downstream(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, parent_id, summary="done with passing evidence", metadata={"tests_run": ["pytest -q"]})
        handoff = kb.list_loop_handoffs(conn)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="proof packet evidence passed",
        )
        reviewed = kb.list_loop_handoffs(conn)[0]
        child = kb.get_task(conn, child_id)
        events = [e for e in kb.list_events(conn, parent_id) if e.kind == "loop_handoff_auto_action"]

    assert result == {
        "ok": True,
        "outcome": "approved",
        "created_cards": [],
        "notification": {"level": "quiet", "state": "approved"},
    }
    assert reviewed["state"] == "closed"
    assert reviewed["verification_state"] == "approved"
    assert reviewed["decision_actor"] == "reviewer-qa"
    assert reviewed["auto_actions_log"][0]["outcome"] == "approved"
    assert child is not None and child.status == "ready"
    assert events and events[-1].payload["action"] == "approve_release"


def test_autonomous_policy_escalates_prohibited_and_bounded_repair(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="needs review")
        handoff = kb.list_loop_handoffs(conn)[0]

        prohibited = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            prohibited_flags=["push"],
            reason="would require pushing to remote",
        )
        reviewed = kb.list_loop_handoffs(conn)[0]

    assert prohibited["ok"] is False
    assert prohibited["outcome"] == "escalated"
    assert prohibited["notification"] == {"level": "escalation", "state": "needs-user"}
    assert "push" in prohibited["escalation_reason"]
    assert reviewed["attention"] == "needs-user"
    assert reviewed["verification_state"] == "needs-user"
    assert reviewed["escalation_reason"] == prohibited["escalation_reason"]

    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop repair", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:456") is not None
        assert kb.complete_task(conn, task_id, summary="tests failed")
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        bounded = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="auto_repair",
            actor="reviewer-qa",
            repair_attempts=2,
            max_repair_attempts=2,
        )

    assert bounded == {
        "ok": False,
        "outcome": "escalated",
        "escalation_reason": "repeated_failed_auto_repair",
        "notification": {"level": "escalation", "state": "needs-user"},
    }


@pytest.mark.parametrize(
    "flag",
    [
        "ambiguous",
        "destructive_side_effect",
        "external_side_effect",
        "failed_evidence_tradeoff",
        "live_mutation",
        "privacy_sensitive",
        "product_decision",
        "push",
        "restart",
        "secrets",
        "unclear_acceptance_criteria",
    ],
)
def test_autonomous_policy_escalates_every_boundary_flag_without_closing(kanban_home, flag):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title=f"loop parent {flag}", tenant="tenant-a")
        child_id = _loop_node(conn, title=f"loop child {flag}", parents=(parent_id,), tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer="worker-host:boundary") is not None
        assert kb.complete_task(conn, parent_id, summary="done but boundary needs foreground decision")
        handoff = kb.list_loop_handoffs(conn, task_id=parent_id)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            prohibited_flags=[flag],
            reason=f"boundary flag {flag} must not auto-close",
        )
        reviewed = kb.list_loop_handoffs(conn, task_id=parent_id)[0]
        child = kb.get_task(conn, child_id)

    assert result["ok"] is False
    assert result["outcome"] == "escalated"
    assert flag in result["escalation_reason"]
    assert reviewed["state"] == "escalated"
    assert reviewed["attention"] == "needs-user"
    assert reviewed["verification_state"] == "needs-user"
    assert reviewed["verification_status"] == "unknown"
    assert child is not None and child.status == "todo"


@pytest.mark.parametrize("flag", ["unknown_flag", "typo-secret"])
def test_autonomous_policy_escalates_unknown_boundary_flags_without_closing(kanban_home, flag):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title=f"loop parent {flag}", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:boundary") is not None
        assert kb.complete_task(conn, task_id, summary="done but unknown boundary flag appears")
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            prohibited_flags=[flag],
            reason=f"unknown boundary flag {flag} must still be safe",
        )
        reviewed = kb.list_loop_handoffs(conn, task_id=task_id)[0]

    assert result["ok"] is False
    assert result["outcome"] == "escalated"
    assert flag in result["escalation_reason"]
    assert reviewed["state"] == "escalated"
    assert reviewed["attention"] == "needs-user"
    assert reviewed["verification_state"] == "needs-user"


def test_autonomous_action_after_escalation_is_rejected_without_promoting_downstream(kanban_home):
    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, parent_id, summary="done but needs human release")
        handoff = kb.list_loop_handoffs(conn)[0]

        escalated = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            prohibited_flags=["push"],
            reason="release needs a push",
        )
        rejected = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="safe-looking retry must not clear escalation",
        )
        reviewed = kb.list_loop_handoffs(conn)[0]
        child = kb.get_task(conn, child_id)

    assert escalated["outcome"] == "escalated"
    assert rejected == {"ok": False, "outcome": "rejected_state", "current_state": "escalated"}
    assert reviewed["state"] == "escalated"
    assert reviewed["attention"] == "needs-user"
    assert reviewed["verification_state"] == "needs-user"
    assert child is not None and child.status == "todo"


def test_autonomous_action_after_closed_handoff_is_rejected(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="done with passing evidence")
        handoff = kb.list_loop_handoffs(conn)[0]
        approved = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="first approval",
        )

        rejected = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="duplicate approval must not rerun",
        )
        reviewed = kb.list_loop_handoffs(conn)[0]

    assert approved["ok"] is True
    assert rejected == {"ok": False, "outcome": "rejected_state", "current_state": "closed"}
    assert reviewed["state"] == "closed"
    assert reviewed["verification_state"] == "approved"
    assert reviewed["decision_reason"] == "first approval"


def test_autonomous_action_loses_stale_state_race_without_promoting_or_creating_followups(kanban_home, monkeypatch):
    original_handoff_row_by_id = kb._handoff_row_by_id

    with kb.connect() as conn:
        parent_id = _loop_node(conn, title="loop parent", tenant="tenant-a")
        child_id = _loop_node(conn, title="loop child", parents=(parent_id,), tenant="tenant-a")
        assert kb.claim_task(conn, parent_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, parent_id, summary="done with stale reviewer")
        stale_handoff = kb.list_loop_handoffs(conn)[0]
        conn.execute("UPDATE loop_handoffs SET state = 'closed' WHERE id = ?", (stale_handoff["id"],))

        calls = {"count": 0}

        def stale_once(inner_conn, handoff_id):
            calls["count"] += 1
            if calls["count"] == 1:
                return dict(stale_handoff)
            return original_handoff_row_by_id(inner_conn, handoff_id)

        monkeypatch.setattr(kb, "_handoff_row_by_id", stale_once)
        rejected = kb.review_loop_handoff_autonomous_action(
            conn,
            stale_handoff["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="stale reviewer must lose",
            followups=[{"kind": "test", "title": "Should not be created", "assignee": "implementation-worker"}],
        )
        reviewed = kb.list_loop_handoffs(conn)[0]
        child = kb.get_task(conn, child_id)
        followups = [task for task in kb.list_tasks(conn) if task.created_by == f"loop-review:{stale_handoff['id']}"]

    assert rejected == {"ok": False, "outcome": "rejected_state", "current_state": "closed"}
    assert reviewed["state"] == "closed"
    assert reviewed["verification_state"] != "approved"
    assert child is not None and child.status == "todo"
    assert followups == []



def test_failed_final_evidence_creates_followups_without_blocking_root(kanban_home):
    with kb.connect() as conn:
        root_id = _loop_node(conn, title="loop root", tenant="tenant-a")
        assert kb.claim_task(conn, root_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, root_id, summary="final evidence has a gap")
        handoff = kb.list_loop_handoffs(conn, task_id=root_id)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=False,
            reason="missing regression evidence for final acceptance",
            followups=[{
                "kind": "test",
                "title": "Add missing final evidence regression",
                "assignee": "implementation-worker",
                "body": "Cover the final acceptance evidence gap before releasing the root.",
            }],
        )
        reviewed = kb.list_loop_handoffs(conn, task_id=root_id)[0]
        root = kb.get_task(conn, root_id)
        followup = kb.get_task(conn, result["created_cards"][0])
        followup_parents = kb.parent_ids(conn, result["created_cards"][0])
        followup_claim = kb.claim_task(conn, result["created_cards"][0], claimer="worker-host:followup")
        launched_followup = kb.get_task(conn, result["created_cards"][0])
        events = [event for event in kb.list_events(conn, root_id) if event.kind == "loop_final_evidence_followups"]
        event_payload = events[-1].payload if events else {}

    assert result["ok"] is True
    assert result["outcome"] == "followups_created"
    assert reviewed["verification_state"] == "followups-created"
    assert reviewed["verification_status"] == "failed"
    assert reviewed["decision_reason"] == "missing regression evidence for final acceptance"
    assert root is not None and root.status == "running"
    assert root.completed_at is None
    assert root.current_run_id is not None
    assert followup is not None
    assert followup.status == "ready"
    assert followup.tenant == "tenant-a"
    assert followup.created_by == f"loop-review:{handoff['id']}"
    assert followup_parents == [root_id]
    assert followup_claim is not None
    assert launched_followup is not None and launched_followup.status == "running"
    assert event_payload and event_payload["created_cards"] == result["created_cards"]


def test_dependency_parented_loop_closeout_uses_root_identity_for_handoff_lifecycle(kanban_home):
    with kb.connect() as conn:
        closeout_id, parent_ids = _parented_loop_closeout(conn, tenant="tenant-a")
        assert kb.parent_ids(conn, closeout_id) == sorted(parent_ids)
        assert kb.claim_task(conn, closeout_id, claimer="worker-host:root-closeout") is not None

        assert kb.complete_task(conn, closeout_id, summary="final closeout evidence ready")
        handoffs = kb.list_loop_handoffs(conn, task_id=closeout_id)
        events = _handoff_events(conn, closeout_id)
        closeout_after_completion = kb.get_task(conn, closeout_id)

        assert len(handoffs) == 1
        assert len(events) == 1
        assert handoffs[0]["root_task_id"] == closeout_id
        assert closeout_after_completion is not None and closeout_after_completion.status == "done"

        failed = kb.review_loop_handoff_autonomous_action(
            conn,
            handoffs[0]["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=False,
            reason="missing final closeout evidence",
            followups=[{
                "kind": "test",
                "title": "Add closeout evidence regression",
                "assignee": "implementation-worker",
                "body": "Cover dependency-parented closeout final evidence.",
            }],
        )
        closeout_after_failure = kb.get_task(conn, closeout_id)
        followup = kb.get_task(conn, failed["created_cards"][0])
        followup_claim = kb.claim_task(conn, failed["created_cards"][0], claimer="worker-host:followup")

        assert failed["ok"] is True
        assert closeout_after_failure is not None and closeout_after_failure.status == "running"
        assert closeout_after_failure.completed_at is None
        assert followup is not None and followup.status == "ready"
        assert kb.parent_ids(conn, followup.id) == [closeout_id]
        assert followup_claim is not None

        assert kb.complete_task(conn, failed["created_cards"][0], summary="followup evidence complete")
        approved = kb.review_loop_handoff_autonomous_action(
            conn,
            handoffs[0]["id"],
            action="approve_release",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="final closeout evidence accepted",
        )
        closeout_after_approval = kb.get_task(conn, closeout_id)

    assert approved["ok"] is True
    assert approved["outcome"] == "approved"
    assert closeout_after_approval is not None and closeout_after_approval.status == "done"

def test_failed_final_evidence_requires_concrete_followup_tasks(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, title="loop root", tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, task_id, summary="final evidence has a gap")
        handoff = kb.list_loop_handoffs(conn, task_id=task_id)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=False,
            reason="gap named but no work item supplied",
            followups=[],
        )
        reviewed = kb.list_loop_handoffs(conn, task_id=task_id)[0]
        followups = [task for task in kb.list_tasks(conn) if task.created_by == f"loop-review:{handoff['id']}"]

    assert result["ok"] is False
    assert result["outcome"] == "escalated"
    assert result["escalation_reason"] == "missing follow-up task request"
    assert reviewed["state"] == "escalated"
    assert followups == []


def test_autonomous_safe_followups_are_same_tenant_clean_worktrees(kanban_home):
    with kb.connect() as conn:
        task_id = _loop_node(conn, tenant="tenant-a")
        assert kb.claim_task(conn, task_id, claimer="worker-host:123") is not None
        assert kb.complete_task(conn, task_id, summary="needs a test follow-up")
        handoff = kb.list_loop_handoffs(conn)[0]

        result = kb.review_loop_handoff_autonomous_action(
            conn,
            handoff["id"],
            action="create_followups",
            actor="reviewer-qa",
            evidence_passed=True,
            reason="add focused regression test",
            followups=[{"kind": "test", "title": "Add regression test", "assignee": "implementation-worker", "body": "Cover reviewer proof packet."}],
        )
        followup = kb.get_task(conn, result["created_cards"][0])

    assert result["ok"] is True
    assert followup is not None
    assert followup.tenant == "tenant-a"
    assert followup.workspace_kind == "worktree"
    assert followup.branch_name.startswith("loop-review/")
