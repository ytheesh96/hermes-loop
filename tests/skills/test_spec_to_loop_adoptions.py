from __future__ import annotations

from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
SOFTWARE = ROOT / "skills" / "software-development"
UPSTREAM_REVISION = "ed37663cc5fbef691ddfecd080dff42f7e7e350d"
EXPECTED_AUTHOR = (
    "Vaitheesh Jeypalan (@ytheesh96, https://github.com/ytheesh96), "
    "adapted from Matt Pocock, ported by Hermes Agent"
)
SKILLS = {
    "to-spec": SOFTWARE / "to-spec",
}


def _load_skill(name: str) -> tuple[dict[str, object], str]:
    path = SKILLS[name] / "SKILL.md"
    assert path.is_file(), f"missing bundled skill: {path}"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, raw_frontmatter, _body = text.split("---", 2)
    frontmatter = yaml.safe_load(raw_frontmatter)
    assert isinstance(frontmatter, dict)
    return frontmatter, text


def _normalized(text: str) -> str:
    return " ".join(text.lower().split())


@pytest.mark.parametrize("name", SKILLS)
def test_spec_workflow_skills_are_routable_and_attributed(name: str) -> None:
    frontmatter, text = _load_skill(name)

    assert frontmatter["name"] == name
    description = str(frontmatter["description"])
    assert description.startswith("Use when ")
    assert description.endswith(".")
    assert len(description) <= 60
    assert frontmatter["author"] == EXPECTED_AUTHOR
    assert frontmatter["license"] == "MIT"
    platforms = frontmatter["platforms"]
    assert isinstance(platforms, list)
    assert set(platforms) >= {"linux", "macos", "windows"}
    assert len(text) <= 12_000
    assert "disable-model-invocation" not in text
    assert "agents/openai.yaml" not in text

    attribution = (
        SKILLS[name] / "references" / "UPSTREAM_LICENSE.md"
    ).read_text(encoding="utf-8")
    assert UPSTREAM_REVISION in attribution
    assert "Copyright (c) 2026 Matt Pocock" in attribution
    assert "MIT License" in attribution


def test_to_spec_synthesizes_a_decision_complete_local_artifact() -> None:
    _, text = _load_skill("to-spec")
    normalized = _normalized(text)

    for concept in (
        "current conversation",
        "inspect the real codebase",
        "highest existing test seam",
        "do not create a new test seam",
        "problem statement",
        "solution overview",
        "user stories",
        "implementation decisions",
        "testing decisions",
        "acceptance criteria",
        "out of scope",
        "unresolved decisions",
        "spec.md",
    ):
        assert concept in normalized

    assert "broad interview" in normalized
    assert "do not create loop" in normalized
    assert "do not publish" in normalized
    assert "issue tracker" in normalized
    assert "secrets" in normalized
    assert "gh issue create" not in normalized


def test_to_tickets_skill_is_absorbed_into_loop_triage() -> None:
    assert not (SOFTWARE / "to-tickets").exists()

    loop_dir = ROOT / "skills" / "loop-triage"
    text = (loop_dir / "SKILL.md").read_text(encoding="utf-8")
    _, raw_frontmatter, _body = text.split("---", 2)
    frontmatter = yaml.safe_load(raw_frontmatter)
    assert frontmatter["name"] == "loop-triage"
    assert str(frontmatter["description"]).startswith("Use when ")
    assert len(str(frontmatter["description"])) <= 60
    assert frontmatter["author"] == EXPECTED_AUTHOR
    assert frontmatter["license"] == "MIT"

    attribution = (loop_dir / "references" / "UPSTREAM_LICENSE.md").read_text(
        encoding="utf-8"
    )
    assert "skills/engineering/to-tickets/SKILL.md" in attribution
    assert UPSTREAM_REVISION in attribution
    assert "Copyright (c) 2026 Matt Pocock" in attribution


def test_loop_triage_owns_approved_spec_to_graph_process() -> None:
    text = (ROOT / "skills" / "loop-triage" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    normalized = _normalized(text)

    for concept in (
        "approved spec",
        "tracer bullet",
        "independent vertical slice",
        "expand–migrate–contract",
        "minimum blocking edge",
        "draft graph",
        "user approval",
        "delegate_task",
        'mode="loop"',
        "attachments",
        'filename": "spec.md"',
        "depends_on",
        "tasks[].context",
        "auto-decomposer",
        "blocks",
    ):
        assert concept in normalized

    assert "do not mutate durable loop state before approval" in normalized
    assert "do not choose assignees" in normalized
    assert "do not shell out to `hermes kanban`" in normalized
    assert "external issue tracker" in normalized
    assert "attach the complete approved spec" in normalized
    assert "blocked target belongs in `blocks`" in normalized
    assert "blocked target does not belong in `depends_on`" in normalized
    assert "use `to-tickets` instead" not in normalized


def test_to_spec_routes_approved_work_to_loop_triage_not_to_tickets() -> None:
    _, text = _load_skill("to-spec")
    normalized = _normalized(text)

    assert "loop-triage" in normalized
    assert "to-tickets" not in normalized


def test_kanban_docs_describe_inline_loop_spec_attachments() -> None:
    text = (
        ROOT / "website" / "docs" / "user-guide" / "features" / "kanban.md"
    ).read_text(encoding="utf-8")
    normalized = _normalized(text)

    assert "inline text attachments" in normalized
    assert 'delegate_task(mode="loop"' in normalized
    assert "spec.md" in normalized
    assert "before jit specification" in normalized
    assert "generated worker children" in normalized
    assert "not arbitrary local file paths" in normalized
