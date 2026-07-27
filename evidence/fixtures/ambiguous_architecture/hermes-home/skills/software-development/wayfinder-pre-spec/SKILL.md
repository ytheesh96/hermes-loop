---
name: wayfinder-pre-spec
description: Use when a feature has unresolved product or architecture decisions, or the user asks for Wayfinder. Research first, keep user-owned choices in the foreground, and hand off a decision-complete specification without production implementation.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [planning, discovery, decisions, specifications, wayfinder]
    related_skills: [plan, loop-triage]
---

# Wayfinder Pre-Spec

## Overview

Wayfinder is a behavioral planning skill, not a special orchestration engine. It
turns a decision-incomplete request into a traceable, decision-complete
specification. Use normal Hermes tools to inspect code and evidence, and use
existing delegation or Loop primitives only when the work genuinely benefits
from parallelism or durability.

Wayfinder owns **policy**: when to pause implementation, how to expose the
uncertain frontier, which questions belong to the user, and what evidence a
specification needs. Native tools own **mechanism**: files, browser access,
delegation, durable tasks, dependencies, and persistence. Do not invent a
Wayfinder-specific transport, task state, or lifecycle protocol.

The deliverable is alignment and a specification handoff. Disposable
prototypes may be produced to resolve a choice, but Wayfinder does not implement
production code or launch implementation tickets as part of discovery.

## When to Use

Use Wayfinder when at least one of these is true:

- The user explicitly asks for Wayfinder, pre-spec discovery, a decision map,
  or an implementation-ready specification before coding.
- A requested feature has unresolved product behavior, user experience,
  architecture, security, policy, or ownership decisions that materially alter
  the implementation.
- Objective facts must be researched before a responsible trade-off can be
  presented to the user.
- The user cannot picture the alternatives and needs a small disposable
  prototype to choose confidently.
- Several independent evidence lanes must converge before a coherent
  specification can be written.

Do **not** use Wayfinder when:

- An ordinary implementation request is already decision-complete.
- The task is a bounded bug fix, refactor, documentation edit, test run, or code
  review with existing acceptance criteria.
- The user asks a standalone factual or research question with no downstream
  product decision.
- The prompt contains an incidental reference to “Wayfinder,” such as editing
  its documentation or skill text, without invoking its planning behavior.
- The user explicitly asks to implement an approved change without reopening a
  planning phase.
- The user says “Use Loop” for execution of an already-approved task. That is
  durable implementation routing, not Wayfinder discovery.

If the request is small and one grounded foreground exchange can resolve it,
do that. Do not create a task graph merely to demonstrate process.

## Quick Reference

| Situation | Default behavior |
|---|---|
| Relevant facts exist in the repository | Inspect them before asking the user |
| External facts control viable options | Research primary sources first |
| A preference or trade-off remains | Present evidence-backed alternatives to the user |
| The user cannot picture the choice | Build the minimum disposable comparison |
| One or two tightly coupled decisions | Keep discovery in the foreground |
| Independent short research lanes | Use ephemeral delegation if it reduces latency |
| Discovery must survive restart or span many stages | Use ordinary durable Loop tasks |
| Specification is decision-complete | Hand it off; do not implement within Wayfinder |

## Operating Contract

### 1. Inspect before asking

Do not ask the user a question that source inspection can answer. Use code,
documentation, live UI, schemas, APIs, and primary sources to establish the
current state first. Distinguish:

- what already exists and must remain compatible;
- what is objectively constrained;
- what is genuinely uncertain; and
- what requires a user preference rather than more research.

A question is ready for the user only after retrievable facts have been removed
from it.

### 2. Keep user-owned decisions in the foreground

The user owns taste, priority, acceptable risk, irreversible trade-offs, and
product values. Workers may gather evidence, compare alternatives, or build a
small prototype. They must not silently choose on the user's behalf.

When evidence narrows a decision, return it to the foreground with concrete
options and consequences. A worker result is evidence, not acceptance.

### 3. Separate three kinds of frontier item

- **Decision** — a human preference, value judgment, or trade-off remains.
- **Research** — objective evidence from code, documentation, an API, policy, or
  experiment can resolve the uncertainty.
- **Prototype** — prose is too low-fidelity to compare the viable options.

Each item should contain one question, why it matters, known evidence,
dependencies, an exit criterion, and current status. Do not create vague rows
such as “investigate unknowns.”

### 4. Keep discovery separate from production implementation

Wayfinder may read production code and may create disposable evidence artifacts.
It must not mutate production behavior, present prototype code as shippable, or
quietly turn the decision map into an implementation queue.

When the map is settled, write a decision-complete specification and stop. A
fresh implementation phase may then create or execute implementation tickets.

## Procedure

1. **Restate the destination and non-goals.**
   - Define the requested outcome as a decision-complete specification.
   - State that production implementation is outside the current phase.
   - Preserve any explicit constraints, compatibility requirements, and user
     values already provided.

2. **Ground the current state.**
   - Inspect relevant code, schemas, routes, UI, tests, and prior decisions.
   - Research external constraints from primary sources when needed.
   - Record evidence pointers so later claims remain verifiable.

3. **Decide whether Wayfinder is actually needed.**
   - If the task is already decision-complete, exit Wayfinder and implement or
     answer normally.
   - If the ambiguity is minor and safely resolved by a stated default, use the
     default instead of manufacturing a planning program.
   - If material decisions remain, continue with discovery.

4. **Chart the smallest useful frontier.**
   - Create one item per independently resolvable decision, research question,
     or prototype comparison.
   - Encode only real dependencies.
   - Keep the top-level map terse and link thick evidence from each item.

5. **Choose the lightest execution mode.**
   - Foreground conversation is the default.
   - Use ephemeral delegation for independent, bounded evidence gathering.
   - Use `delegate_task(mode="loop", tasks=[...])` only when the user explicitly
     requests durable Loop or the discovery genuinely must survive restart and
     benefit from durable dependencies.
   - Durable workers receive research or prototype objectives, not authority to
     make user-owned decisions.

6. **Run objective lanes before subjective ones.**
   - Inspect or research facts that determine which options are viable.
   - Do not ask the user to choose between options that evidence may eliminate.
   - Update dependencies when findings expose a new question.

7. **Ask one grounded decision at a time.**
   - Present the relevant evidence first.
   - Offer concrete viable alternatives, consequences, and a recommendation
     when evidence supports one.
   - Ask only the narrow preference or risk question that remains.

8. **Prototype only to resolve a choice.**
   - Build the minimum faithful comparison.
   - Label it disposable and non-production.
   - Collect specific feedback about the decision, not general aesthetic praise.
   - Record accepted, rejected, deferred, and still-missing details.

9. **Close each item with a resolution packet.**
   - State the decision or finding.
   - Explain why it was chosen.
   - Record rejected alternatives and why they lost.
   - Link supporting code, research, or prototype evidence.
   - State downstream constraints and newly exposed items.

10. **Reconcile the map.**
    - Inspect open, blocked, and newly exposed items after each resolution wave.
    - Do not trust a summary that claims completion while required items remain
      unresolved.
    - Avoid duplicate rows and archive or supersede obsolete alternatives in
      the chosen planning artifact.

11. **Write the handoff.**
    - Produce one coherent decision-complete specification.
    - Preserve source pointers, rationale, constraints, rejected alternatives,
      and explicit non-goals.
    - Separate implementation tickets from decision history.
    - Stop before production implementation begins.

## Suggested Map Shape

Use the user's existing tracker or document when one is specified. Otherwise,
keep the map in the foreground conversation instead of inventing a repository
artifact.

```markdown
| Item | Kind | Question | Evidence | Depends on | Exit criterion | Status |
|---|---|---|---|---|---|---|
| auth-boundary | decision | Which supported boundary fits the risk tolerance? | links | threat-model | User selects one viable boundary | open |
| threat-model | research | What threats and migration constraints apply? | links | — | Evidence rules out unsupported options | open |
```

A map is a progressive-disclosure index, not a data dump. Put detailed evidence
and prototype artifacts behind links.

## Delegation Boundaries

When independent evidence gathering justifies workers:

- Give each worker one bounded objective and an explicit non-goal of production
  implementation.
- Require findings, evidence pointers, constraints, and unresolved questions.
- Keep taste, priority, risk acceptance, and irreversible choices in the
  foreground.
- Treat comments and summaries as advisory evidence.
- Do not create durable work merely because delegation is available.
- Do not duplicate the durable graph in a separate session todo list.

An ordinary explicit Loop implementation request remains an implementation
workflow. Wayfinder must not intercept or delay it unless the user also asks to
reopen unresolved decisions.

## Handoff Contract

A Wayfinder handoff is ready only when:

- every required decision is resolved by the appropriate owner;
- every objective claim points to inspectable evidence;
- rejected alternatives and their reasons are recorded;
- unresolved items are explicit rather than hidden in prose;
- prototypes are labeled non-production;
- compatibility, security, migration, and operational constraints are stated;
- the specification says what implementation must verify; and
- implementation can begin in a fresh context without guessing product intent.

If any of these are missing, continue discovery or explicitly mark the remaining
blocker. Do not fill gaps with plausible assumptions.

## Pitfalls

1. **Over-triggering on any ambiguity.** Minor uncertainty does not justify a
   planning program; use a safe stated default when appropriate.
2. **Triggering on the word instead of the intent.** An incidental Wayfinder
   reference is not an invocation.
3. **Asking ungrounded questions.** Inspect retrievable facts first.
4. **Letting workers own preferences.** Workers return evidence; the user owns
   product values and trade-offs.
5. **Materializing fog.** A vague task hides uncertainty rather than resolving
   it.
6. **False parallelism.** Dependent decisions handled concurrently produce
   incompatible assumptions.
7. **Prototype drift.** A polished prototype is still evidence, not production
   code.
8. **Planning becoming implementation.** The handoff ends Wayfinder; it does not
   silently execute the next phase.
9. **Graph sprawl.** More rows do not mean more clarity. Keep only independently
   resolvable items and real dependencies.
10. **Duplicating orchestration.** Existing foreground, delegation, and Loop
    primitives are sufficient; do not invent a separate Wayfinder engine.

## Verification

Before completing Wayfinder discovery, confirm:

- [ ] The trigger was a materially decision-incomplete request, not a nearby negative case.
- [ ] Relevant source and external evidence were inspected before user questions.
- [ ] User-owned choices remained in the foreground.
- [ ] No production implementation occurred during discovery.
- [ ] Delegation used the lightest sufficient execution mode.
- [ ] Every map item has one question, evidence, dependencies, and an exit criterion.
- [ ] Every resolved item records rationale and rejected alternatives.
- [ ] No required item remains hidden, duplicated, or falsely marked complete.
- [ ] The final artifact is a decision-complete specification with verifiable evidence.
- [ ] Implementation is a separate next phase.
