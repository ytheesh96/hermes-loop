import type { LoopRow } from './loop-state'

function rowTitle(row: LoopRow): string {
  return row.title?.trim() || row.taskId
}

export function buildLoopChatDraft(row: LoopRow): string {
  const title = rowTitle(row)

  return title ? `Help me with Loop task ${row.taskId}: ${title}` : `Help me with Loop task ${row.taskId}.`
}

export function buildLoopTriageDraft(row: LoopRow, board?: null | string): string {
  const boardContext = board?.trim() ? ` on Kanban board ${board.trim()}` : ''

  return `/loop-triage Triage Loop root ${row.taskId}${boardContext}: ${rowTitle(row)}`
}
