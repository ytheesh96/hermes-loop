import type { LoopRow } from './loop-state'

export const LOOP_TERMINAL_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])

export const LOOP_FAILED_STATUSES = new Set([
  'blocked',
  'crashed',
  'error',
  'failed',
  'failure',
  'stale',
  'timed_out',
  'timeout'
])

export function normalizedLoopValue(value?: null | string): string {
  return (value || '').trim().toLowerCase().replaceAll('-', '_')
}

export function isDoneLoopRow(row: LoopRow): boolean {
  return LOOP_TERMINAL_STATUSES.has(normalizedLoopValue(row.status))
}

export function isPanelActiveLoopRow(row: LoopRow): boolean {
  const status = normalizedLoopValue(row.status)

  return (
    (row.activeDecompositionChildCount || 0) > 0 ||
    status === 'claimed' ||
    status === 'running' ||
    status === 'in_progress'
  )
}

export function isGraphActiveLoopRow(row: LoopRow): boolean {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)

  return row.active || status === 'running' || status === 'in_progress' || runStatus === 'running'
}

export function loopAttentionText(row: LoopRow): string {
  return [
    row.status,
    row.title,
    row.body,
    row.result,
    row.latestSummary,
    row.latestRun?.error,
    row.latestRun?.outcome,
    row.latestRun?.status,
    row.latestRun?.summary,
    row.reviewKind,
    row.resumeMode,
    row.reviewSubjectAssignee
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
}

export const loopTextValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export const loopToolLabel = (name: string): string =>
  name
    .split('_')
    .filter(Boolean)
    .map(part => part[0]!.toUpperCase() + part.slice(1))
    .join(' ') || name

export const loopRecordFrom = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export function currentToolFromLoopRecord(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined
  }

  for (const key of ['current_tool', 'currentTool', 'current_tool_name', 'tool_name', 'active_tool', 'last_tool']) {
    const value = loopTextValue(record[key])

    if (value) {
      return loopToolLabel(value)
    }
  }

  return undefined
}

export function loopWorkerCurrentTool(row: LoopRow): string | undefined {
  const worker = row.workerActivity
  const direct = currentToolFromLoopRecord(worker ? (worker as unknown as Record<string, unknown>) : null)

  if (direct) {
    return direct
  }

  for (const event of (worker?.recent_task_events || []).slice().reverse()) {
    const fromPayload = currentToolFromLoopRecord(loopRecordFrom(event.payload))

    if (fromPayload) {
      return fromPayload
    }
  }

  return currentToolFromLoopRecord(loopRecordFrom(row.latestRun?.metadata))
}
