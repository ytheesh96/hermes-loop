import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'

export type LoopPanelStatus = 'error' | 'ready' | 'stale'

export interface LoopRow {
  active: boolean
  attention: string
  board: string
  children?: string[]
  depth: number
  frontier: boolean
  handoff?: {
    reason?: string
    summary?: string
  }
  parents: string[]
  rootTaskId: string
  status: string
  taskId: string
  tenant: string
  title: string
  verificationState: string
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

  const handoff = parseRecord(node.handoff)
  const childrenValue = node.children ?? node.dependents

  return {
    active: booleanField(node, 'active'),
    attention: stringField(node, 'attention'),
    board: stringField(node, 'board'),
    children: Array.isArray(childrenValue) ? childrenValue.map(item => String(item)).filter(Boolean) : undefined,
    depth: numberField(node, 'depth'),
    frontier: booleanField(node, 'frontier'),
    handoff: handoff
      ? {
          reason: stringField(handoff, 'reason'),
          summary: stringField(handoff, 'summary') || stringField(handoff, 'resolution_summary')
        }
      : undefined,
    parents: stringArrayField(node, 'parents'),
    rootTaskId: stringField(node, 'root_task_id'),
    status: stringField(node, 'status') || 'triage',
    taskId,
    tenant: stringField(node, 'tenant'),
    title: title || taskId,
    verificationState: stringField(node, 'verification_state')
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

export function loopPanelStateFromResult(resultValue: unknown, args?: unknown): LoopPanelState | null {
  const result = parseRecord(resultValue)

  if (!result) {
    return null
  }

  const status = statusFrom(result)
  const rootTaskId = rootTaskIdFrom(args, result)
  const revision = numberField(result, 'graph_revision') || numberField(result, 'current_revision') || 0
  const rows = rowsFrom(result)

  return {
    message: messageFrom(status, result),
    rawJson: rawJson(result),
    revision,
    rootTaskId,
    rows,
    status
  }
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
