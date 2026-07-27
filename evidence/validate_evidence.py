#!/usr/bin/env python3
"""Validate retained runtime-evaluation evidence files."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence"
REPORT_PATH = EVIDENCE_ROOT / "wayfinder-runtime-report.json"
STALE_WORKSPACE_PREFIX = "/Users/yt/.hermes/kanban/boards/hermes-agent/workspaces/"


def resolve_locator(value: str) -> Path:
    """Resolve an evidence-root-relative locator without allowing escapes."""
    assert isinstance(value, str) and not Path(value).is_absolute(), value
    resolved = (EVIDENCE_ROOT / value).resolve()
    assert resolved.is_relative_to(EVIDENCE_ROOT.resolve()), value
    return resolved


def assert_no_stale_locators() -> None:
    """Reject machine-specific task workspace paths in retained evidence."""
    for path in EVIDENCE_ROOT.rglob("*"):
        if not path.is_file() or path == Path(__file__).resolve():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        assert STALE_WORKSPACE_PREFIX not in text, path


report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
assert report["status"] == "passed"
assert len(report["cases"]) == 4
assert_no_stale_locators()
for case in report["cases"]:
    evidence = case["evidence"]
    assert case["passed"] is True
    for key in ("fixture_root", "hermes_home", "sandbox", "trace_artifact", "trace_path"):
        assert resolve_locator(evidence[key]).exists(), (case["id"], key, evidence[key])
    assert resolve_locator(evidence["fixture_root"]).is_dir()
    assert resolve_locator(evidence["trace_artifact"]).is_file()
    assert resolve_locator(evidence["trace_path"]).is_file()
    for line in resolve_locator(evidence["trace_path"]).read_text(encoding="utf-8").splitlines():
        json.loads(line)
for path in sorted((ROOT / "evidence" / "traces").glob("*.json")):
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["case"]
for entry in report["fixture_manifest"]:
    assert resolve_locator(entry["fixture_root"]).is_dir()
    assert resolve_locator(entry["trace_artifact"]).is_file()
print("status=passed")
print("cases=4")
print("fixture_roots=4")
print("trace_artifacts=4")
print("TRACE_JSON_VALID=4")
print("PORTABLE_LOCATORS_VALID=4")
