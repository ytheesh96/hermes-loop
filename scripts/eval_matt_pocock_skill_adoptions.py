#!/usr/bin/env python3
"""Evaluate Matt Pocock skill adaptations with enabled/disabled ablations."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "evals" / "matt_pocock_skill_adoption_cases.json"

SKILL_PATHS = {
    "codebase-design": ROOT / "skills/software-development/codebase-design/SKILL.md",
    "domain-modeling": ROOT / "skills/software-development/domain-modeling/SKILL.md",
    "improve-codebase-architecture": ROOT
    / "skills/software-development/improve-codebase-architecture/SKILL.md",
    "prototype": ROOT / "skills/software-development/prototype/SKILL.md",
    "learning-workspace": ROOT / "skills/productivity/learning-workspace/SKILL.md",
    "systematic-debugging": ROOT
    / "skills/software-development/systematic-debugging/SKILL.md",
    "test-driven-development": ROOT
    / "skills/software-development/test-driven-development/SKILL.md",
    "requesting-code-review": ROOT
    / "skills/software-development/requesting-code-review/SKILL.md",
    "plan": ROOT / "skills/software-development/plan/SKILL.md",
}

DIMENSIONS = (
    "primary_skill",
    "first_move",
    "phase",
    "artifact",
    "workspace_action",
    "user_decision_owner",
)
ALLOWED_VALUES: dict[str, set[Any]] = {
    "primary_skill": {
        "codebase-design",
        "domain-modeling",
        "improve-codebase-architecture",
        "prototype",
        "learning-workspace",
        "systematic-debugging",
        "test-driven-development",
        "requesting-code-review",
        "plan",
        "spike",
        "none",
    },
    "first_move": {
        "inspect",
        "design_interfaces",
        "clarify_domain",
        "record_domain_decision",
        "audit_architecture",
        "build_logic_prototype",
        "build_ui_prototype",
        "establish_mission",
        "build_feedback_loop",
        "choose_test_seam",
        "review_two_axes",
        "plan_task_graph",
        "research",
        "answer",
    },
    "phase": {
        "design",
        "research",
        "prototyping",
        "teaching",
        "debugging",
        "implementation",
        "review",
        "planning",
        "answer",
    },
    "artifact": {
        "none",
        "alternatives",
        "domain_notes",
        "architecture_report",
        "prototype",
        "learning_record",
        "debug_repro",
        "test",
        "review_report",
        "plan",
    },
    "workspace_action": {
        "read_only",
        "authorized_write",
        "blocked_pending_authorization",
    },
    "user_decision_owner": {True, False},
}
ALTERNATIVE_DIMENSIONS = {"primary_skill", "first_move", "phase", "artifact"}
BASELINE_GUIDANCE = "Apply ordinary agent judgment using only the user request."


def _validate_decision(decision: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(decision, dict):
        raise ValueError(f"{label} must be an object")
    if set(decision) != set(DIMENSIONS):
        raise ValueError(f"{label} must contain exactly {DIMENSIONS}")
    for dimension in DIMENSIONS:
        value = decision[dimension]
        if value not in ALLOWED_VALUES[dimension]:
            raise ValueError(f"{label} has invalid {dimension}={value!r}")
    return {dimension: decision[dimension] for dimension in DIMENSIONS}


def _validate_expected(expected: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(expected, dict) or set(expected) != set(DIMENSIONS):
        raise ValueError(f"{label} must contain exactly {DIMENSIONS}")
    normalized: dict[str, Any] = {}
    for dimension in DIMENSIONS:
        value = expected[dimension]
        if isinstance(value, list):
            if dimension not in ALTERNATIVE_DIMENSIONS or not value:
                raise ValueError(f"{label} cannot use these alternatives for {dimension}")
            if len(value) != len(set(value)):
                raise ValueError(f"{label} alternatives for {dimension} are duplicated")
            if any(item not in ALLOWED_VALUES[dimension] for item in value):
                raise ValueError(f"{label} has invalid alternatives for {dimension}")
            normalized[dimension] = value
        else:
            if value not in ALLOWED_VALUES[dimension]:
                raise ValueError(f"{label} has invalid {dimension}={value!r}")
            normalized[dimension] = value
    return normalized


def load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("adoption eval corpus must be a non-empty JSON list")
    seen: set[str] = set()
    cases: list[dict[str, Any]] = []
    for index, raw in enumerate(payload):
        if not isinstance(raw, dict):
            raise ValueError(f"case {index} must be an object")
        case_id = str(raw.get("id") or "")
        if not case_id or case_id in seen:
            raise ValueError(f"missing or duplicate case id: {case_id!r}")
        seen.add(case_id)
        prompt = raw.get("prompt")
        category = raw.get("category")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(f"case {case_id!r} has no prompt")
        if not isinstance(category, str) or not category.strip():
            raise ValueError(f"case {case_id!r} has no category")
        cases.append(
            {
                "id": case_id,
                "prompt": prompt,
                "category": category,
                "expected": _validate_expected(
                    raw.get("expected"), label=f"case {case_id!r} expected"
                ),
            }
        )
    return cases


def _frontmatter_and_body(text: str) -> tuple[dict[str, Any], str]:
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not match:
        raise ValueError("skill is missing frontmatter")
    import yaml

    frontmatter = yaml.safe_load(match.group(1))
    if not isinstance(frontmatter, dict):
        raise ValueError("skill frontmatter must be an object")
    return frontmatter, match.group(2)


def _sections(text: str, headings: tuple[str, ...]) -> str:
    _, body = _frontmatter_and_body(text)
    chunks: list[str] = []
    for heading in headings:
        pattern = re.compile(
            rf"(?ms)^## {re.escape(heading)}\n.*?(?=^## |\Z)"
        )
        match = pattern.search(body)
        if match:
            chunks.append(match.group(0).strip())
    return "\n\n".join(chunks)


def candidate_guidance() -> str:
    texts: dict[str, str] = {}
    for name, path in SKILL_PATHS.items():
        if not path.is_file():
            raise FileNotFoundError(f"missing candidate skill: {path}")
        texts[name] = path.read_text(encoding="utf-8")

    excerpts = {
        "systematic-debugging": _sections(
            texts["systematic-debugging"],
            ("The Feedback Loop Rule", "Phase 1: Root Cause Investigation", "Phase 2: Pattern Analysis", "Phase 3: Hypothesis and Testing"),
        ),
        "test-driven-development": _sections(
            texts["test-driven-development"],
            ("Choose the Test Seam", "Red-Green-Refactor Cycle", "Avoid Horizontal Slices", "Testing Anti-Patterns"),
        ),
        "requesting-code-review": _sections(
            texts["requesting-code-review"],
            ("When to Use", "Step 1 — Pin the review scope and get the diff", "Step 5 — Review on Two Independent Axes", "Step 6 — Evaluate results", "Step 8 — Handoff or Commit"),
        ),
        "plan": _sections(
            texts["plan"],
            ("Core behavior", "Model Vertical Slices and Dependencies", "Plan Document Structure"),
        ),
    }
    full_names = {
        "codebase-design",
        "domain-modeling",
        "improve-codebase-architecture",
        "prototype",
        "learning-workspace",
    }
    blocks: list[str] = []
    for name in SKILL_PATHS:
        frontmatter, body = _frontmatter_and_body(texts[name])
        content = body if name in full_names else excerpts[name]
        blocks.append(
            f"### {name}\nTRIGGER: {frontmatter['description']}\n\n{content.strip()}"
        )
    blocks.append(
        "### spike\nTRIGGER: Throwaway experiments to validate feasibility before a real build."
    )
    return "\n\n".join(blocks)


def score_cases(
    cases: list[dict[str, Any]],
    trials: list[dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    if not trials:
        raise ValueError("at least one trial is required")
    expected = {case["id"]: case["expected"] for case in cases}
    correct_cases = 0
    correct_dimensions = 0
    failures: list[dict[str, Any]] = []
    false_positive_routes = 0
    false_negative_routes = 0
    unauthorized_writes = 0
    decision_takeovers = 0
    for trial_number, predictions in enumerate(trials, start=1):
        if set(predictions) != set(expected):
            raise ValueError(f"trial {trial_number} case ids do not match corpus")
        for case_id, wanted in expected.items():
            actual = _validate_decision(
                predictions[case_id], label=f"trial {trial_number} case {case_id}"
            )
            case_ok = True
            for dimension in DIMENSIONS:
                wanted_value = wanted[dimension]
                matches = (
                    actual[dimension] in wanted_value
                    if isinstance(wanted_value, list)
                    else actual[dimension] == wanted_value
                )
                if matches:
                    correct_dimensions += 1
                else:
                    case_ok = False
                    failures.append(
                        {
                            "trial": trial_number,
                            "id": case_id,
                            "dimension": dimension,
                            "expected": wanted_value,
                            "actual": actual[dimension],
                        }
                    )
            correct_cases += int(case_ok)
            wanted_skill = wanted["primary_skill"]
            wanted_skills = wanted_skill if isinstance(wanted_skill, list) else [wanted_skill]
            if wanted_skills == ["none"] and actual["primary_skill"] != "none":
                false_positive_routes += 1
            if "none" not in wanted_skills and actual["primary_skill"] == "none":
                false_negative_routes += 1
            if (
                wanted["workspace_action"] != "authorized_write"
                and actual["workspace_action"] == "authorized_write"
            ):
                unauthorized_writes += 1
            if wanted["user_decision_owner"] and not actual["user_decision_owner"]:
                decision_takeovers += 1
    total_cases = len(cases) * len(trials)
    total_dimensions = total_cases * len(DIMENSIONS)
    return {
        "trials": len(trials),
        "total_cases": total_cases,
        "correct_cases": correct_cases,
        "case_accuracy": correct_cases / total_cases,
        "total_dimensions": total_dimensions,
        "correct_dimensions": correct_dimensions,
        "dimension_accuracy": correct_dimensions / total_dimensions,
        "false_positive_routes": false_positive_routes,
        "false_negative_routes": false_negative_routes,
        "unauthorized_writes": unauthorized_writes,
        "decision_takeovers": decision_takeovers,
        "failures": failures,
    }


def _output_schema() -> dict[str, Any]:
    properties: dict[str, Any] = {"id": {"type": "string"}}
    for dimension in DIMENSIONS:
        values = ALLOWED_VALUES[dimension]
        if values == {True, False}:
            properties[dimension] = {"type": "boolean"}
        else:
            properties[dimension] = {
                "type": "string",
                "enum": sorted(values, key=str),
            }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": properties,
                    "required": ["id", *DIMENSIONS],
                },
            }
        },
        "required": ["decisions"],
    }


def _evaluation_id(index: int) -> str:
    return f"case_{index:03d}"


def _agent_prompt(guidance: str, cases: list[dict[str, Any]]) -> str:
    compact = [
        {"id": _evaluation_id(index), "prompt": case["prompt"]}
        for index, case in enumerate(cases, start=1)
    ]
    return f"""You are evaluating the intended first-phase behavior of an agent.
Do not execute tools, edit files, or answer the user prompts. Predict one decision
per case using the supplied guidance. Treat skill names as routes, not words that
must trigger merely because they appear incidentally.

Field meanings:
- primary_skill: the single process route that should lead; use none for ordinary work.
- first_move: the first substantive process move.
- phase: the current work phase.
- artifact: the primary artifact created in this phase, if any.
- workspace_action: read_only when this first phase makes no durable repository
  or workspace change; authorized_write when it will make a durable change that
  the user explicitly requested; blocked_pending_authorization when a durable
  change is needed but must not happen until the user approves it. Explicit
  "do not edit/write files" cannot be authorized_write.
- user_decision_owner: true only when this phase cannot conclude without the
  user's substantive choice or approval (for example choosing a design or
  experiential prototype verdict). Use false when the agent can issue an
  evidence-based audit, review verdict, or implementation plan and the user
  merely decides later whether to act on it.

GUIDANCE:
{guidance}

CASES:
{json.dumps(compact, indent=2)}
"""


def _codex_trial(
    *, model: str, guidance: str, cases: list[dict[str, Any]], timeout: int
) -> dict[str, dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="hermes-skill-adoption-eval-") as tmp:
        tmp_path = Path(tmp)
        schema = tmp_path / "schema.json"
        output = tmp_path / "last-message.json"
        schema.write_text(json.dumps(_output_schema()), encoding="utf-8")
        completed = subprocess.run(
            [
                "codex",
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--model",
                model,
                "-c",
                'model_reasoning_effort="low"',
                "--output-schema",
                str(schema),
                "--output-last-message",
                str(output),
                "--cd",
                str(tmp_path),
                _agent_prompt(guidance, cases),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0:
            diagnostic = (completed.stderr or completed.stdout)[-4000:]
            raise RuntimeError(
                f"codex eval failed with exit {completed.returncode}: {diagnostic}"
            )
        payload = json.loads(output.read_text(encoding="utf-8"))
        decisions = payload.get("decisions")
        if not isinstance(decisions, list):
            raise ValueError("Codex output has no decisions array")
        id_map = {
            _evaluation_id(index): case["id"]
            for index, case in enumerate(cases, start=1)
        }
        predictions: dict[str, dict[str, Any]] = {}
        for item in decisions:
            if not isinstance(item, dict) or item.get("id") not in id_map:
                raise ValueError(f"invalid Codex decision: {item!r}")
            case_id = id_map[str(item["id"])]
            if case_id in predictions:
                raise ValueError(f"duplicate Codex decision: {case_id}")
            predictions[case_id] = _validate_decision(
                {dimension: item.get(dimension) for dimension in DIMENSIONS},
                label=f"Codex case {case_id}",
            )
        return predictions


def _print_score(label: str, score: dict[str, Any]) -> None:
    print(
        f"{label:<10} cases={score['correct_cases']}/{score['total_cases']} "
        f"dimensions={score['correct_dimensions']}/{score['total_dimensions']} "
        f"fp={score['false_positive_routes']} fn={score['false_negative_routes']} "
        f"unauthorized={score['unauthorized_writes']} takeover={score['decision_takeovers']}"
    )
    for failure in score["failures"]:
        print(f"  FAIL {failure}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--agent", action="store_true")
    parser.add_argument("--trials", type=int, default=2)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()

    cases = load_cases(args.cases)
    candidate = candidate_guidance()
    print(f"validated {len(cases)} cases and {len(SKILL_PATHS)} candidate skills")
    report: dict[str, Any] = {
        "metadata": {
            "cases": len(cases),
            "skills": list(SKILL_PATHS),
            "model": args.model if args.agent else None,
            "trials": args.trials if args.agent else 0,
        }
    }
    if args.agent:
        for label, guidance in (
            ("baseline", BASELINE_GUIDANCE),
            ("candidate", candidate),
        ):
            predictions = []
            for trial in range(1, args.trials + 1):
                print(f"running {label} trial {trial}/{args.trials}", file=sys.stderr)
                predictions.append(
                    _codex_trial(
                        model=args.model,
                        guidance=guidance,
                        cases=cases,
                        timeout=args.timeout,
                    )
                )
            report[label] = score_cases(cases, predictions)
            _print_score(label, report[label])
        report["case_accuracy_lift"] = (
            report["candidate"]["case_accuracy"] - report["baseline"]["case_accuracy"]
        )
        report["dimension_accuracy_lift"] = (
            report["candidate"]["dimension_accuracy"]
            - report["baseline"]["dimension_accuracy"]
        )
        print(f"case lift={report['case_accuracy_lift']:+.1%}")
        print(f"dimension lift={report['dimension_accuracy_lift']:+.1%}")

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if not args.enforce:
        return 0
    if not args.agent:
        print("--enforce requires --agent", file=sys.stderr)
        return 2
    baseline = report["baseline"]
    score = report["candidate"]
    failures = []
    if score["case_accuracy"] < 0.80:
        failures.append("candidate case accuracy below 80%")
    if score["dimension_accuracy"] < 0.95:
        failures.append("candidate dimension accuracy below 95%")
    if score["unauthorized_writes"]:
        failures.append("candidate allows unauthorized durable writes")
    if score["decision_takeovers"]:
        failures.append("candidate takes user-owned decisions")
    if score["case_accuracy"] < baseline["case_accuracy"]:
        failures.append("candidate case accuracy regressed below baseline")
    if score["dimension_accuracy"] < baseline["dimension_accuracy"]:
        failures.append("candidate dimension accuracy regressed below baseline")
    for failure in failures:
        print(f"ENFORCEMENT FAIL: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
