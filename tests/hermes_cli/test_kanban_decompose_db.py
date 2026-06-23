"""Tests for kb.decompose_triage_task — the DB-layer atomic fan-out
from the triage column. LLM-free by design.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _create_triage(conn, title="rough idea", body=None, assignee=None, tenant=None):
    return kb.create_task(
        conn,
        title=title,
        body=body,
        assignee=assignee,
        tenant=tenant,
        triage=True,
    )


def test_decompose_creates_children_and_promotes_root(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn, title="ship a feature")
        assert kb.get_task(conn, tid).status == "triage"

    children = [
        {"title": "research", "body": "look at prior art", "assignee": "researcher", "parents": []},
        {"title": "build it", "body": "write code", "assignee": "engineer", "parents": [0]},
    ]
    with kb.connect() as conn:
        child_ids = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orchestrator",
            children=children,
            author="decomposer",
        )
    assert child_ids is not None
    assert len(child_ids) == 2

    with kb.connect() as conn:
        root = kb.get_task(conn, tid)
        c0 = kb.get_task(conn, child_ids[0])
        c1 = kb.get_task(conn, child_ids[1])

    # Root flipped to todo with orchestrator assignee, gated by children.
    assert root.status == "todo"
    assert root.assignee == "orchestrator"
    # First child has no internal parents → ready on recompute_ready.
    assert c0.status == "ready"
    assert c0.assignee == "researcher"
    # Second child has parents=[0] → stays in todo until c0 completes.
    assert c1.status == "todo"
    assert c1.assignee == "engineer"


def test_decompose_returns_none_when_task_missing(kanban_home):
    with kb.connect() as conn:
        result = kb.decompose_triage_task(
            conn,
            "nonexistent",
            root_assignee="orch",
            children=[{"title": "x"}],
            author="me",
        )
    assert result is None


def test_decompose_returns_none_when_task_not_in_triage(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="already a real task")  # not triage
        result = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orch",
            children=[{"title": "x"}],
            author="me",
        )
    assert result is None


def test_decompose_empty_children_returns_none(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn)
        result = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orch",
            children=[],
            author="me",
        )
    assert result is None


def test_decompose_rejects_self_parent(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn)
        with pytest.raises(ValueError, match="cannot list itself"):
            kb.decompose_triage_task(
                conn,
                tid,
                root_assignee="orch",
                children=[{"title": "x", "parents": [0]}],
                author="me",
            )


def test_decompose_rejects_out_of_range_parent(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn)
        with pytest.raises(ValueError, match="not a valid index"):
            kb.decompose_triage_task(
                conn,
                tid,
                root_assignee="orch",
                children=[{"title": "x", "parents": [5]}],
                author="me",
            )


def test_decompose_rejects_cyclic_parents(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn)
        with pytest.raises(ValueError, match="cyclic dependency"):
            kb.decompose_triage_task(
                conn,
                tid,
                root_assignee="orch",
                children=[
                    {"title": "A", "parents": [1]},
                    {"title": "B", "parents": [0]},
                ],
                author="me",
            )


def test_decompose_records_audit_comment_and_event(kanban_home):
    with kb.connect() as conn:
        tid = _create_triage(conn)
        child_ids = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orch",
            children=[{"title": "task A", "assignee": "researcher"}],
            author="alice",
        )
    assert child_ids is not None

    with kb.connect() as conn:
        comments = kb.list_comments(conn, tid)
        events = kb.list_events(conn, tid)

    assert any("Decomposed into" in (c.body or "") for c in comments)
    assert any(ev.kind == "decomposed" for ev in events)


def test_decompose_loop_root_children_keep_root_provenance_and_session(kanban_home):
    """Loop fan-out children remain traceable to the real root/session."""
    with kb.connect() as conn:
        tid = kb.create_task(
            conn,
            title="Loop root",
            assignee="foreground",
            tenant="loop-tenant",
            triage=True,
            session_id="logical-session-123",
        )
        conn.execute("UPDATE tasks SET created_by = ? WHERE id = ?", (f"loop:{tid}", tid))
        child_ids = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orchestrator",
            children=[{"title": "implementation", "assignee": "engineer"}],
            author="foreground",
        )
    assert child_ids is not None

    with kb.connect() as conn:
        child = kb.get_task(conn, child_ids[0])
        events = kb.list_events(conn, child_ids[0])
        assert child is not None
        assert child.created_by == f"loop:{tid}"
        assert child.tenant == "loop-tenant"
        assert child.session_id == "logical-session-123"
        assert kb._loop_root_for_task(conn, child_ids[0]) == tid

    created_payloads = [ev.payload for ev in events if ev.kind == "created"]
    assert created_payloads == [
        {
            "by": "foreground",
            "from_decompose_of": tid,
            "status": "todo",
            "loop_root_task_id": tid,
        }
    ]


def test_decompose_loop_child_triage_children_inherit_real_root_session(kanban_home):
    """Nested Loop triage decompositions keep the real root logical session."""
    with kb.connect() as conn:
        root_id = kb.create_task(
            conn,
            title="Loop root",
            assignee="foreground",
            tenant="loop-tenant",
            session_id="session-root",
        )
        conn.execute(
            "UPDATE tasks SET created_by = ? WHERE id = ?",
            (f"loop:{root_id}", root_id),
        )
        triage_id = kb.create_task(
            conn,
            title="triage under root",
            assignee="planner",
            tenant="loop-tenant",
            triage=True,
            parents=[root_id],
            session_id="triage-session-should-not-win",
        )
        conn.execute(
            "UPDATE tasks SET created_by = ? WHERE id = ?",
            (f"loop:{root_id}", triage_id),
        )
        child_ids = kb.decompose_triage_task(
            conn,
            triage_id,
            root_assignee="planner",
            children=[{"title": "child", "assignee": "eng"}],
            author="planner",
        )
    assert child_ids is not None

    with kb.connect() as conn:
        child = kb.get_task(conn, child_ids[0])
        events = kb.list_events(conn, child_ids[0])
        assert child is not None
        assert child.created_by == f"loop:{root_id}"
        assert child.session_id == "session-root"
        assert kb._loop_root_for_task(conn, child_ids[0]) == root_id

    created_payloads = [ev.payload for ev in events if ev.kind == "created"]
    assert created_payloads == [
        {
            "by": "planner",
            "from_decompose_of": triage_id,
            "status": "todo",
            "loop_root_task_id": root_id,
        }
    ]


def test_legacy_foreground_decomposed_root_completion_skips_loop_handoff(kanban_home):
    """Legacy foreground decomposed roots now complete without foreground handoffs."""
    with kb.connect() as conn:
        root_id = kb.create_task(
            conn,
            title="legacy foreground root",
            assignee="foreground",
            created_by="foreground",
            tenant="loop-tenant",
            triage=True,
            session_id="foreground-session",
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root_id,
            root_assignee="orchestrator",
            children=[{"title": "implementation", "assignee": "engineer"}],
            author="foreground",
        )
        assert child_ids is not None
        child_id = child_ids[0]

        assert kb._loop_root_for_task(conn, root_id) == root_id
        assert kb._loop_root_for_task(conn, child_id) == root_id
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None
        assert kb.complete_task(conn, child_id, summary="implementation done")
        assert kb.claim_task(conn, root_id, claimer="worker-host:root") is not None
        assert kb.complete_task(conn, root_id, summary="root closeout complete")

        handoffs = kb.list_loop_handoffs(conn, task_id=root_id)
        events = [
            event for event in kb.list_events(conn, root_id)
            if event.kind == "loop_foreground_handoff"
        ]

    assert handoffs == []
    assert events == []


def test_legacy_foreground_decomposed_child_explicit_block_stays_plain_blocker(kanban_home):
    """Explicit child review boundaries no longer create foreground handoffs."""
    with kb.connect() as conn:
        root_id = kb.create_task(
            conn,
            title="legacy foreground root",
            assignee="foreground",
            created_by="foreground",
            tenant="loop-tenant",
            triage=True,
            session_id="foreground-session",
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root_id,
            root_assignee="orchestrator",
            children=[{"title": "implementation", "assignee": "engineer"}],
            author="foreground",
        )
        assert child_ids is not None
        child_id = child_ids[0]

        assert kb._loop_root_for_task(conn, child_id) == root_id
        assert kb.claim_task(conn, child_id, claimer="worker-host:child") is not None
        assert kb.block_task(conn, child_id, reason="review-required: inspect implementation")

        handoffs = kb.list_loop_handoffs(conn, task_id=child_id)
        events = [
            event for event in kb.list_events(conn, child_id)
            if event.kind == "loop_foreground_handoff"
        ]

    assert handoffs == []
    assert events == []


def test_loop_handoff_recording_is_noop_after_removal(kanban_home):
    """Legacy recording helper no longer persists foreground handoff rows."""
    with kb.connect() as conn:
        root_id = kb.create_task(
            conn,
            title="Loop root",
            assignee="foreground",
            created_by="foreground",
            tenant="loop-tenant",
            triage=True,
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root_id,
            root_assignee="orchestrator",
            children=[{"title": "implementation", "assignee": "engineer"}],
            author="foreground",
        )
        assert child_ids is not None
        source_event_id = kb._append_event(conn, root_id, "completed", {"summary": "done"})

        first = kb._record_loop_handoff(
            conn,
            root_id,
            root_task_id=root_id,
            handoff_kind="worker_completed",
            run_id=None,
            source_event_id=source_event_id,
            summary="first evidence wins",
        )
        second = kb._record_loop_handoff(
            conn,
            root_id,
            root_task_id=root_id,
            handoff_kind="worker_completed",
            run_id=None,
            source_event_id=source_event_id,
            summary="duplicate retry should not overwrite",
        )
        handoffs = kb.list_loop_handoffs(conn, task_id=root_id)

    assert first == second == {}
    assert handoffs == []


def test_decompose_non_loop_children_keep_author_provenance(kanban_home):
    """Ordinary decomposition remains compatible with existing author metadata."""
    with kb.connect() as conn:
        tid = _create_triage(conn, tenant="plain-tenant")
        child_ids = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orch",
            children=[{"title": "task A", "assignee": "researcher"}],
            author="alice",
        )
    assert child_ids is not None

    with kb.connect() as conn:
        child = kb.get_task(conn, child_ids[0])
        events = kb.list_events(conn, child_ids[0])
        assert child is not None
        assert child.created_by == "alice"
        assert child.tenant == "plain-tenant"
        assert child.session_id is None
        assert kb._loop_root_for_task(conn, child_ids[0]) is None

    created_payloads = [ev.payload for ev in events if ev.kind == "created"]
    assert created_payloads == [{"by": "alice", "from_decompose_of": tid, "status": "todo"}]


def test_decompose_auto_promote_false_sticky_blocks_children(kanban_home):
    """Planning-only fan-out must not leak parent-free children to dispatcher.

    ``auto_promote=False`` used to leave children as ordinary ``todo`` rows.
    Any later ``recompute_ready()`` call (dispatcher tick, list path, tool read)
    promoted parent-free children to ``ready`` and could spawn them despite the
    caller asking for a manual-review-first graph.
    """
    with kb.connect() as conn:
        tid = _create_triage(conn, title="parked graph", tenant="loop-tenant")
        child_ids = kb.decompose_triage_task(
            conn,
            tid,
            root_assignee="orchestrator",
            children=[
                {"title": "parallel discovery", "assignee": "researcher", "parents": []},
                {"title": "parallel criteria", "assignee": "designer", "parents": []},
                {"title": "synthesis", "assignee": "engineer", "parents": [0, 1]},
            ],
            author="planner",
            auto_promote=False,
        )
        assert child_ids is not None

        # Simulate an arbitrary dispatcher/read-path recompute after the hold.
        promoted = kb.recompute_ready(conn)
        children = [kb.get_task(conn, cid) for cid in child_ids]
        block_events = {
            cid: [ev for ev in kb.list_events(conn, cid) if ev.kind == "blocked"]
            for cid in child_ids
        }

    assert promoted == 0
    assert all(child is not None for child in children)
    assert [child.status for child in children] == ["blocked", "blocked", "blocked"]
    assert all(block_events[cid] for cid in child_ids)


def test_decompose_children_inherit_dir_workspace(kanban_home):
    """Fan-out children inherit the root's dir workspace, not scratch."""
    proj = "/home/teknium/myproject"
    with kb.connect() as conn:
        tid = kb.create_task(
            conn, title="codegen root", assignee="worker",
            workspace_kind="dir", workspace_path=proj, triage=True,
        )
        child_ids = kb.decompose_triage_task(
            conn, tid, root_assignee="orchestrator",
            children=[{"title": "part A"}, {"title": "part B", "parents": [0]}],
            author="decomposer",
        )
    assert child_ids and len(child_ids) == 2
    with kb.connect() as conn:
        for cid in child_ids:
            t = kb.get_task(conn, cid)
            assert t.workspace_kind == "dir"
            assert t.workspace_path == proj


def test_decompose_children_stay_scratch_when_root_scratch(kanban_home):
    """No regression: a scratch root still fans out into scratch children."""
    with kb.connect() as conn:
        tid = kb.create_task(
            conn, title="scratch root", assignee="worker",
            workspace_kind="scratch", triage=True,
        )
        child_ids = kb.decompose_triage_task(
            conn, tid, root_assignee="orchestrator",
            children=[{"title": "s1"}], author="decomposer",
        )
    with kb.connect() as conn:
        t = kb.get_task(conn, child_ids[0])
    assert t.workspace_kind == "scratch"
    assert t.workspace_path is None


def test_decompose_per_child_workspace_override(kanban_home):
    """An explicit per-child workspace beats inheritance."""
    proj = "/home/teknium/myproject"
    with kb.connect() as conn:
        tid = kb.create_task(
            conn, title="root", assignee="worker",
            workspace_kind="dir", workspace_path=proj, triage=True,
        )
        child_ids = kb.decompose_triage_task(
            conn, tid, root_assignee="orchestrator",
            children=[
                {"title": "override", "workspace_kind": "dir",
                 "workspace_path": "/other/repo"},
                {"title": "inherit"},
            ],
            author="decomposer",
        )
    with kb.connect() as conn:
        over = kb.get_task(conn, child_ids[0])
        inh = kb.get_task(conn, child_ids[1])
    assert over.workspace_path == "/other/repo"
    assert inh.workspace_path == proj
