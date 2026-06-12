import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'

export type LoopPanelStatus = 'error' | 'ready' | 'stale'

export interface LoopRow {
  active: boolean
  depth: number
  frontier: boolean
  parents: string[]
  status: string
  taskId: string
  title: string
}

export interface LoopPanelState {
  message: string
  rawJson: string
  revision: number
  rootTaskId: string
  rows: LoopRow[]
  status: LoopPanelStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value
  }

  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value)

    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]

  return typeof value === 'string' ? value : ''
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? n : 0
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]

  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : []
}

function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function rootTaskIdFrom(args: unknown, result: Record<string, unknown>): string {
  return stringField(result, 'root_task_id') || stringField(parseRecord(args) || {}, 'root_task_id')
}

function rowFromNode(value: unknown): LoopRow | null {
  const node = parseRecord(value)

  if (!node) {
    return null
  }

  const taskId = stringField(node, 'task_id') || stringField(node, 'id')
  const title = stringField(node, 'title')

  if (!taskId || !title) {
    return null
  }

  return {
    active: booleanField(node, 'active'),
    depth: numberField(node, 'depth'),
    frontier: booleanField(node, 'frontier'),
    parents: stringArrayField(node, 'parents'),
    status: stringField(node, 'status') || 'triage',
    taskId,
    title: title || taskId
  }
}

function rowsFrom(result: Record<string, unknown>): LoopRow[] {
  const nodes = result.nodes

  if (!Array.isArray(nodes)) {
    return []
  }

  return nodes.map(rowFromNode).filter((row): row is LoopRow => Boolean(row))
}

function statusFrom(result: Record<string, unknown>): LoopPanelStatus {
  if (result.ok !== false) {
    return 'ready'
  }

  return stringField(result, 'error') === 'stale_revision' ? 'stale' : 'error'
}

function messageFrom(status: LoopPanelStatus, result: Record<string, unknown>): string {
  if (status === 'ready') {
    return ''
  }

  return stringField(result, 'message') || stringField(result, 'error') || 'Loop graph update failed'
}

function loopToolParts(messages: readonly ChatMessage[]): Extract<ChatMessagePart, { type: 'tool-call' }>[] {
  return messages.flatMap(message =>
    message.parts.filter(
      (part): part is Extract<ChatMessagePart, { type: 'tool-call' }> =>
        part.type === 'tool-call' && part.toolName === 'loop_graph' && part.result !== undefined
    )
  )
}

export function deriveLoopPanelState(messages: readonly ChatMessage[]): LoopPanelState | null {
  let state: LoopPanelState | null = null

  for (const part of loopToolParts(messages)) {
    const result = parseRecord(part.result)

    if (!result) {
      continue
    }

    const status = statusFrom(result)

    const previousState = state
    const rootTaskId: string = rootTaskIdFrom(part.args, result) || previousState?.rootTaskId || ''

    const revision: number =
      numberField(result, 'graph_revision') || numberField(result, 'current_revision') || previousState?.revision || 0

    const nextRows = rowsFrom(result)

    if (status === 'ready') {
      state = {
        message: '',
        rawJson: rawJson(result),
        revision,
        rootTaskId,
        rows: nextRows,
        status
      }

      continue
    }

    state = {
      message: messageFrom(status, result),
      rawJson: rawJson(result),
      revision: state?.revision || revision,
      rootTaskId,
      rows: state?.rows || [],
      status
    }
  }

  return state
}
