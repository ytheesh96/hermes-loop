# Loop Skeleton Graph Compilation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let the foreground agent create a durable Loop graph using only brief task titles and dependency aliases, while the existing Kanban auto-decomposer specifies or decomposes each node before execution.

**Architecture:** Treat foreground-authored rows as durable skeleton tasks, not worker-ready specifications. Persist the graph atomically, mark skeletons as needing specification, and route each dependency-satisfied skeleton through the existing `triage` decomposer. Preserve each skeleton as a stable fan-in shell when it expands; propagate its external prerequisites to the generated entry tasks so decomposition cannot bypass the original graph.

**Tech Stack:** Python 3.11, SQLite/WAL Kanban DB, FastAPI plugin API, Hermes tool registry, React/TypeScript Desktop, pytest, Vitest.

---

## Repository state and evidence

The plan targets `/Users/yt/.hermes/hermes-agent` on `main` at `6cdd8486bd794b1085691ca453d3ec612d3741c1`.

The working tree already contains uncommitted Loop Triage/Submit work in:

- `hermes_cli/kanban_db.py`
- `hermes_cli/kanban_decompose.py`
- `plugins/kanban/dashboard/plugin_api.py`
- `tools/loop_tools.py`
- Desktop Loop files
- the untracked `skills/loop-triage/`

Do not reset or overwrite this work. Before implementation, checkpoint it separately or work in a stable worktree after explicit user approval.

Baseline verification performed during planning:

- Backend target suite: **213 passed**, one warning.
- Desktop target suite: **121 passed**.
- Desktop emitted one pre-existing React missing-key warning in the Loop graph test.

Two live DB reproductions confirmed the architectural gap:

1. A downstream `triage` row is returned by `list_triage_ids()` even while its parent remains `scheduled`.
2. If `A -> B` and `B` decomposes to entry child `B1`, the current DB result is `B1.status == "ready"` with `B1_parents == []` while `A` is still `scheduled`.

## Current code path

1. `tools/delegate_tool.py:_loop_batch_specs` validates aliases, dependencies, assignees and cycles.
2. `tools/delegate_tool.py:_loop_delegation_result` creates every batch row separately through `tools.loop_tools._handle_loop_create`.
3. `tools/loop_tools.py:_handle_loop_create` commits and pokes the dispatcher once per row.
4. `hermes_cli/kanban_db.py:create_task` forces every `triage=True` task into `triage`, regardless of unfinished parents.
5. `gateway/kanban_watchers.py:_auto_decompose_tick` decomposes every row returned by `kanban_decompose.list_triage_ids`.
6. `hermes_cli/kanban_decompose.py:decompose_task` only sees the row title/body and profile roster.
7. `hermes_cli/kanban_db.py:decompose_triage_task` creates an internal child DAG and links its leaves back to the shell, but does not copy the shell's pre-existing parents to internal entry tasks.
8. `hermes_cli/kanban_db.py:recompute_ready` can only promote waiting work to `ready`; it cannot route a dependency-satisfied skeleton to `triage`.

## Locked behavior

A foreground call should be this small:

```python
delegate_task(
    mode="loop",
    decompose=True,
    root_task_id="t_existing_root",  # optional outside Desktop Loop
    tasks=[
        {"id": "research", "goal": "Research the current implementation"},
        {
            "id": "implement",
            "goal": "Implement the selected approach",
            "depends_on": ["research"],
        },
        {
            "id": "verify",
            "goal": "Verify the workflow end to end",
            "depends_on": ["implement"],
        },
    ],
)
```

In this mode, `goal` is the brief task title. Per-node `context`, `assignee`, acceptance criteria, workspace policy and child graphs are not required. `decompose=True` is the batch-level mode switch, not content the foreground must repeat on every row.

Required invariants:

1. Graph validation and insertion are atomic.
2. Skeleton tasks are never claimable by a worker.
3. Entry skeletons compile first; downstream skeletons compile after their parents finish.
4. The decomposer may specify in place or expand into a child DAG.
5. If `A -> B` and `B` expands, every internal entry child inherits `A` as a parent.
6. Existing outgoing edges stay attached to the stable `B` shell.
7. Normal manually-created triage cards and non-decomposed Loop delegation remain backward compatible.
8. Durable graph size is not limited by ephemeral `delegation.max_concurrent_children`; it gets a separate bounded Loop graph limit.
9. Full foreground transcript inheritance is out of scope. Use the existing Loop root/shared request plus compact direct-parent handoffs.

## Task 1: Add failing contract and dependency-safety tests

**Objective:** Lock the desired semantics before changing production code.

**Files:**

- Modify: `tests/tools/test_delegate_loop_mode.py`
- Modify: `tests/hermes_cli/test_kanban_db.py`
- Modify: `tests/hermes_cli/test_kanban_decompose_db.py`
- Modify: `tests/hermes_cli/test_kanban_decompose.py`

**Step 1: Add foreground-contract tests**

Add tests proving that `mode="loop", decompose=True` accepts title/dependency-only batch rows without an assignee and creates no running task.

```python
def test_loop_skeleton_batch_needs_only_titles_and_dependencies(...):
    out = json.loads(delegate_tool.delegate_task(
        mode="loop",
        decompose=True,
        tasks=[
            {"id": "a", "goal": "Research constraints"},
            {"id": "b", "goal": "Implement the choice", "depends_on": ["a"]},
        ],
        parent_agent=DummyParent(),
    ))
    assert "error" not in out
    assert all(item["needs_specification"] for item in out["items"])
```

Add a rollback test where the final node is invalid and assert that zero rows and links remain.

**Step 2: Add readiness tests**

Add a DB test asserting:

```python
assert get_task(conn, downstream).status == "todo"
complete_task(conn, upstream, summary="done")
recompute_ready(conn)
assert get_task(conn, downstream).status == "triage"
```

Add a fan-in case proving that two parents must both finish before the skeleton enters `triage`.

**Step 3: Add fanout boundary tests**

Create `A -> B`, decompose `B`, and assert every generated entry task has `A` as a parent and remains non-ready until `A` is done. Also assert generated leaves still point to `B` and `B` keeps its outgoing edge to a downstream task.

**Step 4: Run the tests and verify RED**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/tools/test_delegate_loop_mode.py \
  tests/hermes_cli/test_kanban_db.py \
  tests/hermes_cli/test_kanban_decompose_db.py \
  tests/hermes_cli/test_kanban_decompose.py
```

Expected: failures for missing skeleton state, assignee requirement, wrong readiness transition, non-atomic creation and dependency leakage.

**Step 5: Commit**

```bash
git add tests/tools/test_delegate_loop_mode.py tests/hermes_cli/test_kanban_db.py \
  tests/hermes_cli/test_kanban_decompose_db.py tests/hermes_cli/test_kanban_decompose.py
git commit -m "test(loop): define skeleton graph compilation semantics"
```

## Task 2: Add first-class skeleton specification state

**Objective:** Make unspecific tasks queryable and structurally impossible to dispatch.

**Files:**

- Modify: `hermes_cli/kanban_db.py`
- Test: `tests/hermes_cli/test_kanban_db.py`

**Step 1: Extend the task schema**

Add a backward-compatible column and dataclass field:

```python
needs_specification: bool = False
```

```sql
needs_specification INTEGER NOT NULL DEFAULT 0
```

Update the schema migration, `Task.from_row`, `create_task`, and task inserts. Existing rows must backfill to `0`.

**Step 2: Route dependency-satisfied skeletons to triage**

Change `recompute_ready` to select `needs_specification` and choose the next status:

```python
next_status = "triage" if row["needs_specification"] else "ready"
```

Emit `specification_requested` when a skeleton moves to triage. Preserve existing failure-limit and parent-done guards.

**Step 3: Add a claim-time invariant**

Before the ready-to-running CAS in `claim_task`, reject any row with `needs_specification=1`, move it to `triage`, and append `claim_rejected` with reason `needs_specification`. This protects against manual status edits and races.

**Step 4: Clear the flag only on successful compilation**

Update both `specify_triage_task` and `decompose_triage_task` to atomically set `needs_specification=0` when their DB mutation succeeds. Failures leave the row in triage with the flag intact.

**Step 5: Run focused tests and verify GREEN**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/hermes_cli/test_kanban_db.py \
  tests/hermes_cli/test_kanban_decompose_db.py
```

Expected: new readiness/claim tests pass; existing tests remain green.

**Step 6: Commit**

```bash
git add hermes_cli/kanban_db.py tests/hermes_cli/test_kanban_db.py \
  tests/hermes_cli/test_kanban_decompose_db.py
git commit -m "feat(loop): add durable skeleton specification state"
```

## Task 3: Preserve external dependencies across decomposition

**Objective:** Make decomposed children obey the original skeleton boundary.

**Files:**

- Modify: `hermes_cli/kanban_db.py:decompose_triage_task`
- Test: `tests/hermes_cli/test_kanban_decompose_db.py`

**Step 1: Capture the shell boundary before adding internal links**

At the start of the write transaction, capture the root's existing incoming parents. These are the external prerequisites supplied by the foreground graph.

```python
external_parent_ids = parent_ids(conn, task_id)
```

**Step 2: Identify internal entry and exit tasks**

Reuse the validated `internal_parents` map. Entry indices have no internal parents; exit indices are not referenced as a parent by another generated task.

**Step 3: Propagate the boundary**

After creating child rows and internal links, add:

```python
for entry_index in entry_indices:
    for parent_id in external_parent_ids:
        _link_tasks_no_txn(conn, parent_id, child_ids[entry_index])

for exit_index in exit_indices:
    _link_tasks_no_txn(conn, child_ids[exit_index], task_id)
```

Keep the original external-parent-to-shell edge and all shell-to-downstream edges. The shell remains a stable aggregate/audit node.

**Step 4: Verify fan-out, fan-in and nested cases**

Cover:

- one external parent and one entry;
- two external parents and two parallel entries;
- an internal fan-in;
- decomposition of a Loop child under a real Loop root;
- no duplicate edge events on retry;
- cycle rejection remains atomic.

**Step 5: Run tests**

```bash
uv run --extra dev pytest -q -o addopts='' tests/hermes_cli/test_kanban_decompose_db.py
```

Expected: all tests pass and no generated entry task is ready while an external parent is unfinished.

**Step 6: Commit**

```bash
git add hermes_cli/kanban_db.py tests/hermes_cli/test_kanban_decompose_db.py
git commit -m "fix(loop): preserve dependency gates through decomposition"
```

## Task 4: Add one atomic skeleton-graph creation service

**Objective:** Replace per-row Loop creation with a single validated transaction.

**Files:**

- Modify: `hermes_cli/kanban_db.py`
- Modify: `tools/loop_tools.py`
- Test: `tests/tools/test_loop_tools.py`
- Test: `tests/tools/test_delegate_loop_mode.py`

**Step 1: Define an internal node contract**

Use one normalized internal shape:

```python
{
    "client_id": "research",
    "title": "Research constraints",
    "depends_on": [],
}
```

The service may also receive one shared root request/context, workspace defaults, source session, tenant, board, proof packet, optional `root_task_id`, and `hold_for_review`.

**Step 2: Validate before opening the transaction**

Validate:

- non-empty unique aliases and titles;
- every alias dependency exists;
- external task IDs exist on the requested board;
- no self-links or cycles;
- node count does not exceed `loop.max_graph_nodes` (recommended default: 32);
- an optional `root_task_id` exists and is a Loop root on the same board.

Do not apply `delegation.max_concurrent_children` to durable Loop graphs.

**Step 3: Insert rows and links in one write transaction**

Add a core function such as:

```python
def create_loop_skeleton_graph(
    conn,
    *,
    nodes,
    root_task_id=None,
    shared_context=None,
    session_id=None,
    tenant=None,
    workspace_kind="scratch",
    workspace_path=None,
    hold_for_review=False,
    idempotency_scope=None,
) -> SkeletonGraphResult:
    ...
```

Insert every skeleton with `needs_specification=1`. Use `scheduled` when held for review; otherwise use `todo` and call `recompute_ready` after commit so entry nodes become `triage` and downstream nodes stay `todo`.

If a real Loop root is supplied:

- inherit its session, tenant, workspace and root request;
- set each row's `created_by` to `loop:<root_task_id>`;
- link every skeleton sink to the root shell;
- keep the root as the single foreground subscription/completion boundary.

Use stable idempotency keys derived from root/session scope plus `client_id`, so a retried tool call returns the same graph rather than duplicating it.

**Step 4: Poke the dispatcher only after commit**

Move dispatcher notification and foreground subscription setup outside the transaction. Poke once for the completed graph, not once per node.

**Step 5: Add atomicity tests**

Test a valid three-node chain, replay idempotency, external dependencies, missing parent rollback, cycle rollback, root provenance, and failure in the final node. Every failed case must leave zero new tasks and links.

**Step 6: Run tests**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/tools/test_loop_tools.py \
  tests/tools/test_delegate_loop_mode.py
```

Expected: graph insertion is all-or-nothing and the dispatcher is poked exactly once.

**Step 7: Commit**

```bash
git add hermes_cli/kanban_db.py tools/loop_tools.py \
  tests/tools/test_loop_tools.py tests/tools/test_delegate_loop_mode.py
git commit -m "feat(loop): create skeleton graphs atomically"
```

## Task 5: Make `delegate_task(mode="loop")` model-facing input minimal

**Objective:** Let the foreground agent author only topology and brief titles.

**Files:**

- Modify: `tools/delegate_tool.py`
- Modify: `agent/prompt_builder.py`
- Test: `tests/tools/test_delegate_loop_mode.py`

**Step 1: Split direct durable execution from skeleton graph mode**

Preserve the current path when `decompose=False`: it still requires an assignee and creates worker-ready durable work.

When `decompose=True`:

- interpret each `goal` as a brief title;
- do not require per-node assignee or context;
- ignore/deprecate per-node `decompose` overrides;
- call the atomic graph service once;
- allow optional `root_task_id` for an existing Desktop Loop root;
- retain aliases and `depends_on` exactly.

**Step 2: Move the durable-mode branch before the ephemeral child-count guard**

Today the generic `max_concurrent_children` check runs before the Loop branch. Apply that limit only to ephemeral subagents. Enforce the separate bounded Loop graph limit in the graph service.

**Step 3: Correct the tool schema**

Update `DELEGATE_TASK_SCHEMA` so it states:

- `decompose=True` applies to all batch skeleton rows;
- `goal` is a brief title in Loop skeleton mode;
- `assignee` is optional because the decomposer routes compiled work;
- `root_task_id` attaches the graph to an existing Loop root;
- detailed per-task context is optional and normally omitted.

Keep the current field names for compatibility; do not introduce a second parallel graph JSON schema.

**Step 4: Update foreground guidance**

Change the orchestration prompt to say:

> For Loop graph delegation, provide brief task titles and dependency aliases only. The triage compiler owns detailed specifications, routing and child decomposition.

**Step 5: Verify backward compatibility**

Add tests for:

- old direct single Loop delegation;
- old fully specified batch delegation with `decompose=False`;
- new title/dependency-only skeleton batch;
- graph larger than ephemeral concurrency but smaller than `loop.max_graph_nodes`;
- optional existing Loop root;
- output payload includes graph IDs, edges and specification state.

**Step 6: Run tests**

```bash
uv run --extra dev pytest -q -o addopts='' tests/tools/test_delegate_loop_mode.py tests/tools/test_delegate.py
```

Expected: direct mode remains compatible; skeleton mode accepts the minimal graph contract.

**Step 7: Commit**

```bash
git add tools/delegate_tool.py agent/prompt_builder.py tests/tools/test_delegate_loop_mode.py
git commit -m "feat(delegation): accept title-only Loop skeleton graphs"
```

## Task 6: Give the existing decomposer graph-aware, just-in-time context

**Objective:** Reuse the current triage compiler while preventing speculative downstream specifications.

**Files:**

- Modify: `hermes_cli/kanban_decompose.py`
- Modify: `hermes_cli/kanban_db.py`
- Test: `tests/hermes_cli/test_kanban_decompose.py`

**Step 1: Build compact compiler context**

Add a helper that renders only:

- the skeleton title and any shared root request;
- the canonical Loop root title/body when present;
- direct parent titles and statuses;
- completed parent run summaries/result metadata;
- immediate downstream skeleton titles, to prevent overlapping scope;
- the existing profile roster.

Reuse the bounded parent-result logic in `kanban_db.build_worker_context` rather than copying the full foreground transcript.

**Step 2: Enforce just-in-time compilation**

A skeleton with unfinished parents must remain `todo` and must not appear in `list_triage_ids`. Once all parents finish, `recompute_ready` routes it to `triage`, and the normal gateway auto-decomposer claims it on a later tick.

Ordinary user-created triage cards remain immediately compilable.

**Step 3: Preserve both decomposer outcomes**

For `fanout=false`, atomically update title/body/assignee, clear `needs_specification`, set `todo`, and recompute. For `fanout=true`, create worker-complete children, clear the shell flag, preserve boundary links, and set the shell to `todo`.

On malformed output, missing auxiliary model or API failure, leave the skeleton in `triage` with `needs_specification=1`; append an auditable failure event and create no child task.

**Step 4: Test the prompt and transition**

Mock the auxiliary client and assert that the downstream compiler request includes completed parent summaries but not unrelated sibling histories or the full foreground conversation. Test a single-task result, a fanout result, failure/retry, and multiple completed parents.

**Step 5: Run tests**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/hermes_cli/test_kanban_decompose.py \
  tests/hermes_cli/test_kanban_decompose_db.py
```

Expected: all compilation outcomes preserve graph gates and failure atomicity.

**Step 6: Commit**

```bash
git add hermes_cli/kanban_decompose.py hermes_cli/kanban_db.py \
  tests/hermes_cli/test_kanban_decompose.py tests/hermes_cli/test_kanban_decompose_db.py
git commit -m "feat(loop): compile skeleton tasks just in time"
```

## Task 7: Integrate existing Loop roots and the explicit Submit gate

**Objective:** Let Desktop planning create a title/dependency skeleton under the current root and activate it safely.

**Files:**

- Modify: `tools/loop_tools.py`
- Modify: `plugins/kanban/dashboard/plugin_api.py`
- Modify: `tests/tools/test_loop_tools.py`
- Modify: `tests/plugins/test_kanban_dashboard_plugin.py`

**Step 1: Reuse the current root instead of creating competing roots**

When `root_task_id` is supplied, verify it with `_loop_root_for_task`, inherit its root/session metadata, and mark every skeleton row `created_by="loop:<root_task_id>"`. Do not create a second synthetic root.

**Step 2: Record a reviewable skeleton state**

For Desktop-created graphs, insert all skeletons as `scheduled`, keep the root's intake state non-dispatchable, and return the title/dependency graph for preview. The foreground does not have to write complete bodies before this state.

When the Loop root already has scheduled title-only task descendants and `task_links`, `loop_graph action="triage"` must treat those rows as the canonical skeleton graph. Compile or mark those existing task IDs in place; preserve their links and do not ask the decomposer to replace the root with a duplicate set of children. If a skeleton is further decomposed, keep that existing task ID as its stable shell.

Add the existing skeleton titles, IDs, and dependency edges to the decomposer input so its output can be mapped back deterministically. Reject an output that references an unknown or duplicate existing ID without mutating the graph.

**Step 3: Update activation**

Extend `_activate_planned_loop` so Submit:

1. atomically changes scheduled skeletons and the root shell to `todo`;
2. marks the root intake approved/dispatchable;
3. calls `recompute_ready` once;
4. yields `triage` for dependency-free skeletons and `todo` for downstream skeletons;
5. never promotes an unspecific row to `ready`.

Keep the existing `loop_safe=True` pre-decomposition path only as an explicit preview option, not as the required foreground graph-authoring path.

**Step 4: Test activation and idempotency**

Cover one-node, chain, fanout/fan-in, repeated Submit, invalid root, cross-board rejection, and zero worker runs before Submit.

**Step 5: Run tests**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/tools/test_loop_tools.py \
  tests/plugins/test_kanban_dashboard_plugin.py
```

Expected: scheduled graphs stay inert before Submit; after Submit only entry skeletons enter triage.

**Step 6: Commit**

```bash
git add tools/loop_tools.py plugins/kanban/dashboard/plugin_api.py \
  tests/tools/test_loop_tools.py tests/plugins/test_kanban_dashboard_plugin.py
git commit -m "feat(loop): activate scheduled skeleton graphs safely"
```

## Task 8: Simplify foreground Triage and show compilation state in Desktop

**Objective:** Make the product surface match the minimal foreground contract.

**Files:**

- Modify: `skills/loop-triage/SKILL.md`
- Modify: `apps/desktop/src/app/chat/loop-intake.ts`
- Modify: `apps/desktop/src/app/chat/loop-state.ts`
- Modify: `apps/desktop/src/app/chat/loop-panel.tsx`
- Modify: `apps/desktop/src/app/chat/loop-task-graph.tsx`
- Modify: `apps/desktop/src/app/chat/use-loop-panel-controller.ts`
- Test: `apps/desktop/src/app/chat/loop-intake.test.ts`
- Test: `apps/desktop/src/app/chat/use-loop-panel-controller.test.tsx`
- Test: `apps/desktop/src/app/chat/loop-panel.test.tsx`

**Step 1: Rewrite the foreground skill boundary**

Remove the requirement that foreground Triage inspect the codebase and write Objective/Context/Acceptance/Verification for every row. Its responsibility becomes:

1. capture the root request and locked user decisions once;
2. emit brief lane titles and dependency aliases;
3. create the scheduled skeleton graph under the existing root;
4. show the topology for review;
5. stop at the Submit gate.

The auto-decomposer owns all worker-ready specifications and routing after activation.

**Step 2: Expose specification state**

Because `_task_dict` uses `asdict(task)`, the backend field will flow through automatically after the dataclass change. Add `needs_specification` to `TenantLoopTask` and `needsSpecification` to `LoopRow`.

Make assignee optional when creating a title-only skeleton in `LoopTaskGraphCreateNode`; routing belongs to the auto-decomposer. Retain explicit assignee selection only as an advanced override for already-specified work.

Render clear states:

- `scheduled + needsSpecification`: **Planned skeleton**;
- `todo + needsSpecification`: **Waiting for dependencies**;
- `triage + needsSpecification`: **Specifying**;
- `needsSpecification=false`: normal task statuses.

**Step 3: Keep the graph focused after expansion**

Do not delete shell rows. In the graph projection, collapse a decomposed shell into a group boundary by default and draw effective edges from its external parents to generated entries and from generated exits to downstream tasks. The detail drawer retains the shell, audit events and original title.

**Step 4: Update action copy**

Use **Plan graph** for foreground topology construction and **Submit** for activation. Avoid implying that the foreground agent must fully specify every card.

**Step 5: Run Desktop tests**

```bash
cd apps/desktop
npx vitest run --project ui \
  src/app/chat/loop-intake.test.ts \
  src/app/chat/use-loop-panel-controller.test.tsx \
  src/app/chat/loop-panel.test.tsx \
  src/hermes.test.ts
npm run typecheck
```

Expected: all tests pass; skeleton/compiling/waiting states render correctly; no dispatch mutation occurs before Submit.

**Step 6: Commit**

```bash
git add skills/loop-triage/SKILL.md apps/desktop/src/app/chat/
git commit -m "feat(desktop): surface Loop skeleton compilation"
```

## Task 9: Run end-to-end regression and document the contract

**Objective:** Verify the complete workflow and make the new boundary durable.

**Files:**

- Modify: `docs/` or the existing Loop developer documentation discovered during implementation
- Modify: `skills/loop-triage/SKILL.md` if final behavior differs from Task 8
- Test: all focused files listed above

**Step 1: Add an end-to-end backend test**

Exercise this complete sequence without a real LLM:

1. atomically create `A -> B -> C` as title-only skeletons;
2. mock the decomposer so `A` specifies in place;
3. complete `A`;
4. assert `B` moves to triage with `A`'s handoff context;
5. mock `B` fanout to `B1 -> B2`;
6. assert `A -> B1 -> B2 -> B` and `B -> C`;
7. complete `B1`, `B2`, and `B`;
8. assert `C` enters triage, never ready before specification;
9. assert only the root completion boundary notifies the foreground.

**Step 2: Run focused backend regression**

```bash
uv run --extra dev pytest -q -o addopts='' \
  tests/tools/test_delegate_loop_mode.py \
  tests/tools/test_loop_tools.py \
  tests/hermes_cli/test_kanban_db.py \
  tests/hermes_cli/test_kanban_decompose.py \
  tests/hermes_cli/test_kanban_decompose_db.py \
  tests/plugins/test_kanban_dashboard_plugin.py
```

Expected: all focused tests pass.

**Step 3: Run Desktop regression**

```bash
cd apps/desktop
npx vitest run --project ui \
  src/app/chat/loop-intake.test.ts \
  src/app/chat/use-loop-panel-controller.test.tsx \
  src/app/chat/loop-panel.test.tsx \
  src/hermes.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass. Fix the existing Loop graph missing-key warning if the touched render path still emits it.

**Step 4: Run static checks on touched Python**

```bash
uv run --extra dev ruff check \
  tools/delegate_tool.py tools/loop_tools.py agent/prompt_builder.py \
  hermes_cli/kanban_db.py hermes_cli/kanban_decompose.py \
  plugins/kanban/dashboard/plugin_api.py
```

Expected: no new lint failures.

**Step 5: Perform a live disposable-board smoke test**

Use a temporary board and a mock/stub auxiliary client. Verify the visible status sequence:

```text
scheduled skeleton -> todo waiting -> triage specifying
-> ready/running compiled work -> done
```

Verify that no skeleton task is ever claimed directly and that decomposed entry tasks retain upstream parent links.

**Step 6: Document the model contract**

Document one canonical example using only `id`, brief `goal`, and `depends_on`. State clearly that assignee, detailed body, acceptance criteria and child DAGs belong to the auto-decomposer.

**Step 7: Commit**

```bash
git add docs/ skills/loop-triage/SKILL.md
git commit -m "docs(loop): define skeleton graph compilation contract"
```

## Acceptance checklist

- [ ] Foreground batch nodes require only brief titles and dependencies.
- [ ] Skeleton mode does not require per-node assignees or detailed context.
- [ ] The entire graph and its edges are created atomically.
- [ ] Durable graph size is independent of ephemeral subagent concurrency.
- [ ] Entry skeletons compile first; downstream skeletons compile only after all parents finish.
- [ ] Completed parent handoffs are included in downstream compiler context.
- [ ] In-place specification and fanout decomposition both work.
- [ ] External dependency gates are propagated to generated entry tasks.
- [ ] Skeleton shells remain stable audit/fan-in boundaries.
- [ ] A skeleton cannot be claimed even after a manual/racy `ready` write.
- [ ] Decomposer failures leave a retryable triage row and create no partial children.
- [ ] Existing manual triage and direct durable delegation remain compatible.
- [ ] Existing Desktop Loop root is reused; no competing root is introduced.
- [ ] Scheduled Desktop graphs remain inert until Submit.
- [ ] Expanded shell nodes are collapsed in the default graph projection but remain available in details.
- [ ] Focused Python and Desktop suites pass.

## Recommended implementation order

Implement Tasks 1-6 first as one backend slice. That alone fixes the foreground delegation contract and the dependency leak. Then integrate the current uncommitted Desktop Triage/Submit work in Tasks 7-8. Finish with Task 9 only after both backend and Desktop behavior are stable.

## Deliberate non-goals

Do not add hidden recursive worker delegation, copy full chat history into descendants, or let execution workers create arbitrary children. Do not replace the existing decomposer with a second planner. Do not delete lightweight `loop_plan_nodes`; they still serve interview/option planning and are separate from executable skeleton tasks. Root-wide token/cost accounting is valuable follow-up work but is not required to fix this graph-authoring boundary.
