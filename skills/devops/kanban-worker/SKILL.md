---
name: kanban-worker
description: Pitfalls, examples, and edge cases for Hermes Kanban workers. The lifecycle itself is auto-injected into every worker's system prompt as KANBAN_GUIDANCE (from agent/prompt_builder.py); this skill is what you load when you want deeper detail on specific scenarios.
version: 2.1.0
platforms: [linux, macos, windows]
environments: [kanban]
metadata:
  hermes:
    tags: [kanban, multi-agent, collaboration, workflow, pitfalls]
    related_skills: [kanban-orchestrator]
---

# Kanban Worker — Pitfalls and Examples

> You're seeing this skill because the Hermes Kanban dispatcher spawned you as a worker with `--skills kanban-worker` — it's loaded automatically for every dispatched worker. The **lifecycle** (6 steps: orient → work → heartbeat → block/complete) also lives in the `KANBAN_GUIDANCE` block that's auto-injected into your system prompt. This skill is the deeper detail: good handoff shapes, retry diagnostics, edge cases.

## Workspace handling

Your workspace kind determines how you should behave inside `$HERMES_KANBAN_WORKSPACE`:

| Kind | What it is | How to work |
|---|---|---|
| `scratch` | Fresh tmp dir, yours alone | Read/write freely; it gets GC'd when the task is archived. |
| `dir:<path>` | Shared persistent directory | Other runs will read what you write. Treat it like long-lived state. Path is guaranteed absolute (the kernel rejects relative paths). |
| `worktree` | Git worktree at the resolved path | If `.git` doesn't exist, run `git worktree add <path> ${HERMES_KANBAN_BRANCH:-wt/$HERMES_KANBAN_TASK}` from the main repo first, then cd and work normally. Commit work here. |

## Tenant isolation

If `$HERMES_TENANT` is set, the task belongs to a tenant namespace. When reading or writing persistent memory, prefix memory entries with the tenant so context doesn't leak across tenants:

- Good: `business-a: Acme is our biggest customer`
- Bad (leaks): `Acme is our biggest customer`

## Good summary + metadata shapes

The `kanban_complete(summary=..., metadata=...)` handoff is how downstream workers read what you did. Patterns that work:

**Coding task:**
```python
kanban_complete(
    summary="shipped rate limiter — token bucket, keys on user_id with IP fallback, 14 tests pass",
    metadata={
        "changed_files": ["rate_limiter.py", "tests/test_rate_limiter.py"],
        "tests_run": 14,
        "tests_passed": 14,
        "decisions": ["user_id primary, IP fallback for unauthenticated requests"],
    },
)
```

**Coding task that should be reviewed:**

When your scoped implementation is finished, leave a review recommendation as a comment and complete the task. The completion boundary wakes the workflow-subscribed foreground, which reads the comment and decides whether to create a real reviewer task. Workers do not route their own task into review and do not create the reviewer card.

Use `kanban_block(reason="...")` only when your own work cannot finish. Keep the reason neutral: a genuine non-dependency block delivers the latest comments to the foreground; a dependency wait returns to `todo` without waking it.

```python
import json

kanban_comment(
    body="review handoff:\n" + json.dumps({
        "changed_files": ["rate_limiter.py", "tests/test_rate_limiter.py"],
        "tests_run": 14,
        "tests_passed": 14,
        "diff_path": "/path/to/worktree",  # or PR url if pushed
        "decisions": ["user_id primary, IP fallback for unauthenticated requests"],
    }, indent=2),
)
kanban_complete(
    summary="rate limiter shipped; 14/14 tests pass; review recommended for the user_id/IP fallback choice",
    metadata={
        "changed_files": ["rate_limiter.py", "tests/test_rate_limiter.py"],
        "tests_run": 14,
        "tests_passed": 14,
        "review_scope": "user_id/IP fallback choice and merge safety",
    },
)
```

Completion means the worker's scoped implementation is terminal. It does not mean the workflow is approved or closed; that decision belongs to the foreground.

**Research task:**
```python
kanban_complete(
    summary="3 competing libraries reviewed; vLLM wins on throughput, SGLang on latency, Tensorrt-LLM on memory efficiency",
    metadata={
        "sources_read": 12,
        "recommendation": "vLLM",
        "benchmarks": {"vllm": 1.0, "sglang": 0.87, "trtllm": 0.72},
    },
)
```

**Review task:**
```python
kanban_complete(
    summary="reviewed PR #123; 2 blocking issues found (SQL injection in /search, missing CSRF on /settings)",
    metadata={
        "pr_number": 123,
        "findings": [
            {"severity": "critical", "file": "api/search.py", "line": 42, "issue": "raw SQL concat"},
            {"severity": "high", "file": "api/settings.py", "issue": "missing CSRF middleware"},
        ],
        "approved": False,
    },
)
```

Shape `metadata` so downstream parsers (reviewers, aggregators, schedulers) can use it without re-reading your prose.

## Shipping deliverables (`artifacts=[...]`)

If your task produced files a human actually wants — a chart, a PDF, a spreadsheet, a generated image, an archive — pass their **absolute paths** to `kanban_complete(artifacts=[...])`. The gateway notifier uploads each one as a native attachment to whoever subscribed to the task, so the deliverable lands in their chat alongside the completion message instead of being a path they have to go fetch.

```python
kanban_complete(
    summary="Q3 revenue analysis: 14% QoQ growth, EMEA the laggard. Chart + full PDF attached.",
    artifacts=["/tmp/q3-revenue.png", "/tmp/q3-report.pdf"],
    metadata={"rows_analyzed": 48000, "growth_qoq": 0.14},
)
```

Images and video embed inline; PDFs, docx, csv/xlsx/json/yaml, pptx, zip/tar/gz, audio, and html upload as files. Rules:

- **Absolute paths only**, and the file must still exist when you complete — don't point at a scratch file you already deleted.
- **Only real deliverables.** Skip intermediate logs, scratch files, and inputs the human already has.
- `artifacts` is the **top-level** parameter the notifier reads. Do not bury deliverable paths in `metadata` (e.g. `metadata.codex_lane.artifacts`) and expect them to upload — the notifier only scans the top-level `artifacts` list, with a best-effort fallback over your `summary`/`result` text. Metadata paths are for downstream-worker bookkeeping, not delivery.
- A bare string is auto-promoted to a one-element list, and it merges with any pre-existing `metadata.artifacts` without dupes.

Same primitive works outside kanban: any agent surface delivers a file just by writing its absolute path into the response, and Slack/Discord/Telegram/etc. upload it natively — the `artifacts` param is the structured kanban entry point.

## Block reasons that route cleanly

Bad: `"stuck"` — the reviewer/orchestrator has no context.

Good: one sentence naming the specific unresolved blocker. Leave longer context as a comment instead. Do not pre-label a block as `needs-user`; the orchestrator/operator decides whether the user is actually required.

```python
kanban_comment(
    task_id=os.environ["HERMES_KANBAN_TASK"],
    body="Full context: I have user IPs from Cloudflare headers but some users are behind NATs with thousands of peers. Keying on IP alone causes false positives.",
)
kanban_block(reason="Rate limit key choice is unresolved: IP is simple but NAT-unsafe; user_id requires auth and skips anonymous endpoints.")
```

The block message is what appears in the dashboard / gateway notifier. The comment is the deeper context a reviewer reads when they open the task.

## Heartbeats worth sending

Good heartbeats name progress: `"epoch 12/50, loss 0.31"`, `"scanned 1.2M/2.4M rows"`, `"uploaded 47/120 videos"`.

Bad heartbeats: `"still working"`, empty notes, sub-second intervals. Every few minutes max; skip entirely for tasks under ~2 minutes.

## Retry scenarios

If you open the task and `kanban_show` returns `runs: [...]` with one or more closed runs, you're a retry. The prior runs' `outcome` / `summary` / `error` tell you what didn't work. Don't repeat that path. Typical retry diagnostics:

- `outcome: "timed_out"` — the previous attempt hit `max_runtime_seconds`. You may need to chunk the work or shorten it.
- `outcome: "crashed"` — OOM or segfault. Reduce memory footprint.
- `outcome: "spawn_failed"` + `error: "..."` — usually a profile config issue (missing credential, bad PATH). Block with the concrete setup problem instead of retrying blindly.
- `outcome: "reclaimed"` + `summary: "task archived..."` — operator archived the task out from under the previous run; you probably shouldn't be running at all, check status carefully.
- `outcome: "blocked"` — a previous attempt blocked; the unblock comment should be in the thread by now.

## Notification routing

You can configure the gateway to receive cross-profile Kanban task notifications by adding `notification_sources` to `~/.hermes/config.yaml`.
- `notification_sources: ['*']` accepts subscriptions from all profiles.
- `notification_sources: ['default', 'zilor-ppt']` or `"default,zilor-ppt"` restricts subscriptions to specified profiles.
- Omitting the key keeps the default behavior (profile isolation).

## Do NOT

- Create or link follow-up/review tasks. Describe the suggested work in `kanban_comment`, then complete or cross a genuine non-dependency block so the foreground can decide and call `kanban_create`.
- Call `delegate_task` as a substitute for foreground workflow mutation. Short reasoning subtasks inside your run must not become hidden durable work.
- Call `clarify` to ask the human a question. You are running headless — there is no live user to answer. The call will time out (default ~120s) and the task will sit silently in `running` with no signal that it is blocked. Use `kanban_comment` (context) + `kanban_block(reason=...)` (concrete blocker) instead — the task surfaces on the board as blocked, and the orchestrator/operator decides whether it can resolve, route follow-up work, or escalate to the user.
- Modify files outside `$HERMES_KANBAN_WORKSPACE` unless the task body says to.
- Recommend follow-up work as if a different specialist will execute it; never
  create or self-assign that task from a task-scoped worker.
- Complete a task you didn't actually finish. Block it instead.

## Pitfalls

**Task state can change between dispatch and your startup.** Between when the dispatcher claimed and when your process actually booted, the task may have been blocked, reassigned, or archived. Always `kanban_show` first. If it reports `blocked` or `archived`, stop — you shouldn't be running.

**Workspace may have stale artifacts.** Especially `dir:` and `worktree` workspaces can have files from previous runs. Read the comment thread — it usually explains why you're running again and what state the workspace is in.

**Don't rely on the CLI when the guidance is available.** The `kanban_*` tools work across all terminal backends (Docker, Modal, SSH). `hermes kanban <verb>` from your terminal tool will fail in containerized backends because the CLI isn't installed there. When in doubt, use the tool.

## CLI fallback (for scripting)

Every tool has a CLI equivalent for human operators and scripts:
- `kanban_show` ↔ `hermes kanban show <id> --json`
- `kanban_complete` ↔ `hermes kanban complete <id> --summary "..." --metadata '{...}'`
- `kanban_block` ↔ `hermes kanban block <id> "reason"`
- etc.

Use the worker tools from inside an agent; graph creation and committed
review/follow-up task creation are foreground actions, not worker actions.
