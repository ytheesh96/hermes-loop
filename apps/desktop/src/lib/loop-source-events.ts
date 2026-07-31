import type { Query, QueryClient, QueryKey } from '@tanstack/react-query'

export interface LoopSourceChangedEvent {
  affected_task_ids?: unknown
  latest_revision?: unknown
  latest_task_event_id?: unknown
  parent_session_id?: unknown
  root_session_id?: unknown
  source_session_id?: unknown
  task_id?: unknown
  worker_session_id?: unknown
}

export function isLoopSourceInvalidationEvent(
  eventType: string | undefined,
  payload: unknown
): payload is LoopSourceChangedEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }

  return (
    eventType === 'loop.source_changed' ||
    eventType === 'kanban.task_event' ||
    Boolean(eventType?.startsWith('kanban.worker.'))
  )
}

interface InvalidateLoopSourceOptions {
  activeProfile?: null | string
  activeSessionIds: readonly (null | string | undefined)[]
  event: LoopSourceChangedEvent
  selectedTaskId?: null | string
}

const isStr = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isStr) : [])

const queryDataRevision = (query: Query): number => {
  const data = query.state.data

  if (!data || typeof data !== 'object') {
    return 0
  }

  const record = data as Record<string, unknown>
  const latestEvent = record.latest_event_id
  const latestRevision = record.latest_revision ?? record.revision

  return isNum(latestRevision) ? latestRevision : isNum(latestEvent) ? latestEvent : 0
}

const eventRevision = (event: LoopSourceChangedEvent): number => {
  const latestRevision = event.latest_revision
  const latestEvent = event.latest_task_event_id

  return isNum(latestRevision) ? latestRevision : isNum(latestEvent) ? latestEvent : 0
}

const profileMatches = (key: QueryKey, activeProfile?: null | string) => {
  if (!activeProfile) {
    return true
  }

  return key[1] === activeProfile
}

const sourceKeyMatches = (key: QueryKey, sessionIds: ReadonlySet<string>) =>
  key[0] === 'loop-session-source' && (sessionIds.size === 0 || (typeof key[2] === 'string' && sessionIds.has(key[2])))

const taskDetailIdFromKey = (key: QueryKey): string => {
  if (key[0] !== 'loop-task-detail') {
    return ''
  }

  // Current detail keys are ['loop-task-detail', profile, board, taskId, revision].
  // Older keys omitted board: ['loop-task-detail', profile, taskId, revision].
  // Accept both shapes so live kanban.comment/task events keep refreshing the
  // focused drawer across upgrades.
  const currentTaskId = key.length >= 5 ? key[3] : key[2]

  return typeof currentTaskId === 'string' ? currentTaskId : ''
}

const taskDetailKeyMatches = (key: QueryKey, affectedTaskIds: ReadonlySet<string>, selectedTaskId?: null | string) => {
  if (key[0] !== 'loop-task-detail') {
    return false
  }

  const taskId = taskDetailIdFromKey(key)

  if (selectedTaskId && taskId === selectedTaskId) {
    return true
  }

  return affectedTaskIds.size === 0 || affectedTaskIds.has(taskId)
}

export async function invalidateLoopSourceFromEvent(
  queryClient: QueryClient,
  { activeProfile, activeSessionIds, event, selectedTaskId }: InvalidateLoopSourceOptions
): Promise<void> {
  const eventLineageIds = [
    event.root_session_id,
    event.parent_session_id,
    event.source_session_id,
    event.worker_session_id
  ].filter(isStr)

  const lineageIds = new Set(eventLineageIds.length ? eventLineageIds : activeSessionIds.filter(isStr))
  const affectedTaskIds = new Set([
    ...strings(event.affected_task_ids),
    ...(isStr(event.task_id) ? [event.task_id] : [])
  ])
  const incomingRevision = eventRevision(event)

  await queryClient.invalidateQueries({
    predicate: query => {
      const key = query.queryKey

      if (!profileMatches(key, activeProfile)) {
        return false
      }

      const sourceMatch = sourceKeyMatches(key, lineageIds)
      const detailMatch = taskDetailKeyMatches(key, affectedTaskIds, selectedTaskId)

      if (!sourceMatch && !detailMatch) {
        return false
      }

      const currentRevision = queryDataRevision(query)

      return incomingRevision <= 0 || currentRevision <= 0 || incomingRevision > currentRevision
    }
  })
}
