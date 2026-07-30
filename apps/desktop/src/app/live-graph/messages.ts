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

export interface LiveGraphMessageThread {
  board: string
  key: string
  latestActivityAt: number
  messages: LiveGraphMessage[]
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
  const visibleTasks = new Map(
    graphNodes
      .filter(node => node.kind === 'task')
      .map(node => [taskKey(node.board || 'default', node.entityId), node] as const)
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

      const taskNode = visibleTasks.get(taskKey(board, taskId))

      byId.set(identity, {
        author: clean(comment.author),
        board,
        body,
        createdAt: createdAt as number,
        id: identity,
        status: normalizeLiveGraphStatus(taskNode?.status || comment.task_status),
        taskId,
        taskTitle: clean(taskNode?.label) || clean(comment.task_title) || taskId,
        workflowId: clean(taskNode?.workflowId) || clean(comment.workflow_id) || null
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

export function groupSessionMessageThreads(
  sourceProfile: string,
  messages: readonly LiveGraphMessage[]
): LiveGraphMessageThread[] {
  const byTask = new Map<string, LiveGraphMessage[]>()

  for (const message of messages) {
    const key = `${sourceProfile}\u0000${boardName(message.board)}\u0000${message.taskId}`
    const grouped = byTask.get(key)

    if (grouped) {
      grouped.push(message)
    } else {
      byTask.set(key, [message])
    }
  }

  return [...byTask.entries()]
    .map(([key, grouped]) => {
      const chronological = [...grouped].sort(
        (left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id)
      )

      const latest = chronological[chronological.length - 1]!

      return {
        board: latest.board,
        key,
        latestActivityAt: latest.createdAt,
        messages: chronological,
        status: latest.status,
        taskId: latest.taskId,
        taskTitle: latest.taskTitle,
        workflowId: latest.workflowId
      }
    })
    .sort(
      (left, right) =>
        right.latestActivityAt - left.latestActivityAt ||
        compareText(left.board, right.board) ||
        compareText(left.taskId, right.taskId) ||
        compareText(left.key, right.key)
    )
}
