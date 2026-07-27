# Architecture Audit Report Patterns

Markdown is canonical.

```markdown
# Architecture Audit: [Scope]

## Scope and Method
- Area and exclusions
- History range or sampled changes
- Graph/file tools and verification method

## Current Map
[Packages, clusters, boundaries, and representative flows]

## Candidate 1: [Name]
**Strength:** Strong | Moderate | Speculative
**Friction:** [Observed cost]
**Evidence:**
- `path:line` or qualified symbol — [finding]
- commit/range or graph path — [finding]
**Hidden decision without an owner:** [policy]
**Smallest move:** [architecture change]
**Deletion test:** [burden or layer that can disappear]
**Risks:** [migration, compatibility, operation]
**Falsifier:** [evidence that would weaken this recommendation]

## Ranked Comparison
[Why candidates differ in evidence and leverage]

## Top Recommendation
[Opinionated recommendation, alternatives, validation sketch, and user-owned decision]
```

## Optional HTML

Generate HTML only when a visual comparison adds value. Derive it from the same canonical content. Use semantic sections, readable typography, accessible contrast, and no invented charts or metrics. Open it with `open_preview` and verify text, links, layout, and responsive behavior before delivery.
