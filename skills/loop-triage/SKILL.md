---
name: loop-triage
description: Turn a rough Loop intake into a live, durable task graph in the foreground. Use when a user invokes Loop Triage or asks the foreground agent to plan evolving Loop work from brief task titles and dependencies.
---

# Loop Triage

Build the smallest useful live graph. Creating a node submits it immediately;
there is no separate graph-level Submit step.

## Ownership

- The foreground agent owns the task titles, dependency topology, and later graph changes.
- The Kanban auto-decomposer owns worker-ready bodies, acceptance criteria, routing, and optional child fan-out.
- The Desktop is the live graph and review surface; the backend database is authoritative.

## Invariants

- Treat every card as an ordinary task. Workflow identity is separate routing
  context, never a privileged root card.
- Stay in the foreground conversation for material product decisions. Do not delegate the interview.
- Create graph fragments atomically with brief titles and dependency aliases only.
- Once a node is created, it may start as soon as its current dependencies allow.
- Modify or archive only pending nodes. Never add a prerequisite to running or completed work; add a corrective or successor node instead.
- Preserve the user's original request in the workflow context.

## Workflow

1. Read the changed task and current workflow graph with `kanban_show` and
   `loop_graph`, including nodes.
2. Resolve facts available from the conversation, repository, or existing task results. Ask only questions whose answers materially change the first executable graph fragment.
3. Choose brief lane titles and actual dependencies. Do not write Objective/Context/Acceptance/Verification sections for every node.
4. Call `delegate_task` once for the fragment with `mode="loop"` and
   batch-local aliases. Loop mode always invokes the auto-decomposer; there is
   no decomposition flag or assignee choice. The foreground turn supplies
   workflow identity internally on re-entry. The first call returns
   `workflow_id`; use that value for graph reads/patches during the originating
   turn:

   ```json
   {
     "mode": "loop",
     "tasks": [
       {"id": "research", "goal": "Research the current implementation"},
       {"id": "implement", "goal": "Implement the selected approach", "depends_on": ["research"]},
       {"id": "verify", "goal": "Verify the workflow end to end", "depends_on": ["implement"]}
     ]
   }
   ```

   Aliases are local to that call. Refer to a node from an earlier fragment by
   its returned durable task id. Do not choose assignees; routing belongs to the
   auto-decomposer.

5. Re-read the graph and verify dependency-free skeletons are specifying while downstream skeletons wait. Do not ask the user to submit the graph.
6. As results arrive, re-read before mutating. Add new nodes with another
   atomic `delegate_task` fragment. Use revision-guarded `loop_graph` patches
   to update pending titles, replace pending parents, or archive obsolete
   pending nodes.
7. Report what is live, what is waiting, and any decision that genuinely needs
   the user. Continue evolving the graph until the workflow objective is
   satisfied.
8. When no more work is needed, re-read the graph. After every current member
   and planning node is terminal/archived, call `loop_graph(action="close")`.
   Closure is guarded and returns the unfinished blockers if the graph is not
   settled. Completing a task never closes the workflow and no synthetic
   closeout card is required.

If a graph mutation fails, re-read its current revision and reconcile. Never bypass dependency validation or convert an unspecific skeleton directly to `ready`.
