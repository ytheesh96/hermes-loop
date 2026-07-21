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


def test_decompose_clears_skeleton_flag_only_on_success(kanban_home):
    with kb.connect() as conn:
        waiting_parent = kb.create_task(conn, title="unfinished")
        waiting = kb.create_task(
            conn,
            title="waiting skeleton",
            parents=[waiting_parent],
            needs_specification=True,
        )
        assert kb.decompose_triage_task(
            conn,
            waiting,
            root_assignee="orchestrator",
            children=[{"title": "must not be created"}],
        ) is None
        assert kb.get_task(conn, waiting).needs_specification is True

        skeleton = kb.create_task(
            conn, title="live skeleton", needs_specification=True
        )
        child_ids = kb.decompose_triage_task(
            conn,
            skeleton,
            root_assignee="orchestrator",
            children=[{"title": "worker-complete child"}],
        )
        compiled = kb.get_task(conn, skeleton)
        child = kb.get_task(conn, child_ids[0])

    assert compiled is not None and compiled.needs_specification is False
    assert child is not None and child.needs_specification is False


def test_decompose_preserves_external_parents_and_shell_outgoing_edges(
    kanban_home,
):
    with kb.connect() as conn:
        upstream = kb.create_task(conn, title="upstream research")
        shell = kb.create_task(
            conn,
            title="implementation skeleton",
            parents=[upstream],
            triage=True,
            needs_specification=True,
        )
        downstream = kb.create_task(conn, title="verify", parents=[shell])

        child_ids = kb.decompose_triage_task(
            conn,
            shell,
            root_assignee="orchestrator",
            children=[
                {"title": "entry", "assignee": "engineer"},
                {"title": "exit", "assignee": "engineer", "parents": [0]},
            ],
            author="decomposer",
        )
        assert child_ids is not None
        entry, exit_task = child_ids

        assert upstream in kb.parent_ids(conn, entry)
        assert kb.get_task(conn, entry).status == "todo"
        assert kb.parent_ids(conn, exit_task) == [entry]
        assert exit_task in kb.parent_ids(conn, shell)
        assert downstream in kb.child_ids(conn, shell)
        assert kb.get_task(conn, shell).needs_specification is False

        assert kb.claim_task(conn, upstream) is not None
        assert kb.complete_task(conn, upstream, summary="research complete")
        assert kb.get_task(conn, entry).status == "ready"


def test_decompose_parallel_entries_inherit_every_external_parent(kanban_home):
    with kb.connect() as conn:
        left = kb.create_task(conn, title="left prerequisite")
        right = kb.create_task(conn, title="right prerequisite")
        shell = kb.create_task(
            conn,
            title="fan-in skeleton",
            parents=[left, right],
            triage=True,
            needs_specification=True,
        )
        children = kb.decompose_triage_task(
            conn,
            shell,
            root_assignee="orchestrator",
            children=[
                {"title": "entry one"},
                {"title": "entry two"},
                {"title": "internal fan-in", "parents": [0, 1]},
            ],
        )
        assert children is not None
        entry_one, entry_two, internal_exit = children

        assert set(kb.parent_ids(conn, entry_one)) == {left, right}
        assert set(kb.parent_ids(conn, entry_two)) == {left, right}
        assert set(kb.parent_ids(conn, internal_exit)) == {entry_one, entry_two}
        assert internal_exit in kb.parent_ids(conn, shell)
        assert entry_one not in kb.parent_ids(conn, shell)
        assert entry_two not in kb.parent_ids(conn, shell)


def test_live_fanout_shell_auto_settles_without_a_worker_run(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Live workflow",
        )
        shell = kb.create_task(
            conn,
            title="Build and verify the feature",
            assignee="orchestrator",
            triage=True,
            needs_specification=True,
            workflow_id=workflow_id,
        )
        downstream = kb.create_task(
            conn,
            title="Publish the result",
            assignee="publisher",
            parents=[shell],
            workflow_id=workflow_id,
        )
        child_ids = kb.decompose_triage_task(
            conn,
            shell,
            root_assignee="orchestrator",
            children=[
                {
                    "title": "Implement the feature",
                    "assignee": "engineer",
                },
                {
                    "title": "Integrate and verify",
                    "assignee": "reviewer",
                    "parents": [0],
                },
            ],
            author="auto-decomposer",
            auto_complete_shell=True,
        )
        assert child_ids is not None
        implementation, integration = child_ids

        parked_shell = kb.get_task(conn, shell)
        assert parked_shell is not None
        assert parked_shell.status == "todo"
        assert parked_shell.assignee is None
        assert kb.get_task(conn, implementation).status == "ready"
        assert kb.get_task(conn, integration).status == "todo"

        assert kb.claim_task(conn, implementation, claimer="engineer") is not None
        assert kb.complete_task(
            conn,
            implementation,
            summary="Implementation complete",
        )
        assert kb.get_task(conn, integration).status == "ready"
        assert kb.get_task(conn, shell).status == "todo"

        assert kb.claim_task(conn, integration, claimer="reviewer") is not None
        assert kb.complete_task(
            conn,
            integration,
            summary="Integrated result passed verification",
        )

        settled_shell = kb.get_task(conn, shell)
        shell_run = kb.latest_run(conn, shell)
        shell_events = kb.list_events(conn, shell)
        assert settled_shell is not None
        assert settled_shell.status == "done"
        assert settled_shell.assignee is None
        assert settled_shell.result == "Integrated result passed verification"
        assert shell_run is not None
        assert shell_run.profile is None
        assert shell_run.outcome == "completed"
        assert shell_run.summary == "Integrated result passed verification"
        assert any(
            event.kind == "completed"
            and event.payload.get("auto_completed") is True
            for event in shell_events
        )
        assert not any(
            event.kind == "promoted"
            and event.id > next(
                decomposed.id
                for decomposed in shell_events
                if decomposed.kind == "decomposed"
            )
            for event in shell_events
        )
        assert kb.get_task(conn, downstream).status == "ready"
        assert kb.get_workflow(conn, workflow_id).status == "open"


def test_live_fanout_shell_aggregates_multiple_exit_summaries(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, title="Parallel workflow")
        shell = kb.create_task(
            conn,
            title="Collect both reports",
            triage=True,
            needs_specification=True,
            workflow_id=workflow_id,
        )
        child_ids = kb.decompose_triage_task(
            conn,
            shell,
            root_assignee=None,
            children=[
                {"title": "Left report", "assignee": "left"},
                {"title": "Right report", "assignee": "right"},
            ],
            auto_complete_shell=True,
        )
        assert child_ids is not None
        left, right = child_ids

        assert kb.complete_task(conn, left, summary="left complete")
        assert kb.get_task(conn, shell).status == "todo"
        assert kb.complete_task(conn, right, summary="right complete")

        settled = kb.get_task(conn, shell)
        assert settled is not None and settled.status == "done"
        assert "Left report: left complete" in (settled.result or "")
        assert "Right report: right complete" in (settled.result or "")


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


def test_decompose_workflow_member_inherits_canonical_workflow_metadata(
    kanban_home,
):
    """Fan-out uses workflow metadata while keeping actor provenance."""
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Foreground workflow",
            origin_session_id="workflow-session",
            tenant="workflow-tenant",
            workspace_kind="dir",
            workspace_path="/workflow/project",
        )
        tid = kb.create_task(
            conn,
            title="Aggregate shell",
            assignee="foreground",
            created_by="initial-author",
            tenant="stale-shell-tenant",
            triage=True,
            session_id="stale-shell-session",
            workspace_kind="scratch",
            workflow_id=workflow_id,
        )
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
        assert child.created_by == "foreground"
        assert child.workflow_id == workflow_id
        assert child.tenant == "workflow-tenant"
        assert child.session_id == "workflow-session"
        assert child.workspace_kind == "dir"
        assert child.workspace_path == "/workflow/project"
        assert kb.workflow_id_for_task(conn, child_ids[0]) == workflow_id

    created_payloads = [ev.payload for ev in events if ev.kind == "created"]
    assert created_payloads == [
        {
            "by": "foreground",
            "from_decompose_of": tid,
            "status": "todo",
            "workflow_id": workflow_id,
        }
    ]


def test_decompose_nested_workflow_member_keeps_workflow_identity(kanban_home):
    """Nested fan-out stays in the same workflow without root provenance."""
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Nested workflow",
            origin_session_id="workflow-origin-session",
            tenant="workflow-tenant",
        )
        parent_id = kb.create_task(
            conn,
            title="Ordinary parent",
            assignee="foreground",
            created_by="foreground",
            workflow_id=workflow_id,
        )
        triage_id = kb.create_task(
            conn,
            title="Aggregate shell",
            assignee="planner",
            created_by="planner",
            tenant="stale-shell-tenant",
            triage=True,
            parents=[parent_id],
            session_id="triage-session-should-not-win",
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
        assert child.created_by == "planner"
        assert child.workflow_id == workflow_id
        assert child.session_id == "workflow-origin-session"
        assert child.tenant == "workflow-tenant"
        assert kb.workflow_id_for_task(conn, child_ids[0]) == workflow_id

    created_payloads = [ev.payload for ev in events if ev.kind == "created"]
    assert created_payloads == [
        {
            "by": "planner",
            "from_decompose_of": triage_id,
            "status": "todo",
            "workflow_id": workflow_id,
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

        events = [
            event for event in kb.list_events(conn, root_id)
            if event.kind == "loop_foreground_handoff"
        ]

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

        events = [
            event for event in kb.list_events(conn, child_id)
            if event.kind == "loop_foreground_handoff"
        ]

    assert events == []


def test_loop_handoff_recording_helper_removed_after_removal():
    assert not hasattr(kb, "_record_loop_handoff")


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
    assert created_payloads == [
        {
            "by": "alice",
            "from_decompose_of": tid,
            "status": "todo",
            "workflow_id": None,
        }
    ]


def test_decompose_auto_promote_false_schedules_children(kanban_home):
    """Planning-only fan-out must not leak parent-free children to dispatcher.

    ``auto_promote=False`` used to leave children as ordinary ``todo`` rows.
    Any later ``recompute_ready()`` call (dispatcher tick, list path, tool read)
    promoted parent-free children to ``ready`` and could spawn them despite the
    caller asking for a manual-review-first graph. Scheduled children stay
    visible in the graph/board but require explicit activation.
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
        schedule_events = {
            cid: [ev for ev in kb.list_events(conn, cid) if ev.kind == "scheduled"]
            for cid in child_ids
        }

    assert promoted == 0
    assert all(child is not None for child in children)
    assert [child.status for child in children if child is not None] == ["scheduled", "scheduled", "scheduled"]
    assert all(schedule_events[cid] for cid in child_ids)


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


def test_decompose_inherits_project_repo_contract(kanban_home):
    with kb.connect() as conn:
        root = kb.create_task(conn, title="project root", triage=True)
        conn.execute(
            "UPDATE tasks SET project_id = ?, project_repo_path = ? WHERE id = ?",
            ("p_project", "/repo/project", root),
        )
        child_ids = kb.decompose_triage_task(
            conn,
            root,
            root_assignee="orchestrator",
            children=[{"title": "implementation"}],
        )
        child = kb.get_task(conn, child_ids[0])

    assert child.project_id == "p_project"
    assert child.project_repo_path == "/repo/project"
