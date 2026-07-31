import type { LoopSessionThreadsSource } from '@/app/chat/loop-state'

export interface LiveGraphMessage {
  author: string
  board: string
  body: string
  createdAt: number
  id: string
  kind?: 'reply' | 'root'
  legacyRoot?: boolean
  replyId?: number
  rootTaskId?: string
  status?: string
  taskId: string
  taskTitle: string
  workflowId: null | string
}

export interface LiveGraphMessageThread {
  board: string
  key: string
  latestActivityAt: number
  messages: LiveGraphMessage[]
  rootCreatedAt: number
  rootTaskId: string
  taskTitle: string
  workflowId: null | string
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const boardName = (value: unknown): string => clean(value).toLowerCase() || 'default'
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const compareThreadMessages = (left: LiveGraphMessage, right: LiveGraphMessage): number => {
  if (left.kind !== right.kind) {
    return left.kind === 'root' ? -1 : 1
  }
  return (
    left.createdAt - right.createdAt ||
    (left.replyId ?? 0) - (right.replyId ?? 0) ||
    compareText(left.id, right.id)
  )
}

export function mergeSessionThreadSources(
  previous: readonly LoopSessionThreadsSource[],
  incoming: readonly LoopSessionThreadsSource[]
): LoopSessionThreadsSource[] {
  const merged = new Map(previous.map(source => [boardName(source.board), source] as const))

  for (const delta of incoming) {
    const board = boardName(delta.board)
    const current = merged.get(board)
    const threads = new Map(
      [...(current?.threads || []), ...(delta.threads || [])].map(thread => [thread.root_task_id, thread] as const)
    )
    const replies = new Map(
      [...(current?.replies || []), ...(delta.replies || [])].map(reply => [reply.id, reply] as const)
    )

    merged.set(board, {
      ...current,
      ...delta,
      board,
      latest_reply_id: Math.max(current?.latest_reply_id || 0, delta.latest_reply_id || 0),
      replies: [...replies.values()].sort(
        (left, right) =>
          (left.created_at || 0) - (right.created_at || 0) || left.id - right.id
      ),
      threads: [...threads.values()].sort(
        (left, right) => left.created_at - right.created_at || compareText(left.root_task_id, right.root_task_id)
      )
    })
  }

  return [...merged.values()].sort((left, right) => compareText(left.board, right.board))
}

export function normalizeSessionThreads(
  sourceProfile: string,
  sources: readonly LoopSessionThreadsSource[]
): LiveGraphMessage[] {
  const messages: LiveGraphMessage[] = []

  for (const source of sources) {
    const board = boardName(source.board)
    const roots = new Map((source.threads || []).map(root => [root.root_task_id, root] as const))

    for (const root of roots.values()) {
      const rootTaskId = clean(root.root_task_id)
      const body = typeof root.description === 'string' ? root.description : ''

      if (!rootTaskId || !Number.isInteger(root.created_at)) {
        continue
      }

      messages.push({
        author: '',
        board,
        body,
        createdAt: root.created_at,
        id: `${sourceProfile}\u0000${board}\u0000root\u0000${rootTaskId}`,
        kind: 'root',
        legacyRoot: Boolean(root.legacy_root),
        rootTaskId,
        taskId: rootTaskId,
        taskTitle: clean(root.title) || rootTaskId,
        workflowId: clean(root.workflow_id) || null
      })
    }

    const seenReplies = new Set<number>()
    for (const reply of source.replies || []) {
      const root = roots.get(clean(reply.root_task_id))
      const body = typeof reply.body === 'string' ? reply.body : ''

      if (!root || !Number.isInteger(reply.id) || seenReplies.has(reply.id) || !body.trim()) {
        continue
      }
      seenReplies.add(reply.id)

      const rootTaskId = root.root_task_id
      messages.push({
        author: clean(reply.author),
        board,
        body,
        createdAt: Number.isInteger(reply.created_at) ? (reply.created_at as number) : 0,
        id: `${sourceProfile}\u0000${board}\u0000reply\u0000${reply.id}`,
        kind: 'reply',
        legacyRoot: Boolean(root.legacy_root),
        replyId: reply.id,
        rootTaskId,
        taskId: clean(reply.task_id) || rootTaskId,
        taskTitle: clean(root.title) || rootTaskId,
        workflowId: clean(root.workflow_id) || null
      })
    }
  }

  return messages.sort((left, right) => {
    const rootOrder = compareText(`${left.board}\u0000${left.rootTaskId}`, `${right.board}\u0000${right.rootTaskId}`)
    if (rootOrder !== 0) {
      return rootOrder
    }
    return compareThreadMessages(left, right)
  })
}

export function groupSessionMessageThreads(
  sourceProfile: string,
  messages: readonly LiveGraphMessage[]
): LiveGraphMessageThread[] {
  const byRoot = new Map<string, LiveGraphMessage[]>()

  for (const message of messages) {
    const key = `${sourceProfile}\u0000${boardName(message.board)}\u0000${message.rootTaskId || message.taskId}`
    const grouped = byRoot.get(key)
    if (grouped) {
      grouped.push(message)
    } else {
      byRoot.set(key, [message])
    }
  }

  return [...byRoot.entries()]
    .map(([key, grouped]) => {
      const chronological = [...grouped].sort(compareThreadMessages)
      const root = chronological.find(message => message.kind === 'root') || chronological[0]!
      const latest = chronological[chronological.length - 1]!
      return {
        board: root.board,
        key,
        latestActivityAt: latest.createdAt,
        messages: chronological,
        rootCreatedAt: root.createdAt,
        rootTaskId: root.rootTaskId || root.taskId,
        taskTitle: root.taskTitle,
        workflowId: root.workflowId
      }
    })
    .sort(
      (left, right) =>
        left.rootCreatedAt - right.rootCreatedAt || compareText(left.rootTaskId, right.rootTaskId)
    )
}
