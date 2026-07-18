import { atom } from 'nanostores'

export type LoopagentStatus = 'blocked' | 'completed' | 'failed' | 'interrupted' | 'queued' | 'running'

export interface LoopagentActivity {
  board?: string
  currentTool?: string
  errorPreview?: string
  id: string
  /** Legacy live-event compatibility only. Canonical grouping uses workflowId. */
  isRootTask?: boolean
  kind: 'task' | 'worker'
  latestTaskEventId?: number
  parentTaskIds: string[]
  profile?: string
  revision?: number
  runId?: number
  sourceEvent: string
  status: LoopagentStatus
  summaryPreview?: string
  taskId: string
  taskStatus?: string
  tenant?: string
  title: string
  updatedAt: number
  workerSessionId?: string
  workflowId?: string
}

export type LoopagentPayload = Record<string, unknown>

export const $loopagentsBySession = atom<Record<string, LoopagentActivity[]>>({})

const TERMINAL: ReadonlySet<LoopagentStatus> = new Set(['completed', 'failed', 'interrupted'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const str = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : [])

const normalized = (value: unknown): string => str(value).toLowerCase().replaceAll('-', '_')

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

const compact = (value: unknown, max = 220): string | undefined => {
  const text = str(value).replace(/\s+/g, ' ')

  if (!text) {
    return undefined
  }

  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

const statusFromPayload = (payload: LoopagentPayload, eventType: string): LoopagentStatus => {
  const worker = record(payload.worker)

  const candidates = [
    payload.status,
    payload.run_status,
    worker.status,
    payload.task_status,
    payload.outcome,
    worker.outcome,
    payload.event,
    eventType
  ]
    .map(normalized)
    .filter(Boolean)

  if (candidates.some(value => ['blocked', 'review_required', 'needs_review', 'needs_approval'].includes(value))) {
    return 'blocked'
  }

  if (
    candidates.some(value =>
      ['failed', 'error', 'crashed', 'gave_up', 'spawn_failed', 'timed_out', 'timeout'].includes(value)
    )
  ) {
    return 'failed'
  }

  if (candidates.some(value => ['interrupted', 'cancelled', 'canceled'].includes(value))) {
    return 'interrupted'
  }

  if (candidates.some(value => ['completed', 'complete', 'done', 'success', 'succeeded', 'ok'].includes(value))) {
    return 'completed'
  }

  if (candidates.some(value => ['queued', 'ready', 'scheduled', 'todo', 'triage'].includes(value))) {
    return 'queued'
  }

  return 'running'
}

const taskIdOf = (payload: LoopagentPayload): string =>
  str(payload.task_id) || str(payload.taskId) || str(payload.id) || str(payload.kanban_task_id)

const runIdOf = (payload: LoopagentPayload): number | undefined => num(payload.run_id) ?? num(payload.runId)

const revisionOf = (payload: LoopagentPayload): number | undefined =>
  num(payload.revision) ?? num(payload.latest_revision) ?? num(payload.latest_task_event_id)

const latestTaskEventIdOf = (payload: LoopagentPayload): number | undefined =>
  num(payload.latest_task_event_id) ?? num(payload.latestTaskEventId)

const kindOf = (payload: LoopagentPayload, eventType: string): 'task' | 'worker' =>
  eventType.includes('.task.') || str(payload.event).includes('.task.') ? 'task' : 'worker'

const idOf = (payload: LoopagentPayload, eventType = ''): string => {
  const taskId = taskIdOf(payload) || 'unknown-task'
  const runId = runIdOf(payload)
  const workerSessionId = str(payload.worker_session_id)
  const kind = kindOf(payload, eventType || str(payload.event))

  if (kind === 'task') {
    return `loopagent:task:${taskId}`
  }

  const suffix = runId !== undefined ? String(runId) : workerSessionId || str(payload.profile) || 'activity'

  return `loopagent:worker:${taskId}:${suffix}`
}

const newerThan = (payload: LoopagentPayload, prev: LoopagentActivity | undefined): boolean => {
  if (!prev) {
    return true
  }

  const revision = revisionOf(payload)
  const latestTaskEventId = latestTaskEventIdOf(payload)

  if (revision !== undefined && prev.revision !== undefined) {
    return revision >= prev.revision
  }

  if (latestTaskEventId !== undefined && prev.latestTaskEventId !== undefined) {
    return latestTaskEventId >= prev.latestTaskEventId
  }

  return true
}

const toActivity = (
  payload: LoopagentPayload,
  prev: LoopagentActivity | undefined,
  eventType: string,
  at: number
): LoopagentActivity | null => {
  const taskId = taskIdOf(payload) || prev?.taskId

  if (!taskId) {
    return null
  }

  const status = statusFromPayload(payload, eventType)
  const task = record(payload.task)
  const worker = record(payload.worker)
  const kind = kindOf(payload, eventType)

  const summaryPreview =
    compact(payload.summary_preview) ??
    compact(payload.safe_summary) ??
    compact(payload.summary) ??
    compact(worker.summary_preview) ??
    compact(worker.summary) ??
    prev?.summaryPreview

  const errorPreview =
    compact(payload.error_preview) ?? compact(payload.error) ?? compact(worker.error_preview) ?? prev?.errorPreview

  const parentTaskIds = strings(payload.parent_task_ids).length
    ? strings(payload.parent_task_ids)
    : strings(task.parent_task_ids).length
      ? strings(task.parent_task_ids)
      : (prev?.parentTaskIds ?? [])

  const workflowId =
    str(payload.workflow_id) || str(task.workflow_id) || str(worker.workflow_id) || prev?.workflowId

  return {
    board: str(payload.board) || prev?.board,
    currentTool:
      str(payload.current_tool) ||
      str(payload.currentTool) ||
      str(payload.tool_name) ||
      str(worker.current_tool) ||
      prev?.currentTool,
    errorPreview,
    id: prev?.id ?? idOf(payload, eventType),
    isRootTask: workflowId
      ? undefined
      : typeof payload.is_root_task === 'boolean'
        ? payload.is_root_task
        : parentTaskIds.length === 0,
    kind,
    latestTaskEventId: latestTaskEventIdOf(payload) ?? prev?.latestTaskEventId,
    parentTaskIds,
    profile: str(payload.profile) || prev?.profile,
    revision: revisionOf(payload) ?? prev?.revision,
    runId: runIdOf(payload) ?? prev?.runId,
    sourceEvent: str(payload.event) || eventType,
    status,
    summaryPreview,
    taskId,
    taskStatus: str(payload.task_status) || str(task.status) || prev?.taskStatus,
    tenant: str(payload.tenant) || prev?.tenant,
    title: str(payload.task_title) || str(payload.title) || str(task.title) || prev?.title || taskId,
    updatedAt: at,
    workerSessionId: str(payload.worker_session_id) || prev?.workerSessionId,
    workflowId
  }
}

export function loopagentSessionKeys(payload: unknown, explicitSessionId?: null | string): string[] {
  const record = isRecord(payload) ? payload : {}

  const keys = [
    explicitSessionId,
    record.current_session_id,
    record.logical_session_id,
    record.source_session_id,
    ...strings(record.lineage_session_ids),
    record.worker_session_id
  ]
    .map(str)
    .filter(Boolean)

  return [...new Set(keys)]
}

export function clearSessionLoopagents(sid: string) {
  const map = $loopagentsBySession.get()

  if (!(sid in map)) {
    return
  }

  const { [sid]: _drop, ...rest } = map
  $loopagentsBySession.set(rest)
}

export function upsertLoopagent(
  sessionIds: readonly string[],
  payload: LoopagentPayload,
  eventType: string,
  createIfMissing = true
) {
  const ids = [...new Set(sessionIds.filter(Boolean))]

  if (ids.length === 0) {
    return
  }

  const map = $loopagentsBySession.get()
  const nextMap = { ...map }
  const at = Date.now()
  let changed = false

  for (const sid of ids) {
    const list = nextMap[sid] ?? []
    const id = idOf(payload, eventType)
    const idx = list.findIndex(item => item.id === id)

    if (idx < 0 && !createIfMissing) {
      continue
    }

    const prev = idx >= 0 ? list[idx] : undefined

    if (!newerThan(payload, prev)) {
      continue
    }

    if (
      prev &&
      TERMINAL.has(prev.status) &&
      revisionOf(payload) === undefined &&
      latestTaskEventIdOf(payload) === undefined
    ) {
      continue
    }

    const next = toActivity(payload, prev, eventType, at)

    if (!next) {
      continue
    }

    nextMap[sid] = idx >= 0 ? list.map(item => (item.id === id ? next : item)) : [...list, next]
    changed = true
  }

  if (changed) {
    $loopagentsBySession.set(nextMap)
  }
}
