import type { LoopSessionCommentsSource } from '@/app/chat/loop-state'

import type { LiveGraphNode } from './model'
import { normalizeLiveGraphStatus } from './model'

export interface LiveGraphMessage {
  author: string
  board: string
  body: string
  createdAt: number
  id: string
  status: string
  taskId: string
  taskTitle: string
  workflowId: null | string
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const boardName = (value: unknown): string => clean(value).toLowerCase() || 'default'
const taskKey = (board: string, taskId: string): string => `${boardName(board)}\u0000${taskId}`
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export function normalizeSessionMessages(
  sourceProfile: string,
  sources: readonly LoopSessionCommentsSource[],
  graphNodes: readonly LiveGraphNode[]
): LiveGraphMessage[] {
  const visibleTasks = new Set(
    graphNodes.filter(node => node.kind === 'task').map(node => taskKey(node.board || 'default', node.entityId))
  )

  const byId = new Map<string, LiveGraphMessage>()

  for (const source of sources) {
    const board = boardName(source.board)

    for (const comment of source.comments || []) {
      const id = comment.id
      const createdAt = comment.created_at
      const taskId = clean(comment.task_id)
      const body = typeof comment.body === 'string' ? comment.body : ''

      if (
        !Number.isInteger(id) ||
        !Number.isInteger(createdAt) ||
        !taskId ||
        !body.trim() ||
        !visibleTasks.has(taskKey(board, taskId))
      ) {
        continue
      }

      const identity = `${sourceProfile}\u0000${board}\u0000${id}`

      if (byId.has(identity)) {
        continue
      }

      byId.set(identity, {
        author: clean(comment.author),
        board,
        body,
        createdAt: createdAt as number,
        id: identity,
        status: normalizeLiveGraphStatus(comment.task_status),
        taskId,
        taskTitle: clean(comment.task_title) || taskId,
        workflowId: clean(comment.workflow_id) || null
      })
    }
  }

  return [...byId.values()].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      compareText(a.board, b.board) ||
      compareText(a.taskId, b.taskId) ||
      Number(a.id.slice(a.id.lastIndexOf('\u0000') + 1)) - Number(b.id.slice(b.id.lastIndexOf('\u0000') + 1))
  )
}
