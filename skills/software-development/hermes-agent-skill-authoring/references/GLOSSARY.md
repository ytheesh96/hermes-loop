# Glossary — Writing Great Hermes Skills

This adapted domain model follows Matt Pocock's `writing-great-skills`
glossary. The root virtue is **Predictability**; every other term is a lever on
it. Read only the axis needed to diagnose the current skill.

## Predictability

A skill's ability to make an agent follow the same useful process on repeated
runs. It does not require identical output: brainstorming can predictably
diverge while following a stable method.

## Invocation

How a skill is reached and what the choice costs.

- **Description:** the model-visible trigger in the skill index. It names the
  skill's distinct trigger branches and spends context on every turn.
- **Context pointer:** wording already in context that says when and why to load
  out-of-context material. Its wording determines retrieval reliability.
- **Context load:** tokens and attention permanently spent on model-visible
  descriptions.
- **Cognitive load:** skill names and trigger conditions the human must remember
  for explicit invocation.
- **Leading word:** a compact pretrained concept that anchors both invocation
  and execution, such as *root cause*, *tracer bullet*, or *fog of war*.
- **Granularity:** how finely skills are divided. Each split must earn its added
  context or cognitive load.

Matt's upstream model distinguishes model-invoked and user-invoked skills with
`disable-model-invocation`. Current Hermes does not support that field; see
`HERMES_MECHANICS.md` for the enforceable invocation contract.

## Information hierarchy

The ladder that ranks content by how immediately the agent needs it:

1. **Steps:** ordered actions in `SKILL.md`, each ending in a completion
   criterion.
2. **In-skill reference:** compact definitions, rules, or facts needed across
   branches.
3. **Disclosed reference:** conditional material behind a context pointer.

- **Progressive disclosure:** moving branch-specific reference down the ladder
  so the always-visible path stays legible.
- **Co-location:** keeping a concept's definition, rules, and caveats together
  once its rung is chosen.
- **Branch:** a distinct way the skill is used. Inline what every branch needs;
  disclose what only one branch needs.
- **Sprawl:** too much always-visible material, even when each line is live and
  unique. Repair it with disclosure or an earned split.

## Steering

Levers that shape runtime behavior.

- **Completion criterion:** the condition that tells the agent a step is done.
  Clarity resists premature completion; demand drives legwork. Strong criteria
  are checkable and, when needed, exhaustive.
- **Legwork:** exploration and execution inside a step. Raise it with a more
  demanding criterion or a stronger leading word.
- **Post-completion steps:** visible later steps that pull attention away from
  finishing the current one.
- **Premature completion:** leaving a step before its criterion is met. Sharpen
  the criterion first; split only when later steps still cause the failure.
- **Negation:** steering by naming forbidden behavior, which can make that
  behavior more available. Prefer a positive target and retain prohibitions
  only as paired hard guardrails.

## Pruning

How a skill stays lean and maintainable.

- **Single source of truth:** one authoritative home for each meaning.
- **Duplication:** the same meaning in multiple places, increasing tokens,
  maintenance cost, and accidental prominence.
- **Relevance:** whether a line still bears on the skill's current behavior.
- **Sediment:** stale layers that accumulate because adding feels safer than
  deleting.
- **No-op:** an instruction that does not change behavior versus the model's
  default. Settle uncertainty with an ablation, not prose debate.
- **Sprawl:** excessive always-visible material; unlike sediment, every line may
  still be current.

Pruning asks, sentence by sentence: does removing this change routing,
execution, or verification? If not, delete it.
