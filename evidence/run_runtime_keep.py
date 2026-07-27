#!/usr/bin/env python3
"""Run the runtime evaluator while retaining disposable fixtures for review."""
from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "eval_wayfinder_runtime.py"
OUTPUT = ROOT / "evidence" / "wayfinder-runtime-report.json"
TRACE_DIR = ROOT / "evidence" / "traces"
FIXTURE_DIR = ROOT / "evidence" / "fixtures"
EVIDENCE_ROOT = ROOT / "evidence"

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
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    status = module.main()
raw_output = captured.getvalue()

payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
TRACE_DIR.mkdir(parents=True, exist_ok=True)
FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
manifest = []
path_replacements = []


def locator(path: Path) -> str:
    """Return a checkout-portable path relative to ``evidence/``."""
    return path.resolve().relative_to(EVIDENCE_ROOT.resolve()).as_posix()


def portableize(value, source: str, replacement: str):
    """Remove the temporary run root from retained JSON/text evidence."""
    if isinstance(value, str):
        return value.replace(source, replacement)
    if isinstance(value, list):
        return [portableize(item, source, replacement) for item in value]
    if isinstance(value, dict):
        return {key: portableize(item, source, replacement) for key, item in value.items()}
    return value


def portableize_fixture(root: Path, source: str, replacement: str) -> None:
    """Normalize text traces copied from the disposable temporary home."""
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        path.write_text(text.replace(source, replacement), encoding="utf-8")


for index, result in enumerate(payload.get("cases", [])):
    case_id = result["id"]
    roots = sorted(ROOT.glob(f".hermes-wayfinder-{case_id}-*"), key=lambda path: path.stat().st_mtime)
    fixture_root = roots[-1].resolve() if roots else None
    evidence = result.setdefault("evidence", {})
    if fixture_root is not None:
        retained_root = FIXTURE_DIR / case_id
        if retained_root.exists():
            shutil.rmtree(retained_root)
        shutil.copytree(fixture_root, retained_root, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        portable_root = locator(retained_root)
        portableize_fixture(retained_root, str(fixture_root), portable_root)
        path_replacements.append((str(fixture_root), portable_root))
        evidence["fixture_root"] = portable_root
        evidence["hermes_home"] = f"{portable_root}/hermes-home"
        evidence["sandbox"] = f"{portable_root}/sandbox"
        evidence["trace_path"] = f"{portable_root}/hermes-home/tool-hooks.jsonl"
        result = portableize(result, str(fixture_root), portable_root)
        evidence = result["evidence"]
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
    evidence["trace_artifact"] = locator(trace_path)
    result = portableize(result, str(fixture_root) if fixture_root else "", locator(FIXTURE_DIR / case_id) if fixture_root else "")
    evidence = result["evidence"]
    payload["cases"][index] = result
    manifest.append({"case": case_id, "fixture_root": evidence.get("fixture_root"), "trace_artifact": evidence["trace_artifact"]})

payload["command"] = "PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python evidence/run_runtime_keep.py --timeout 90 --output evidence/wayfinder-runtime-report.json"
payload["fixture_manifest"] = manifest
OUTPUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
for source, replacement in path_replacements:
    raw_output = raw_output.replace(source, replacement)
(EVIDENCE_ROOT / "runtime-harness-output.txt").write_text(raw_output, encoding="utf-8")
print(raw_output, end="")
raise SystemExit(status)
