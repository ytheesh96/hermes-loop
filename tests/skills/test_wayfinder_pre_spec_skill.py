"""Contract tests for the skill-first Wayfinder behavior and eval harness."""
from __future__ import annotations

import importlib.util
import json
import re
from copy import deepcopy
from pathlib import Path
from types import ModuleType

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "software-development" / "wayfinder-pre-spec" / "SKILL.md"
CASES = ROOT / "evals" / "wayfinder_skill_cases.json"
EVAL_SCRIPT = ROOT / "scripts" / "eval_wayfinder_skill.py"
DIMENSIONS = {
    "use_wayfinder",
    "phase",
    "evidence_method",
    "execution_mode",
    "user_decision_owner",
    "allow_production_changes",
}


def _load_eval_module() -> ModuleType:
    assert EVAL_SCRIPT.is_file(), f"missing Wayfinder evaluator: {EVAL_SCRIPT}"
    spec = importlib.util.spec_from_file_location("eval_wayfinder_skill", EVAL_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _raw_cases() -> list[dict]:
    return json.loads(CASES.read_text(encoding="utf-8"))


def test_canonical_skill_is_shipped() -> None:
    assert SKILL.is_file(), f"missing canonical bundled Wayfinder skill: {SKILL}"


def test_skill_frontmatter_and_trigger_are_specific() -> None:
    text = SKILL.read_text(encoding="utf-8")
    match = re.search(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    assert match, "SKILL.md missing YAML frontmatter"
    frontmatter = yaml.safe_load(match.group(1))
    assert frontmatter["name"] == "wayfinder-pre-spec"
    assert frontmatter["description"].startswith(
        "Use when a feature has unresolved product or architecture decisions"
    )
    assert len(frontmatter["description"]) <= 1024
    assert set(frontmatter["platforms"]) >= {"linux", "macos", "windows"}


def test_skill_is_behavioral_and_uses_existing_primitives() -> None:
    text = SKILL.read_text(encoding="utf-8")
    for required in (
        "inspect",
        "user-owned",
        "production code",
        "decision-complete specification",
        'delegate_task(mode="loop"',
        "ordinary implementation",
        "incidental",
        "evidence",
    ):
        assert required in text, f"skill is missing behavioral contract: {required!r}"

    for native_surface in (
        'mode="wayfinder"',
        "wayfinder.admit",
        "wayfinder.resolve",
        "wayfinder.settle",
        "task_fingerprints",
        "expected_revision",
    ):
        assert native_surface not in text, (
            "skill-first Wayfinder must not depend on dedicated native lifecycle surface: "
            f"{native_surface}"
        )


def test_eval_corpus_covers_positive_negative_and_routing_boundaries() -> None:
    cases = _raw_cases()
    assert len(cases) >= 15
    ids = [case["id"] for case in cases]
    assert len(ids) == len(set(ids))
    assert sum(case["expected"]["use_wayfinder"] for case in cases) >= 5
    assert sum(not case["expected"]["use_wayfinder"] for case in cases) >= 5
    assert {case["category"] for case in cases} >= {
        "positive_implicit",
        "positive_durable",
        "negative_incidental_name",
        "negative_explicit_loop",
        "negative_decision_complete",
    }
    for case in cases:
        assert set(case["expected"]) == DIMENSIONS


def test_boundary_cases_encode_skill_first_not_native_wayfinder() -> None:
    by_id = {case["id"]: case["expected"] for case in _raw_cases()}
    assert by_id["implicit_ambiguous_brownfield"]["use_wayfinder"] is True
    assert by_id["implicit_ambiguous_brownfield"]["allow_production_changes"] is False
    assert by_id["incidental_wayfinder_name"]["use_wayfinder"] is False
    assert by_id["explicit_loop_implementation"]["use_wayfinder"] is False
    assert by_id["explicit_loop_implementation"]["execution_mode"] == "loop"
    assert by_id["durable_wayfinder_research"]["execution_mode"] == "loop"
    assert by_id["clear_bug_fix"]["allow_production_changes"] is True
    assert by_id["minor_ambiguity_safe_default"]["use_wayfinder"] is False
    assert by_id["minor_ambiguity_safe_default"]["execution_mode"] == "foreground"
    assert by_id["minor_ambiguity_safe_default"]["allow_production_changes"] is True


def test_loader_rejects_duplicate_ids_and_invalid_dimensions(tmp_path: Path) -> None:
    module = _load_eval_module()
    cases = _raw_cases()

    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(json.dumps([cases[0], cases[0]]), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate case id"):
        module.load_cases(duplicate)

    malformed = deepcopy(cases[0])
    malformed["expected"].pop("phase")
    malformed_path = tmp_path / "malformed.json"
    malformed_path.write_text(json.dumps([malformed]), encoding="utf-8")
    with pytest.raises(ValueError, match="expected dimensions"):
        module.load_cases(malformed_path)


def test_baseline_prompt_does_not_leak_candidate_policy() -> None:
    module = _load_eval_module()
    assert module.BASELINE_GUIDANCE.strip() == (
        "Apply ordinary agent judgment using only the user request."
    )
    prompt = module._agent_prompt(module.BASELINE_GUIDANCE, _raw_cases()[:1])
    evaluator_instructions = prompt.split("GUIDANCE:", 1)[0]
    for leaked_policy in (
        "foreground by default",
        "explicitly independent bounded lanes",
        "Explicit Loop implementation remains implementation",
        "A word appearing in a prompt is not necessarily an invocation",
        "If a repository can answer",
    ):
        assert leaked_policy not in evaluator_instructions


def test_agent_prompt_blinds_semantic_case_ids() -> None:
    module = _load_eval_module()
    cases = _raw_cases()[:3]
    prompt = module._agent_prompt(module.BASELINE_GUIDANCE, cases)
    for case in cases:
        assert case["id"] not in prompt
    assert "case_001" in prompt
    assert "case_002" in prompt
    assert "case_003" in prompt


def test_score_cases_accepts_explicit_oracle_alternatives(tmp_path: Path) -> None:
    module = _load_eval_module()
    case = deepcopy(_raw_cases()[0])
    case["expected"]["phase"] = ["discovery", "research"]
    cases_path = tmp_path / "alternatives.json"
    cases_path.write_text(json.dumps([case]), encoding="utf-8")
    loaded = module.load_cases(cases_path)

    prediction = {
        case["id"]: {
            **case["expected"],
            "phase": "research",
        }
    }
    report = module.score_cases(loaded, [prediction])
    assert report["case_accuracy"] == 1.0
    assert report["dimension_accuracy"] == 1.0


def test_score_cases_reports_dimension_and_safety_failures() -> None:
    module = _load_eval_module()
    cases = _raw_cases()[:2]
    perfect = {case["id"]: dict(case["expected"]) for case in cases}
    report = module.score_cases(cases, [perfect])
    assert report["case_accuracy"] == 1.0
    assert report["dimension_accuracy"] == 1.0
    assert report["wayfinder_false_positives"] == 0
    assert report["wayfinder_false_negatives"] == 0
    assert report["unsafe_production_starts"] == 0

    unsafe = deepcopy(perfect)
    unsafe[cases[0]["id"]]["allow_production_changes"] = True
    report = module.score_cases(cases, [unsafe])
    assert report["case_accuracy"] < 1.0
    assert report["unsafe_production_starts"] == 1
    assert report["failures"][0]["dimension"] == "allow_production_changes"


def test_enforcement_requires_safe_high_quality_candidate_without_regression() -> None:
    module = _load_eval_module()
    strong = {
        "case_accuracy": 0.90,
        "dimension_accuracy": 0.98,
        "wayfinder_false_positives": 0,
        "wayfinder_false_negatives": 0,
        "unsafe_production_starts": 0,
    }
    baseline = dict(strong, case_accuracy=0.80, dimension_accuracy=0.90)
    assert module.enforcement_failures({"baseline": baseline, "candidate": strong}) == []

    unsafe = dict(strong, unsafe_production_starts=1)
    failures = module.enforcement_failures({"baseline": baseline, "candidate": unsafe})
    assert any("unsafe production" in failure for failure in failures)

    missed = dict(strong, wayfinder_false_negatives=1)
    failures = module.enforcement_failures({"baseline": baseline, "candidate": missed})
    assert any("false negatives" in failure for failure in failures)

    regressed = dict(strong, case_accuracy=0.70)
    failures = module.enforcement_failures({"baseline": baseline, "candidate": regressed})
    assert any("below baseline" in failure for failure in failures)
