---
name: domain-modeling
description: "Use when clarifying domain language and invariants."
version: 1.0.0
author: Hermes Agent (adapted from Matt Pocock)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [domain, modeling, invariants, state-machines, adr]
    related_skills: [codebase-design, plan, test-driven-development]
---

# Domain Modeling

Make domain concepts precise enough that code, tests, product language, and
documentation describe the same world.

## Routing Boundary

Use this skill when a task changes or exposes uncertainty about:

- canonical domain terms,
- entity or value-object boundaries,
- invariants and legal state transitions,
- relationships and ownership, or
- a substantial domain decision worth recording.

Do not invoke it merely because an existing `CONTEXT.md`, glossary, or ADR must
be read before routine implementation. Consuming an established model is normal
context gathering; changing the model is domain work.

## Process

### 1. Inspect Existing Language

Read representative product text, code symbols, schemas, tests, API contracts,
and existing domain documentation. Search for competing names and meanings.
Treat code as evidence of current behavior, not automatic authority over the
intended domain.

Record ambiguous terms, overloaded terms, synonyms, and places where the same
word denotes different lifecycle stages.

### 2. Ground the Model in Concrete Scenarios

Ask for or derive representative scenarios, including edge and failure cases.
For each scenario, identify:

- actors and objects,
- triggering events,
- state before and after,
- rules that must always hold, and
- operations that must be rejected.

Prefer examples such as “a paid order is refunded after partial fulfillment”
over abstract debates about class names.

### 3. Establish Ubiquitous Language

For each important term define:

- canonical name,
- concise meaning,
- what it explicitly does **not** mean,
- representative examples and counterexamples,
- lifecycle or ownership, and
- deprecated synonyms, if any.

Use the language consistently in proposed APIs, tests, and artifacts. Do not
rename code yet; first prove the vocabulary resolves real ambiguity.

### 4. Model Invariants and State Transitions

State invariants as checkable rules. Describe transitions as:

```text
current state + event/preconditions -> next state + observable effects
```

List illegal transitions and represent invalid combinations explicitly. Favor
types and interfaces that make illegal states unrepresentable rather than
scattering runtime checks across callers.

Validate the model against every concrete scenario. A model that only explains
the happy path is incomplete.

### 5. Review Boundaries and Relationships

Identify entities, value objects, aggregates or consistency boundaries only
when those concepts clarify behavior. Avoid importing elaborate tactical DDD
patterns by default.

For each relationship, clarify direction, multiplicity, ownership, lifecycle,
and whether consistency is immediate or eventual.

### 6. Draft Before Writing

Present the glossary, invariants, transition table, unresolved questions, and
recommended changes in the conversation first. The user owns disputed domain
meaning and substantive product decisions.

Create or update durable documentation only after explicit user **approval** or
when the user already requested those repository changes:

- merge canonical language into `CONTEXT.md` or the project's established
  domain file using `references/context-format.md`,
- preserve unrelated and still-valid content,
- create an ADR only for a consequential approved decision with real
  alternatives and trade-offs, using `references/adr-format.md`, and
- do not create branches, commits, issues, labels, or publications without
  separate authorization; never commit or push by default.

### 7. Hand Off to Design and Tests

Use `codebase-design` when the clarified model requires a new public interface.
Use `test-driven-development` to encode invariants and legal/illegal transitions
through a public seam. Use `plan` only after unresolved domain decisions are
closed or explicitly marked.

## Completion Contract

Domain modeling is complete when:

- canonical terms resolve the observed ambiguity,
- invariants and legal/illegal transitions are explicit,
- concrete scenarios fit without contradiction,
- unresolved product decisions remain visible and user-owned,
- durable documentation was merged rather than blindly overwritten, and
- routine implementation is not forced to rediscover the model.

## References

- `references/context-format.md` — compact domain-context structure
- `references/adr-format.md` — decision-record threshold and template
- `references/UPSTREAM_LICENSE.md` — Matt Pocock attribution and MIT license
