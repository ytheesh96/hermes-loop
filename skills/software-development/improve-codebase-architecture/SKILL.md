---
name: improve-codebase-architecture
description: "Use when auditing architecture for costly friction."
version: 1.0.0
author: Hermes Agent (adapted from Matt Pocock)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [architecture, audit, coupling, locality, maintainability]
    related_skills: [codebase-design, domain-modeling, plan, requesting-code-review]
---

# Improve Codebase Architecture

Find the architecture improvement with the strongest evidence and leverage.
This is an audit and decision workflow, not a mandate to refactor.

## Routing Boundary

Use this skill for an existing codebase when the user asks where architecture
causes recurring navigation, coupling, change-locality, or testing friction.

Do not use it to design one already-chosen module interface (`codebase-design`),
review one diff (`requesting-code-review`), or implement a known refactor
(`plan` plus TDD). Do not trigger from the word “architecture” in a one-off
explanation.

When the immediate question is “add another helper or deepen/merge this module?”
or “what should callers see at this seam?”, route to `codebase-design` even if
the symptom spans many callers. This audit skill locates and ranks friction;
`codebase-design` chooses the interface shape.

## Output Boundary

The default deliverable is a cited Markdown report with ranked candidates and
one top recommendation. HTML is optional only when a visual artifact will help
the user compare evidence; it is never required.

No production code, branch, **commit or push**, issue, label, or publication is
created by this audit unless separately authorized.

## Process

### 1. Scope the Audit

Clarify the repository area, recurring pain, relevant time window, and excluded
concerns. State whether the user wants diagnosis only or also design options.
Keep implementation out of scope until a recommendation is accepted.

### 2. Build a Structural and Historical Map

For indexed repositories, use Codebase Memory when available:

- `get_architecture` for clusters, boundaries, entry points, and hot spots,
- `search_graph` for exact symbols and structural importance,
- `trace_path` for high-risk callers, callees, and data flow,
- `query_graph` for complexity, coupling, or multi-hop patterns, and
- `detect_changes` for change impact when a comparison range is relevant.

Use git history to sample recent, representative changes—not only the current
snapshot. Use `search_files` and `read_file` as fallbacks and to verify graph
results in source. Record tool inputs or commands so findings are reproducible.

### 3. Locate Evidence of Friction

Look for repeated, independently observable signals:

- one conceptual change scattered across many files,
- pass-through layers that expose rather than hide decisions,
- related symbols split across structural clusters,
- cycles or unstable boundaries,
- broad callers reaching into internal state,
- test setup that mirrors implementation details,
- high-churn code with many inbound dependencies,
- the same policy reimplemented in multiple callers, and
- operational fixes repeatedly landing in different layers.

Avoid ranking by file size, complexity score, or intuition alone. A graph metric
is a lead that must be checked against source and change history.

### 4. Form Candidate Improvements

For each candidate state:

- the observed friction,
- source paths, symbols, graph paths, or commits that prove it,
- the hidden decision that lacks a clear owner,
- the smallest plausible architecture move,
- the **deletion test**—which shallow layer, duplicate policy, or caller burden
  could disappear,
- risks and migration constraints, and
- evidence that would falsify the recommendation.

If the move requires a new seam or interface, defer detailed alternatives to
`codebase-design`.

### 5. Rank Recommendation Strength

Classify each candidate:

- **Strong:** several independent evidence sources point to the same boundary
  and the proposed move clearly improves locality.
- **Moderate:** the problem is real, but the right boundary or payoff remains
  uncertain.
- **Speculative:** evidence is thin or based on one isolated change.

Do not invent numeric ROI, speedup, defect reduction, or confidence percentages.
Use recommendation strength and cited facts instead.

### 6. Present the Report

Use `references/report-patterns.md`. Include:

1. scope and method,
2. current architecture map,
3. evidence-backed candidates,
4. ranked comparison,
5. top recommendation and why,
6. alternatives and risks,
7. a validation or migration sketch, and
8. open questions the user must decide.

For optional HTML, generate it from the same report content, keep Markdown as the
canonical source, and verify it with `open_preview`. Do not create a visual
artifact merely to make the audit look substantial.

### 7. Stop at the Decision Boundary

Recommend one candidate, but keep the user as decision owner. After approval:

- use `codebase-design` for the new interface,
- use `domain-modeling` if language or invariants are unresolved,
- use `plan` for tracer-bullet migration topology, and
- use `test-driven-development` for behavior-preserving seams.

## Completion Contract

The audit is complete when:

- every recommendation cites verified code or history,
- candidates are ranked by strength without fabricated metrics,
- the top recommendation has a deletion test, risks, and falsifier,
- design and implementation remain separate follow-up decisions, and
- the user can inspect the canonical report directly.

## References

- `references/report-patterns.md` — Markdown-first report and optional HTML guidance
- `references/UPSTREAM_LICENSE.md` — Matt Pocock attribution and MIT license
