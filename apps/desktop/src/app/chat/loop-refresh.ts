import type { TenantLoopSource } from './loop-state'

// Keep active Loop rows live while Kanban workers mutate their backing tasks.
// Status changes are persisted as task_events; polling the session-source endpoint
// is intentionally cheap and updates the composer/drawer through latest_event_id.
export const LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS = 2_000

// Also poll idle session-source results slowly so externally-created Loop rows
// appear without requiring the user to press the manual refresh button.
export const LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS = 10_000

const TERMINAL_TASK_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])
const ACTIVE_RUN_STATUSES = new Set(['claimed', 'in_progress', 'ready', 'running'])

function normalizedStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : ''
}

function needsActiveRefresh(task: NonNullable<TenantLoopSource['tasks']>[number]): boolean {
  const taskStatus = normalizedStatus(task.status)
  const runStatus = normalizedStatus(task.latest_run?.status)

  return (
    !TERMINAL_TASK_STATUSES.has(taskStatus) ||
    ACTIVE_RUN_STATUSES.has(runStatus) ||
    Boolean(task.current_run_id)
  )
}

export function loopSessionSourceRefetchInterval(source?: null | TenantLoopSource): false | number {
  const tasks = source?.tasks || []

  if (!tasks.length) {
    return LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
  }

  return tasks.some(needsActiveRefresh) ? LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS : LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
}
