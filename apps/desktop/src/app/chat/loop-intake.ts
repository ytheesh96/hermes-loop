import type { LoopRow } from './loop-state'

type LoopTaskReference = Pick<LoopRow, 'taskId' | 'title'>

function rowTitle(row: LoopTaskReference): string {
  return row.title?.trim() || row.taskId
}

export function buildLoopChatDraft(row: LoopRow): string {
  const title = rowTitle(row)

  return title ? `Help me with Loop task ${row.taskId}: ${title}` : `Help me with Loop task ${row.taskId}.`
}

export function buildLoopTriageDraft(row: LoopTaskReference, board?: null | string): string {
  const boardContext = board?.trim() ? ` on Kanban board ${board.trim()}` : ''

  return `/loop-triage Triage Loop workflow task ${row.taskId}${boardContext}: ${rowTitle(row)}`
}
