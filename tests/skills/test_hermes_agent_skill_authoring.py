from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = ROOT / "skills" / "software-development" / "hermes-agent-skill-authoring"
SKILL_PATH = SKILL_DIR / "SKILL.md"
MECHANICS_PATH = SKILL_DIR / "references" / "HERMES_MECHANICS.md"
GLOSSARY_PATH = SKILL_DIR / "references" / "GLOSSARY.md"
LICENSE_PATH = SKILL_DIR / "references" / "UPSTREAM_LICENSE.md"


def _skill_parts() -> tuple[dict[str, object], str, str]:
    text = SKILL_PATH.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, raw_frontmatter, body = text.split("---", 2)
    frontmatter = yaml.safe_load(raw_frontmatter)
    assert isinstance(frontmatter, dict)
    return frontmatter, body.strip(), text


def test_frontmatter_routes_skill_authoring_within_prompt_budget() -> None:
    frontmatter, body, _ = _skill_parts()

    assert frontmatter["name"] == "hermes-agent-skill-authoring"
    description = str(frontmatter["description"])
    assert description.startswith("Use when ")
    assert description.endswith(".")
    assert len(description) <= 60
    assert frontmatter["version"] == "2.0.0"
    assert "Matt Pocock" in str(frontmatter["author"])
    assert body.startswith("# Writing Great Hermes Skills")


def test_main_skill_is_compact_predictability_first_reference() -> None:
    _, body, text = _skill_parts()
    lowered = " ".join(body.lower().split())

    assert len(text) <= 7_000
    assert len(text.splitlines()) <= 150
    for phrase in (
        "predictable process",
        "not identical output",
        "completion criterion",
        "information hierarchy",
        "progressive disclosure",
        "context pointer",
        "leading word",
        "single source of truth",
        "no-op",
        "sediment",
        "sprawl",
        "positive target",
        "references/HERMES_MECHANICS.md",
        "references/GLOSSARY.md",
    ):
        assert phrase.lower() in lowered

    for stale in (
        "/home/bb/hermes-agent",
        "aim for 8-15k",
        "aim for 8-14k",
        "peer-matched structure",
        "every in-repo skill follows roughly",
        "the current session to see the new skill. it won't",
    ):
        assert stale not in lowered


def test_hermes_mechanics_are_disclosed_and_source_grounded() -> None:
    mechanics = MECHANICS_PATH.read_text(encoding="utf-8")
    lowered = " ".join(mechanics.lower().split())

    for phrase in (
        "$HERMES_HOME/skills/",
        "<repo-root>/skills/",
        "skill_manage(action=\"create\")",
        "60-character",
        "1024",
        "100,000",
        "/reload-skills",
        "disable-model-invocation",
        "not supported",
        "skill-evaluation-and-ablation",
    ):
        assert phrase.lower() in lowered

    assert "`references/`, `templates/`, `scripts/`, or `assets/`" in lowered


def test_disclosed_glossary_and_upstream_license_are_present() -> None:
    glossary = GLOSSARY_PATH.read_text(encoding="utf-8")
    license_text = LICENSE_PATH.read_text(encoding="utf-8")

    for heading in (
        "## Predictability",
        "## Invocation",
        "## Information hierarchy",
        "## Steering",
        "## Pruning",
    ):
        assert heading in glossary

    assert "writing-great-skills/SKILL.md" in license_text
    assert "Copyright (c) 2026 Matt Pocock" in license_text
    assert "MIT License" in license_text
