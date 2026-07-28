---
name: to-spec
description: "Use when turning an approved discussion into a spec."
version: 1.0.0
author: Vaitheesh Jeypalan (@ytheesh96, https://github.com/ytheesh96), adapted from Matt Pocock, ported by Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [specification, requirements, testing, planning]
    related_skills: [loop-triage, wayfinder, plan, test-driven-development]
---

# To Spec

Turn the **current conversation** and verified codebase context into one
reviewable specification. Synthesize what is already known; do not restart
discovery as a broad interview.

## Routing Boundary

Use this skill when the user explicitly asks to turn an accepted discussion,
plan, or design into a spec/PRD. Use `wayfinder` first when product or
architecture decisions are still genuinely open.

The invocation authorizes writing only the spec artifact. It does **not**
authorize production-code edits, commits, pushes, external publication, or
Loop/Kanban task creation. Do not create Loop work from this skill; use
`loop-triage` only after the user approves the specification and its proposed
breakdown.

## Process

### 1. Reconstruct the accepted intent

Read the full current conversation and any source the user named. Separate:

- the user-visible problem and outcome,
- accepted requirements and constraints,
- implementation decisions already made,
- testing expectations,
- exclusions, and
- unresolved decisions that still belong to the user.

Do not conduct a broad interview or silently invent missing product decisions.
If an unknown does not block a coherent draft, record it under **Unresolved
Decisions** with its decision owner. Ask one narrow question only when the user
requested a decision-complete spec and the answer materially changes scope.

### 2. Inspect the real codebase

Inspect the real codebase when implementation or testing claims depend on it.
Use the repository's domain glossary and respect applicable ADRs. Verify names
and behavior in source; do not rely on stale conversation claims.

Identify the **highest existing test seam** that can prove the user-visible
behavior. Prefer existing public interfaces and prior-art tests. Do not create a
new test seam merely to make one test convenient. If a new seam is unavoidable,
state why the existing seam cannot observe the requirement and keep the new
surface as high and narrow as possible.

### 3. Draft `SPEC.md`

Use these sections in order:

## Problem Statement

Describe the problem from the user's perspective, including the observable
failure or unmet need.

## Solution Overview

Describe the intended user-visible behavior and the boundaries of the solution.

## User Stories

Use numbered stories in the form: “As a …, I want …, so that …”. Cover meaningful
success, failure, recovery, and accessibility/operability cases without padding
the list with duplicates.

## Implementation Decisions

Record accepted module/interface, data, API, state-transition, compatibility,
and migration decisions. Avoid brittle file paths and working code snippets.
A short prototype-derived state machine, schema, or type may be included when it
captures an accepted decision more precisely than prose.

## Testing Decisions

Name the highest existing test seam, the externally observable behavior, the
independent oracle, relevant prior art, and any lower-level tests needed only for
failure localization. Tests must verify behavior rather than implementation
details.

## Acceptance Criteria

Write concrete, independently verifiable checkboxes. Include negative and
failure-path criteria where the requirement implies them.

## Out of Scope

State exclusions and nearby work that this spec does not authorize.

## Unresolved Decisions

List only material unresolved choices, their owner, and what each choice blocks.
Write `None` when the spec is decision-complete.

## Further Notes

Include provenance, compatibility caveats, rollout/rollback notes, or durable
context that does not fit above.

### 4. Store and verify the artifact

For an explicit `to-spec` invocation, write the result to
`.hermes/specs/<short-slug>/SPEC.md` in the current workspace. That request is
write authorization for this artifact only. If workspace policy forbids a local
write, return the complete Markdown in chat and state that no file was written.

Before reporting completion:

- confirm every accepted requirement appears in the spec,
- distinguish facts from assumptions and unresolved decisions,
- remove secrets, credentials, personal tokens, and irrelevant raw transcripts,
- avoid issue-tracker labels or publication instructions, and
- report the exact artifact path and whether it is ready for user approval.

Do not publish to an issue tracker and do not create Loop tasks from this skill.

## Attribution

Adapted from Matt Pocock's `to-spec` skill. Hermes replaces external issue
publication with a local, approval-gated specification artifact and preserves
foreground ownership of durable work. See `references/UPSTREAM_LICENSE.md`.
