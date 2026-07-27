# Hermes Skill Mechanics

Load this reference when a writing decision reaches Hermes-specific paths,
frontmatter, limits, installation, reload, evaluation, or Git scope. The values
below are grounded in the current Hermes source, not a generic skill format.

## Locations and precedence

- **Active/user-local:** `$HERMES_HOME/skills/<category>/<name>/SKILL.md`
  (normally `~/.hermes/skills/...`). `skill_manage(action="create")` writes
  here.
- **Bundled/in-repo:** `<repo-root>/skills/<category>/<name>/SKILL.md`. These
  files ship with Hermes and should be edited with file tools, tested, staged,
  and committed in the repository.
- The active and bundled trees are separate copies. When a task changes both,
  compare them byte-for-byte after the final edit. Preserve local precedence
  intentionally; an accidental active copy can shadow a bundled skill.

## Current frontmatter contract

`tools/skill_manager_tool.py` and `agent/skill_utils.py` are the sources of
truth.

```yaml
---
name: example-skill
description: Use when a distinct trigger needs this process.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [short, useful, tags]
    related_skills: [existing-skill]
---
```

Hard limits and loader behavior:

- Name: at most 64 characters; lowercase letters, digits, dots, underscores,
  and hyphens; starts with a letter or digit.
- Low-level description limit: 1024 characters.
- New user-local skills created with `skill_manage(action="create")`: a
  stricter 60-character routing budget. Use one sentence, trigger first, ending
  in a period.
- The system skill index truncates descriptions over 60 characters to the first
  57 plus `...`; front-load every branch that must route reliably.
- `SKILL.md`: at most 100,000 characters with a non-empty body.
- Supporting file: at most 1 MiB through the skill manager.
- `version`, `author`, `license`, `platforms`, and `metadata` improve
  portability and provenance even where the low-level validator does not
  require all of them.

Matt Pocock's `disable-model-invocation` field is **not supported** by current
Hermes. Enabled skill descriptions remain model-visible and explicit
`/skill-name` invocation remains available. Treat user-only invocation as a
conceptual design choice, not a frontmatter feature Hermes can currently
enforce. Do not copy an unsupported field and assume it removes context load.

## Authoring operations

| Intent | Operation |
|---|---|
| Create an active personal skill | `skill_manage(action="create", ...)` |
| Patch an active skill | `skill_manage(action="patch", ...)` |
| Rewrite an active skill | `skill_manage(action="edit", ...)` with the full file |
| Add active support material | `skill_manage(action="write_file", ...)` |
| Create or rewrite a bundled skill | `write_file` under `<repo-root>/skills/` |
| Patch a bundled skill | `patch` with an exact, narrow replacement |

Skill-manager support files must live under `references/`, `templates/`,
`scripts/`, or `assets/`. Name a reference for the decision it supports, not
for the session that produced it.

For a bundled change, inspect neighboring skills only to learn real repository
constraints. Peer length and heading patterns are observations, not quotas or
mandatory templates.

## Reload and invocation proof

After adding, deleting, or renaming an active skill:

1. Run `/reload-skills` or call the runtime reload path.
2. Confirm discovery with `skills_list` or exact loading with `skill_view`.
3. Verify the slash command resolves to the intended canonical name.
4. Build or inspect the invocation payload when the skill body itself controls
   routing or tool topology.

`/reload-skills` refreshes runtime skill commands without requiring a fresh
session. A fresh session is still useful when testing the system-prompt index
from a clean context.

## Verification ladder

1. **RED structural test:** encode the behavior contract before rewriting.
2. **Frontmatter:** parse YAML and assert name, trigger-first description,
   provenance, and platform metadata.
3. **Hierarchy:** assert required pointers resolve and stale or duplicated
   patterns stay absent.
4. **Runtime:** reload, discover, explicitly invoke, and inspect the resulting
   payload.
5. **Ablation:** use `skill-evaluation-and-ablation` with positive and nearby
   negative prompts, enabled and disabled conditions, and repeated trials.
6. **Repository:** run focused tests, relevant broader tests, lint, and
   `git diff --check`.
7. **Scope:** stage only the skill, its disclosed files, tests, and evaluators;
   preserve unrelated worktree changes.

A skill is verified when the completion criteria and behavior tests pass, not
when the prose merely looks polished.
