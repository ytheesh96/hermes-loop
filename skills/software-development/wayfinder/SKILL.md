---
name: wayfinder
description: Use when a large, foggy plan needs a durable Loop map.
version: 2.0.0
author: Matt Pocock; adapted for Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [planning, decisions, wayfinder, loop]
    related_skills: [loop-triage]
---

# Wayfinder

A loose idea has arrived—too large for one agent session, with no clear route
to the **destination**. Wayfinding finds that route instead of charging at the
destination. It charts a durable **shared map** in Hermes Loop, then works its
**decision tasks** until nothing important remains undecided.

## Plan, don't do

Wayfinder is planning by default. A task resolves a question; it is not a slice
of the eventual build. The map is done when another session can implement the
result without guessing. Production changes are never part of the current
Wayfinding phase, even when the prompt says "fix it"; that phrase names the
destination. Implementation requires a later explicit request after the map
closes.

The foreground owns the destination, human choices, graph changes, acceptance,
and closure. Workers gather evidence, prototype, or perform a prerequisite;
they do not choose for the user or create follow-up work.

## The map

The canonical map is one durable Loop workflow. Do not duplicate it in a todo
list or a second planning document.

| Wayfinder concept | Hermes representation |
|---|---|
| Map | Loop workflow created with `delegate_task(mode="loop", ...)` |
| Ticket | One bounded Loop task |
| Child ticket | A task in the workflow |
| Blocking | `depends_on`; use `blocks` only to insert a new prerequisite before an existing task |
| Frontier | Open, unblocked tasks ready to run |
| Resolution | Worker summary/comments plus foreground acceptance |
| Human decision | Worker blocks with the exact question; foreground asks the user and resumes it |

Put this low-resolution context on the workflow:

```markdown
## Destination
<what the map is finding its way to>

## Notes
<constraints, named skills, and any explicit execution override>

## Decisions so far
<completed task titles and one-line outcomes>

## Not yet specified
<in-scope fog that is not sharp enough to become a task>

## Out of scope
<work deliberately beyond this destination>
```

Completed task summaries are the detailed decision record. Keep the map as an
index; do not restate every finding everywhere. In user-facing narration, always
refer to tasks by title, not bare task IDs.

## Task types

Each task contains one question, enough context to work independently, its exit
criterion, and any real dependencies.

- **Research** (AFK): inspect code, documentation, APIs, or other evidence that
  can settle a factual uncertainty.
- **Prototype** (AFK then HITL): create the smallest disposable artifact that
  makes a behavior or appearance choice concrete; the user reacts in the
  foreground.
- **Decision / grilling** (HITL): gather viable options and consequences. If a
  human preference remains, block with one grounded question instead of
  answering for the user.
- **Task** (AFK or HITL): perform manual work required before a decision can be
  made. It may unblock the route, but must not quietly deliver the destination.

One worker session resolves one task. Independent Research tasks may run in
parallel; dependencies control the rest.

## Fog of war

The map is deliberately incomplete.

- Create a task when its question is precise now, even if it is blocked.
- Keep it under **Not yet specified** when the question itself is still fuzzy.
- Put it under **Out of scope** when it lies beyond the destination.

Resolving a task may clear more fog. The foreground—not a worker—adds newly
sharp tasks and wires their dependencies. Never create vague tasks merely to
make the map look complete.

## Invocation

### Chart the map

Use this mode when the user invokes `/wayfinder` with a loose idea.

1. **Name the destination.** Inspect retrievable facts first, then ask the user
   only for choices that evidence cannot answer.
2. **Map breadth-first.** Surface the open decisions, the first answerable
   questions, fog, and out-of-scope boundary. If the whole route fits one
   foreground session and no fog remains, do not create a Loop workflow; tell
   the user the map is unnecessary and ask how to proceed.
3. **Create the sharp tasks in one call.** Use brief titles, bounded context,
   and only real dependency edges:

```python
delegate_task(
    mode="loop",
    context="Destination: ...\nNotes: ...\nNot yet specified: ...",
    tasks=[
        {
            "id": "research-current-state",
            "title": "Establish the current system boundary",
            "context": "Type: Research. Return evidence and constraints; do not implement.",
        },
        {
            "id": "choose-boundary",
            "title": "Choose the supported boundary",
            "depends_on": ["research-current-state"],
            "context": "Type: Decision. Block if a user-owned trade-off remains.",
        },
    ],
)
```

4. Leave fog as fog. Do not pre-slice it into speculative tasks.
5. Stop. Charting launches the map; it does not hand-resolve its tasks or begin
   production implementation.

### Work through the map

Use this mode when Wayfinder is invoked with an existing workflow or when a
Loop boundary returns to the foreground.

1. Orient to the destination and current frontier. Use the boundary context
   already supplied; call `loop_graph(action="read")` only when manual resume
   lacks current graph state.
2. Accept sound evidence, request rework when it is insufficient, or take a
   blocked human decision to the user. Do not let a worker decide taste, risk,
   priority, or irreversible trade-offs.
3. As an answer clears fog, add only the newly precise tasks with
   `delegate_task(mode="loop", tasks=[...])`. Use `blocks` when the new work
   must finish before an existing blocked task can resume.
4. Preserve each decision in its task summary/comment and keep narration keyed
   by title.
5. Close with `loop_graph(action="close")` only when no task, decision, or
   in-scope fog remains. The result is the planning handoff; implementation is
   a separate workflow unless Notes said otherwise.

---

Adapted from [Matt Pocock's Wayfinder skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md), © 2026 Matt Pocock, under the MIT License. See `references/UPSTREAM_LICENSE.md`.
