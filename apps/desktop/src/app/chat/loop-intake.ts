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

  if (!rowNeedsIntake(row)) {
    return title ? `Help me with Loop task ${row.taskId}: ${title}` : `Help me with Loop task ${row.taskId}.`
  }

  return [
    `For Loop row ${row.taskId} (${title}): start the graph-first Loop intake path for this slash-created title-only draft.`,
    'Treat this row as the real Loop/Kanban root. Keep it in intake/planning; do not dispatch it or promote planning/options to ready until the user explicitly activates an executable leaf.',
    'Use the Loop graph as the exploration surface, not a prose-only interview. First read the graph with loop_graph. Then create the next decision branch as scheduled option tasks with loop_graph add_node operations so the options are visible in the Loop overview/card UI and detail drawer. Parent each option to the root/current frontier node so the branch stays connected in the graph.',
    'Every option task body must include: Description, Tradeoffs, Recommendation rationale, Dependencies/assumptions, and Likely downstream impact. Put the recommended option first and label it clearly in the title/body.',
    'After the scheduled option tasks exist, call clarify. The clarify choices must match those option tasks, with the recommended option first/labeled. Keep chat light; tell me I can inspect the graph/detail drawers before answering.',
    'When I choose, make the graph lock and clarify choice the same operation: mark the selected option as the chosen/frontier path, delete/archive unchosen sibling option tasks, leave the selected option in the graph, then expand only that selected option into the next scheduled branch.',
    'Do not write a root-body decision ledger or duplicate locked-choice section. The surviving graph path is the durable record: chosen options remain, rejected sibling options are deleted/archived.',
    'Repeat until the frontier is an executable leaf. On origin activation, subscribe/route the origin session first, then move only the executable scheduled leaf to ready; parent completion must not auto-run scheduled planning children.',
    'When a worker re-enters with done, treat it only as candidate completion. Judge it against the root goal, the task criteria, acceptance criteria, and whether it moved the needle; accept, rework, split, or block before advancing the graph.'
  ].join('\n')
}
