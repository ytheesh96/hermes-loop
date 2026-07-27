# Design It Twice Packet

Use for consequential interface choices.

## Frame

Record the capability, representative callers, constraints, dependencies, domain vocabulary, and what each option must hide. Include a small caller sketch only to make constraints concrete.

## Independent alternatives

Create at least two genuinely different designs. Parallel `delegate_task` lanes can optimize for different constraints:

- minimal surface and maximum leverage,
- flexibility across established use cases,
- trivial common-case calling path,
- explicit ports and adapters at a real boundary.

Each lane returns:

1. interface types and operations,
2. ordering, invariants, and error modes,
3. caller example,
4. hidden implementation decisions,
5. dependency and adapter strategy,
6. strongest and weakest trade-off.

## Comparison

Compare depth, locality, seam placement, testability, evolvability, and failure semantics. Verify designs against real callers. Present a recommendation, alternatives, and unresolved user-owned decisions. Do not implement during comparison.
