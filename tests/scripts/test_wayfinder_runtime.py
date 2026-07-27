"""Execution-level coverage for the Wayfinder runtime evaluator."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "eval_wayfinder_runtime.py"


def _load_module():
    assert SCRIPT.is_file(), f"missing runtime evaluator: {SCRIPT}"
    spec = importlib.util.spec_from_file_location("eval_wayfinder_runtime", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_runtime_cases_cover_the_four_outcome_boundaries() -> None:
    module = _load_module()
    assert [case.id for case in module.CASES] == [
        "ambiguous_architecture",
        "clear_implementation",
        "explicit_loop",
        "minor_ambiguity",
    ]
    assert all(case.prompt for case in module.CASES)
    assert all(case.expected for case in module.CASES)


def test_runtime_fresh_foreground_env_clears_delegated_lineage(monkeypatch) -> None:
    module = _load_module()
    monkeypatch.setenv("HERMES_DELEGATED_CHILD_CONTEXT", "1")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_parent")
    monkeypatch.setenv("HERMES_WORKFLOW_ID", "wf_parent")

    env = module._fresh_foreground_env()

    assert "HERMES_DELEGATED_CHILD_CONTEXT" not in env
    assert "HERMES_KANBAN_TASK" not in env
    assert "HERMES_WORKFLOW_ID" not in env


def test_trace_evaluator_requires_fresh_runtime_and_inspectable_tools() -> None:
    module = _load_module()
    report = module.evaluate_trace(
        module.CASES[0],
        {
            "fresh_process": True,
            "returncode": 0,
            "session_id": "session-1",
            "workflow_id": "wf-wayfinder",
            "requests": [
                {
                    "messages": [
                        {"role": "system", "content": "<available_skills>\n- wayfinder: durable decision map\n</available_skills>"},
                        {"role": "user", "content": module.CASES[0].prompt},
                    ],
                    "tools": [{"function": {"name": "skills_list"}}],
                },
                {
                    "messages": [{"role": "tool", "name": "skills_list", "content": "{}"}],
                    "tools": [],
                },
            ],
            "tool_events": [
                {"name": "skills_list", "phase": "call"},
                {"name": "skills_list", "phase": "result"},
                {"name": "skill_view", "phase": "call"},
                {"name": "skill_view", "phase": "result"},
                {"name": "read_file", "phase": "call"},
                {"name": "read_file", "phase": "result"},
                {
                    "name": "delegate_task",
                    "phase": "call",
                    "arguments": {"mode": "loop"},
                },
                {"name": "delegate_task", "phase": "result"},
            ],
            "hook_events": [{"tool_name": "read_file", "duration_ms": 1, "status": "ok"}],
            "sandbox_changed": False,
            "final_text": "I inspected the repository and need your choice between A and B.",
        },
    )
    assert report["passed"] is True
    assert report["checks"]["skill_discovery"] is True
    assert report["checks"]["tool_trace"] is True
    assert report["checks"]["production_unchanged"] is True
    assert report["checks"]["loop_route"] is True


def test_ambiguous_boundary_requires_inspection_after_wayfinder_discovery() -> None:
    module = _load_module()
    evidence = {
        "fresh_process": True,
        "returncode": 0,
        "session_id": "session-1",
        "requests": [],
        "tool_events": [
            {"name": "skills_list", "phase": "call"},
            {"name": "skill_view", "phase": "call"},
        ],
        "hook_events": [
            {"tool_name": "skills_list", "duration_ms": 1, "status": "ok"},
            {"tool_name": "skill_view", "duration_ms": 1, "status": "ok"},
        ],
        "sandbox_changed": False,
        "final_text": "Which choice should the foreground approve?",
    }
    report = module.evaluate_trace(module.CASES[0], evidence)
    assert report["passed"] is False
    assert "inspect_before_choice" in report["failed_checks"]


def test_trace_evaluator_does_not_accept_classifier_only_output() -> None:
    module = _load_module()
    report = module.evaluate_trace(
        module.CASES[0],
        {
            "fresh_process": False,
            "returncode": 0,
            "session_id": None,
            "requests": [],
            "tool_events": [],
            "sandbox_changed": False,
            "final_text": "use_wayfinder=true",
        },
    )
    assert report["passed"] is False
    assert "fresh_process" in report["failed_checks"]
    assert "tool_trace" in report["failed_checks"]


def test_trace_evaluator_requires_a_runtime_post_tool_hook_event() -> None:
    module = _load_module()
    evidence = {
        "fresh_process": True,
        "returncode": 0,
        "session_id": "session-1",
        "requests": [],
        "tool_events": [
            {"name": "read_file", "phase": "call"},
            {"name": "read_file", "phase": "result"},
        ],
        "hook_events": [],
        "sandbox_changed": False,
        "final_text": "inspected",
    }
    report = module.evaluate_trace(module.CASES[0], evidence)
    assert report["passed"] is False
    assert "tool_trace" in report["failed_checks"]




def test_loop_boundary_requires_a_workflow_identity() -> None:
    module = _load_module()
    evidence = {
        "fresh_process": True,
        "returncode": 0,
        "session_id": "session-1",
        "workflow_id": None,
        "requests": [],
        "tool_events": [
            {"name": "delegate_task", "phase": "call", "arguments": {"mode": "loop"}},
        ],
        "sandbox_changed": False,
        "final_text": "routed",
    }
    report = module.evaluate_trace(module.CASES[2], evidence)
    assert report["passed"] is False
    assert "loop_route" in report["failed_checks"]


def test_blocker_report_is_reproducible_and_actionable() -> None:
    module = _load_module()
    report = module.blocker_report(
        ["hermes", "-z", "request"],
        returncode=1,
        stderr="No inference provider configured",
        home="/tmp/hermes-eval-home",
    )
    assert report["status"] == "blocked"
    assert report["command"] == ["hermes", "-z", "request"]
    assert "No inference provider configured" in report["stderr"]
    assert report["home"] == "/tmp/hermes-eval-home"


def test_runtime_evidence_redacts_machine_specific_home_paths() -> None:
    module = _load_module()
    home = str(Path.home())
    payload = {
        "home": f"{home}/.hermes",
        "nested": [home, {"path": f"{home}/repo"}],
        "safe": "unchanged",
    }

    redacted = module.redact_machine_specific(payload)

    assert home not in repr(redacted)
    assert redacted["home"] == "<USER_HOME>/.hermes"
    assert redacted["nested"] == ["<USER_HOME>", {"path": "<USER_HOME>/repo"}]
    assert redacted["safe"] == "unchanged"
