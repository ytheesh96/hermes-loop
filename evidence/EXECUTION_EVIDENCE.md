# Runtime evaluation evidence

## Scope and checkout

- Scratch checkout: this repository checkout (all evidence locators are portable)
- HEAD before evidence packaging: `171dc440a` (`test: add runtime Wayfinder evaluation harness`)
- Evaluation source under test: `scripts/eval_wayfinder_runtime.py`
- The evaluator ran four fresh `python -m hermes_cli.main -z` subprocesses against its disposable local OpenAI-compatible model stub. Each case used a temporary `HERMES_HOME`, fixture sandbox, isolated Kanban database, and real `post_tool_call` observer plugin.
- Canonical checkout was not modified. Native runtime/lifecycle code was not modified. The only workspace additions are this evidence bundle and its retained disposable fixtures.

## Exact commands and results

1. Focused runtime harness tests:

   `scripts/run_tests.sh tests/scripts/test_wayfinder_runtime.py`

   Result: exit `0`; `1` file, `7` tests passed, `0` failed.
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

   Result: exit `0`; output was `status=passed`, `cases=4`, `fixture_roots=4`, `trace_artifacts=4`, `TRACE_JSON_VALID=4`, `PORTABLE_LOCATORS_VALID=4`.
   Full captured output: [`evidence-validation.txt`](evidence-validation.txt).

5. Final source/evidence hygiene:

   `git diff --check`

   Result: exit `0`.

All machine-readable locators in `evidence/wayfinder-runtime-report.json` are relative to the `evidence/` directory. Resolve a locator from a fresh checkout root as `evidence/<locator>`; the validator checks that it stays inside `evidence/`, rejects task-workspace absolute paths, and verifies every retained fixture and trace.

## Per-boundary results

| Boundary | Fresh session | Hook events | Sandbox changes | Outcome | Trace artifact |
|---|---|---:|---|---|---|
| `ambiguous_architecture` | `20260727_030229_444c9d` | 3 | `[]` | PASS; `skills_list` → `skill_view` → `read_file`, then foreground choice; no production mutation | [`traces/ambiguous_architecture.json`](traces/ambiguous_architecture.json) |
| `clear_implementation` | `20260727_030231_d579fd` | 1 | `artifacts/runtime-artifact.txt` | PASS; bounded foreground write | [`traces/clear_implementation.json`](traces/clear_implementation.json) |
| `explicit_loop` | `20260727_030233_85435a` | 1 | `[]` | PASS; `delegate_task(mode="loop")` returned a workflow identity; no sandbox mutation | [`traces/explicit_loop.json`](traces/explicit_loop.json) |
| `minor_ambiguity` | `20260727_030235_cc1a2f` | 2 | `README.md` | PASS; `read_file` preceded the small foreground write; no Wayfinder/delegation discovery | [`traces/minor_ambiguity.json`](traces/minor_ambiguity.json) |

All hook events had status `ok`. The provider transcript and evaluator assertions for every case are in `evidence/wayfinder-runtime-report.json`; compact per-case copies are in `evidence/traces/`.

The explicit Loop case used the isolated fixture database at `evidence/fixtures/explicit_loop/kanban.db`. Its returned workflow identity is real and inspectable in the captured tool result; the local stub's downstream decomposition reported `LLM returned malformed JSON`, but the required Loop routing boundary still returned `status: dispatched`, `mode: loop`, and `workflow_id`, and no task was created on the live board.

## Fixture locations

Retained, reviewable disposable fixtures are under `evidence/fixtures/`:

- [`fixtures/ambiguous_architecture/`](fixtures/ambiguous_architecture/)
- [`fixtures/clear_implementation/`](fixtures/clear_implementation/)
- [`fixtures/explicit_loop/`](fixtures/explicit_loop/)
- [`fixtures/minor_ambiguity/`](fixtures/minor_ambiguity/)

Each case contains the captured temporary `hermes-home/` (including `config.yaml`, bundled Wayfinder skill, observer plugin, usage file, and `tool-hooks.jsonl`) and `sandbox/`. The explicit Loop case also contains its isolated `kanban.db`. Raw observer traces are available both in each fixture's `hermes-home/tool-hooks.jsonl` and as normalized JSON under `evidence/traces/`.

## Changed paths and local handle

The harness commit under evaluation is `171dc440a`. The evidence bundle is committed locally on top of that harness commit. Local patch handle: `HEAD` (the exact hash is recorded in the worker handoff); this scratch-only evidence commit adds:

- `evidence/wayfinder-runtime-report.json`
- `evidence/runtime-harness-output.txt`
- `evidence/focused-harness-tests.txt`
- `evidence/classifier-foreground-regressions.txt`
- `evidence/run_runtime_keep.py`
- `evidence/traces/*.json`
- `evidence/fixtures/*/`
- this report: `evidence/EXECUTION_EVIDENCE.md`

The evidence bundle is intentionally local-only: no push, merge, or application to the canonical checkout was performed.
