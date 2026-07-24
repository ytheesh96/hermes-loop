import { atom, computed } from 'nanostores'

import {
  currentToolFromLoopRecord,
  loopRecordFrom,
  loopToolLabel,
  loopWorkerCurrentTool
} from '@/app/chat/loop-selectors'
import {
  type LoopWorkerActivity,
  type LoopWorkflowRef,
  loopWorkflowRefKey,
  normalizeLoopBoard,
  type TenantLoopSource,
  type TenantLoopTask
} from '@/app/chat/loop-state'
import type { StatusIndicatorKind } from '@/components/chat/status-indicator'
import { translateNow } from '@/i18n'
import { stableArray } from '@/lib/stable-array'
import type { TodoItem, TodoStatus } from '@/lib/todos'

import { $gateway } from './gateway'
import { $loopagentsBySession, type LoopagentActivity } from './loopagents'
import { dispatchNativeNotification } from './native-notifications'
import { notifyError } from './notifications'
import { $sessionStates } from './session-states'
import { $subagentsBySession, type SubagentProgress } from './subagents'
import { $todosBySession } from './todos'

/** Composer status stack feed — merged todos, Kanban, subagents, background per session. */
export type StatusItemState = 'done' | 'failed' | 'running'
export type StatusItemType = 'background' | 'kanban-agent' | 'subagent' | 'todo'

export interface ComposerStatusItem {
  /** Structured activity retained for the Spawn tree; never raw worker logs. */
  activity?: SubagentProgress['stream']
  /** background: non-zero exit shown inline when failed. */
  exitCode?: number
  /** subagent/Loop task: secondary status label shown on the right. */
  currentTool?: string
  id: string
  /** background process: captured stdout/stderr tail for the inline viewer. */
  output?: string
  /** Kanban/Loop task id. Row click focuses the durable task in the Loop side panel. */
  kanbanTaskId?: string
  /** Owning board for board-aware workflow/task routing. */
  kanbanBoard?: string
  /** Canonical Loop workflow identity used to merge snapshot and live-event summaries. */
  kanbanWorkflowId?: string
  /** Kanban worker run id for the durable agent row. */
  runId?: number
  /** Actual worker run start, used by the Spawn tree timer. */
  startedAt?: number
  /** subagent: its own stored session id — ordinary subagent and Loop worker
   *  rows open read-only watch surfaces (ordinary children in a window,
   *  Loop workers in a tab backed by their durable transcript). Workflow/task
   *  rows still prefer kanbanTaskId so the user lands on the Loop canvas/task
   *  first. */
  sessionId?: string
  state: StatusItemState
  /** Shared leading glyph grammar for Loop/Kanban rows. */
  statusIndicator?: StatusIndicatorKind
  /** Aggregate task progress carried by a single Loop workflow summary row. */
  taskProgress?: { blocked: number; completed: number; pending: number; total: number }
  title: string
  /** Number of structured tool starts observed for this worker run. */
  toolCount?: number
  /** todo: the full four-state status driving the row's checkmark glyph. */
  todoStatus?: TodoStatus
  type: StatusItemType
  /** Last semantic worker update or heartbeat. */
  updatedAt?: number
  /** assignee profile name (e.g. coder, researcher) */
  profile?: string
}

// Writable source for background work, synced from the gateway's process
// registry (`terminal(background=true)` spawns) via `process.list`.
export const $backgroundStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})
export const $selectedLoopWorkflowBySession = atom<Record<string, string>>({})

export function composerStatusWorkflowRef(item: ComposerStatusItem): LoopWorkflowRef | null {
  const workflowId = item.kanbanWorkflowId || item.kanbanTaskId

  return workflowId ? { board: normalizeLoopBoard(item.kanbanBoard), workflowId } : null
}

export function selectLoopWorkflowForSession(sessionId: string, workflow: LoopWorkflowRef | string) {
  const ref = typeof workflow === 'string' ? { board: 'default', workflowId: workflow } : workflow

  if (!sessionId || !ref.workflowId) {
    return
  }

  $selectedLoopWorkflowBySession.set({
    ...$selectedLoopWorkflowBySession.get(),
    [sessionId]: loopWorkflowRefKey(ref)
  })
}

// Durable Loop/Kanban activity derived from the kanban dashboard session-source
// payload. Task rows project as todos; active worker rows join the Subagents
// composer group so Loopagent stays an implementation detail.
export const $kanbanStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})

// Stored session ids that have at least one RUNNING background process. The
// sidebar row reads this for a pulsing gray dot — distinct from the accent
// pulse of an active LLM turn — so the user can tell at a glance "this session
// has something chugging along in the background" even when the turn is idle.
//
// $backgroundStatusBySession is keyed by RUNTIME session id (gateway events
// and process.list both speak that); the sidebar row knows only the STORED id.
// $sessionStates bridges the two: runtime id → state.storedSessionId.
// Perf: recomputes on every $sessionStates change (message deltas, tens/sec),
// but the background-running set rarely moves. `stableArray` keeps the prior
// reference when unchanged so rows reading this don't re-render per token.
let backgroundRunningIds: readonly string[] = []
export const $backgroundRunningSessionIds = computed([$backgroundStatusBySession, $sessionStates], (bg, states) => {
  const ids = new Set<string>()

  for (const [runtimeId, items] of Object.entries(bg)) {
    if (items.some(i => i.state === 'running')) {
      const storedId = states[runtimeId]?.storedSessionId

      if (storedId) {
        ids.add(storedId)
      }
    }
  }

  return (backgroundRunningIds = stableArray(backgroundRunningIds, [...ids]))
})

// Rows the user X-ed away. The registry keeps finished processes around for a
// while, so without this every refresh would resurrect a dismissed row.
const dismissedBySession = new Map<string, Set<string>>()

// Finished tasks self-clear so the stack only ever holds running work. Success
// goes quick; failure lingers longer so its exit code stays readable (the output
// also lives in the transcript). A manual X still drops either at once.
const SUCCESS_LINGER_MS = 4_000
const FAILURE_LINGER_MS = 12_000
const autoClearTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

function scheduleAutoDismiss(sid: string, id: string, delayMs: number) {
  let timers = autoClearTimers.get(sid)

  if (timers?.has(id)) {
    return
  }

  if (!timers) {
    timers = new Map()
    autoClearTimers.set(sid, timers)
  }

  timers.set(
    id,
    setTimeout(() => {
      autoClearTimers.get(sid)?.delete(id)
      dismissBackgroundProcess(sid, id)
    }, delayMs)
  )
}

function cancelAutoDismiss(sid: string, id: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  const timer = timers.get(id)

  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function cancelAllAutoDismiss(sid: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  for (const timer of timers.values()) {
    clearTimeout(timer)
  }

  autoClearTimers.delete(sid)
}

const subToItem = (s: SubagentProgress): ComposerStatusItem => ({
  currentTool: s.currentTool,
  id: s.id,
  sessionId: s.sessionId,
  state: 'running',
  title: s.goal,
  type: 'subagent'
})

const todoToItem = (t: TodoItem): ComposerStatusItem => ({
  id: `todo:${t.id}`,
  state: t.status === 'in_progress' ? 'running' : 'done',
  title: t.content,
  todoStatus: t.status,
  type: 'todo'
})

const ACTIVE_KANBAN_TASK_STATUSES = new Set(['claimed', 'in_progress', 'running'])
const PENDING_KANBAN_TASK_STATUSES = new Set(['queued', 'ready', 'scheduled', 'todo'])
const DONE_KANBAN_TASK_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])

const FAILED_KANBAN_RUN_STATES = new Set([
  'blocked',
  'crashed',
  'error',
  'failed',
  'gave_up',
  'interrupted',
  'spawn_failed',
  'timed_out',
  'timeout'
])

const normalized = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase().replaceAll('-', '_') : ''

const textValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const needsAttentionText = (text: string): boolean =>
  text.includes('review-required') ||
  text.includes('review required') ||
  text.includes('human approval') ||
  text.includes('needs approval')

const kanbanIdBoardScope = (board?: null | string): string => {
  const normalizedBoard = normalizeLoopBoard(board)

  return normalizedBoard === 'default' ? '' : `${encodeURIComponent(normalizedBoard)}:`
}

const taskAttentionText = (task: TenantLoopTask): string =>
  [
    task.status,
    task.title,
    task.body,
    task.result,
    task.latest_summary,
    task.latest_run?.summary,
    task.latest_run?.outcome
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()

const taskNeedsAttention = (task: TenantLoopTask): boolean => {
  const status = normalized(task.status)
  const runStatus = normalized(task.latest_run?.status)
  const runOutcome = normalized(task.latest_run?.outcome)
  const text = taskAttentionText(task)

  return (
    status === 'blocked' ||
    FAILED_KANBAN_RUN_STATES.has(status) ||
    FAILED_KANBAN_RUN_STATES.has(runStatus) ||
    FAILED_KANBAN_RUN_STATES.has(runOutcome) ||
    needsAttentionText(text)
  )
}

const taskIsActive = (task: TenantLoopTask): boolean => {
  const status = normalized(task.status)
  const runStatus = normalized(task.latest_run?.status)

  return (
    ACTIVE_KANBAN_TASK_STATUSES.has(status) ||
    ACTIVE_KANBAN_TASK_STATUSES.has(runStatus) ||
    Boolean(task.current_run_id)
  )
}

const taskIsDone = (task: TenantLoopTask): boolean => DONE_KANBAN_TASK_STATUSES.has(normalized(task.status))

const taskIsTriage = (task: TenantLoopTask): boolean => normalized(task.status) === 'triage'

const kanbanTaskProgress = (tasks: readonly TenantLoopTask[]): NonNullable<ComposerStatusItem['taskProgress']> =>
  tasks.reduce<NonNullable<ComposerStatusItem['taskProgress']>>(
    (progress, task) => {
      if (taskNeedsAttention(task)) {
        progress.blocked += 1
      } else if (taskIsDone(task)) {
        progress.completed += 1
      } else {
        progress.pending += 1
      }

      progress.total += 1

      return progress
    },
    { blocked: 0, completed: 0, pending: 0, total: 0 }
  )

const workerAttentionText = (worker: LoopWorkerActivity): string =>
  [
    worker.summary,
    worker.summary_preview,
    worker.error,
    worker.error_preview,
    worker.outcome,
    worker.status,
    worker.task_status
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()

const workerNeedsForegroundAttention = (worker: LoopWorkerActivity): boolean => {
  const status = normalized(worker.status)
  const outcome = normalized(worker.outcome)
  const text = workerAttentionText(worker)

  if (workerIsActive(worker)) {
    return false
  }

  return (
    status === 'blocked' ||
    outcome === 'blocked' ||
    FAILED_KANBAN_RUN_STATES.has(status) ||
    FAILED_KANBAN_RUN_STATES.has(outcome) ||
    needsAttentionText(text)
  )
}

const workerIsActive = (worker: LoopWorkerActivity): boolean => {
  const status = normalized(worker.status)
  const taskStatus = normalized(worker.task_status)

  return ACTIVE_KANBAN_TASK_STATUSES.has(status) || (!status && ACTIVE_KANBAN_TASK_STATUSES.has(taskStatus))
}

const workerStatusIndicator = (worker: LoopWorkerActivity): StatusIndicatorKind => {
  const status = normalized(worker.status)
  const outcome = normalized(worker.outcome)
  const text = workerAttentionText(worker)

  if (workerIsActive(worker)) {
    return 'active'
  }

  if (needsAttentionText(text)) {
    return 'attention'
  }

  if (
    status === 'blocked' ||
    outcome === 'blocked' ||
    FAILED_KANBAN_RUN_STATES.has(status) ||
    FAILED_KANBAN_RUN_STATES.has(outcome)
  ) {
    return 'failed'
  }

  return 'done'
}

const kanbanWorkerState = (worker: LoopWorkerActivity): StatusItemState => {
  if (workerNeedsForegroundAttention(worker)) {
    return 'failed'
  }

  if (workerIsActive(worker)) {
    return 'running'
  }

  return 'done'
}

const epochMs = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  return value >= 1_000_000_000_000 ? value : value * 1000
}

const kanbanWorkerActivity = (worker: LoopWorkerActivity): SubagentProgress['stream'] => {
  const entries: SubagentProgress['stream'] = []

  for (const event of worker.recent_task_events ?? []) {
    const tool = currentToolFromLoopRecord(loopRecordFrom(event.payload))

    if (!tool || entries.at(-1)?.text === tool) {
      continue
    }

    entries.push({
      at: epochMs(event.created_at) ?? Date.now(),
      kind: 'tool',
      text: tool
    })
  }

  return entries.slice(-8)
}

const kanbanWorkerUpdatedAt = (worker: LoopWorkerActivity): number | undefined => {
  const recent = (worker.recent_task_events ?? [])
    .map(event => epochMs(event.created_at))
    .filter((value): value is number => value !== undefined)

  return (
    epochMs(worker.ended_at) ??
    epochMs(worker.last_heartbeat_at) ??
    (recent.length > 0 ? Math.max(...recent) : undefined) ??
    epochMs(worker.started_at)
  )
}

const kanbanWorkerActivityLabel = (worker: LoopWorkerActivity): string | undefined => {
  const profile = textValue(worker.profile)
  const currentTool = loopWorkerCurrentTool({ workerActivity: worker })

  return (
    [profile, currentTool].filter(Boolean).join(' · ') ||
    profile ||
    currentTool ||
    textValue(worker.status) ||
    textValue(worker.outcome)
  )
}

const kanbanWorkerToItem = (worker: LoopWorkerActivity, board?: null | string): ComposerStatusItem => ({
  activity: kanbanWorkerActivity(worker),
  currentTool: loopWorkerCurrentTool({ workerActivity: worker }),
  profile: textValue(worker.profile),
  id: `kanban-agent:${kanbanIdBoardScope(board)}${worker.task_id}:${worker.run_id}`,
  kanbanBoard: normalizeLoopBoard(board),
  kanbanTaskId: worker.task_id,
  output: worker.error_preview || worker.error || worker.summary_preview || worker.summary || undefined,
  runId: worker.run_id,
  sessionId: worker.worker_session_id || undefined,
  startedAt: epochMs(worker.started_at),
  state: kanbanWorkerState(worker),
  statusIndicator: workerStatusIndicator(worker),
  title: worker.task_title || worker.task_id,
  type: 'subagent',
  updatedAt: kanbanWorkerUpdatedAt(worker)
})

const kanbanTaskAggregate = (
  tasks: readonly TenantLoopTask[],
  workers: readonly LoopWorkerActivity[]
): { state: StatusItemState; statusIndicator: StatusIndicatorKind; todoStatus: TodoStatus } => {
  const taskIds = new Set(tasks.map(task => task.id))
  const relatedWorkers = workers.filter(worker => taskIds.has(worker.task_id))

  if (tasks.some(taskNeedsAttention) || relatedWorkers.some(workerNeedsForegroundAttention)) {
    return { state: 'failed', statusIndicator: 'attention', todoStatus: 'in_progress' }
  }

  if (tasks.some(taskIsActive) || relatedWorkers.some(workerIsActive)) {
    return { state: 'running', statusIndicator: 'active', todoStatus: 'in_progress' }
  }

  if (tasks.length > 0 && tasks.every(taskIsDone)) {
    return { state: 'done', statusIndicator: 'done', todoStatus: 'completed' }
  }

  if (tasks.some(taskIsTriage)) {
    return { state: 'running', statusIndicator: 'triage', todoStatus: 'pending' }
  }

  return { state: 'running', statusIndicator: 'pending', todoStatus: 'pending' }
}

const kanbanTaskToItem = (
  board: string,
  workflowId: string,
  tasks: readonly TenantLoopTask[],
  workers: readonly LoopWorkerActivity[]
): ComposerStatusItem => {
  const aggregate = kanbanTaskAggregate(tasks, workers)

  const task =
    tasks.find(candidate => candidate.id === workflowId) ||
    [...tasks].sort(
      (left, right) => (left.created_at ?? Number.MAX_SAFE_INTEGER) - (right.created_at ?? Number.MAX_SAFE_INTEGER)
    )[0]!

  return {
    currentTool: 'Loop',
    id: `kanban-task:${kanbanIdBoardScope(board)}${task.id}`,
    kanbanBoard: board,
    kanbanTaskId: task.id,
    kanbanWorkflowId: workflowId,
    state: aggregate.state,
    statusIndicator: aggregate.statusIndicator,
    taskProgress: kanbanTaskProgress(tasks),
    title: task.title || task.id,
    todoStatus: aggregate.todoStatus,
    type: 'todo'
  }
}

const loopagentNeedsForegroundAttention = (agent: LoopagentActivity): boolean => {
  const status = normalized(agent.status)
  const taskStatus = normalized(agent.taskStatus)

  if (agent.kind === 'worker' && loopagentIsActive(agent)) {
    return false
  }

  const text = [agent.errorPreview, agent.summaryPreview, agent.sourceEvent, agent.taskStatus]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return (
    status === 'blocked' ||
    (agent.kind === 'task' && taskStatus === 'blocked') ||
    FAILED_KANBAN_RUN_STATES.has(status) ||
    needsAttentionText(text)
  )
}

const loopagentIsActive = (agent: LoopagentActivity): boolean => {
  const status = normalized(agent.status)
  const taskStatus = normalized(agent.taskStatus)

  if (agent.kind === 'task') {
    return ACTIVE_KANBAN_TASK_STATUSES.has(status) || ACTIVE_KANBAN_TASK_STATUSES.has(taskStatus)
  }

  return ACTIVE_KANBAN_TASK_STATUSES.has(status) || (!status && ACTIVE_KANBAN_TASK_STATUSES.has(taskStatus))
}

const loopagentStatusIndicator = (agent: LoopagentActivity): StatusIndicatorKind => {
  const status = normalized(agent.status)
  const taskStatus = normalized(agent.taskStatus)

  const text = [agent.errorPreview, agent.summaryPreview, agent.sourceEvent, agent.taskStatus]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (agent.kind === 'worker' && loopagentIsActive(agent)) {
    return 'active'
  }

  if (needsAttentionText(text)) {
    return 'attention'
  }

  if (
    status === 'blocked' ||
    (agent.kind === 'task' && taskStatus === 'blocked') ||
    FAILED_KANBAN_RUN_STATES.has(status)
  ) {
    return 'failed'
  }

  if (loopagentIsActive(agent)) {
    return 'active'
  }

  if (DONE_KANBAN_TASK_STATUSES.has(taskStatus) || agent.status === 'completed') {
    return 'done'
  }

  if (taskStatus === 'triage') {
    return 'triage'
  }

  if (PENDING_KANBAN_TASK_STATUSES.has(taskStatus)) {
    return 'pending'
  }

  return 'unknown'
}

const loopagentState = (agent: LoopagentActivity): StatusItemState => {
  if (loopagentNeedsForegroundAttention(agent)) {
    return 'failed'
  }

  if (loopagentIsActive(agent)) {
    return 'running'
  }

  return 'done'
}

const loopagentActivityLabel = (agent: LoopagentActivity): string | undefined => {
  const profile = textValue(agent.profile)
  const currentTool = agent.currentTool ? loopToolLabel(agent.currentTool) : undefined

  return (
    [profile, currentTool].filter(Boolean).join(' · ') ||
    profile ||
    currentTool ||
    textValue(agent.taskStatus) ||
    agent.status
  )
}

const loopagentTaskTodoStatus = (agent: LoopagentActivity): TodoStatus => {
  const status = normalized(agent.taskStatus || agent.status)

  if (DONE_KANBAN_TASK_STATUSES.has(status)) {
    return 'completed'
  }

  if (status === 'triage' || PENDING_KANBAN_TASK_STATUSES.has(status)) {
    return 'pending'
  }

  return 'in_progress'
}

const loopagentToItem = (agent: LoopagentActivity): ComposerStatusItem => {
  const board = normalizeLoopBoard(agent.board)

  if (agent.kind === 'task') {
    const todoStatus = loopagentTaskTodoStatus(agent)

    return {
      currentTool: 'Loop',
      id: `kanban-task:${kanbanIdBoardScope(board)}${agent.taskId}`,
      kanbanBoard: board,
      kanbanTaskId: agent.taskId,
      kanbanWorkflowId: agent.workflowId,
      state: todoStatus === 'completed' ? 'done' : 'running',
      statusIndicator: loopagentStatusIndicator(agent),
      title: agent.title || agent.taskId,
      todoStatus,
      type: 'todo'
    }
  }

  return {
    activity: agent.stream,
    currentTool: agent.currentTool ? loopToolLabel(agent.currentTool) : undefined,
    profile: textValue(agent.profile),
    id: `kanban-agent:${kanbanIdBoardScope(board)}${agent.taskId}:${agent.runId ?? agent.workerSessionId ?? 'activity'}`,
    kanbanBoard: board,
    kanbanTaskId: agent.taskId,
    output: agent.errorPreview || agent.summaryPreview,
    runId: agent.runId,
    sessionId: agent.workerSessionId,
    startedAt: agent.startedAt,
    state: loopagentState(agent),
    statusIndicator: loopagentStatusIndicator(agent),
    title: agent.title || agent.taskId,
    toolCount: agent.toolCount,
    type: 'subagent',
    updatedAt: agent.updatedAt
  }
}

const LOOP_STATUS_INDICATOR_RANK: Readonly<Record<StatusIndicatorKind, number>> = {
  active: 4,
  attention: 6,
  done: 0,
  failed: 5,
  pending: 2,
  triage: 3,
  unknown: 1
}

const loopagentWorkflowTaskToItem = (
  workflowRef: LoopWorkflowRef,
  agents: readonly LoopagentActivity[]
): ComposerStatusItem => {
  const { board, workflowId } = workflowRef

  const representative =
    agents.find(agent => agent.taskId === workflowId) ||
    [...agents].sort((left, right) => left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId))[0]!

  let statusIndicator: StatusIndicatorKind

  if (agents.some(loopagentNeedsForegroundAttention)) {
    statusIndicator = 'attention'
  } else if (agents.some(loopagentIsActive)) {
    statusIndicator = 'active'
  } else if (agents.length > 0 && agents.every(agent => agent.status === 'completed')) {
    statusIndicator = 'done'
  } else if (agents.some(agent => normalized(agent.taskStatus) === 'triage')) {
    statusIndicator = 'triage'
  } else {
    statusIndicator = 'pending'
  }

  const todoStatus: TodoStatus =
    statusIndicator === 'done'
      ? 'completed'
      : statusIndicator === 'pending' || statusIndicator === 'triage'
        ? 'pending'
        : 'in_progress'

  const taskProgress = agents.reduce<NonNullable<ComposerStatusItem['taskProgress']>>(
    (progress, agent) => {
      if (loopagentNeedsForegroundAttention(agent)) {
        progress.blocked += 1
      } else if (loopagentTaskTodoStatus(agent) === 'completed') {
        progress.completed += 1
      } else {
        progress.pending += 1
      }

      progress.total += 1

      return progress
    },
    { blocked: 0, completed: 0, pending: 0, total: 0 }
  )

  return {
    currentTool: 'Loop',
    id: `kanban-workflow:${kanbanIdBoardScope(board)}${workflowId}`,
    kanbanBoard: board,
    kanbanTaskId: representative.taskId,
    kanbanWorkflowId: workflowId,
    state: statusIndicator === 'done' ? 'done' : statusIndicator === 'attention' ? 'failed' : 'running',
    statusIndicator,
    taskProgress,
    title: representative.title || representative.taskId,
    todoStatus,
    type: 'todo'
  }
}

const mergeLoopWorkflowTaskItem = (snapshot: ComposerStatusItem, live: ComposerStatusItem): ComposerStatusItem => {
  const snapshotIndicator = snapshot.statusIndicator || 'unknown'
  const liveIndicator = live.statusIndicator || 'unknown'

  const statusIndicator =
    LOOP_STATUS_INDICATOR_RANK[liveIndicator] > LOOP_STATUS_INDICATOR_RANK[snapshotIndicator]
      ? liveIndicator
      : snapshotIndicator

  const todoStatus: TodoStatus =
    statusIndicator === 'done'
      ? 'completed'
      : statusIndicator === 'pending' || statusIndicator === 'triage'
        ? 'pending'
        : 'in_progress'

  const taskProgress =
    live.taskProgress && (!snapshot.taskProgress || live.taskProgress.total >= snapshot.taskProgress.total)
      ? live.taskProgress
      : snapshot.taskProgress

  return {
    ...snapshot,
    state:
      statusIndicator === 'done'
        ? 'done'
        : statusIndicator === 'attention' || statusIndicator === 'failed'
          ? 'failed'
          : 'running',
    statusIndicator,
    taskProgress,
    title: snapshot.kanbanTaskId === live.kanbanTaskId ? live.title : snapshot.title,
    todoStatus
  }
}

const legacyLoopagentVisibleInComposer = (agent: LoopagentActivity): boolean =>
  agent.kind === 'task'
    ? !agent.workflowId && agent.isRootTask !== false
    : loopagentIsActive(agent) || loopagentNeedsForegroundAttention(agent)

function writeKanbanStatus(sid: string, items: ComposerStatusItem[]) {
  const current = $kanbanStatusBySession.get()
  const next = { ...current }

  if (items.length > 0) {
    next[sid] = items
  } else {
    delete next[sid]
  }

  $kanbanStatusBySession.set(next)
}

function kanbanItemsFromSource(source: TenantLoopSource): ComposerStatusItem[] {
  const board = normalizeLoopBoard(source.board)

  const visibleTasks = (source.tasks || []).filter(task => task.id && normalized(task.status) !== 'archived')

  const activeWorkers = (source.workers || [])
    .filter(worker => worker.task_id && Number.isFinite(worker.run_id))
    .filter(worker => workerIsActive(worker) || workerNeedsForegroundAttention(worker))

  const tasksByWorkflow = new Map<string, TenantLoopTask[]>()

  const sourceWorkflowId =
    source.workflow_id?.trim() ||
    ((source.workflow_ids?.length || 0) === 1 ? source.workflow_ids![0]!.trim() : '') ||
    source.root_task_id?.trim() ||
    ''

  for (const task of visibleTasks) {
    const workflowId = task.workflow_id?.trim() || sourceWorkflowId || `task:${task.id}`
    tasksByWorkflow.set(workflowId, [...(tasksByWorkflow.get(workflowId) || []), task])
  }

  const tasks = [...tasksByWorkflow].map(([workflowId, workflowTasks]) =>
    kanbanTaskToItem(board, workflowId, workflowTasks, activeWorkers)
  )

  const agents = activeWorkers.map(worker => kanbanWorkerToItem(worker, board))

  return [...tasks, ...agents]
}

export function reconcileKanbanSessionSources(sid: string, sources: readonly TenantLoopSource[]) {
  if (!sid) {
    return
  }

  writeKanbanStatus(sid, sources.flatMap(kanbanItemsFromSource))
}

export function reconcileKanbanSessionSource(sid: string, source: TenantLoopSource | null | undefined) {
  reconcileKanbanSessionSources(sid, source ? [source] : [])
}

export function reconcileKanbanSessionSourceForComposer({
  activeSessionId,
  source,
  sourceSessionId
}: {
  activeSessionId?: null | string
  source: TenantLoopSource | null | undefined
  sourceSessionId?: null | string
}) {
  reconcileKanbanSessionSourcesForComposer({
    activeSessionId,
    sources: source ? [source] : [],
    sourceSessionId
  })
}

export function reconcileKanbanSessionSourcesForComposer({
  activeSessionId,
  sources,
  sourceSessionId
}: {
  activeSessionId?: null | string
  sources: readonly TenantLoopSource[]
  sourceSessionId?: null | string
}) {
  const displaySessionId = activeSessionId || sourceSessionId || ''

  if (!displaySessionId) {
    return
  }

  if (sourceSessionId && sourceSessionId !== displaySessionId) {
    writeKanbanStatus(sourceSessionId, [])
  }

  reconcileKanbanSessionSources(displaySessionId, sources)
}

// The single thing the stack reads: a typed, merged item list per session.
export const $statusItemsBySession = computed(
  [$subagentsBySession, $backgroundStatusBySession, $todosBySession, $kanbanStatusBySession, $loopagentsBySession],
  (subs, background, todos, kanban, loopagents) => {
    const out: Record<string, ComposerStatusItem[]> = {}

    const push = (sid: string, items: ComposerStatusItem[]) => {
      if (items.length > 0) {
        out[sid] = out[sid] ? [...out[sid], ...items] : items
      }
    }

    for (const [sid, list] of Object.entries(todos)) {
      push(sid, list.map(todoToItem))
    }

    for (const sid of new Set([...Object.keys(kanban), ...Object.keys(loopagents)])) {
      const sessionActivities = loopagents[sid] ?? []
      const workflowTaskGroups = new Map<string, LoopagentActivity[]>()

      for (const agent of sessionActivities) {
        if (agent.kind !== 'task' || !agent.workflowId) {
          continue
        }

        const workflowKey = loopWorkflowRefKey({
          board: normalizeLoopBoard(agent.board),
          workflowId: agent.workflowId
        })

        workflowTaskGroups.set(workflowKey, [...(workflowTaskGroups.get(workflowKey) || []), agent])
      }

      const workflowItems = new Map(
        [...workflowTaskGroups].map(([workflowKey, agents]) => {
          const representative = agents[0]!

          const workflowRef = {
            board: normalizeLoopBoard(representative.board),
            workflowId: representative.workflowId!
          }

          return [workflowKey, loopagentWorkflowTaskToItem(workflowRef, agents)] as const
        })
      )

      const legacyAndWorkerItems = sessionActivities.filter(legacyLoopagentVisibleInComposer).map(loopagentToItem)
      const liveIds = new Set(legacyAndWorkerItems.map(item => item.id))
      const snapshotWorkflowKeys = new Set<string>()

      const snapshotItems = (kanban[sid] ?? [])
        .filter(item => !liveIds.has(item.id))
        .map(item => {
          const workflowId = item.kanbanWorkflowId

          if (!workflowId) {
            return item
          }

          const workflowKey = loopWorkflowRefKey({
            board: normalizeLoopBoard(item.kanbanBoard),
            workflowId
          })

          snapshotWorkflowKeys.add(workflowKey)
          const live = workflowItems.get(workflowKey)

          return live ? mergeLoopWorkflowTaskItem(item, live) : item
        })

      const newWorkflowItems = [...workflowItems]
        .filter(([workflowKey]) => !snapshotWorkflowKeys.has(workflowKey))
        .map(([, item]) => item)

      push(sid, [...snapshotItems, ...newWorkflowItems, ...legacyAndWorkerItems])
    }

    for (const [sid, list] of Object.entries(subs)) {
      push(sid, list.filter(s => s.status === 'running' || s.status === 'queued').map(subToItem))
    }

    for (const [sid, list] of Object.entries(background)) {
      push(sid, list)
    }

    return out
  }
)

// Fixed render order for the groups in the stack (top → bottom, above queue).
export type StatusGroupType = Exclude<StatusItemType, 'kanban-agent'>
const TYPE_ORDER: readonly StatusGroupType[] = ['todo', 'subagent', 'background']

const composerGroupType = (item: ComposerStatusItem): StatusGroupType =>
  item.type === 'kanban-agent' ? 'subagent' : item.type

export interface StatusGroup {
  items: ComposerStatusItem[]
  type: StatusGroupType
}

export function groupStatusItems(items: readonly ComposerStatusItem[]): StatusGroup[] {
  const byType = new Map<StatusGroupType, ComposerStatusItem[]>()

  for (const item of items) {
    const type = composerGroupType(item)
    const list = byType.get(type)

    if (list) {
      list.push(item)
    } else {
      byType.set(type, [item])
    }
  }

  return TYPE_ORDER.filter(type => byType.has(type)).map(type => ({ items: byType.get(type)!, type }))
}

const writeBackground = (sid: string, items: ComposerStatusItem[]) => {
  const current = $backgroundStatusBySession.get()
  const next = { ...current }

  if (items.length > 0) {
    next[sid] = items
  } else {
    delete next[sid]
  }

  $backgroundStatusBySession.set(next)
}

// `tui_gateway` process.list entry (tools/process_registry.list_sessions + output_tail).
interface GatewayProcessEntry {
  command?: string
  exit_code?: number
  output_tail?: string
  session_id?: string
  status?: string
}

const toBackgroundItem = (proc: GatewayProcessEntry): ComposerStatusItem => {
  const exited = proc.status === 'exited'
  const exitCode = typeof proc.exit_code === 'number' ? proc.exit_code : undefined

  return {
    exitCode,
    id: proc.session_id ?? '',
    output: proc.output_tail || undefined,
    state: exited ? (exitCode ? 'failed' : 'done') : 'running',
    title: (proc.command ?? '').split('\n')[0]!.trim() || 'background process',
    type: 'background'
  }
}

const sameItem = (a: ComposerStatusItem, b: ComposerStatusItem) =>
  a.state === b.state && a.title === b.title && a.output === b.output && a.exitCode === b.exitCode

/**
 * Layout-stable sync of the registry snapshot into the store: existing rows
 * keep their position (status flips happen in place, never reorder), new
 * processes append, dismissed ids stay gone, and unchanged rows keep their
 * object identity so memoised rows skip re-rendering.
 */
export function reconcileBackgroundProcesses(sid: string, procs: GatewayProcessEntry[]) {
  const dismissed = dismissedBySession.get(sid)

  const fresh = new Map(
    procs
      .filter(proc => proc.session_id && !dismissed?.has(proc.session_id))
      .map(proc => [proc.session_id!, toBackgroundItem(proc)])
  )

  const prev = $backgroundStatusBySession.get()[sid] ?? []

  // running → exited since the last snapshot = a background process just finished.
  const prevState = new Map(prev.map(item => [item.id, item.state]))

  for (const [id, item] of fresh) {
    if (item.state !== 'running' && prevState.get(id) === 'running') {
      dispatchNativeNotification({
        body: item.title,
        kind: 'backgroundDone',
        sessionId: sid,
        title: translateNow(
          item.state === 'failed'
            ? 'notifications.native.backgroundFailedTitle'
            : 'notifications.native.backgroundDoneTitle'
        )
      })
    }
  }

  const kept = prev.flatMap(old => {
    const next = fresh.get(old.id)
    fresh.delete(old.id)

    return next ? [sameItem(old, next) ? old : next] : []
  })

  const next = [...kept, ...fresh.values()]

  // Dismissals only need remembering while the registry still reports the id.
  if (dismissed) {
    const reported = new Set(procs.map(proc => proc.session_id))

    for (const id of dismissed) {
      if (!reported.has(id)) {
        dismissed.delete(id)
      }
    }
  }

  // Arm the self-clear on every finished task (failures linger longer); cancel
  // it for anything running again or gone from the snapshot.
  const finishedDelay = new Map(
    next
      .filter(item => item.state !== 'running')
      .map(item => [item.id, item.state === 'failed' ? FAILURE_LINGER_MS : SUCCESS_LINGER_MS])
  )

  for (const [id, delay] of finishedDelay) {
    scheduleAutoDismiss(sid, id, delay)
  }

  for (const id of [...(autoClearTimers.get(sid)?.keys() ?? [])]) {
    if (!finishedDelay.has(id)) {
      cancelAutoDismiss(sid, id)
    }
  }

  if (next.length === prev.length && next.every((item, i) => item === prev[i])) {
    return
  }

  writeBackground(sid, next)
}

/** Pull the session's live process snapshot from the gateway. */
export async function refreshBackgroundProcesses(sid: string): Promise<void> {
  const gateway = $gateway.get()

  if (!sid || !gateway) {
    return
  }

  try {
    const result = await gateway.request<{ processes?: GatewayProcessEntry[] }>('process.list', { session_id: sid })

    reconcileBackgroundProcesses(sid, result?.processes ?? [])
  } catch {
    // Transient socket loss — the next trigger (event or poll) retries.
  }
}

/** X on a finished row: drop it now and keep it dropped across refreshes. */
export function dismissBackgroundProcess(sid: string, id: string) {
  cancelAutoDismiss(sid, id)

  const dismissed = dismissedBySession.get(sid) ?? new Set<string>()
  dismissed.add(id)
  dismissedBySession.set(sid, dismissed)

  const list = $backgroundStatusBySession.get()[sid] ?? []

  writeBackground(
    sid,
    list.filter(item => item.id !== id)
  )
}

/** X on a running row: kill the process for real, THEN drop the row. Only drop
 *  on a confirmed kill — dismissing unconditionally (the old behavior) hid the
 *  row while the process lived on, stranding rogue tasks. On failure the row
 *  stays so the user can retry / see it didn't die. */
export async function stopBackgroundProcess(sid: string, id: string): Promise<void> {
  try {
    await $gateway.get()?.request('process.kill', { process_id: id, session_id: sid })
    dismissBackgroundProcess(sid, id)
  } catch (err) {
    notifyError(err, 'Could not stop the process')
  }
}

/**
 * Rewind cleanup: a restore/edit discards the turns that spawned these
 * processes, so they belong to an abandoned timeline. Kill the live ones and
 * drop every row. Ids are marked dismissed so an in-flight `process.list` poll
 * (kill is async) can't resurrect them; reconcile garbage-collects those once
 * the registry stops reporting them.
 */
export function resetSessionBackground(sid: string) {
  if (!sid) {
    return
  }

  cancelAllAutoDismiss(sid)

  const gateway = $gateway.get()
  const list = $backgroundStatusBySession.get()[sid] ?? []
  const dismissed = dismissedBySession.get(sid) ?? new Set<string>()

  for (const item of list) {
    dismissed.add(item.id)

    if (item.state === 'running') {
      void gateway?.request('process.kill', { process_id: item.id, session_id: sid }).catch(() => undefined)
    }
  }

  dismissedBySession.set(sid, dismissed)
  writeBackground(sid, [])
}
