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
    `For Loop row ${row.taskId} (${title}): start the grill-me Loop intake path for this slash-created title-only draft.`,
    'Use the durable loop_intake state on the row as the trigger, ask exactly one unresolved decision at a time, and mark the recommended option inline in the A/B/C choice text.',
    'Use retrievable repo/session/task facts when available; do not make hidden product decisions or draft implementation promises before I answer.',
    'Before asking any follow-up after I answer, write each locked decision into the canonical task body under Resolved decisions, keeping assumptions/open questions current.',
    'leave the row triage/non-dispatchable until I explicitly approve Decompose or activation.'
  ].join('\n')
}
