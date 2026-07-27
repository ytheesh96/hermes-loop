---
name: hermes-agent-skill-authoring
description: Use when writing, editing, or pruning Hermes skills.
version: 2.0.0
author: Matt Pocock; adapted for Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [skills, authoring, predictability, progressive-disclosure]
    related_skills: [skill-evaluation-and-ablation]
---

# Writing Great Hermes Skills

A skill wrangles predictability out of a stochastic system. A **predictable
process** means the agent follows the same useful discipline on repeated runs,
not identical output. Every line must earn its context and attention cost by
changing that process.

## Authoring loop

### 1. Name the behavior gap

State the process the agent follows without the skill, the process it should
follow with the skill, and the evidence that distinguishes them. Use real
failures or representative prompts when available.

**Completion criterion:** the intended process change is observable and can be
tested against a no-skill baseline.

### 2. Design invocation

Choose a **leading word** the model already understands and that users naturally
say when they need the behavior. Put the distinct trigger branches first in the
description. Each branch earns its place; synonyms for one branch are
duplication.

Hermes currently exposes enabled skill descriptions to the model, so every
extra description spends **context load**. Keep it short enough to preserve the
routing signal. Read `references/HERMES_MECHANICS.md` before choosing metadata,
paths, or invocation behavior.

**Completion criterion:** positive cases share the trigger language and nearby
negative cases do not.

### 3. Build the information hierarchy

Rank content by when the agent needs it:

1. **Steps** in `SKILL.md` — ordered actions needed on every applicable run.
2. **In-skill reference** — compact rules needed across branches.
3. **Disclosed reference** — branch-specific facts behind a **context pointer**.

Use **progressive disclosure** to move branch-specific reference into
`references/`, `templates/`, `scripts/`, or `assets/`. The pointer must say when
to load the file and what decision it informs. Keep must-have behavior inline
when a pointer proves unreliable.

**Completion criterion:** every line occupies the lowest rung that still makes
its behavior reliable.

### 4. Write checkable steps

When the skill has steps, end each one with a **completion criterion**. A strong
criterion is checkable and, where needed, exhaustive: “every modified file is
accounted for” drives more legwork than “summarize the changes.”

If agents rush a step, sharpen its criterion first. Split a sequence only when
later visible steps still pull attention forward into premature completion.

**Completion criterion:** the agent can distinguish done from almost done at
every boundary.

### 5. Prune relentlessly

Apply these tests sentence by sentence:

- **Single source of truth:** each meaning has one authoritative home.
- **Relevance:** the sentence still bears on the skill's current behavior.
- **No-op:** removing it changes the agent's process versus the default.
- **Sediment:** old layers are deleted rather than covered by new wording.
- **Sprawl:** live but branch-specific material moves behind a pointer.
- **Leading word:** a compact pretrained concept replaces repeated explanation.
- **Positive target:** say what the agent should do; reserve negation for hard
  guardrails and pair it with the target behavior.

Delete a failed sentence instead of polishing it. Shortness is not the goal;
predictable behavior per token is.

**Completion criterion:** every surviving sentence changes routing, execution,
or verification.

### 6. Prove the skill

Start with deterministic checks for frontmatter, disclosed files, forbidden
stale patterns, and size ceilings. Then use the
`skill-evaluation-and-ablation` skill for representative positive and negative
prompts with the skill enabled and disabled. Repeat model trials when behavior
is stochastic.

Accept the change when the skill improves the declared process without new
routing or outcome regressions. If the baseline already performs as well,
remove the no-op skill or the lines that add no lift.

**Completion criterion:** structure, invocation, enabled behavior, disabled
baseline, and regression boundaries all have recorded evidence.

## Split only when the cut earns its load

- **By invocation:** split when a distinct leading word should trigger a branch
  independently and its permanent description cost is justified.
- **By sequence:** split when an irreducibly fuzzy step repeatedly rushes because
  later steps remain visible.

Otherwise keep one skill and disclose conditional reference. More files are not
automatically more predictable.

## Diagnose failures

| Failure | First repair |
|---|---|
| Missed invocation | Strengthen the description's trigger branches and leading word. |
| Irrelevant invocation | Remove broad synonyms and add a nearby negative eval. |
| Premature completion | Sharpen the current step's completion criterion. |
| Thin legwork | Raise the criterion's demand or use a stronger leading word. |
| Duplication | Restore one single source of truth. |
| Sediment | Delete stale layers. |
| Sprawl | Disclose branch-specific reference behind a precise pointer. |
| No-op | Delete it, then verify the ablation is unchanged. |
| Negation rebound | Replace the prohibition with a positive target behavior. |

## Disclosed reference

- Read `references/HERMES_MECHANICS.md` before creating, installing, syncing,
  validating, reloading, or committing a Hermes skill.
- Read `references/GLOSSARY.md` when diagnosing invocation, hierarchy, steering,
  or pruning failures.
- `references/UPSTREAM_LICENSE.md` records the upstream source and MIT terms.
