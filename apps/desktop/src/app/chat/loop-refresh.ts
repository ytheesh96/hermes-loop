import type { TenantLoopSource } from './loop-state'

// Keep active Loop rows live while Kanban workers mutate their backing tasks.
// Status changes are persisted as task_events; polling the session-source endpoint
// is intentionally cheap and updates the composer/drawer through latest_event_id.
export const LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS = 2_000

// Also poll empty session-source results slowly so externally-created Loop rows
// appear without requiring the user to press the manual refresh button.
export const LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS = 10_000

export function loopSessionSourceRefetchInterval(source?: null | TenantLoopSource): number {
  return source?.tasks?.length ? LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS : LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
}
