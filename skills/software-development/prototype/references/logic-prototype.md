# Logic Prototype

Use for state transitions, business rules, data shape, or API feel.

## Shape

Put decision logic behind one small pure interface:

- reducer: `(state, action) -> state`,
- explicit state machine,
- pure transformation functions, or
- narrow stateful module when ongoing state is essential.

Keep the interactive shell separate. The shell may render state and dispatch actions; the logic must not perform terminal or browser I/O.

## Interaction loop

1. Initialize in-memory state.
2. Render current state and legal actions.
3. Read one action.
4. Apply it through the pure interface.
5. Render the full state again.
6. Repeat until quit.

Use the host project's runtime and task runner. Provide one command. Do not add a package manager solely for the prototype.

## Verdict

Drive the motivating edge scenarios. Record what became possible, impossible, or surprising. If logic is selected for production, implement it through TDD rather than copying the shell or treating prototype behavior as production proof.
