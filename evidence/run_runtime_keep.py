#!/usr/bin/env python3
"""Run the runtime evaluator while retaining disposable fixtures for review."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "eval_wayfinder_runtime.py"
OUTPUT = ROOT / "evidence" / "wayfinder-runtime-report.json"
TRACE_DIR = ROOT / "evidence" / "traces"

spec = importlib.util.spec_from_file_location("eval_wayfinder_runtime", SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetainedTemporaryDirectory:
    def __init__(self, *args, **kwargs):
        self.name = tempfile.mkdtemp(*args, **kwargs)

    def __enter__(self):
        return self.name

    def __exit__(self, *_args):
        return False


module.tempfile.TemporaryDirectory = RetainedTemporaryDirectory
sys.argv = [str(SCRIPT), *sys.argv[1:]]
status = module.main()

payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
TRACE_DIR.mkdir(parents=True, exist_ok=True)
manifest = []
for result in payload.get("cases", []):
    case_id = result["id"]
    roots = sorted(ROOT.glob(f".hermes-wayfinder-{case_id}-*"), key=lambda path: path.stat().st_mtime)
    fixture_root = roots[-1].resolve() if roots else None
    evidence = result.setdefault("evidence", {})
    if fixture_root is not None:
        evidence["fixture_root"] = str(fixture_root)
        evidence["hermes_home"] = str(fixture_root / "hermes-home")
        evidence["sandbox"] = str(fixture_root / "sandbox")
        evidence["trace_path"] = str(fixture_root / "hermes-home" / "tool-hooks.jsonl")
    trace_path = TRACE_DIR / f"{case_id}.json"
    trace_path.write_text(json.dumps({
        "case": case_id,
        "requests": evidence.get("requests", []),
        "tool_events": evidence.get("tool_events", []),
        "hook_events": evidence.get("hook_events", []),
        "final_text": evidence.get("final_text", ""),
        "changed_paths": evidence.get("changed_paths", []),
        "checks": result.get("checks", {}),
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    evidence["trace_artifact"] = str(trace_path.resolve())
    manifest.append({"case": case_id, "fixture_root": evidence.get("fixture_root"), "trace_artifact": evidence["trace_artifact"]})

payload["command"] = "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python evidence/run_runtime_keep.py --timeout 90 --output evidence/wayfinder-runtime-report.json"
payload["fixture_manifest"] = manifest
OUTPUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
raise SystemExit(status)
