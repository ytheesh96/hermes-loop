# Design QA — Graph View Worker Session Feed

## Source of truth

- Source visual truth: `/var/folders/53/xfcnshdj7tg8k1cp5x48vr4r0000gn/T/codex-clipboard-0d705c25-7c3a-4323-91b5-6ef6efd26c7c.png`
- Implementation screenshot, task prompt and expanded session controls: `/Users/yt/.codex/visualizations/2026/07/27/019fa1bb-159b-7030-9109-443b91ffcd9c/worker-session-feed-live-reasoning.jpeg`
- Implementation screenshot, terminal worker result: `/Users/yt/.codex/visualizations/2026/07/27/019fa1bb-159b-7030-9109-443b91ffcd9c/worker-session-feed-live-bottom.jpeg`
- Source viewport: 2974 × 1964 px, dark theme, full session workspace
- Implementation viewport: 1172 × 768 px, light theme, 336 px Graph View inspector
- State: completed Kanban worker session `20260726_221916_8cf0f7`, Activity selected

## Visual comparison

- Hierarchy: the Activity tab now reads like the source session timeline: a task prompt leads into chronological assistant reasoning, tool activity, and the terminal assistant result.
- Typography: the inspector reuses Hermes' existing user-message, Markdown, compact disclosure, and tool-title treatments at the inspector's smaller type scale.
- Spacing: each chronological item has a distinct vertical rhythm, while tool previews remain compact enough to scan in the narrow feed.
- Color and tokens: the implementation deliberately keeps the active Hermes theme and Graph View surface tokens instead of copying the reference's dark full-workspace palette.
- Assets: existing Codicons and canonical tool icons provide the same semantic cues as the main session without introducing image assets.
- Copy and content: persisted task/user rows, system notices when present, assistant Markdown, reasoning, tool details, and timestamps are retained. Only rows already marked hidden by the persisted transcript contract remain omitted.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Expected difference: the reference is a full session workspace with composer and file browser, while the implementation is intentionally a read-only session feed inside a narrow Graph View inspector.

## Comparison history

1. The first live attempt exposed a stalled local backend and remained on `Loading session activity…`.
2. Restarting the isolated development app restored the default and `research-worker` profile backends.
3. The completed worker session then loaded all 79 persisted messages. The task prompt, Thinking disclosure, tool disclosure, scrolling, and terminal assistant result were verified live.

## Interaction checks

- Activity loads the worker session rather than duplicating the latest-summary card: passed.
- Persisted task/user content remains visible at the start of the feed: passed.
- Thinking disclosures expand and reveal reasoning text: passed.
- Tool rows expand and reveal structured Markdown details without horizontal clipping: passed.
- The feed scrolls through the full worker history to the final assistant result and run history: passed.
- All, Comments, Activity, and Details remain separate inspector filters: passed.

final result: passed
