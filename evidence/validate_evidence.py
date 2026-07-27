#!/usr/bin/env python3
"""Validate retained runtime-evaluation evidence files."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
report = json.loads((ROOT / "evidence" / "wayfinder-runtime-report.json").read_text(encoding="utf-8"))
assert report["status"] == "passed"
assert len(report["cases"]) == 4
for case in report["cases"]:
    evidence = case["evidence"]
    assert case["passed"] is True
    assert Path(evidence["fixture_root"]).is_dir()
    assert Path(evidence["trace_artifact"]).is_file()
    assert Path(evidence["trace_path"]).is_file()
for path in sorted((ROOT / "evidence" / "traces").glob("*.json")):
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["case"]
print("status=passed")
print("cases=4")
print("fixture_roots=4")
print("trace_artifacts=4")
print("TRACE_JSON_VALID=4")
