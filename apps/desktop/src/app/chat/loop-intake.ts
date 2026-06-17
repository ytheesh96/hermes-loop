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
    'Interview me relentlessly about every aspect of this task until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.',
    'Ask exactly one unresolved decision at a time, waiting for feedback before continuing. Asking multiple questions at once is bewildering.',
    'For each question, provide your recommended answer and mark the recommended option inline.',
    'If a question can be answered by exploring the codebase, repo state, session history, or existing task facts, explore those sources instead of asking me.',
    'Do not make hidden product decisions or draft implementation promises before I answer.',
    'Before asking the next follow-up after I answer, write each locked decision into the canonical task body under Resolved decisions, and keep assumptions/open questions current.'
  ].join('\n')
}
