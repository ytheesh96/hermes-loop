from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
SOFTWARE = ROOT / "skills" / "software-development"
PRODUCTIVITY = ROOT / "skills" / "productivity"
EVAL_CASES = ROOT / "evals" / "matt_pocock_skill_adoption_cases.json"
EVAL_SCRIPT = ROOT / "scripts" / "eval_matt_pocock_skill_adoptions.py"

NEW_SKILLS = {
    "codebase-design": SOFTWARE / "codebase-design",
    "domain-modeling": SOFTWARE / "domain-modeling",
    "improve-codebase-architecture": SOFTWARE / "improve-codebase-architecture",
    "prototype": SOFTWARE / "prototype",
    "learning-workspace": PRODUCTIVITY / "learning-workspace",
}

REQUIRED_REFERENCES = {
    "codebase-design": {
        "references/deepening.md",
        "references/design-it-twice.md",
        "references/UPSTREAM_LICENSE.md",
    },
    "domain-modeling": {
        "references/context-format.md",
        "references/adr-format.md",
        "references/UPSTREAM_LICENSE.md",
    },
    "improve-codebase-architecture": {
        "references/report-patterns.md",
        "references/UPSTREAM_LICENSE.md",
    },
    "prototype": {
        "references/logic-prototype.md",
        "references/ui-prototype.md",
        "references/UPSTREAM_LICENSE.md",
    },
    "learning-workspace": {
        "references/mission-format.md",
        "references/resource-format.md",
        "references/glossary-format.md",
        "references/lesson-format.md",
        "references/learning-record-format.md",
        "references/UPSTREAM_LICENSE.md",
    },
}

REQUIRED_CONCEPTS = {
    "codebase-design": {
        "deep module",
        "interface",
        "seam",
        "deletion test",
        "one adapter",
        "two adapters",
        "design it twice",
        "codebase memory",
    },
    "domain-modeling": {
        "domain language",
        "invariant",
        "state transition",
        "concrete scenario",
        "context.md",
        "adr",
        "approval",
    },
    "improve-codebase-architecture": {
        "hot spot",
        "friction",
        "add another helper",
        "chooses the interface shape",
        "deletion test",
        "recommendation strength",
        "top recommendation",
        "codebase memory",
        "open_preview",
    },
    "prototype": {
        "throwaway",
        "question",
        "logic",
        "ui",
        "sketch",
        "one command",
        "verdict",
        "production",
    },
    "learning-workspace": {
        "mission.md",
        "resources.md",
        "learning-records",
        "retrieval",
        "spacing",
        "interleaving",
        "citation",
        "zone of proximal development",
        "markdown",
        "html",
    },
}


def _load_skill(skill_dir: Path) -> tuple[dict[str, object], str, str]:
    skill_path = skill_dir / "SKILL.md"
    assert skill_path.is_file(), f"missing bundled skill: {skill_path}"
    text = skill_path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, raw_frontmatter, body = text.split("---", 2)
    frontmatter = yaml.safe_load(raw_frontmatter)
    assert isinstance(frontmatter, dict)
    return frontmatter, body.strip(), text


def _normalized(text: str) -> str:
    return " ".join(text.lower().split())


def _load_eval_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "eval_matt_pocock_skill_adoptions", EVAL_SCRIPT
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(("name", "skill_dir"), NEW_SKILLS.items())
def test_new_skill_frontmatter_is_routable_and_attributed(
    name: str, skill_dir: Path
) -> None:
    frontmatter, body, text = _load_skill(skill_dir)

    assert frontmatter["name"] == name
    description = str(frontmatter["description"])
    assert description.startswith("Use when ")
    assert description.endswith(".")
    assert len(description) <= 60
    assert "Matt Pocock" in str(frontmatter["author"])
    assert frontmatter["license"] == "MIT"
    assert set(frontmatter["platforms"]) >= {"linux", "macos", "windows"}
    assert body.startswith("# ")
    assert len(text) <= 12_000
    assert len(text.splitlines()) <= 260
    assert "disable-model-invocation" not in text
    assert "agents/openai.yaml" not in text


@pytest.mark.parametrize(("name", "skill_dir"), NEW_SKILLS.items())
def test_new_skill_process_contracts_are_present(name: str, skill_dir: Path) -> None:
    _, _, text = _load_skill(skill_dir)
    normalized = _normalized(text)

    for concept in REQUIRED_CONCEPTS[name]:
        assert concept in normalized, f"{name} is missing process concept {concept!r}"

    for relative_path in REQUIRED_REFERENCES[name]:
        reference = skill_dir / relative_path
        assert reference.is_file(), f"{name} is missing disclosed file {relative_path}"
        assert relative_path in text, f"{name} does not point to {relative_path}"

    license_text = (skill_dir / "references" / "UPSTREAM_LICENSE.md").read_text(
        encoding="utf-8"
    )
    assert "Copyright (c) 2026 Matt Pocock" in license_text
    assert "MIT License" in license_text


def test_architecture_and_domain_skills_gate_durable_changes() -> None:
    for name in ("codebase-design", "domain-modeling", "improve-codebase-architecture"):
        _, _, text = _load_skill(NEW_SKILLS[name])
        normalized = _normalized(text)
        assert "approval" in normalized or "user asked" in normalized
        assert "commit or push" in normalized


def test_prototype_preserves_production_and_authorization_boundaries() -> None:
    _, _, text = _load_skill(NEW_SKILLS["prototype"])
    normalized = _normalized(text)

    assert "do not ship" in normalized
    assert "approval" in normalized
    assert "commit" in normalized
    assert "push" in normalized
    assert "ui" in normalized and "sketch" in normalized
    assert "secrets" in normalized
    assert "production data" in normalized


def test_learning_workspace_uses_sources_and_user_owned_state() -> None:
    _, _, text = _load_skill(NEW_SKILLS["learning-workspace"])
    normalized = _normalized(text)

    assert "primary source" in normalized
    assert "user" in normalized and "mission" in normalized
    assert "community" in normalized and "optional" in normalized
    assert "markdown" in normalized and "default" in normalized


def test_systematic_debugging_already_has_the_adopted_feedback_loop() -> None:
    frontmatter, _, text = _load_skill(SOFTWARE / "systematic-debugging")
    normalized = _normalized(text)

    for concept in (
        "feedback loop rule",
        "red-capable",
        "minimize the reproduction",
        "ranked falsifiable hypotheses",
        "3–5 plausible hypotheses",
        "[debug-",
        "public seam",
        "architecture gap",
    ):
        assert concept in normalized
    assert "Matt Pocock" in str(frontmatter["author"])
    assert (SOFTWARE / "systematic-debugging/references/UPSTREAM_LICENSE.md").is_file()


@pytest.mark.parametrize(
    "skill_name",
    [
        "systematic-debugging",
        "test-driven-development",
        "requesting-code-review",
        "plan",
    ],
)
def test_integration_attribution_is_pinned_to_reviewed_revision(
    skill_name: str,
) -> None:
    attribution = (
        SOFTWARE / skill_name / "references" / "UPSTREAM_LICENSE.md"
    ).read_text(encoding="utf-8")
    assert "ed37663cc5fbef691ddfecd080dff42f7e7e350d" in attribution
    assert "Copyright (c) 2026 Matt Pocock" in attribution
    assert "MIT License" in attribution


def test_tdd_adds_seam_first_public_interface_test_design() -> None:
    frontmatter, _, text = _load_skill(SOFTWARE / "test-driven-development")
    normalized = _normalized(text)

    for concept in (
        "test seam",
        "public interface",
        "independently known",
        "tautological",
        "system boundary",
        "tracer bullet",
    ):
        assert concept in normalized
    assert "\n    6. Commit\n" not in text
    assert "commit only when explicitly authorized" in normalized
    assert "Matt Pocock" in str(frontmatter["author"])
    assert (SOFTWARE / "test-driven-development/references/UPSTREAM_LICENSE.md").is_file()


def test_review_separates_specification_from_implementation_quality() -> None:
    frontmatter, _, text = _load_skill(SOFTWARE / "requesting-code-review")
    normalized = _normalized(text)

    for concept in (
        "specification compliance",
        "implementation quality",
        "independent axes",
        "requirement-by-requirement",
        "scope creep",
        "fixed point",
        "git rev-parse",
        "...head",
    ):
        assert concept in normalized
    assert normalized.index("specification compliance") < normalized.index(
        "implementation quality"
    )
    assert "pinned diff from step 1" in normalized
    assert "stash changes" not in normalized
    assert "ask before any reset" in normalized
    assert "reviewer owns" in normalized
    assert "Matt Pocock" in str(frontmatter["author"])
    assert (SOFTWARE / "requesting-code-review/references/UPSTREAM_LICENSE.md").is_file()


def test_plan_models_tracer_bullets_and_dependency_edges() -> None:
    frontmatter, _, text = _load_skill(SOFTWARE / "plan")
    normalized = _normalized(text)

    for concept in (
        "tracer bullet",
        "blocking edge",
        "execution frontier",
        "expand–migrate–contract",
        "acceptance criteria",
    ):
        assert concept in normalized
    assert "frequent commits" not in normalized
    description = str(frontmatter["description"])
    assert description.startswith("Use when ")
    assert description.endswith(".")
    assert len(description) <= 60
    assert "Matt Pocock" in str(frontmatter["author"])
    assert (SOFTWARE / "plan/references/UPSTREAM_LICENSE.md").is_file()


def test_behavioral_eval_corpus_covers_routes_and_nearby_negatives() -> None:
    module = _load_eval_module()
    cases = module.load_cases(EVAL_CASES)

    assert len(cases) >= 24
    assert len({case["id"] for case in cases}) == len(cases)
    expected_routes = {
        value
        for case in cases
        for value in (
            case["expected"]["primary_skill"]
            if isinstance(case["expected"]["primary_skill"], list)
            else [case["expected"]["primary_skill"]]
        )
    }
    assert expected_routes >= {
        *NEW_SKILLS,
        "systematic-debugging",
        "test-driven-development",
        "requesting-code-review",
        "plan",
        "spike",
        "none",
    }
    categories = {case["category"] for case in cases}
    assert categories >= {
        "codebase_design_positive",
        "domain_modeling_negative",
        "architecture_audit_positive",
        "prototype_negative",
        "learning_negative",
        "debugging_integration",
        "tdd_integration",
        "review_integration",
        "planning_integration",
    }


def test_behavioral_eval_score_detects_authorization_and_decision_failures() -> None:
    module = _load_eval_module()
    assert "workspace_action" in module.DIMENSIONS
    assert "require_authorization" not in module.DIMENSIONS
    cases = module.load_cases(EVAL_CASES)
    perfect = {
        case["id"]: {
            dimension: value[0] if isinstance(value, list) else value
            for dimension, value in case["expected"].items()
        }
        for case in cases
    }
    score = module.score_cases(cases, [perfect])
    assert score["case_accuracy"] == 1.0
    assert score["dimension_accuracy"] == 1.0
    assert score["unauthorized_writes"] == 0
    assert score["decision_takeovers"] == 0

    unsafe = json.loads(json.dumps(perfect))
    guarded = next(
        case
        for case in cases
        if case["expected"]["workspace_action"] != "authorized_write"
    )
    owned = next(
        case for case in cases if case["expected"]["user_decision_owner"] is True
    )
    unsafe[guarded["id"]]["workspace_action"] = "authorized_write"
    unsafe[owned["id"]]["user_decision_owner"] = False
    score = module.score_cases(cases, [unsafe])
    assert score["unauthorized_writes"] == 1
    assert score["decision_takeovers"] == 1


def test_behavioral_eval_corpus_preserves_routing_and_authorization_boundaries() -> None:
    module = _load_eval_module()
    cases = {case["id"]: case for case in module.load_cases(EVAL_CASES)}

    for case_id in (
        "domain_consumer_not_modeling",
        "production_ui_implementation",
        "straightforward_cli_flag",
    ):
        expected = cases[case_id]["expected"]
        assert expected["primary_skill"] == ["none", "test-driven-development"]
        assert expected["first_move"] == ["inspect", "choose_test_seam"]

    assert cases["rare_flake_diagnosis"]["expected"]["workspace_action"] == "read_only"
    greenfield = cases["greenfield_module_shape"]
    assert "do not write or edit files" in greenfield["prompt"].lower()
    assert greenfield["expected"]["workspace_action"] == "read_only"
    assert (
        cases["library_feasibility_spike"]["expected"]["user_decision_owner"]
        is False
    )
    for case_id in ("stateful_bayesian_course", "stateful_programming_course"):
        expected = cases[case_id]["expected"]
        assert expected["phase"] == ["teaching", "planning"]
        assert expected["artifact"] == ["learning_record", "plan"]
        assert expected["workspace_action"] == "authorized_write"
        assert expected["user_decision_owner"] is False
    assert (
        cases["domain_cancellation_language"]["expected"]["workspace_action"]
        == "blocked_pending_authorization"
    )
    for case_id in ("feature_task_graph_plan", "wide_refactor_plan"):
        expected = cases[case_id]["expected"]
        assert expected["workspace_action"] == "authorized_write"
        assert expected["user_decision_owner"] is False


def test_candidate_eval_guidance_is_built_from_shipped_skill_sources() -> None:
    module = _load_eval_module()
    assert module.BASELINE_GUIDANCE == (
        "Apply ordinary agent judgment using only the user request."
    )
    guidance = module.candidate_guidance()
    for name in module.SKILL_PATHS:
        assert f"### {name}" in guidance
    assert "fixed point" in guidance.lower()
    assert "reviewer owns" in guidance.lower()
    assert "disable-model-invocation" not in guidance
    assert "agents/openai.yaml" not in guidance
