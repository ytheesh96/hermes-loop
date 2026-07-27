---
name: codebase-design
description: "Use when designing module interfaces and seams."
version: 1.0.0
author: Hermes Agent (adapted from Matt Pocock)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [architecture, interfaces, modules, seams, design]
    related_skills: [domain-modeling, improve-codebase-architecture, plan, test-driven-development]
---

# Codebase Design

Design a module's interface before committing to implementation. Seek **deep
modules**: narrow interfaces that hide substantial policy, state, and
coordination behind them.

## Routing Boundary

Use this skill when the decision is about:

- the public interface of a new module,
- where a seam should sit,
- whether a cluster of shallow modules should become one deeper module, or
- how dependencies should cross that seam.

Do not use it merely to consume an existing design, perform a broad
architecture audit, define domain vocabulary, or plan an already-approved
implementation. Use `improve-codebase-architecture` for evidence-led audits and
`domain-modeling` for terms, invariants, and state transitions.

## Working Vocabulary

- **Module:** any unit that hides a design decision: function, class, package,
  service, subsystem, or component.
- **Interface:** everything callers must know to use the module correctly.
- **Depth:** useful capability hidden per unit of interface complexity.
- **Seam:** a boundary where behavior can vary independently.
- **Adapter:** one implementation of a seam's contract.

A module is deep when callers express intent without coordinating its internal
steps. A thin pass-through wrapper is not depth.

## Process

### 1. Frame the Decision

State the capability, callers, constraints, known failure modes, and what is not
being designed. Separate user requirements from implementation assumptions.
Do not edit production code during this phase.

**Completion criterion:** the design question and decision owner are explicit.

### 2. Inspect the Real Codebase

Trace representative callers and dependencies before proposing an interface.
For a large indexed repository, prefer Codebase Memory tools when available:

- `get_architecture` for packages, clusters, boundaries, and hot spots,
- `search_graph` before reading a symbol,
- `trace_path` for callers, callees, and data flow,
- `get_code_snippet` only after resolving the exact qualified name.

Fall back to `search_files`, `read_file`, and git history when the graph is
missing or stale. Verify graph findings in source before treating them as fact.

Record:

- what callers currently know,
- which changes force callers to move together,
- dependency categories and side effects,
- existing tests and public behavior, and
- vocabulary already established by the domain.

### 3. Test Whether Deepening Helps

For an existing cluster, apply the **deletion test**:

> If the shallow modules disappeared behind one interface, would callers become
> simpler while the same behavior remained testable?

If not, do not merge merely to reduce file count. Prefer deepening an existing
module over introducing a new wrapper when the responsibility already has a
natural owner.

Classify dependencies using `references/deepening.md`. One adapter usually
means a hypothetical seam; **two adapters** with distinct justified roles—often
production plus test—make the seam real. Keep test-only internal seams out of
the public interface.

### 4. Design It Twice

Produce at least two meaningfully different interfaces. For consequential
choices, use parallel `delegate_task` lanes with different constraints, such as:

1. minimal surface and maximum leverage,
2. flexibility across known use cases,
3. trivial default path for the common caller, or
4. explicit ports and adapters across a real boundary.

Each option must include:

- types, operations, ordering, invariants, and error modes,
- a representative caller example,
- what becomes hidden,
- dependency and adapter strategy, and
- the trade-off it intentionally makes.

Use `references/design-it-twice.md` for the comparison packet. Subagents provide
evidence and designs; the foreground agent verifies and synthesizes them.

### 5. Compare and Recommend

Compare alternatives on:

- **depth:** capability hidden behind the interface,
- **locality:** how many places change for one decision,
- **seam placement:** whether variation sits at a real boundary,
- **testability:** observable behavior at the public interface,
- **evolvability:** cost of likely future changes, and
- **failure semantics:** what callers can understand and recover from.

Make a recommendation and explain why it wins. Keep the alternatives visible;
do not silently select on the user's behalf.

### 6. Hand Off the Approved Design

Do not create durable design documents, change code, create branches, **commit
or push**, or publish unless the user requested or approved that action. After
approval:

- use `domain-modeling` if vocabulary or invariants remain unresolved,
- use `plan` for implementation topology,
- use `test-driven-development` to choose a public test seam, and
- replace obsolete internal tests only after equivalent public-interface tests
  prove the behavior.

## Completion Contract

A design phase is complete when:

- the real callers and dependencies were inspected,
- at least two distinct interfaces were compared,
- the seam and adapter choices are justified,
- the recommendation states trade-offs and failure behavior,
- the user retains the substantive design decision, and
- no implementation or durable write happened without authorization.

## References

- `references/deepening.md` — dependency categories, seam discipline, and test migration
- `references/design-it-twice.md` — parallel alternative-design packet
- `references/UPSTREAM_LICENSE.md` — Matt Pocock attribution and MIT license
