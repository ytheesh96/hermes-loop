---
name: prototype
description: "Use when a throwaway build must answer a question."
version: 1.0.0
author: Hermes Agent (adapted from Matt Pocock)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [prototype, experiment, state-machine, ui, design]
    related_skills: [spike, sketch, codebase-design, test-driven-development]
---

# Prototype

Build the smallest disposable artifact that lets the user answer one design or
behavior question through direct interaction.

## Routing Boundary

Use this skill when uncertainty is experiential: the user needs to drive a
state model, exercise an interface, or compare visibly different UI directions.
The artifact exists to learn, not to become production code.

Use `spike` instead when the unknown is technical feasibility, dependency
behavior, or external documentation. Do not use this skill for an approved
production implementation, a one-off explanation, or a polished demo of known
behavior.

## Non-Negotiable Boundary

A prototype is not production-ready evidence. It may omit hardening that real
code requires. **Do not ship prototype artifacts.** Never promote one directly,
silently merge it, or let a UI switcher ship. Any selected behavior must
re-enter implementation through a public test seam and the project's normal
quality gates.

Do not create a branch, commit, push, publish, or change remote state without
explicit authorization.

## Process

### 1. State the Question and Exit Rule

Write one sentence that the artifact must answer, for example:

- “Can this state model represent partial approval without contradiction?”
- “Which information hierarchy makes the dashboard's primary action obvious?”

Define what observation would answer the question and when to stop. A prototype
with no verdict criterion becomes an unbounded side project.

### 2. Choose the Branch

- **Logic prototype:** business logic, state transitions, data shape, or API
  feel. Load `references/logic-prototype.md`.
- **UI prototype:** visual hierarchy, layout, density, or interaction direction.
  Load `references/ui-prototype.md` and use the `sketch` skill for variant
  generation when available.

If both are uncertain, isolate them and prototype the highest-risk question
first rather than entangling them.

### 3. Isolate the Artifact

Prefer a managed scratch directory or `/tmp` when the user did not authorize
repository writes. If the user asked for an in-repository prototype, place it in
an obviously disposable location, reuse the project's runtime and package
manager, and avoid production imports or real mutations. Keep real credentials,
secrets, production data, databases, migrations, queues, billing, and destructive
services out of the prototype; use inert fixtures, stubs, or isolated scratch
resources when the question requires that boundary.

State the location and cleanup plan before building.

### 4A. Build a Logic Prototype

Keep the decision logic behind a small pure interface: reducer, explicit state
machine, pure function set, or narrow stateful module. Keep terminal or browser
I/O in a thin shell that calls the logic; the logic must not call back into the
shell.

Use in-memory data unless persistence is the question. Show current state and
available actions clearly. Make the prototype runnable with one command and
keep the full interaction on one screen when practical.

### 4B. Build a UI Prototype

Generate 2–4 structurally different variants—not color-only variations. Prefer
placing read-only variants inside the real surrounding page so navigation,
density, and data shape remain visible. If no natural host exists, use an
obviously disposable route.

Use a shareable `?variant=` selector or equivalent and a visible floating
switcher. Gate the switcher and throwaway route out of production builds. Do not
wire prototypes to real destructive mutations; use stubs or read-only data.

### 5. Run and Verify It

Actually run the one-command entry point. For UI, open the route and verify each
variant, switcher, keyboard behavior, console, and production gate. For logic,
drive the edge scenarios that motivated the question.

Do not claim the prototype works from source inspection alone.

### 6. Hand It to the User

Provide the exact command or URL, the question being tested, and 2–4 scenarios
to try. The user owns the experiential verdict. Capture surprising behavior
rather than explaining it away.

### 7. Record the Verdict and Dispose

Classify the result:

- **answered:** state the decision and evidence,
- **ambiguous:** state what the prototype failed to distinguish, or
- **failed:** state why the artifact could not answer the question.

Then follow the authorized cleanup plan. Retain only what the user asks to keep.
If logic or a variant is selected, treat it as design evidence and implement it
fresh with TDD, independently known expectations, error handling, and normal
review. Do not describe prototype code as production-ready.

## Testing Policy

The disposable shell does not require a full production test suite. A tiny
assertion or harness is appropriate when it makes the question measurable. Any
logic copied, promoted, or rewritten for production must follow
`test-driven-development`; prototype status never weakens production safeguards.

## Completion Contract

A prototype task is complete when:

- one explicit question and exit rule drove the artifact,
- logic and presentation remained separate,
- the artifact ran successfully through the relevant scenarios,
- the user received a command or URL and retained the verdict,
- production code and remote state were untouched unless authorized, and
- cleanup, retention, or promotion was explicit.

## References

- `references/logic-prototype.md` — state-model and interactive shell pattern
- `references/ui-prototype.md` — variant and switcher pattern
- `references/UPSTREAM_LICENSE.md` — Matt Pocock attribution and MIT license
