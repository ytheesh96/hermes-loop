# UI Prototype

Use for unresolved layout, hierarchy, density, or interaction direction. Use the `sketch` skill to generate variants when available.

## Variant rules

- Create 2–4 structurally different variants.
- Reuse the real design system and surrounding page context.
- Prefer an existing route with rendering selected by `?variant=`.
- Use a disposable route only when no natural host exists.
- Keep real data fetching read-only; stub mutations.

## Switcher

Provide a visible floating control with previous/next actions and a clear variant label. Update a shareable URL parameter and support arrow keys without intercepting input, textarea, or contenteditable focus. Gate the switcher and disposable route out of production builds.

## Evaluation

Give each variant a short intent statement. Ask the user to compare information hierarchy, primary affordance, density, and missing context—not color preference alone. Capture the selected direction and why.

Remove losing variants and the switcher from production work. Reimplement the winner with tests and normal error handling.
