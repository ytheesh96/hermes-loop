# Wayfinder runtime evaluation

`scripts/eval_wayfinder_runtime.py` is an execution-level evaluator, not a
classifier or `skill_view` unit test. Every case starts a fresh subprocess via
`python -m hermes_cli.main -z`, points it at a disposable local
OpenAI-compatible SSE server, installs only the bundled Wayfinder skill into a
temporary `HERMES_HOME`, and uses a temporary Kanban database for Loop runs.
The model stub returns deterministic tool calls so the normal Hermes tool
executor, skill discovery, file tools, and Loop primitive are exercised.

The harness records:

- one-shot session IDs from `--usage-file`;
- provider request metadata, including the skill index in the system prompt;
- ordered model tool call/result events, real `post_tool_call` hook payloads
  (tool name, arguments, status, duration, and result), and Loop workflow IDs;
- fixture sandbox changes and changed paths; and
- final foreground text.

Four outcome boundaries are checked:

1. `ambiguous_architecture`: `skills_list` → `skill_view` → repository
   inspection, then a foreground-owned choice; no sandbox mutation.
2. `clear_implementation`: no Wayfinder tool discovery; a bounded file write in
   the disposable sandbox.
3. `explicit_loop`: no Wayfinder discovery; `delegate_task(mode="loop")` must
   return a workflow identity and must not mutate the sandbox.
4. `minor_ambiguity`: `read_file` before a small foreground-only write; no
   Wayfinder or delegation discovery.

Run the focused tests:

```text
scripts/run_tests.sh tests/scripts/test_wayfinder_runtime.py -q
```

Run the execution harness and save the inspectable report:

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python scripts/eval_wayfinder_runtime.py --timeout 90 --output /tmp/wayfinder-runtime-report.json
```

The temporary home enables a fixture observer plugin so the evaluator requires
an execution-level `post_tool_call` event in addition to the provider transcript;
classifier-only output cannot pass. If the fresh process cannot start or the
provider call fails, the result is non-passing and includes the exact command,
temporary Hermes home, return code, and stderr in a `blocker` object. The
harness never falls back to classifier-only or Codex behavior.
