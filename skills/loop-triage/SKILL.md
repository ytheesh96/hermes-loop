---
name: loop-triage
description: Clarify, specify, and safely plan a Loop task in the foreground. Use when a user invokes Loop Triage for a rough or scheduled root that may need an interview, a durable specification, and optional dependency decomposition before explicit submission.
---

# Loop Triage

Turn one real Loop root into a reviewable plan without starting execution.

## Invariants

- Treat the supplied task id as the canonical Loop/Kanban root. Keep separate Loop roots separate.
- Stay in the foreground conversation. Do not delegate the interview.
- Do not dispatch, submit, promote to `ready`, start workers, or create execution runs.
- Let decomposition return either one improved task or a dependency graph. Never force fan-out.
- Preserve the user's original request verbatim in the final specification.

## Workflow

1. Read the root and its graph with `loop_graph`. Pass the supplied `board` on every graph call. Capture the original title and body before changing either.
2. Read the current conversation and inspect relevant code, files, or documentation. Resolve discoverable facts yourself instead of asking the user.
3. Identify only decisions whose answers would materially change scope, behavior, constraints, or verification.
4. If such a decision is unresolved, ask exactly one question in each clarification call. Prefer the clarification UI when available, give 2-3 mutually exclusive choices, put the recommendation first, and explain why it is recommended. Wait for its returned answer before deciding whether another question is necessary. Never batch questions. Do not mutate the graph before the material decisions are resolved.
5. Repeat one decision at a time until the task is clear. If material assumptions remain, summarize the shared understanding and ask one final confirmation question. Skip ceremonial confirmation when the user's intent is already unambiguous.
6. Update the same root with `loop_graph` `action="patch"`, the revision returned by the last read, a stable mutation id, and one `update_node` operation targeting the root task id. Write a concise executable title and a body containing these headings:
   - Objective
   - Context
   - Acceptance criteria
   - Constraints and assumptions
   - Verification
   - Original request
7. Set `suggested_owner` only when the appropriate execution profile is clear.
8. Call `loop_graph` with `action="triage"`, the canonical `root_task_id`, `author="foreground-triage"`, and the supplied `board` when present. Accept both successful outcomes: `fanout=false` means the improved root is the plan; `fanout=true` means the returned scheduled children form the dependency plan.
9. Re-read the graph. Verify the root and any new task children remain `scheduled` and no worker run started.
10. Report the agreed specification and whether planning kept one task or created a graph. Tell the user that **Submit** remains the explicit execution gate, then stop.

If planning fails, leave the specified root in planning state, report the exact failure, and do not improvise a dispatch path.
