"""Tests for the decomposer module + `hermes kanban decompose` CLI surface.

The auxiliary LLM client is mocked — no network calls. Tests exercise the
prompt plumbing, response parsing, DB writes (via the real DB helper),
and the assignee-fallback logic.
"""

from __future__ import annotations

import json as jsonlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_decompose as decomp


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _fake_aux_response(content: str, *, finish_reason: str = "stop"):
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    resp.choices[0].finish_reason = finish_reason
    return resp


def _patch_aux_client_sequence(items: list[tuple[str, str]]):
    return patch(
        "agent.auxiliary_client.call_llm",
        side_effect=[
            _fake_aux_response(content, finish_reason=finish_reason)
            for content, finish_reason in items
        ],
    )


def _patch_aux_client(content: str, *, model: str = "test-model"):
    # decompose_task now routes through call_llm (see #35566) — mock it at
    # the source module so task config, extra_body, and retries stay out of
    # unit-test scope.
    return patch(
        "agent.auxiliary_client.call_llm",
        return_value=_fake_aux_response(content),
    )


def _patch_extra_body():
    # No-op shim retained for call-site compatibility: extra_body plumbing
    # now lives inside call_llm, which _patch_aux_client already mocks.
    return patch("agent.auxiliary_client.get_auxiliary_extra_body", return_value={})


def _patch_list_profiles(names: list[str]):
    """Pretend the named profiles exist. The decomposer uses
    profiles_mod.list_profiles() to build the roster + valid-set, and
    profiles_mod.profile_exists() to resolve orchestrator/default."""
    from types import SimpleNamespace
    fake_profiles = [
        SimpleNamespace(
            name=n, is_default=(i == 0), description=f"desc for {n}",
            description_auto=False, model="m", provider="p", skill_count=1,
        )
        for i, n in enumerate(names)
    ]
    return [
        patch("hermes_cli.profiles.list_profiles", return_value=fake_profiles),
        patch("hermes_cli.profiles.profile_exists", side_effect=lambda x: x in names),
        patch("hermes_cli.profiles.get_active_profile_name", return_value=names[0] if names else "default"),
    ]


def _create_live_skeleton(title: str = "Foreground-authored shell") -> tuple[str, str]:
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Live Loop workflow",
            shared_context="Compile foreground-authored task shells.",
        )
        skeleton = kb.create_task(
            conn,
            title=title,
            created_by="foreground",
            workflow_id=workflow_id,
            needs_specification=True,
        )
    return workflow_id, skeleton


def test_decompose_with_fanout_creates_children(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="ship a feature", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "test split",
        "tasks": [
            {"title": "research", "body": "look it up", "assignee": "researcher", "parents": []},
            {"title": "build", "body": "code it", "assignee": "engineer", "parents": [0]},
        ],
    })

    patches = _patch_list_profiles(["orchestrator", "researcher", "engineer"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.fanout is True
    assert outcome.child_ids and len(outcome.child_ids) == 2

    with kb.connect() as conn:
        root = kb.get_task(conn, tid)
        c0 = kb.get_task(conn, outcome.child_ids[0])
        c1 = kb.get_task(conn, outcome.child_ids[1])
    assert root.status == "todo"
    assert c0.status == "ready"
    assert c1.status == "todo"
    assert c0.assignee == "researcher"
    assert c1.assignee == "engineer"


def test_loop_safe_decompose_keeps_planning_task_and_options_scheduled(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Implementation strategy",
            origin_session_id="origin-session",
            tenant="origin-session",
        )
        tid = kb.create_task(
            conn,
            title="choose implementation strategy",
            created_by="desktop-submit",
            workflow_id=workflow_id,
            session_id="origin-session",
            tenant="origin-session",
            triage=True,
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET status = 'scheduled' WHERE id = ?",
                (tid,),
            )

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "offer options",
        "tasks": [
            {"title": "Recommended: minimal path", "body": "Tradeoffs and recommendation", "assignee": "planner", "parents": []},
            {"title": "Alternative: broader path", "body": "Tradeoffs", "assignee": "planner", "parents": []},
        ],
    })

    patches = _patch_list_profiles(["orchestrator", "planner"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="desktop-submit", loop_safe=True)
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.fanout is True
    assert outcome.child_ids and len(outcome.child_ids) == 2

    with kb.connect() as conn:
        planning_task = kb.get_task(conn, tid)
        children = [kb.get_task(conn, cid) for cid in outcome.child_ids]
        promoted = kb.recompute_ready(conn)
        after_recompute = [kb.get_task(conn, cid) for cid in outcome.child_ids]
        intake_events = [event for event in kb.list_events(conn, tid) if event.kind == "loop_intake_state"]

    assert promoted == 0
    assert planning_task is not None
    assert planning_task.status == "scheduled"
    assert [child.status for child in children if child is not None] == ["scheduled", "scheduled"]
    assert [child.status for child in after_recompute if child is not None] == ["scheduled", "scheduled"]
    assert [child.session_id for child in children if child is not None] == ["origin-session", "origin-session"]
    assert intake_events[-1].payload["state"] == "planned"
    assert intake_events[-1].payload["dispatchable"] is False
    assert intake_events[-1].payload["child_ids"] == outcome.child_ids


def test_loop_safe_single_task_fallback_stays_scheduled_and_planned(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Tighten task",
            origin_session_id="origin-session",
        )
        tid = kb.create_task(
            conn,
            title="tighten this task",
            created_by="foreground-triage",
            workflow_id=workflow_id,
            session_id="origin-session",
            triage=True,
        )
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET status = 'scheduled' WHERE id = ?",
                (tid,),
            )

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Tightened body",
    })

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="foreground-triage", loop_safe=True)
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is True
    assert outcome.fanout is False
    with kb.connect() as conn:
        planning_task = kb.get_task(conn, tid)
        intake_events = [event for event in kb.list_events(conn, tid) if event.kind == "loop_intake_state"]
    assert planning_task is not None
    assert planning_task.status == "scheduled"
    assert planning_task.title == "Tightened title"
    assert intake_events[-1].payload == {
        "author": "foreground-triage",
        "child_ids": [],
        "dispatchable": False,
        "fanout": False,
        "needed": True,
        "source": "foreground_triage",
        "state": "planned",
    }


def test_live_skeleton_single_task_spec_preserves_foreground_title(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Stable Loop workflow",
        )
        skeleton = kb.create_task(
            conn,
            title="Foreground-authored node title",
            created_by="foreground",
            workflow_id=workflow_id,
            needs_specification=True,
        )

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Model-tightened replacement title",
        "body": "Detailed worker specification from the decomposer.",
        "assignee": "engineer",
    })
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(skeleton, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is True
    assert outcome.new_title == "Foreground-authored node title"
    with kb.connect() as conn:
        task = kb.get_task(conn, skeleton)
    assert task is not None
    assert task.title == "Foreground-authored node title"
    assert task.body == "Detailed worker specification from the decomposer."
    assert task.assignee == "engineer"
    assert task.needs_specification is False


def test_live_skeleton_single_task_requires_worker_ready_body(kanban_home):
    _, skeleton = _create_live_skeleton()
    llm_payload = jsonlib.dumps(
        {
            "fanout": False,
            "title": "Model title",
            "body": "   ",
            "assignee": "engineer",
        }
    )
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(skeleton, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    assert "nonempty worker-ready body" in outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, skeleton)
        failures = [
            event
            for event in kb.list_events(conn, skeleton)
            if event.kind == "specification_failed"
        ]
        assert kb.child_ids(conn, skeleton) == []
    assert task is not None
    assert task.status == "triage" and task.needs_specification is True
    assert "nonempty worker-ready body" in failures[-1].payload["reason"]


@pytest.mark.parametrize(
    ("child", "reason"),
    [
        (
            {"title": "Child", "body": "Do it", "parents": [99]},
            "not a valid dependency index",
        ),
        (
            {"title": "Child", "body": "Do it", "parents": ["0"]},
            "must be an integer index",
        ),
        (
            {"title": "Child", "body": "", "parents": []},
            "nonempty worker-ready specification",
        ),
        (
            {"title": "Child", "body": 7, "parents": []},
            "nonempty worker-ready specification",
        ),
        (
            {"title": "Child", "body": "Do it"},
            "parents must be a list",
        ),
    ],
)
def test_live_skeleton_fanout_fails_closed_on_malformed_children(
    kanban_home,
    child,
    reason,
):
    _, skeleton = _create_live_skeleton()
    llm_payload = jsonlib.dumps(
        {"fanout": True, "rationale": "split", "tasks": [child]}
    )
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(skeleton, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    assert reason in outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, skeleton)
        failures = [
            event
            for event in kb.list_events(conn, skeleton)
            if event.kind == "specification_failed"
        ]
        assert kb.child_ids(conn, skeleton) == []
    assert task is not None
    assert task.status == "triage" and task.needs_specification is True
    assert reason in failures[-1].payload["reason"]


def test_live_skeleton_fanout_honors_graph_node_limit(kanban_home):
    _, skeleton = _create_live_skeleton()
    llm_payload = jsonlib.dumps(
        {
            "fanout": True,
            "rationale": "too broad",
            "tasks": [
                {"title": f"Child {index}", "body": "Do it", "parents": []}
                for index in range(3)
            ],
        }
    )
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"loop": {"max_graph_nodes": 2}},
        ):
            outcome = decomp.decompose_task(skeleton, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    assert "maximum is 2" in outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, skeleton)
        failures = [
            event
            for event in kb.list_events(conn, skeleton)
            if event.kind == "specification_failed"
        ]
        assert kb.child_ids(conn, skeleton) == []
    assert task is not None
    assert task.status == "triage" and task.needs_specification is True
    assert "maximum is 2" in failures[-1].payload["reason"]


def test_decompose_fanout_false_assigns_default_when_unassigned(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="just one thing", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "**Goal**\nDo the thing.",
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.fanout is False
    assert outcome.new_title == "Tightened title"
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    # specify path with no parents -> recompute_ready flips to 'ready'
    assert task.status == "ready"
    assert task.title == "Tightened title"
    assert task.assignee == "fallback"


def test_decompose_fanout_false_preserves_existing_assignee(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(
            conn,
            title="already routed",
            assignee="engineer",
            triage=True,
        )

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Keep existing lane.",
        "assignee": "fallback",
    })

    patches = _patch_list_profiles(["orchestrator", "engineer", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "engineer"
    assert task.title == "Tightened title"


def test_decompose_fanout_false_uses_valid_llm_assignee(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="route me", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Route to specialist.",
        "assignee": "engineer",
    })

    patches = _patch_list_profiles(["orchestrator", "engineer", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "engineer"


def test_decompose_fanout_false_invalid_llm_assignee_uses_default(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="route me safely", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Route to fallback.",
        "assignee": "made_up",
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "fallback"


def test_decompose_unknown_assignee_falls_back_to_default(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)

    # Roster only has 'orchestrator' and 'fallback'; LLM picks 'made_up'.
    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "test",
        "tasks": [
            {"title": "do X", "body": "", "assignee": "made_up", "parents": []},
        ],
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with patch.dict(
            "os.environ", {}, clear=False,
        ), _patch_aux_client(llm_payload), _patch_extra_body(), \
            patch(
                "hermes_cli.kanban_decompose._load_config",
                return_value={
                    "kanban": {
                        "orchestrator_profile": "orchestrator",
                        "default_assignee": "fallback",
                    }
                },
            ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.child_ids and len(outcome.child_ids) == 1
    with kb.connect() as conn:
        child = kb.get_task(conn, outcome.child_ids[0])
    # 'made_up' wasn't in roster, so assignee rewritten to 'fallback'
    assert child.assignee == "fallback"


def test_decompose_handles_malformed_llm_json(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", needs_specification=True)

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client("not json at all, sorry"), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is False
    assert "malformed JSON" in outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
        failures = [
            event for event in kb.list_events(conn, tid)
            if event.kind == "specification_failed"
        ]
        assert kb.child_ids(conn, tid) == []
    assert task is not None and task.status == "triage"
    assert task.needs_specification is True
    assert failures[-1].payload["reason"] == "LLM returned malformed JSON"
    assert failures[-1].payload["retry_after"] > failures[-1].created_at
    assert tid not in decomp.list_triage_ids()

    # Once the durable backoff expires, the watcher may retry the same shell.
    with kb.connect() as conn, kb.write_txn(conn):
        payload = dict(failures[-1].payload)
        payload["retry_after"] = 0
        conn.execute(
            "UPDATE task_events SET payload = ? WHERE id = ?",
            (jsonlib.dumps(payload), failures[-1].id),
        )
    assert tid in decomp.list_triage_ids()


def test_decompose_persists_api_failure_and_backoff(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="compile me", needs_specification=True)

    patches = _patch_list_profiles(["orchestrator"])
    for item in patches:
        item.start()
    try:
        with patch(
            "agent.auxiliary_client.call_llm",
            side_effect=RuntimeError("offline"),
        ), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    assert outcome.reason == "LLM error: RuntimeError"
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
        failures = [
            event for event in kb.list_events(conn, tid)
            if event.kind == "specification_failed"
        ]
    assert task is not None and task.status == "triage"
    assert task.needs_specification is True
    assert failures[-1].payload["reason"] == "LLM error: RuntimeError"
    assert tid not in decomp.list_triage_ids()


def test_decompose_rejects_output_after_foreground_edit_during_llm_call(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(
            conn,
            title="Initial shell",
            body="Initial context",
            needs_specification=True,
        )

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "split it",
        "tasks": [
            {
                "title": "Stale generated child",
                "body": "This must not be persisted.",
                "assignee": "engineer",
                "parents": [],
            },
        ],
    })

    def edit_then_respond(**_kwargs):
        with kb.connect() as edit_conn, kb.write_txn(edit_conn):
            edit_conn.execute(
                "UPDATE tasks SET title = ?, body = ? WHERE id = ?",
                ("Foreground revision", "New constraints", tid),
            )
            kb._append_event(
                edit_conn,
                tid,
                "edited",
                {"fields": ["title", "body"], "author": "foreground"},
            )
        return _fake_aux_response(llm_payload)

    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with patch(
            "agent.auxiliary_client.call_llm",
            side_effect=edit_then_respond,
        ), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    assert "stale decomposer output rejected" in outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
        children = kb.child_ids(conn, tid)
        failures = [
            event for event in kb.list_events(conn, tid)
            if event.kind == "specification_failed"
        ]
    assert task is not None
    assert (task.title, task.body) == ("Foreground revision", "New constraints")
    assert task.status == "triage" and task.needs_specification is True
    assert children == []
    assert failures == []
    assert tid in decomp.list_triage_ids()


def test_failed_llm_call_does_not_backoff_a_concurrently_edited_revision(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(
            conn,
            title="Initial shell",
            body="Initial context",
            needs_specification=True,
        )

    def edit_then_fail(**_kwargs):
        with kb.connect() as edit_conn, kb.write_txn(edit_conn):
            edit_conn.execute(
                "UPDATE tasks SET body = ? WHERE id = ?",
                ("Foreground correction", tid),
            )
            kb._append_event(
                edit_conn,
                tid,
                "edited",
                {"fields": ["body"], "author": "foreground"},
            )
        raise RuntimeError("transient old-revision failure")

    patches = _patch_list_profiles(["orchestrator"])
    for item in patches:
        item.start()
    try:
        with patch(
            "agent.auxiliary_client.call_llm",
            side_effect=edit_then_fail,
        ), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok is False
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
        failures = [
            event for event in kb.list_events(conn, tid)
            if event.kind == "specification_failed"
        ]
    assert task is not None and task.body == "Foreground correction"
    assert task.needs_specification is True and task.status == "triage"
    assert failures == []
    assert tid in decomp.list_triage_ids()


def test_decompose_retries_empty_length_output(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="dynamic loop work", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "minimal dynamic scaffold",
        "tasks": [
            {
                "title": "Implement dynamic scaffold",
                "body": "Preserve decision packets as on-demand expansion points.",
                "assignee": "engineer",
                "parents": [],
            },
        ],
    })

    responses = [
        ("", "length"),
        (llm_payload, "stop"),
    ]
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client_sequence(responses) as call_llm, _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.child_ids and len(outcome.child_ids) == 1
    max_tokens = [
        call.kwargs["max_tokens"]
        for call in call_llm.call_args_list
    ]
    assert max_tokens == [4000, 12000]


def test_decompose_reports_empty_truncated_output(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)

    responses = [
        ("", "length"),
        ("", "length"),
    ]
    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client_sequence(responses), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is False
    assert "empty/truncated" in outcome.reason


def test_decomposer_prompt_preserves_dynamic_loop_expansion():
    assert "do NOT pre-materialize" in decomp._SYSTEM_PROMPT
    assert "delegate durable Loop subtasks" in decomp._SYSTEM_PROMPT


def test_live_skeleton_prompt_uses_only_workflow_and_adjacent_graph_context(kanban_home):
    with kb.connect() as conn:
        workflow_id = kb.create_workflow(
            conn,
            title="Ship live graph",
            shared_context="Keep the workflow dynamic",
        )
        parent_id = kb.create_task(
            conn,
            title="Research constraints",
            created_by="foreground",
            workflow_id=workflow_id,
        )
        kb.add_comment(
            conn,
            parent_id,
            "reviewer-qa",
            "PARENT_REVIEW_MARKER: preserve settled wake coalescing.",
        )
        kb.complete_task(conn, parent_id, summary="The existing dispatcher is reusable.")
        skeleton_id = kb.create_task(
            conn,
            title="Implement the live compiler",
            created_by="foreground",
            workflow_id=workflow_id,
            parents=[parent_id],
            needs_specification=True,
        )
        downstream_id = kb.create_task(
            conn,
            title="Verify end to end",
            created_by="foreground",
            workflow_id=workflow_id,
            parents=[skeleton_id],
            needs_specification=True,
        )
        assert kb.get_task(conn, skeleton_id).status == "triage"
        assert kb.get_task(conn, downstream_id).status == "todo"

    response = jsonlib.dumps(
        {
            "fanout": False,
            "rationale": "single unit",
            "title": "Implement the live compiler",
            "body": "Use the existing dispatcher and preserve dependency gates.",
            "assignee": "engineer",
        }
    )
    call_llm = MagicMock(return_value=_fake_aux_response(response))
    patches = _patch_list_profiles(["orchestrator", "engineer"])
    for item in patches:
        item.start()
    try:
        with patch(
            "agent.auxiliary_client.call_llm",
            call_llm,
        ), _patch_extra_body():
            outcome = decomp.decompose_task(skeleton_id, author="auto-decomposer")
    finally:
        for item in patches:
            item.stop()

    assert outcome.ok, outcome.reason
    prompt = call_llm.call_args.kwargs["messages"][1]["content"]
    assert "Workflow context:" in prompt
    assert "Ship live graph" in prompt
    assert "The existing dispatcher is reusable." in prompt
    assert "comment/review from `reviewer-qa`" in prompt
    assert "PARENT_REVIEW_MARKER" in prompt
    assert "Immediate downstream work" in prompt
    assert "Verify end to end" in prompt


def test_decompose_returns_false_when_task_not_triage(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x")  # ready, not triage

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()
    assert outcome.ok is False
    assert "not in triage" in outcome.reason


def test_decompose_no_aux_client_configured(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", needs_specification=True)

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        # call_llm raises RuntimeError when no provider is configured; the
        # decomposer must convert that into a failed outcome, not a crash.
        with patch(
            "agent.auxiliary_client.call_llm",
            side_effect=RuntimeError("No LLM provider configured"),
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is False
    # call_llm's no-provider RuntimeError surfaces via the LLM-error branch.
    assert "LLM error" in outcome.reason
