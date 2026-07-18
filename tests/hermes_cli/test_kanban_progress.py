"""Focused tests for mutation-scoped Kanban progress nudges.

All decomposition and worker dispatch boundaries are mocked: these tests
exercise orchestration and recovery metadata without calling an LLM or
launching a worker.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_progress as progress


@pytest.fixture
def progress_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _outcome(
    task_id: str,
    *,
    child_ids: list[str] | None = None,
    fanout: bool = False,
):
    return SimpleNamespace(
        task_id=task_id,
        ok=True,
        reason="compiled",
        fanout=fanout,
        child_ids=child_ids or [],
        new_title="Specified task",
    )


def test_dispatch_candidates_uses_exact_scope_and_configured_limits():
    config = {
        "default_assignee": "builder",
        "max_spawn": "7",
        "max_in_progress": 3,
        "max_in_progress_per_profile": 2,
        "failure_limit": 4,
    }
    dispatch_result = kb.DispatchResult(
        spawned=[("task-b", "builder", "/tmp/task-b")],
    )
    conn = MagicMock()

    with (
        patch.object(progress, "_load_kanban_config", return_value=(config, None)),
        patch.object(kb, "dispatch_once", return_value=dispatch_result) as dispatch,
    ):
        result = progress.dispatch_candidates(
            [" task-b ", "task-a", "task-b", ""],
            board="loop-board",
            conn=conn,
        )

    dispatch.assert_called_once_with(
        conn,
        board="loop-board",
        candidate_task_ids=["task-b", "task-a"],
        default_assignee="builder",
        max_spawn=7,
        max_in_progress=3,
        max_in_progress_per_profile=2,
        failure_limit=4,
    )
    assert result["candidate_task_ids"] == ["task-b", "task-a"]
    assert result["dispatch"]["spawned"] == ["task-b"]
    conn.close.assert_not_called()


def test_disabled_auto_decompose_leaves_shells_and_dispatches_only_ready_tasks():
    dispatch_payload = {
        "candidate_task_ids": ["ready-now"],
        "dispatch": {"spawned": ["ready-now"]},
        "warnings": [],
    }

    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=({"auto_decompose": False}, None),
        ),
        patch("hermes_cli.kanban_decompose.decompose_task") as decompose,
        patch.object(
            progress,
            "dispatch_candidates",
            return_value=dispatch_payload,
        ) as dispatch,
    ):
        result = progress.decompose_and_dispatch(
            ["durable-shell"],
            ready_task_ids=["ready-now"],
            board="loop-board",
            conn=MagicMock(),
        )

    decompose.assert_not_called()
    dispatch.assert_called_once_with(
        ["ready-now"],
        board="loop-board",
        conn=dispatch.call_args.kwargs["conn"],
        policy=dispatch.call_args.kwargs["policy"],
    )
    assert result["specification_task_ids"] == ["durable-shell"]
    assert result["decomposition"] == []
    assert result["candidate_task_ids"] == ["ready-now"]
    assert any(
        "automatic decomposition is disabled" in warning
        for warning in result["warnings"]
    )


def test_decompose_and_dispatch_emits_pipeline_timing(caplog):
    dispatch_payload = {
        "candidate_task_ids": ["specified", "child"],
        "dispatch": {"spawned": ["child"]},
        "warnings": [],
    }

    with (
        caplog.at_level(logging.INFO, logger=progress.__name__),
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=(
                {
                    "auto_decompose": True,
                    "specification_concurrency": 1,
                },
                None,
            ),
        ),
        patch(
            "hermes_cli.kanban_decompose.decompose_task",
            return_value=_outcome(
                "specified",
                child_ids=["child"],
                fanout=True,
            ),
        ),
        patch.object(
            progress,
            "dispatch_candidates",
            return_value=dispatch_payload,
        ),
    ):
        result = progress.decompose_and_dispatch(
            ["specified"],
            board="loop-board",
            conn=MagicMock(),
        )

    assert result["dispatch"]["spawned"] == ["child"]
    timing_messages = [
        record.getMessage()
        for record in caplog.records
        if record.name == progress.__name__
        and record.getMessage().startswith("kanban progress timing:")
    ]
    assert len(timing_messages) == 1
    message = timing_messages[0]
    assert "board=loop-board" in message
    assert "specification_tasks=1" in message
    assert "candidate_tasks=2" in message
    assert "spawned=1" in message
    timings = {
        name: float(value)
        for name, value in re.findall(
            r"(setup_ms|specification_ms|dispatch_ms|total_ms)=([0-9.]+)",
            message,
        )
    }
    assert set(timings) == {
        "setup_ms",
        "specification_ms",
        "dispatch_ms",
        "total_ms",
    }
    assert all(value >= 0 for value in timings.values())


@pytest.mark.parametrize(
    ("outcome", "expected_candidates"),
    [
        (_outcome("shell"), ["already-ready", "shell"]),
        (
            _outcome(
                "shell",
                child_ids=["research", "build"],
                fanout=True,
            ),
            ["already-ready", "shell", "research", "build"],
        ),
    ],
    ids=["single-task", "fanout"],
)
def test_successful_decomposition_dispatches_only_result_candidates(
    outcome,
    expected_candidates,
):
    conn = MagicMock()
    dispatch_result = kb.DispatchResult(
        spawned=[("shell", "builder", "/tmp/shell")],
    )

    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=({"auto_decompose": True}, None),
        ),
        patch.object(kb, "scoped_current_board", side_effect=lambda _board: nullcontext()),
        patch(
            "hermes_cli.kanban_decompose.decompose_task",
            return_value=outcome,
        ) as decompose,
        patch.object(kb, "dispatch_once", return_value=dispatch_result) as dispatch,
    ):
        result = progress.decompose_and_dispatch(
            ["shell"],
            ready_task_ids=["already-ready"],
            board="loop-board",
            conn=conn,
            author="foreground-auto-decomposer",
        )

    decompose.assert_called_once_with(
        "shell",
        author="foreground-auto-decomposer",
        loop_safe=False,
    )
    assert dispatch.call_args.kwargs["candidate_task_ids"] == expected_candidates
    assert result["candidate_task_ids"] == expected_candidates
    assert result["decomposition"] == [
        {
            "task_id": "shell",
            "ok": True,
            "reason": "compiled",
            "fanout": outcome.fanout,
            "child_ids": outcome.child_ids,
            "new_title": "Specified task",
        }
    ]


def test_decomposition_failure_preserves_recovery_candidates_and_warns():
    conn = MagicMock()

    def run_decompose(task_id, **_kwargs):
        if task_id == "failed-shell":
            raise RuntimeError("model unavailable")
        return _outcome(task_id)

    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=({"auto_decompose": True}, None),
        ),
        patch.object(kb, "scoped_current_board", side_effect=lambda _board: nullcontext()),
        patch(
            "hermes_cli.kanban_decompose.decompose_task",
            side_effect=run_decompose,
        ) as decompose_mock,
        patch.object(
            kb,
            "dispatch_once",
            return_value=kb.DispatchResult(),
        ) as dispatch,
    ):
        result = progress.decompose_and_dispatch(
            ["failed-shell", "healthy-shell"],
            ready_task_ids=["already-ready"],
            board="loop-board",
            conn=conn,
        )

    assert decompose_mock.call_count == 2
    decompose_mock.assert_has_calls(
        [
            call("failed-shell", author="auto-decomposer", loop_safe=False),
            call("healthy-shell", author="auto-decomposer", loop_safe=False),
        ],
        any_order=True,
    )
    expected_candidates = ["already-ready", "healthy-shell"]
    assert dispatch.call_args.kwargs["candidate_task_ids"] == expected_candidates
    assert result["candidate_task_ids"] == expected_candidates
    assert result["decomposition"][0] == {
        "task_id": "failed-shell",
        "ok": False,
        "reason": (
            "inline decomposition failed for failed-shell: "
            "RuntimeError: model unavailable"
        ),
        "fanout": False,
        "child_ids": [],
        "new_title": None,
    }
    assert result["decomposition"][1]["ok"] is True
    assert any("model unavailable" in warning for warning in result["warnings"])


def test_independent_specifications_run_two_at_a_time_and_dispatch_once():
    state_lock = threading.Lock()
    active = 0
    max_active = 0
    calls: list[str] = []

    def decompose(task_id, **_kwargs):
        nonlocal active, max_active
        with state_lock:
            calls.append(task_id)
            active += 1
            max_active = max(max_active, active)
        time.sleep(1)
        with state_lock:
            active -= 1
        return _outcome(task_id)

    def dispatch(task_ids, **_kwargs):
        candidates = list(task_ids)
        return {
            "candidate_task_ids": candidates,
            "dispatch": {"spawned": candidates},
            "warnings": [],
        }

    started_at = time.monotonic()
    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=(
                {
                    "auto_decompose": True,
                    "specification_concurrency": 2,
                },
                None,
            ),
        ),
        patch(
            "hermes_cli.kanban_decompose.decompose_task",
            side_effect=decompose,
        ),
        patch.object(
            progress,
            "dispatch_candidates",
            side_effect=dispatch,
        ) as dispatch_mock,
    ):
        result = progress.decompose_and_dispatch(
            ["task-0", "task-1", "task-0", "task-2", "task-3"],
            ready_task_ids=["already-ready"],
            board="loop-board",
            conn=MagicMock(),
        )
    elapsed = time.monotonic() - started_at

    assert 1.8 <= elapsed < 3.25
    assert max_active == 2
    assert sorted(calls) == ["task-0", "task-1", "task-2", "task-3"]
    assert [item["task_id"] for item in result["decomposition"]] == [
        "task-0",
        "task-1",
        "task-2",
        "task-3",
    ]
    assert result["candidate_task_ids"] == [
        "already-ready",
        "task-0",
        "task-1",
        "task-2",
        "task-3",
    ]
    dispatch_mock.assert_called_once()


def test_concurrent_specification_pins_explicit_board_without_cross_board_writes(
    progress_home,
):
    with kb.connect(board="alt") as conn:
        task_ids = [
            kb.create_task(conn, title=f"alt task {index}", triage=True)
            for index in range(2)
        ]

    def decompose(task_id, **_kwargs):
        assert kb.get_current_board() == "alt"
        with kb.connect_closing() as conn:
            kb.add_comment(
                conn,
                task_id,
                author="stub-decomposer",
                body=f"specified {task_id}",
            )
        return _outcome(task_id)

    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=(
                {
                    "auto_decompose": True,
                    "specification_concurrency": 2,
                },
                None,
            ),
        ),
        patch(
            "hermes_cli.kanban_decompose.decompose_task",
            side_effect=decompose,
        ),
        patch.object(
            progress,
            "dispatch_candidates",
            side_effect=lambda task_ids, **_kwargs: {
                "candidate_task_ids": list(task_ids),
                "dispatch": {"spawned": []},
                "warnings": [],
            },
        ),
    ):
        result = progress.decompose_and_dispatch(
            task_ids,
            board="alt",
            conn=MagicMock(),
        )

    assert [item["task_id"] for item in result["decomposition"]] == task_ids
    assert all(item["ok"] for item in result["decomposition"])
    with kb.connect(board="alt") as conn:
        assert [
            [comment.body for comment in kb.list_comments(conn, task_id)]
            for task_id in task_ids
        ] == [[f"specified {task_id}"] for task_id in task_ids]
    with kb.connect() as conn:
        assert [kb.get_task(conn, task_id) for task_id in task_ids] == [
            None,
            None,
        ]


def test_specification_concurrency_is_conservatively_bounded():
    assert progress.ProgressPolicy({}).specification_concurrency == 2
    assert (
        progress.ProgressPolicy(
            {"specification_concurrency": 1}
        ).specification_concurrency
        == 1
    )
    assert (
        progress.ProgressPolicy(
            {"specification_concurrency": 99}
        ).specification_concurrency
        == 3
    )


def test_dispatch_failure_keeps_candidates_visible_for_reconciliation():
    conn = MagicMock()

    with (
        patch.object(progress, "_load_kanban_config", return_value=({}, None)),
        patch.object(kb, "dispatch_once", side_effect=RuntimeError("lock backend down")) as dispatch,
    ):
        result = progress.dispatch_candidates(
            ["ready-a", "ready-b"],
            board="loop-board",
            conn=conn,
        )

    dispatch.assert_called_once()
    assert result["candidate_task_ids"] == ["ready-a", "ready-b"]
    assert result["dispatch"]["spawned"] == []
    assert "lock backend down" in result["dispatch"]["error"]
    assert result["warnings"] == [result["dispatch"]["error"]]
    conn.close.assert_not_called()


def test_connection_failure_after_commit_is_returned_as_recovery_warning():
    with (
        patch.object(progress, "_load_kanban_config", return_value=({}, None)),
        patch.object(kb, "connect", side_effect=RuntimeError("database unavailable")),
    ):
        result = progress.dispatch_candidates(["ready-a"], board="loop-board")

    assert result["candidate_task_ids"] == ["ready-a"]
    assert result["dispatch"]["spawned"] == []
    assert "database unavailable" in result["dispatch"]["error"]
    assert result["warnings"] == [result["dispatch"]["error"]]


def test_dispatch_config_failure_fails_closed_with_durable_candidates():
    with (
        patch.object(
            progress,
            "_load_kanban_config",
            return_value=({}, "could not read kanban config"),
        ),
        patch.object(kb, "dispatch_once") as dispatch,
    ):
        result = progress.dispatch_candidates(["ready-a"])

    dispatch.assert_not_called()
    assert result["candidate_task_ids"] == ["ready-a"]
    assert result["dispatch"]["spawned"] == []
    assert result["dispatch"]["skipped_config_unavailable"] is True
    assert result["warnings"] == ["could not read kanban config"]


@pytest.mark.parametrize(
    "loaded_config",
    [
        ["not", "a", "mapping"],
        {"kanban": ["not", "a", "mapping"]},
        {"kanban": None},
    ],
)
def test_malformed_config_shape_fails_closed(loaded_config):
    with (
        patch("hermes_cli.config.load_config", return_value=loaded_config),
        patch.object(kb, "dispatch_once") as dispatch,
        patch("hermes_cli.kanban_decompose.decompose_task") as decompose,
    ):
        result = progress.decompose_and_dispatch(
            ["durable-shell"],
            ready_task_ids=["ready-a"],
        )

    decompose.assert_not_called()
    dispatch.assert_not_called()
    assert result["candidate_task_ids"] == ["ready-a"]
    assert result["dispatch"]["skipped_config_unavailable"] is True
    assert len(result["warnings"]) == 2
    assert "could not read kanban config" in result["warnings"][0]
    assert "decomposition was skipped" in result["warnings"][1]


def test_occupied_dispatch_lock_is_not_retried_inline():
    with (
        patch.object(progress, "_load_kanban_config", return_value=({}, None)),
        patch.object(
            kb,
            "dispatch_once",
            return_value=kb.DispatchResult(skipped_locked=True),
        ) as dispatch,
    ):
        result = progress.dispatch_candidates(["ready-a"], conn=MagicMock())

    dispatch.assert_called_once()
    assert result["candidate_task_ids"] == ["ready-a"]
    assert result["dispatch"]["spawned"] == []
    assert result["dispatch"]["skipped_locked"] is True


def test_real_decomposer_and_dispatcher_advance_only_the_new_skeleton(
    progress_home,
):
    """Exercise the canonical DB/LLM-parse/claim path with only edges mocked."""

    with kb.connect() as conn:
        workflow_id = kb.create_workflow(conn, title="Dynamic workflow")
        unrelated = kb.create_task(
            conn,
            title="Older unrelated work",
            assignee="engineer",
            priority=99,
        )
        skeleton = kb.create_task(
            conn,
            title="Implement the requested change",
            created_by="foreground",
            workflow_id=workflow_id,
            needs_specification=True,
        )

        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = json.dumps(
            {
                "fanout": False,
                "rationale": "one worker-ready unit",
                "title": "Model replacement title",
                "body": "Implement and verify the requested change.",
                "assignee": "engineer",
            }
        )
        response.choices[0].finish_reason = "stop"
        spawned: list[str] = []

        def fake_spawn(task, _workspace, board=None):
            spawned.append(task.id)
            return 4242

        with (
            patch.object(
                progress,
                "_load_kanban_config",
                return_value=(
                    {"auto_decompose": True, "max_in_progress": 4},
                    None,
                ),
            ),
            patch("agent.auxiliary_client.call_llm", return_value=response),
            patch(
                "hermes_cli.profiles.profiles_to_serve",
                return_value=[("engineer", Path.cwd())],
            ),
            patch(
                "hermes_cli.profiles.read_profile_meta",
                return_value={
                    "description": "implementation",
                    "description_auto": False,
                },
            ),
            patch("hermes_cli.profiles.profile_exists", return_value=True),
            patch(
                "hermes_cli.profiles.get_active_profile_name",
                return_value="engineer",
            ),
            patch.object(kb, "_default_spawn", side_effect=fake_spawn),
        ):
            result = progress.decompose_and_dispatch(
                [skeleton],
                board=kb.DEFAULT_BOARD,
                conn=conn,
                author="foreground-auto-decomposer",
            )

        compiled = kb.get_task(conn, skeleton)
        untouched = kb.get_task(conn, unrelated)

    assert result["decomposition"][0]["ok"] is True
    assert result["candidate_task_ids"] == [skeleton]
    assert result["dispatch"]["spawned"] == [skeleton]
    assert spawned == [skeleton]
    assert compiled is not None
    assert compiled.status == "running"
    assert compiled.title == "Implement the requested change"
    assert compiled.body == "Implement and verify the requested change."
    assert compiled.needs_specification is False
    assert untouched is not None and untouched.status == "ready"
