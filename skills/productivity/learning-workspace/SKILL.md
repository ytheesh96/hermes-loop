---
name: learning-workspace
description: "Use when teaching a topic across multiple sessions."
version: 1.0.0
author: Hermes Agent (adapted from Matt Pocock)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [teaching, learning, curriculum, retrieval-practice, sources]
    related_skills: [research-information-workflows, document-processing]
---

# Learning Workspace

Create a source-backed, stateful learning environment that remembers the
learner's mission, resources, misconceptions, and demonstrated progress across
sessions.

## Routing Boundary

Use this skill when the user asks for an ongoing course, tutoring workspace,
curriculum, or multi-session learning project. Do not invoke it for a one-off
explanation, summary, or isolated question unless the user asks to preserve and
build on learning state.

The learner owns the mission, pace, and major direction changes. The agent owns
lesson preparation, evidence, calibration, and record maintenance.

## Canonical Workspace

Use Markdown as the default source of truth:

```text
learning/<topic>/
  MISSION.md
  RESOURCES.md
  GLOSSARY.md
  lessons/
  learning-records/
```

Adapt to an existing repository or vault convention rather than creating a
parallel hierarchy. Create these files only when the user has requested a
stateful workspace or otherwise authorized durable writes.

HTML, slides, quizzes, or diagrams are optional generated views. They must not
become a second source of truth. Verify visual views with `open_preview` when
used.

## Process

### 1. Establish the Mission

Co-author `MISSION.md` using `references/mission-format.md`. Capture:

- why the learner cares,
- observable outcomes they want to achieve,
- prior knowledge and constraints,
- preferred pace and evidence style,
- an initial milestone, and
- what is explicitly out of scope.

Do not silently choose the learner's goal. If the request already states a
clear mission, draft it and proceed rather than reopening every decision.

### 2. Build a Cited Resource Library

Discover and verify authoritative resources. Prefer primary sources, official
documentation, textbooks or peer-reviewed material where appropriate, and
high-quality worked examples. Record exact URLs or citations, scope, difficulty,
why each source matters, and access date in `RESOURCES.md` using
`references/resource-format.md`.

Do not present generated prose as sourced material. Mark uncertainty and source
conflicts explicitly.

### 3. Calibrate the Starting Point

Use a short diagnostic conversation or task to find the learner's current
**zone of proximal development**: what they can do unaided, what they can do
with a prompt, and what is not yet accessible.

Record demonstrated evidence, not personality labels or unsupported judgments.
Begin at the first meaningful gap rather than replaying all prerequisites.

### 4. Teach in Mission-Driven Lessons

Each lesson should:

1. connect to the mission,
2. retrieve relevant prior knowledge before explaining,
3. introduce one manageable conceptual step,
4. use a concrete example or demonstration,
5. require the learner to predict, explain, solve, or build,
6. give feedback tied to evidence, and
7. end with a transfer or recall prompt.

Use `references/lesson-format.md` for durable lessons. Keep exposition concise
enough that active work remains the center of the session.

### 5. Use Retrieval, Spacing, and Interleaving

Revisit earlier ideas after delays rather than rereading them immediately.
Interleave nearby concepts when discrimination matters. Vary examples so the
learner demonstrates transfer instead of memorizing one surface pattern.

Do not manufacture a rigid calendar without the learner's scheduling context.
Record suggested next review points and adjust them based on performance.

### 6. Maintain Learning Records

After substantive sessions, append a learning record using
`references/learning-record-format.md`:

- work attempted,
- evidence of understanding,
- misconceptions or unresolved questions,
- assistance required,
- resources used,
- retrieval targets, and
- proposed next step.

Distinguish “explained” from “demonstrated.” Update mastery claims only when the
learner has produced observable evidence.

### 7. Adapt and Reconfirm

Periodically compare demonstrated progress with the mission. Recommend changes
to pace, sequence, resources, or milestone when evidence warrants them, but let
the learner approve major redirection.

If the learner asks a one-off tangent, answer it without bloating the durable
curriculum unless it affects the mission.

## Citation and Privacy Rules

- Cite factual teaching claims that depend on external sources.
- Preserve source links and access information.
- Do not copy private learner material outside the authorized workspace.
- Do not publish, share, email, commit, or sync learning artifacts without
  explicit authorization.
- Keep records pedagogical; avoid sensitive personal profiling.
- A community or peer-learning space is optional. Do not create or require one,
  and do not invite people or post material without explicit authorization.

## Completion Contract

A learning session is complete when:

- the lesson advanced a mission outcome,
- the learner performed an active task,
- evidence and unresolved misconceptions are recorded accurately,
- sources are traceable,
- retrieval and next-step suggestions are explicit, and
- no mastery or progress claim exceeds demonstrated evidence.

## References

- `references/mission-format.md` — mission and observable outcomes
- `references/resource-format.md` — cited resource library
- `references/glossary-format.md` — learner-facing vocabulary
- `references/lesson-format.md` — durable lesson packet
- `references/learning-record-format.md` — evidence-based progress record
- `references/UPSTREAM_LICENSE.md` — Matt Pocock attribution and MIT license
