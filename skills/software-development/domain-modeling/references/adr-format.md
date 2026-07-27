# Domain ADR Format

Create an ADR only for an approved, consequential decision with real alternatives and durable trade-offs. Do not create one for naming cleanup or an implementation detail that can be reversed cheaply.

```markdown
# ADR-NNN: [Decision]

**Status:** proposed | accepted | superseded
**Date:** YYYY-MM-DD

## Context
[Concrete scenarios, constraints, and domain ambiguity]

## Decision
[Chosen model and why]

## Invariants Affected
- [Rule or transition]

## Alternatives Considered
### [Alternative]
- Benefits:
- Costs:
- Why not selected:

## Consequences
- Positive:
- Negative:
- Migration or compatibility:

## Validation
[Scenario, test, or evidence that will show whether the decision works]
```

The user or project authority owns acceptance. Drafting an ADR is not approval.
