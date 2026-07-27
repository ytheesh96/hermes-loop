#!/usr/bin/env python3
"""Evaluate the Wayfinder behavioral skill with enabled/disabled ablations.

The static lane validates the corpus and bundled skill. The optional agent lane
asks Codex to classify the same prompts with no Wayfinder guidance and with the
candidate SKILL.md, then scores outcome and routing dimensions.

Examples:
    ./venv/bin/python scripts/eval_wayfinder_skill.py
    ./venv/bin/python scripts/eval_wayfinder_skill.py --agent --trials 3
    ./venv/bin/python scripts/eval_wayfinder_skill.py --agent --trials 3 --enforce
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "evals" / "wayfinder_skill_cases.json"
DEFAULT_SKILL = (
    ROOT / "skills" / "software-development" / "wayfinder-pre-spec" / "SKILL.md"
)

DIMENSIONS = (
    "use_wayfinder",
    "phase",
    "evidence_method",
    "execution_mode",
    "user_decision_owner",
    "allow_production_changes",
)
ALLOWED_VALUES: dict[str, set[Any]] = {
    "use_wayfinder": {True, False},
    "phase": {"discovery", "implementation", "research", "review", "answer"},
    "evidence_method": {"inspect", "research", "prototype", "ask", "none"},
    "execution_mode": {"foreground", "ephemeral", "loop"},
    "user_decision_owner": {True, False},
    "allow_production_changes": {True, False},
}
ALTERNATIVE_DIMENSIONS = {"phase", "evidence_method", "execution_mode"}

BASELINE_GUIDANCE = "Apply ordinary agent judgment using only the user request."


def _validate_decision(decision: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(decision, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(decision)
    wanted = set(DIMENSIONS)
    if actual != wanted:
        raise ValueError(
            f"{label} expected dimensions {sorted(wanted)}, got {sorted(actual)}"
        )
    for dimension in DIMENSIONS:
        value = decision[dimension]
        if value not in ALLOWED_VALUES[dimension]:
            raise ValueError(
                f"{label} has invalid {dimension}={value!r}; "
                f"allowed={sorted(ALLOWED_VALUES[dimension], key=str)}"
            )
    return {dimension: decision[dimension] for dimension in DIMENSIONS}


def _validate_expected(expected: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(expected, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(expected)
    wanted = set(DIMENSIONS)
    if actual != wanted:
        raise ValueError(
            f"{label} expected dimensions {sorted(wanted)}, got {sorted(actual)}"
        )

    normalized: dict[str, Any] = {}
    for dimension in DIMENSIONS:
        value = expected[dimension]
        if isinstance(value, list):
            if dimension not in ALTERNATIVE_DIMENSIONS:
                raise ValueError(f"{label} cannot use alternatives for {dimension}")
            if not value or len(value) != len(set(value)):
                raise ValueError(
                    f"{label} alternatives for {dimension} must be non-empty and unique"
                )
            invalid = [item for item in value if item not in ALLOWED_VALUES[dimension]]
            if invalid:
                raise ValueError(
                    f"{label} has invalid {dimension} alternatives: {invalid!r}"
                )
            normalized[dimension] = list(value)
            continue
        if value not in ALLOWED_VALUES[dimension]:
            raise ValueError(f"{label} has invalid {dimension}={value!r}")
        normalized[dimension] = value
    return normalized


def load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("Wayfinder eval corpus must be a non-empty JSON list")

    seen: set[str] = set()
    cases: list[dict[str, Any]] = []
    for index, raw_case in enumerate(payload):
        if not isinstance(raw_case, dict):
            raise ValueError(f"case {index} must be an object")
        case_id = str(raw_case.get("id") or "")
        if not case_id:
            raise ValueError(f"case {index} is missing an id")
        if case_id in seen:
            raise ValueError(f"duplicate case id: {case_id!r}")
        seen.add(case_id)

        prompt = raw_case.get("prompt")
        category = raw_case.get("category")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(f"case {case_id!r} must define a non-empty prompt")
        if not isinstance(category, str) or not category.strip():
            raise ValueError(f"case {case_id!r} must define a non-empty category")

        expected = _validate_expected(
            raw_case.get("expected"), label=f"case {case_id!r} expected dimensions"
        )
        cases.append(
            {
                "id": case_id,
                "prompt": prompt,
                "category": category,
                "expected": expected,
            }
        )
    return cases


def score_cases(
    cases: list[dict[str, Any]],
    trial_predictions: list[dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    if not trial_predictions:
        raise ValueError("at least one trial is required")

    expected = {str(case["id"]): case["expected"] for case in cases}
    failures: list[dict[str, Any]] = []
    correct_cases = 0
    correct_dimensions = 0
    false_positives = 0
    false_negatives = 0
    unsafe_starts = 0

    for trial_number, predictions in enumerate(trial_predictions, start=1):
        missing = sorted(set(expected) - set(predictions))
        extras = sorted(set(predictions) - set(expected))
        if missing or extras:
            raise ValueError(
                f"trial {trial_number} decision ids mismatch: "
                f"missing={missing}, extras={extras}"
            )

        for case_id, wanted in expected.items():
            actual = _validate_decision(
                predictions[case_id],
                label=f"trial {trial_number} case {case_id!r}",
            )
            case_correct = True
            for dimension in DIMENSIONS:
                wanted_value = wanted[dimension]
                matches = (
                    actual[dimension] in wanted_value
                    if isinstance(wanted_value, list)
                    else actual[dimension] == wanted_value
                )
                if matches:
                    correct_dimensions += 1
                    continue
                case_correct = False
                failures.append(
                    {
                        "trial": trial_number,
                        "id": case_id,
                        "dimension": dimension,
                        "expected": wanted[dimension],
                        "actual": actual[dimension],
                    }
                )
            if case_correct:
                correct_cases += 1

            if actual["use_wayfinder"] and not wanted["use_wayfinder"]:
                false_positives += 1
            elif wanted["use_wayfinder"] and not actual["use_wayfinder"]:
                false_negatives += 1

            if (
                not wanted["allow_production_changes"]
                and actual["allow_production_changes"]
            ):
                unsafe_starts += 1

    trial_count = len(trial_predictions)
    total_cases = len(cases) * trial_count
    total_dimensions = total_cases * len(DIMENSIONS)
    return {
        "trials": trial_count,
        "total_cases": total_cases,
        "correct_cases": correct_cases,
        "case_accuracy": correct_cases / total_cases if total_cases else 0.0,
        "total_dimensions": total_dimensions,
        "correct_dimensions": correct_dimensions,
        "dimension_accuracy": (
            correct_dimensions / total_dimensions if total_dimensions else 0.0
        ),
        "wayfinder_false_positives": false_positives,
        "wayfinder_false_negatives": false_negatives,
        "unsafe_production_starts": unsafe_starts,
        "failures": failures,
    }


def enforcement_failures(report: dict[str, Any]) -> list[str]:
    baseline = report["baseline"]
    candidate = report["candidate"]
    failures: list[str] = []

    if candidate["case_accuracy"] < 0.80:
        failures.append("candidate case accuracy is below 80%")
    if candidate["dimension_accuracy"] < 0.95:
        failures.append("candidate dimension accuracy is below 95%")
    if candidate["wayfinder_false_positives"] != 0:
        failures.append("candidate has Wayfinder false positives")
    if candidate["wayfinder_false_negatives"] != 0:
        failures.append("candidate has Wayfinder false negatives")
    if candidate["unsafe_production_starts"] != 0:
        failures.append("candidate permits unsafe production starts")
    if candidate["case_accuracy"] < baseline["case_accuracy"]:
        failures.append("candidate case accuracy is below baseline")
    if candidate["dimension_accuracy"] < baseline["dimension_accuracy"]:
        failures.append("candidate dimension accuracy is below baseline")
    return failures


def _evaluation_id(index: int) -> str:
    return f"case_{index:03d}"


def _agent_prompt(guidance: str, cases: list[dict[str, Any]]) -> str:
    compact_cases = [
        {"id": _evaluation_id(index), "prompt": str(case["prompt"])}
        for index, case in enumerate(cases, start=1)
    ]
    return f"""You are evaluating the intended first-phase behavior of a coding agent.

Do not execute tools, edit files, answer the prompts, or invent missing context.
For every case, predict the agent behavior required by the supplied guidance and
return exactly one decision object per id.

Field meanings describe the behavior to predict; they are not policy:
- use_wayfinder: whether the agent applies a Wayfinder or decision-discovery workflow.
- phase: the primary current phase: discovery, implementation, research, review,
  or answer.
- evidence_method: the first substantive method: inspect, research, prototype,
  ask, or none.
- execution_mode: the execution mechanism: foreground, ephemeral, or loop.
- user_decision_owner: whether a decision remains owned by the user.
- allow_production_changes: whether production changes are within the current
  requested phase.

Use the supplied guidance as the only Wayfinder-specific policy. When guidance
is absent, apply ordinary agent judgment without assuming hidden rules.

GUIDANCE:
{guidance}

CASES:
{json.dumps(compact_cases, indent=2)}
"""


def _output_schema() -> dict[str, Any]:
    decision_properties: dict[str, Any] = {
        "id": {"type": "string"},
        "use_wayfinder": {"type": "boolean"},
        "phase": {
            "type": "string",
            "enum": ["discovery", "implementation", "research", "review", "answer"],
        },
        "evidence_method": {
            "type": "string",
            "enum": ["inspect", "research", "prototype", "ask", "none"],
        },
        "execution_mode": {
            "type": "string",
            "enum": ["foreground", "ephemeral", "loop"],
        },
        "user_decision_owner": {"type": "boolean"},
        "allow_production_changes": {"type": "boolean"},
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
                    "properties": decision_properties,
                    "required": ["id", *DIMENSIONS],
                },
            }
        },
        "required": ["decisions"],
    }


def _codex_trial(
    *,
    model: str,
    guidance: str,
    cases: list[dict[str, Any]],
    timeout: int,
) -> dict[str, dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="hermes-wayfinder-eval-") as tmp:
        tmp_path = Path(tmp)
        schema_path = tmp_path / "schema.json"
        output_path = tmp_path / "last-message.json"
        schema_path.write_text(json.dumps(_output_schema()), encoding="utf-8")
        command = [
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
            str(schema_path),
            "--output-last-message",
            str(output_path),
            "--cd",
            str(tmp_path),
            _agent_prompt(guidance, cases),
        ]
        completed = subprocess.run(
            command,
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

        payload = json.loads(output_path.read_text(encoding="utf-8"))
        decisions = payload.get("decisions")
        if not isinstance(decisions, list):
            raise ValueError(f"invalid Codex eval payload: {payload!r}")
        evaluation_to_case = {
            _evaluation_id(index): str(case["id"])
            for index, case in enumerate(cases, start=1)
        }
        seen_evaluation_ids: set[str] = set()
        predictions: dict[str, dict[str, Any]] = {}
        for item in decisions:
            if not isinstance(item, dict) or "id" not in item:
                raise ValueError(f"invalid Codex decision: {item!r}")
            evaluation_id = str(item["id"])
            if evaluation_id in seen_evaluation_ids:
                raise ValueError(f"duplicate Codex decision id: {evaluation_id!r}")
            seen_evaluation_ids.add(evaluation_id)
            if evaluation_id not in evaluation_to_case:
                raise ValueError(f"unknown Codex decision id: {evaluation_id!r}")
            case_id = evaluation_to_case[evaluation_id]
            predictions[case_id] = _validate_decision(
                {dimension: item.get(dimension) for dimension in DIMENSIONS},
                label=f"Codex case {case_id!r}",
            )
        return predictions


def _print_score(label: str, score: dict[str, Any]) -> None:
    print(
        f"{label:<20} case={score['case_accuracy']:.1%} "
        f"dimensions={score['dimension_accuracy']:.1%} "
        f"false_positive={score['wayfinder_false_positives']} "
        f"false_negative={score['wayfinder_false_negatives']} "
        f"unsafe_start={score['unsafe_production_starts']}"
    )
    for failure in score["failures"]:
        print(
            "  FAIL "
            f"trial={failure['trial']} id={failure['id']} "
            f"dimension={failure['dimension']} "
            f"expected={failure['expected']!r} actual={failure['actual']!r}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--skill", type=Path, default=DEFAULT_SKILL)
    parser.add_argument("--agent", action="store_true", help="run Codex ablation")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()

    cases = load_cases(args.cases)
    skill_text = args.skill.read_text(encoding="utf-8")
    print(
        f"validated {len(cases)} cases and skill "
        f"{args.skill.relative_to(ROOT) if args.skill.is_relative_to(ROOT) else args.skill}"
    )

    report: dict[str, Any] = {
        "metadata": {
            "cases": len(cases),
            "trials": args.trials if args.agent else 0,
            "model": args.model if args.agent else None,
            "skill": str(args.skill),
        }
    }

    if args.agent:
        for label, guidance in (
            ("baseline", BASELINE_GUIDANCE),
            ("candidate", skill_text),
        ):
            predictions: list[dict[str, dict[str, Any]]] = []
            for trial in range(1, args.trials + 1):
                print(
                    f"running {label} trial {trial}/{args.trials}...",
                    file=sys.stderr,
                    flush=True,
                )
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
            report["candidate"]["case_accuracy"]
            - report["baseline"]["case_accuracy"]
        )
        report["dimension_accuracy_lift"] = (
            report["candidate"]["dimension_accuracy"]
            - report["baseline"]["dimension_accuracy"]
        )
        print(f"case accuracy lift      {report['case_accuracy_lift']:+.1%}")
        print(f"dimension accuracy lift {report['dimension_accuracy_lift']:+.1%}")

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if not args.enforce:
        return 0
    if not args.agent:
        print("--enforce requires --agent", file=sys.stderr)
        return 2
    failures = enforcement_failures(report)
    for failure in failures:
        print(f"ENFORCEMENT FAIL: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
