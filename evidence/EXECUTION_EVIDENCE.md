# Runtime evaluation evidence

## Scope and checkout

- Canonical checkout: this repository checkout (all evidence locators are portable)
- Reviewed source lineage: harness `171dc440a`, evidence package `9cf8f8544`, and portability repair `eef211922`; adopted into local canonical `main` with cherry-pick provenance preserved.
- Evaluation source under test: `scripts/eval_wayfinder_runtime.py`
- The evaluator ran four fresh `python -m hermes_cli.main -z` subprocesses against its disposable local OpenAI-compatible model stub. Each case used a temporary `HERMES_HOME`, fixture sandbox, isolated Kanban database, and real `post_tool_call` observer plugin.
- Evaluation subprocesses did not modify production files. Native runtime/lifecycle code was not modified; the adopted changes are confined to the evaluator, its tests/documentation, and this sanitized evidence bundle.

## Exact commands and results

1. Focused runtime harness tests:

   `scripts/run_tests.sh tests/scripts/test_wayfinder_runtime.py`

   Result: exit `0`; `1` file, `8` tests passed, `0` failed.
   Full captured output: [`focused-harness-tests.txt`](focused-harness-tests.txt).

2. Existing Wayfinder classifier and foreground-routing regressions:

   `scripts/run_tests.sh tests/skills/test_wayfinder_pre_spec_skill.py tests/agent/test_loop_foreground.py tests/hermes_cli/test_kanban_foreground_handoff.py -q`

   Result: exit `0`; `3` files, `27` tests passed, `0` failed.
   Full captured output: [`classifier-foreground-regressions.txt`](classifier-foreground-regressions.txt).

3. Four-boundary execution evaluation with retained fixture locations:

   `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python evidence/run_runtime_keep.py --timeout 90 --output evidence/wayfinder-runtime-report.json`

   Result: exit `0`; JSON status `passed`; all four cases passed. Raw stdout/stderr capture: [`runtime-harness-output.txt`](runtime-harness-output.txt). Machine-readable report: [`wayfinder-runtime-report.json`](wayfinder-runtime-report.json).

4. Evidence integrity check:

   `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python evidence/validate_evidence.py`

   Result: exit `0`; output was `status=passed`, `cases=4`, `fixture_roots=4`, `trace_artifacts=4`, `TRACE_JSON_VALID=4`, `PORTABLE_LOCATORS_VALID=4`, `MACHINE_PATHS_REDACTED=1`, and `TRANSIENT_STATE_EXCLUDED=1`.
   Full captured output: [`evidence-validation.txt`](evidence-validation.txt).

5. Final source/evidence hygiene:

   `git diff --check`

   Result: exit `0`.

All machine-readable locators in `evidence/wayfinder-runtime-report.json` are relative to the `evidence/` directory. Resolve a locator from a fresh checkout root as `evidence/<locator>`; the validator checks that it stays inside `evidence/`, rejects task-workspace absolute paths, and verifies every retained fixture and trace.

## Per-boundary results

| Boundary | Fresh session | Hook events | Sandbox changes | Outcome | Trace artifact |
|---|---|---:|---|---|---|
| `ambiguous_architecture` | `20260727_111908_245f96` | 3 | `[]` | PASS; `skills_list` → `skill_view` → `read_file`, then foreground choice; no production mutation | [`traces/ambiguous_architecture.json`](traces/ambiguous_architecture.json) |
| `clear_implementation` | `20260727_111912_af8dbf` | 1 | `artifacts/runtime-artifact.txt` | PASS; bounded foreground write | [`traces/clear_implementation.json`](traces/clear_implementation.json) |
| `explicit_loop` | `20260727_111915_48461b` | 1 | `[]` | PASS; `delegate_task(mode="loop")` returned isolated workflow `wf_6b9efdc12e6212fc`; no sandbox mutation | [`traces/explicit_loop.json`](traces/explicit_loop.json) |
| `minor_ambiguity` | `20260727_111917_18e63e` | 2 | `README.md` | PASS; `read_file` preceded the small foreground write; no Wayfinder/delegation discovery | [`traces/minor_ambiguity.json`](traces/minor_ambiguity.json) |

All hook events had status `ok`. The provider transcript and evaluator assertions for every case are in `evidence/wayfinder-runtime-report.json`; compact per-case copies are in `evidence/traces/`.

The explicit Loop case used the isolated fixture database at `evidence/fixtures/explicit_loop/kanban.db`. Its returned workflow identity is real and inspectable in the captured tool result; the local stub's downstream decomposition reported `LLM returned malformed JSON`, but the required Loop routing boundary still returned `status: dispatched`, `mode: loop`, and `workflow_id`, and no task was created on the live board.

## Fixture locations

Retained, reviewable disposable fixtures are under `evidence/fixtures/`:

- [`fixtures/ambiguous_architecture/`](fixtures/ambiguous_architecture/)
- [`fixtures/clear_implementation/`](fixtures/clear_implementation/)
- [`fixtures/explicit_loop/`](fixtures/explicit_loop/)
- [`fixtures/minor_ambiguity/`](fixtures/minor_ambiguity/)

Each case contains a privacy-sanitized capture of the temporary `hermes-home/` (including `config.yaml`, bundled Wayfinder skill, observer plugin, usage file, and `tool-hooks.jsonl`) and `sandbox/`. Machine-home paths are replaced with `<USER_HOME>`, and transient auth metadata plus session/verification databases are intentionally excluded. The explicit Loop case retains its isolated `kanban.db`, which contains only the synthetic evaluation workflow. Raw observer traces are available both in each fixture's `hermes-home/tool-hooks.jsonl` and as normalized JSON under `evidence/traces/`.

## Changed paths and local handle

The original harness commit under evaluation is `171dc440a`, followed by evidence package `9cf8f8544` and portability repair `eef211922`. Their canonical cherry-picks preserve those source IDs in commit trailers. The evidence bundle includes:

- `evidence/wayfinder-runtime-report.json`
- `evidence/runtime-harness-output.txt`
- `evidence/focused-harness-tests.txt`
- `evidence/classifier-foreground-regressions.txt`
- `evidence/run_runtime_keep.py`
- `evidence/traces/*.json`
- `evidence/fixtures/*/`
- this report: `evidence/EXECUTION_EVIDENCE.md`

The reviewed bundle has been adopted into the local canonical `main` checkout. No push was performed.
