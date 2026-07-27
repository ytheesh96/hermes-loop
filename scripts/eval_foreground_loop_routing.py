#!/usr/bin/env python3
"""Evaluate foreground-vs-hard-Loop routing policy.

The deterministic lane exercises the production routing seam. The optional
agent lane asks Codex to apply the legacy and candidate foreground guidance to
the same cases without executing tools, providing a lightweight prompt
ablation.

Examples:
    ./venv/bin/python scripts/eval_foreground_loop_routing.py
    ./venv/bin/python scripts/eval_foreground_loop_routing.py --agent --trials 2
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
DEFAULT_CASES = ROOT / "evals" / "foreground_loop_routing_cases.json"

LEGACY_GUIDANCE = """## Kanban foreground control
You own workflow decisions and graph mutation; workers execute tasks.
Fast path: when the user supplies a sufficient task goal, call
`delegate_task(mode="loop", tasks=[...])` directly in the first model round.
The auto-decomposer owns specification, fan-out, and routing.
"""


class EvalAgent:
    api_mode = "chat_completions"
    reasoning_config = {"enabled": True, "effort": "ultra"}
    valid_tool_names = {
        "delegate_task",
        "kanban_show",
        "kanban_complete",
        "kanban_comment",
    }
    _foreground_loop_routed = False


def _load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("routing eval corpus must be a non-empty JSON list")
    seen: set[str] = set()
    for case in payload:
        case_id = str(case.get("id") or "")
        if not case_id or case_id in seen:
            raise ValueError(f"missing or duplicate case id: {case_id!r}")
        if not isinstance(case.get("hard_route"), bool):
            raise ValueError(f"case {case_id!r} must define boolean hard_route")
        seen.add(case_id)
    return payload


def _score(
    cases: list[dict[str, Any]],
    trial_predictions: list[dict[str, bool]],
) -> dict[str, Any]:
    expected = {str(case["id"]): bool(case["hard_route"]) for case in cases}
    total = len(expected) * len(trial_predictions)
    correct = false_positives = false_negatives = true_positives = 0
    failures: list[dict[str, Any]] = []
    for trial, predictions in enumerate(trial_predictions, start=1):
        missing = sorted(set(expected) - set(predictions))
        extras = sorted(set(predictions) - set(expected))
        if missing or extras:
            raise ValueError(
                f"trial {trial} decision ids mismatch: missing={missing}, extras={extras}"
            )
        for case_id, wanted in expected.items():
            actual = bool(predictions[case_id])
            if actual == wanted:
                correct += 1
            else:
                failures.append(
                    {
                        "trial": trial,
                        "id": case_id,
                        "expected": wanted,
                        "actual": actual,
                    }
                )
            if actual and wanted:
                true_positives += 1
            elif actual and not wanted:
                false_positives += 1
            elif not actual and wanted:
                false_negatives += 1
    negative_total = sum(not value for value in expected.values()) * len(trial_predictions)
    positive_total = sum(expected.values()) * len(trial_predictions)
    return {
        "trials": len(trial_predictions),
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0.0,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
        "foreground_specificity": (
            (negative_total - false_positives) / negative_total if negative_total else 1.0
        ),
        "explicit_loop_recall": (
            true_positives / positive_total if positive_total else 1.0
        ),
        "failures": failures,
    }


def _deterministic_predictions(cases: list[dict[str, Any]]) -> dict[str, bool]:
    from agent.loop_foreground import decide_foreground_loop_route

    config = {"loop": {"enabled": True, "foreground_routing": "ultra"}}
    return {
        str(case["id"]): decide_foreground_loop_route(
            EvalAgent(), str(case["prompt"]), config=config
        ).route
        for case in cases
    }


def _agent_prompt(guidance: str, cases: list[dict[str, Any]]) -> str:
    compact_cases = [
        {"id": str(case["id"]), "prompt": str(case["prompt"])} for case in cases
    ]
    return f"""You are evaluating the first-turn routing policy of an AI agent.

Apply the supplied foreground guidance exactly. For every case, set hard_route
=true only when the guidance requires the runtime to force
`delegate_task(mode="loop")` before the foreground can inspect, reason, plan,
or choose tools. hard_route=false still allows the foreground to delegate later
when it judges that useful. Do not execute tools or solve the user requests.
Return one decision for every id and no extra ids.

FOREGROUND GUIDANCE:
{guidance}

CASES:
{json.dumps(compact_cases, indent=2)}
"""


def _output_schema() -> dict[str, Any]:
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
                    "properties": {
                        "id": {"type": "string"},
                        "hard_route": {"type": "boolean"},
                    },
                    "required": ["id", "hard_route"],
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
) -> dict[str, bool]:
    with tempfile.TemporaryDirectory(prefix="hermes-routing-eval-") as tmp:
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
            raise ValueError(f"invalid codex eval payload: {payload!r}")
        return {
            str(item["id"]): bool(item["hard_route"])
            for item in decisions
            if isinstance(item, dict) and "id" in item and "hard_route" in item
        }


def _print_score(label: str, score: dict[str, Any]) -> None:
    print(
        f"{label:<24} accuracy={score['accuracy']:.1%} "
        f"false_positive={score['false_positives']} "
        f"false_negative={score['false_negatives']} "
        f"foreground_specificity={score['foreground_specificity']:.1%} "
        f"explicit_recall={score['explicit_loop_recall']:.1%}"
    )
    for failure in score["failures"]:
        print(
            "  FAIL "
            f"trial={failure['trial']} id={failure['id']} "
            f"expected={failure['expected']} actual={failure['actual']}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--agent", action="store_true", help="run Codex prompt ablation")
    parser.add_argument("--trials", type=int, default=2)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()

    cases = _load_cases(args.cases)
    deterministic = _score(cases, [_deterministic_predictions(cases)])
    report: dict[str, Any] = {"deterministic": deterministic}
    _print_score("deterministic/current", deterministic)

    if args.agent:
        from agent.prompt_builder import KANBAN_FOREGROUND_GUIDANCE

        agent_scores: dict[str, Any] = {}
        for label, guidance in (
            ("legacy", LEGACY_GUIDANCE),
            ("candidate", KANBAN_FOREGROUND_GUIDANCE),
        ):
            predictions: list[dict[str, bool]] = []
            for trial in range(1, args.trials + 1):
                print(
                    f"running agent eval {label} trial {trial}/{args.trials}...",
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
            agent_scores[label] = _score(cases, predictions)
            _print_score(f"agent/{label}", agent_scores[label])
        report["agent"] = agent_scores
        report["agent"]["accuracy_lift"] = (
            agent_scores["candidate"]["accuracy"] - agent_scores["legacy"]["accuracy"]
        )
        print(f"agent accuracy lift       {report['agent']['accuracy_lift']:+.1%}")

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if not args.enforce:
        return 0
    if deterministic["accuracy"] < 1.0:
        return 1
    if args.agent:
        candidate = report["agent"]["candidate"]
        if candidate["accuracy"] < 0.95:
            return 1
        if candidate["false_positives"] != 0:
            return 1
        if candidate["explicit_loop_recall"] < 1.0:
            return 1
        if report["agent"]["accuracy_lift"] < 0.30:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
