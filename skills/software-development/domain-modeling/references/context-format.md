# Domain Context Format

Merge into the project's established domain document. Preserve unrelated valid content.

```markdown
# Domain Context

## Purpose
[What part of the domain this file describes]

## Ubiquitous Language
| Term | Meaning | Not this | Example |
|---|---|---|---|

## Invariants
- [Checkable rule]

## State Transitions
| Current state | Event / preconditions | Next state | Observable effects |
|---|---|---|---|

## Illegal States or Transitions
- [Combination or transition that must be rejected]

## Relationships and Ownership
- [Direction, multiplicity, owner, lifecycle, consistency]

## Open Questions
- [Unresolved user-owned decision]
```

Keep this model compact. Link to detailed ADRs instead of copying them.
