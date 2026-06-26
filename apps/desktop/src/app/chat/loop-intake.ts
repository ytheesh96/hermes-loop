import type { LoopRow } from './loop-state'

function rowTitle(row: LoopRow): string {
  return row.title?.trim() || row.taskId
}

function rowNeedsIntake(row: LoopRow): boolean {
  const intake = row.loopIntake

  if (!intake?.needed) {
    return false
  }

  const state = (intake.state || '').trim().toLowerCase()

  return intake.dispatchable !== true && !['spec-ready', 'spec_ready', 'approved'].includes(state)
}

export function buildLoopChatDraft(row: LoopRow): string {
  const title = rowTitle(row)

  if (row.planningNode) {
    return [
      `For Loop planning node ${row.taskId} (${title}): inspect the visible planning details and help me decide the next step.`,
      'This is a lightweight planning node, not a dispatchable Kanban task. Do not block, archive, promote, or submit it as a task row.',
      'If I explicitly activate this leaf, synthesize the selected decisions and node details into a self-contained durable work packet, then create real execution with delegate_task(mode="loop", assignee=<real profile>, board=<current board>, goal=..., context=...).',
      'After delegate_task returns a real execution task id, record/reference that id on the planning node/root with loop_graph (execution_task_id) so the planning graph points at the actual work.'
    ].join('\n')
  }

  if (!rowNeedsIntake(row)) {
    return title ? `Help me with Loop task ${row.taskId}: ${title}` : `Help me with Loop task ${row.taskId}.`
  }

  return [
    `For Loop row ${row.taskId} (${title}): start the graph-first Loop intake path for this slash-created title-only draft.`,
    'Treat this row as the real Loop/Kanban root. Keep it in intake/planning; do not dispatch it or promote planning/options to ready until the user explicitly activates an executable leaf.',
    'Use the Loop graph as the exploration surface, not a prose-only interview. First read the graph with loop_graph. Then create the next decision branch as lightweight planning nodes with loop_graph add_node operations so the options are visible in the Loop overview/card UI and detail drawer without creating scheduled Kanban tasks. Parent each option to the root/current frontier node so the branch stays connected in the visual graph.',
    'Every planning node body must include: Description, Tradeoffs, Recommendation rationale, Dependencies/assumptions, and Likely downstream impact. Put the recommended option first and label it clearly in the title/body.',
    'After the planning nodes exist, call clarify. The clarify choices must match those planning nodes, with the recommended option first/labeled. Keep chat light; tell me I can inspect the graph/detail drawers before answering.',
    'When I choose, make the graph lock and clarify choice the same operation: mark the selected planning node as chosen so it can be carried into the eventual dispatch packet, delete/archive unchosen sibling planning nodes, then expand only that selected option into the next lightweight planning branch.',
    'Do not write a root-body decision ledger, duplicate locked-choice section, or keep prior locked options visible in the default graph. The dispatched task packet will carry the locked choices; the visible graph should stay focused on the current open branch plus real execution tasks.',
    'Repeat until the frontier is an executable leaf. On explicit origin activation, subscribe/route the origin session first, synthesize the selected graph path into a self-contained work packet, then call delegate_task(mode="loop") to create the real durable execution task. Do not promote planning nodes to ready and do not create task_links prerequisites from planning edges.',
    'After delegate_task returns, record/reference the real execution task id on the selected planning node/root with loop_graph execution_task_id so the visual plan links to actual work.',
    'When a worker re-enters with done, treat it only as candidate completion. Judge it against the root goal, the task criteria, acceptance criteria, and whether it moved the needle; accept, rework, split, or block before advancing the graph.'
  ].join('\n')
}
