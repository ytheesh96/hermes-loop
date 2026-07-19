import { atom } from 'nanostores'

import type { SubagentStreamEntry } from './subagents'

export type LoopagentStatus = 'blocked' | 'completed' | 'failed' | 'interrupted' | 'queued' | 'running'

export interface LoopagentActivity {
  board?: string
  currentTool?: string
  endedAt?: number
  errorPreview?: string
  filesWritten?: string[]
  id: string
  /** Legacy live-event compatibility only. Canonical grouping uses workflowId. */
  isRootTask?: boolean
  kind: 'task' | 'worker'
  latestTaskEventId?: number
  parentTaskIds: string[]
  profile?: string
  revision?: number
  runId?: number
  sequence?: number
  sourceEvent: string
  startedAt?: number
  status: LoopagentStatus
  stream?: SubagentStreamEntry[]
  summaryPreview?: string
  taskId: string
  taskStatus?: string
  tenant?: string
  title: string
  toolCount?: number
  updatedAt: number
  workerSessionId?: string
  workflowId?: string
}

export type LoopagentPayload = Record<string, unknown>

export const $loopagentsBySession = atom<Record<string, LoopagentActivity[]>>({})

const TERMINAL: ReadonlySet<LoopagentStatus> = new Set(['completed', 'failed', 'interrupted'])
const MAX_STREAM = 24
const TOOL_PREVIEW_MAX = 96

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

  const workerCandidates = [payload.status, payload.run_status, worker.status, payload.outcome, worker.outcome].filter(
    Boolean
  )

  const candidates = [
    ...(kindOf(payload, eventType) === 'worker' && workerCandidates.length > 0
      ? workerCandidates
      : [payload.status, payload.task_status, payload.outcome]),
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

const sequenceOf = (payload: LoopagentPayload): number | undefined => num(payload.sequence)

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

  const sequence = sequenceOf(payload)

  if (sequence !== undefined && prev.sequence !== undefined) {
    return sequence > prev.sequence
  }

  return true
}

const timestampMs = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const numeric = num(value)

    if (numeric !== undefined) {
      return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000
    }

    const text = str(value)
    const parsed = text ? Date.parse(text) : Number.NaN

    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

const toolLabel = (name: string): string =>
  name
    .split('_')
    .filter(Boolean)
    .map(part => part[0]!.toUpperCase() + part.slice(1))
    .join(' ') || name

const formatTool = (name: string, preview = ''): string => {
  const snippet = compact(preview, TOOL_PREVIEW_MAX)

  return snippet ? `${toolLabel(name)}("${snippet}")` : toolLabel(name)
}

const appendStream = (stream: SubagentStreamEntry[], entry: SubagentStreamEntry): SubagentStreamEntry[] => {
  const last = stream.at(-1)

  if (last?.kind === entry.kind && last.text === entry.text && last.isError === entry.isError) {
    return stream
  }

  return [...stream, entry].slice(-MAX_STREAM)
}

const activityEntriesFromPayload = (
  payload: LoopagentPayload,
  status: LoopagentStatus,
  eventType: string,
  at: number
): SubagentStreamEntry[] => {
  const entries: SubagentStreamEntry[] = []
  const source = normalized(str(payload.event) || eventType)
  const tool = str(payload.tool_name) || str(payload.current_tool) || str(payload.currentTool)
  const toolContext = compact(payload.tool_context, TOOL_PREVIEW_MAX)
  const toolPreview = compact(payload.tool_preview, TOOL_PREVIEW_MAX)
  const progress = compact(payload.progress_text)
  const thinking = compact(payload.text)
  const exitCode = num(payload.exit_code)
  const toolFailed = payload.success === false || (exitCode !== undefined && exitCode !== 0)
  const toolStarted = source.endsWith('tool_start') || eventType.endsWith('tool_start')
  const heartbeat = source.endsWith('heartbeat') || eventType.endsWith('heartbeat')

  if (tool && (toolContext || toolStarted || (heartbeat && !progress && !toolPreview))) {
    entries.push({ at, kind: 'tool', text: formatTool(tool, toolContext) })
  }

  if (progress) {
    const current = num(payload.progress_current)
    const total = num(payload.progress_total)
    const unit = str(payload.unit)
    const count = current !== undefined && total !== undefined ? ` · ${current}/${total}${unit ? ` ${unit}` : ''}` : ''

    entries.push({ at, kind: 'progress', text: `${progress}${count}` })
  }

  if (thinking && (source.endsWith('thinking') || typeof payload.redacted === 'boolean')) {
    entries.push({ at, kind: 'thinking', text: thinking })
  }

  if (tool && toolPreview) {
    entries.push({ at, isError: toolFailed, kind: 'tool', text: formatTool(tool, toolPreview) })
  }

  const error =
    compact(payload.error_preview) ??
    compact(payload.error) ??
    (status === 'blocked' ? compact(payload.block_reason) : undefined)

  if (error && (toolFailed || status === 'blocked' || status === 'failed' || status === 'interrupted')) {
    entries.push({ at, isError: true, kind: 'summary', text: error })
  } else if (TERMINAL.has(status) || status === 'blocked') {
    const summary =
      compact(payload.safe_summary) ??
      compact(payload.safe_preview) ??
      compact(payload.summary_preview) ??
      compact(payload.summary)

    if (summary) {
      entries.push({ at, isError: status !== 'completed', kind: 'summary', text: summary })
    }
  }

  return entries
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
  const eventAt = timestampMs(payload.created_at) ?? at

  const stream = activityEntriesFromPayload(payload, status, eventType, eventAt).reduce(
    appendStream,
    prev?.stream ?? []
  )

  const summaryPreview =
    compact(payload.summary_preview) ??
    compact(payload.safe_summary) ??
    compact(payload.safe_preview) ??
    compact(payload.block_reason) ??
    compact(payload.summary) ??
    compact(worker.summary_preview) ??
    compact(worker.summary) ??
    prev?.summaryPreview

  const errorPreview =
    compact(payload.error_preview) ??
    compact(payload.error) ??
    compact(worker.error_preview) ??
    (status === 'blocked' ? compact(payload.block_reason) : undefined) ??
    prev?.errorPreview

  const parentTaskIds = strings(payload.parent_task_ids).length
    ? strings(payload.parent_task_ids)
    : strings(task.parent_task_ids).length
      ? strings(task.parent_task_ids)
      : (prev?.parentTaskIds ?? [])

  const workflowId =
    str(payload.workflow_id) || str(task.workflow_id) || str(worker.workflow_id) || prev?.workflowId

  const filesWritten = strings(payload.changed_files_preview).length
    ? strings(payload.changed_files_preview)
    : strings(worker.changed_files_preview).length
      ? strings(worker.changed_files_preview)
      : (prev?.filesWritten ?? [])

  const sourceEvent = str(payload.event) || eventType
  const toolStarted = sourceEvent.endsWith('tool_start') || eventType.endsWith('tool_start')

  return {
    board: str(payload.board) || prev?.board,
    currentTool:
      str(payload.current_tool) ||
      str(payload.currentTool) ||
      str(payload.tool_name) ||
      str(worker.current_tool) ||
      prev?.currentTool,
    endedAt: timestampMs(payload.ended_at, worker.ended_at) ?? prev?.endedAt,
    errorPreview,
    filesWritten,
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
    sequence: sequenceOf(payload) ?? prev?.sequence,
    sourceEvent,
    startedAt:
      prev?.startedAt ?? timestampMs(payload.started_at, worker.started_at, payload.created_at) ?? at,
    status,
    stream,
    summaryPreview,
    taskId,
    taskStatus: str(payload.task_status) || str(task.status) || prev?.taskStatus,
    tenant: str(payload.tenant) || prev?.tenant,
    title: str(payload.task_title) || str(payload.title) || str(task.title) || prev?.title || taskId,
    toolCount: (prev?.toolCount ?? 0) + (toolStarted ? 1 : 0),
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
