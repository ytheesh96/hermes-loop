import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'

export type LoopPanelStatus = 'error' | 'ready' | 'stale'

export interface LoopLatestRun {
  error?: null | string
  id?: number
  metadata?: unknown
  outcome?: null | string
  profile?: null | string
  status?: null | string
  summary?: null | string
  task_id?: string
  worker_session_id?: null | string
}

export interface LoopTaskEvent {
  created_at?: number
  id?: number
  kind?: string
  payload?: null | unknown
  run_id?: null | number
  task_id?: string
}

export interface LoopWorkerActivity {
  active_tool?: null | string
  claim_expires?: null | number
  current_tool?: null | string
  current_tool_name?: null | string
  currentTool?: null | string
  ended_at?: null | number
  error?: null | string
  error_preview?: null | string
  last_heartbeat_at?: null | number
  latest_event_id?: null | number
  latest_event_kind?: null | string
  log_path?: null | string
  log_size_bytes?: number
  log_tail?: null | string
  log_tail_available?: boolean
  log_tail_truncated?: boolean
  outcome?: null | string
  profile?: null | string
  recent_task_events?: LoopTaskEvent[]
  run_id: number
  started_at?: null | number
  status?: null | string
  summary?: null | string
  summary_preview?: null | string
  task_id: string
  task_status?: null | string
  task_title?: null | string
  tool_name?: null | string
  worker_pid?: null | number
  worker_session_id?: null | string
}

export type LoopWorkerState = 'blocked' | 'done' | 'failed' | 'running' | 'stale' | 'waiting'

export interface LoopWorkerRun {
  action: 'inspect-run' | 'open-session'
  attention: boolean
  claimExpires?: null | number
  elapsedSeconds?: number
  endedAt?: null | number
  error?: null | string
  finishedAgeSeconds?: number
  heartbeatAgeSeconds?: number
  latestText?: string
  logTail?: null | string
  logTailAvailable: boolean
  logTailTruncated: boolean
  profile?: null | string
  recentEvents: LoopTaskEvent[]
  runId: number
  startedAt?: null | number
  state: LoopWorkerState
  status?: null | string
  taskId: string
  taskStatus?: null | string
  taskTitle: string
  workerPid?: null | number
  workerSessionId?: null | string
}

export interface LoopWorkerCounts {
  attention: number
  running: number
  total: number
}

export interface LoopTaskHandoff {
  attention?: null | string
  claimed_at?: null | number
  claimed_by?: null | string
  decision_actor?: null | string
  decision_reason?: null | string
  handoff_kind?: null | string
  id?: number
  intent?: null | string
  payload?: null | Record<string, unknown>
  queue_state?: null | string
  reason?: null | string
  resolution_action?: null | string
  resolved_at?: null | number
  resolution_summary?: null | string
  resolved_by?: null | string
  review_run_id?: null | number
  review_task_id?: null | string
  reviewer_session_id?: null | string
  root_task_id?: null | string
  run_id?: null | number
  state?: null | string
  summary?: null | string
  target_actor?: null | string
  task_id?: null | string
  verification_state?: null | string
  verification_status?: null | string
  worker_metadata?: null | Record<string, unknown>
  worker_profile?: null | string
  worker_session_id?: null | string
}

export interface CompactLoopTask {
  assignee?: null | string
  completed_at?: null | number
  created_at?: null | number
  id: string
  session_id?: null | string
  status?: null | string
  tenant?: null | string
  title?: null | string
}

export interface LoopIntakeState {
  dispatchable?: boolean
  needed: boolean
  source?: null | string
  state?: null | string
}

export interface TenantLoopTask {
  age?: Record<string, null | number>
  active?: boolean
  assignee?: null | string
  branch_kind?: null | string
  body?: null | string
  child_count?: number
  children_count?: number
  comment_count?: number
  completed_at?: null | number
  created_at?: number
  created_by?: null | string
  current_run_id?: null | number
  current_step_key?: null | string
  decision_group_id?: null | string
  diagnostics?: unknown[]
  execution_task_id?: null | string
  external_child_tasks?: CompactLoopTask[]
  external_parent_tasks?: CompactLoopTask[]
  id: string
  included_child_ids?: string[]
  included_parent_ids?: string[]
  is_planning_node?: boolean
  latest_run?: null | LoopLatestRun
  latest_summary?: null | string
  loop_intake?: null | LoopIntakeState
  loop_handoffs?: LoopTaskHandoff[]
  links?: {
    children?: string[]
    parents?: string[]
  }
  parent_count?: number
  parents_count?: number
  priority?: number
  result?: null | string
  session_id?: null | string
  review_kind?: null | string
  resume_mode?: null | string
  review_subject_assignee?: null | string
  selection_state?: null | string
  foreground_parent_session_id?: null | string
  foreground_fork_session_id?: null | string
  frontier?: boolean
  started_at?: null | number
  status: string
  suggested_owner?: null | string
  tenant?: null | string
  title: string
  warnings?: unknown
  workspace_kind?: null | string
  workspace_path?: null | string
  worker_activity?: null | LoopWorkerActivity
}

export interface TenantLoopSource {
  board?: null | string
  external_links?: { child_id?: string; parent_id?: string }[]
  has_changes_since?: null | boolean
  include_archived?: boolean
  latest_event_id?: number
  lineage_session_ids?: string[]
  links?: { child_id?: string; parent_id?: string }[]
  now?: number
  planning_links?: { child_id?: string; parent_id?: string }[]
  planning_nodes?: TenantLoopTask[]
  root_task_id?: null | string
  session_id?: string
  tasks?: TenantLoopTask[]
  tenant?: null | string
  tenants?: string[]
  workers?: LoopWorkerActivity[]
}

export interface LoopTaskComment {
  author?: null | string
  body?: null | string
  created_at?: number
  id?: number
  task_id?: string
}

export interface LoopTaskRun extends LoopLatestRun {
  ended_at?: null | number
  outcome?: null | string
  started_at?: null | number
}

// Normal Loop side-panel data contract.
//
// The panel should render from normalized task metadata, not from the debug
// raw JSON block. Its list/selection rows are derived from
// GET /api/plugins/kanban/session-source (see getLoopSessionSource), while the
// focused selected-task fetch comes from GET /api/plugins/kanban/tasks/:id (see
// getLoopTaskDetail). Field ownership:
// - title/status/body, assignee, result, latest_summary, workspace_kind/path:
//   row.task (TenantLoopTask) from session-source; detail.task carries the same
//   full task shape when fetched.
// - parents/children: row.parents/row.children, computed from
//   included_parent_ids/included_child_ids, falling back to links.parents/children.
//   The focused detail also returns links for the selected task. IDs resolve to
//   display labels through LoopPanel's rowById map; missing rows intentionally
//   display the raw task id and remain selectable when onSelectTaskId exists.
// - comments: focused detail.comments; absent/empty means []. Use the row's
//   commentCount as a preview-only fallback copy, not as rendered comment text.
// - latest run/result/summary: row.latestRun, row.result, row.latestSummary
//   (latest_summary || latest_run.summary). detail.runs is the full history for
//   future expansion; absent/empty means no run history.
// - safe task actions: the UI derives conservative non-destructive affordances from
//   normalized status until a backend capability list exists. Mutating actions are
//   emitted only through explicit user clicks via LoopPanel.onTaskAction.
export interface LoopTaskDetail {
  comments?: LoopTaskComment[]
  links?: {
    children?: string[]
    parents?: string[]
  }
  runs?: LoopTaskRun[]
  task?: TenantLoopTask
}

export interface LoopRow {
  active: boolean
  assignee?: null | string
  branchKind?: null | string
  body?: null | string
  childCount: number
  children: string[]
  commentCount: number
  depth: number
  externalChildTasks?: CompactLoopTask[]
  externalParentTasks?: CompactLoopTask[]
  decisionGroupId?: null | string
  executionTaskId?: null | string
  frontier: boolean
  latestRun?: null | LoopLatestRun
  latestSummary?: null | string
  loopIntake?: null | LoopIntakeState
  loopHandoffs?: LoopTaskHandoff[]
  parentCount: number
  parents: string[]
  priority?: number
  planningNode?: boolean
  rawTask?: TenantLoopTask
  reviewKind?: null | string
  resumeMode?: null | string
  reviewSubjectAssignee?: null | string
  selectionState?: null | string
  result?: null | string
  sourceSessionId?: null | string
  foregroundParentSessionId?: null | string
  foregroundForkSessionId?: null | string
  status: string
  suggestedOwner?: null | string
  taskId: string
  tenant?: null | string
  title: string
  workerActivity?: null | LoopWorkerActivity
  workspaceKind?: null | string
  workspacePath?: null | string
}

export interface LoopPanelState {
  message: string
  rawJson: string
  revision: number
  rootTaskId: string
  rows: LoopRow[]
  sourceNow?: number
  status: LoopPanelStatus
}

export function loopConnectedTaskIds(state?: LoopPanelState | null, rootTaskId?: null | string): string[] {
  const rows = state?.rows || []
  const taskId = rootTaskId?.trim() || state?.rootTaskId || ''

  if (!taskId) {
    return []
  }

  const rowById = new Map(rows.map(row => [row.taskId, row]))

  if (!rowById.has(taskId)) {
    return rows.map(row => row.taskId)
  }

  const neighbors = new Map(rows.map(row => [row.taskId, new Set<string>()]))

  const link = (left?: null | string, right?: null | string) => {
    if (!left || !right || !rowById.has(left) || !rowById.has(right)) {
      return
    }

    neighbors.get(left)?.add(right)
    neighbors.get(right)?.add(left)
  }

  for (const row of rows) {
    for (const parentId of row.parents) {
      link(row.taskId, parentId)
    }

    for (const childId of row.children) {
      link(row.taskId, childId)
    }
  }

  const seen = new Set<string>()
  const queue = [taskId]

  while (queue.length) {
    const currentId = queue.shift()!

    if (seen.has(currentId) || !rowById.has(currentId)) {
      continue
    }

    seen.add(currentId)

    for (const nextId of neighbors.get(currentId) || []) {
      if (!seen.has(nextId)) {
        queue.push(nextId)
      }
    }
  }

  return rows.filter(row => seen.has(row.taskId)).map(row => row.taskId)
}

const ARCHIVED_STATUSES = new Set(['archived'])
const COMPLETE_STATUSES = new Set(['done', 'complete', 'completed', 'cancelled', 'archived'])
const ACTIVE_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress'])
const RUNNABLE_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress', 'todo'])
const WAITING_WORKER_STATUSES = new Set(['queued', 'ready', 'todo'])
const SUCCESS_RUN_OUTCOMES = new Set(['success', 'succeeded', 'ok'])

const FAILED_RUN_STATES = new Set([
  'error',
  'failed',
  'crashed',
  'timed_out',
  'timeout',
  'interrupted',
  'spawn_failed',
  'gave_up'
])

const DEFAULT_STALE_HEARTBEAT_SECONDS = 10 * 60

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

function normalizedStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : 'todo'
}

function secondsBetween(later: number | null | undefined, earlier: number | null | undefined): number | undefined {
  if (typeof later !== 'number' || typeof earlier !== 'number') {
    return undefined
  }

  return Math.max(0, Math.round(later - earlier))
}

function loopWorkerState(
  worker: LoopWorkerActivity,
  nowSeconds: number,
  staleHeartbeatSeconds: number
): LoopWorkerState {
  const status = normalizedStatus(worker.status)
  const taskStatus = worker.task_status ? normalizedStatus(worker.task_status) : ''
  const outcome = normalizedStatus(worker.outcome)
  const active = ACTIVE_STATUSES.has(status) || ACTIVE_STATUSES.has(taskStatus)
  const heartbeatAge = secondsBetween(nowSeconds, worker.last_heartbeat_at)

  if (taskStatus === 'blocked' || outcome === 'blocked') {
    return 'blocked'
  }

  if (FAILED_RUN_STATES.has(status) || FAILED_RUN_STATES.has(outcome)) {
    return 'failed'
  }

  if (active && (heartbeatAge === undefined || heartbeatAge > staleHeartbeatSeconds)) {
    return 'stale'
  }

  if (active) {
    return 'running'
  }

  if (WAITING_WORKER_STATUSES.has(status) || WAITING_WORKER_STATUSES.has(taskStatus)) {
    return 'waiting'
  }

  if (SUCCESS_RUN_OUTCOMES.has(outcome) || COMPLETE_STATUSES.has(status) || COMPLETE_STATUSES.has(taskStatus)) {
    return 'done'
  }

  return worker.ended_at ? 'done' : 'waiting'
}

function latestWorkerText(worker: LoopWorkerActivity): string | undefined {
  const latestEvent = (worker.recent_task_events || [])
    .slice()
    .reverse()
    .find(event => typeof event.kind === 'string' && event.kind.trim())

  return (
    worker.summary?.trim() ||
    worker.summary_preview?.trim() ||
    worker.error?.trim() ||
    worker.error_preview?.trim() ||
    (latestEvent ? latestEvent.kind : '') ||
    (worker.log_tail_available ? 'Worker log tail available' : '') ||
    undefined
  )
}

export function normalizeLoopWorkers(
  source: TenantLoopSource | null | undefined,
  options: { nowSeconds?: number; staleHeartbeatSeconds?: number } = {}
): LoopWorkerRun[] {
  const nowSeconds = options.nowSeconds ?? source?.now ?? Date.now() / 1000
  const staleHeartbeatSeconds = options.staleHeartbeatSeconds ?? DEFAULT_STALE_HEARTBEAT_SECONDS

  return (source?.workers || [])
    .filter(worker => worker.task_id && Number.isFinite(worker.run_id))
    .map(worker => {
      const state = loopWorkerState(worker, nowSeconds, staleHeartbeatSeconds)
      const elapsedSeconds = secondsBetween(worker.ended_at ?? nowSeconds, worker.started_at)
      const heartbeatAgeSeconds = secondsBetween(nowSeconds, worker.last_heartbeat_at)
      const attention = state === 'blocked' || state === 'failed' || state === 'stale'

      return {
        action: worker.worker_session_id ? ('open-session' as const) : ('inspect-run' as const),
        attention,
        claimExpires: worker.claim_expires,
        elapsedSeconds,
        endedAt: worker.ended_at,
        error: worker.error || worker.error_preview,
        finishedAgeSeconds: secondsBetween(nowSeconds, worker.ended_at),
        heartbeatAgeSeconds,
        latestText: latestWorkerText(worker),
        logTail: worker.log_tail,
        logTailAvailable: Boolean(worker.log_tail_available || worker.log_tail),
        logTailTruncated: Boolean(worker.log_tail_truncated),
        profile: worker.profile,
        recentEvents: worker.recent_task_events || [],
        runId: worker.run_id,
        startedAt: worker.started_at,
        state,
        status: worker.status,
        taskId: worker.task_id,
        taskStatus: worker.task_status,
        taskTitle: worker.task_title || worker.task_id,
        workerPid: worker.worker_pid,
        workerSessionId: worker.worker_session_id
      }
    })
    .sort((a, b) => {
      const activeA = a.state === 'running' || a.state === 'waiting' || a.state === 'stale'
      const activeB = b.state === 'running' || b.state === 'waiting' || b.state === 'stale'

      if (activeA !== activeB) {
        return activeA ? -1 : 1
      }

      if (activeA) {
        return (a.startedAt || 0) - (b.startedAt || 0)
      }

      return (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0)
    })
}

export function loopWorkerCounts(workers: readonly LoopWorkerRun[]): LoopWorkerCounts {
  return {
    attention: workers.filter(worker => worker.attention).length,
    running: workers.filter(worker => worker.state === 'running' || worker.state === 'waiting').length,
    total: workers.length
  }
}

function taskParents(task: TenantLoopTask): string[] {
  const explicit = task.included_parent_ids || task.links?.parents || []
  const external = task.external_parent_tasks?.map(parent => parent.id).filter(Boolean) || []

  return Array.from(new Set([...explicit, ...external]))
}

function taskChildren(task: TenantLoopTask): string[] {
  const explicit = task.included_child_ids || task.links?.children || []
  const external = task.external_child_tasks?.map(child => child.id).filter(Boolean) || []

  return Array.from(new Set([...explicit, ...external]))
}

function isHiddenLockedPlanningOption(task: TenantLoopTask): boolean {
  if (task.is_planning_node !== true || normalizedStatus(task.branch_kind) !== 'alternative') {
    return false
  }

  const selectionState = normalizedStatus(task.selection_state)

  return selectionState === 'chosen' || selectionState === 'rejected'
}

function loopTaskRelationMaps(
  source: Omit<TenantLoopSource, 'tasks'> & { tasks?: readonly TenantLoopTask[] },
  tasks: readonly TenantLoopTask[]
): { childrenById: Map<string, Set<string>>; parentsById: Map<string, Set<string>> } {
  const taskIds = new Set(tasks.map(task => task.id))
  const childrenById = new Map(tasks.map(task => [task.id, new Set<string>()]))
  const parentsById = new Map(tasks.map(task => [task.id, new Set<string>()]))

  const link = (parentId?: null | string, childId?: null | string) => {
    if (!parentId || !childId || !taskIds.has(parentId) || !taskIds.has(childId)) {
      return
    }

    childrenById.get(parentId)?.add(childId)
    parentsById.get(childId)?.add(parentId)
  }

  for (const task of tasks) {
    for (const parentId of taskParents(task)) {
      link(parentId, task.id)
    }

    for (const childId of taskChildren(task)) {
      link(task.id, childId)
    }
  }

  for (const sourceLink of [...(source.links || []), ...(source.external_links || []), ...(source.planning_links || [])]) {
    link(sourceLink.parent_id, sourceLink.child_id)
  }

  return { childrenById, parentsById }
}

function resolveVisibleRelatedTaskIds(
  taskId: string,
  relationMap: Map<string, Set<string>>,
  visibleTaskIds: Set<string>,
  hiddenTaskIds: Set<string>,
  seen = new Set<string>()
): string[] {
  if (seen.has(taskId)) {
    return []
  }

  seen.add(taskId)

  const relatedIds: string[] = []

  for (const relatedId of relationMap.get(taskId) || []) {
    if (visibleTaskIds.has(relatedId)) {
      relatedIds.push(relatedId)
    } else if (hiddenTaskIds.has(relatedId)) {
      relatedIds.push(...resolveVisibleRelatedTaskIds(relatedId, relationMap, visibleTaskIds, hiddenTaskIds, seen))
    }
  }

  return Array.from(new Set(relatedIds.filter(relatedId => relatedId !== taskId)))
}

function compactLockedPlanningOptions(
  source: Omit<TenantLoopSource, 'tasks'> & { tasks?: readonly TenantLoopTask[] },
  tasks: readonly TenantLoopTask[]
): TenantLoopTask[] {
  const hiddenTaskIds = new Set(tasks.filter(isHiddenLockedPlanningOption).map(task => task.id))

  if (hiddenTaskIds.size === 0) {
    return [...tasks]
  }

  const visibleTaskIds = new Set(tasks.filter(task => !hiddenTaskIds.has(task.id)).map(task => task.id))
  const { childrenById, parentsById } = loopTaskRelationMaps(source, tasks)

  return tasks
    .filter(task => !hiddenTaskIds.has(task.id))
    .map(task => {
      const parents = resolveVisibleRelatedTaskIds(task.id, parentsById, visibleTaskIds, hiddenTaskIds)
      const children = resolveVisibleRelatedTaskIds(task.id, childrenById, visibleTaskIds, hiddenTaskIds)

      return {
        ...task,
        included_child_ids: children,
        included_parent_ids: parents,
        links: {
          ...task.links,
          children,
          parents
        }
      }
    })
}

const LOOP_DELEGATION_CREATED_BY_PREFIX = 'loop_delegation:'

const isDelegatedLoopRootTask = (task: TenantLoopTask): boolean =>
  Boolean(task.created_by?.startsWith(LOOP_DELEGATION_CREATED_BY_PREFIX)) && taskParents(task).length === 0

const isSelfAnchoredLoopTask = (task: TenantLoopTask): boolean =>
  task.created_by === `loop:${task.id}` || isDelegatedLoopRootTask(task)

function taskNeighborMap(
  source: Omit<TenantLoopSource, 'tasks'> & { tasks?: readonly TenantLoopTask[] },
  tasks: readonly TenantLoopTask[]
): Map<string, Set<string>> {
  const taskIds = new Set(tasks.map(task => task.id))
  const neighbors = new Map(tasks.map(task => [task.id, new Set<string>()]))

  const link = (left?: null | string, right?: null | string) => {
    if (!left || !right || !taskIds.has(left) || !taskIds.has(right)) {
      return
    }

    neighbors.get(left)?.add(right)
    neighbors.get(right)?.add(left)
  }

  for (const task of tasks) {
    for (const parentId of taskParents(task)) {
      link(task.id, parentId)
    }

    for (const childId of taskChildren(task)) {
      link(task.id, childId)
    }
  }

  for (const sourceLink of [...(source.links || []), ...(source.external_links || []), ...(source.planning_links || [])]) {
    link(sourceLink.parent_id, sourceLink.child_id)
  }

  return neighbors
}

function taskGraphHasPath(startId: string, targetId: string, neighbors: Map<string, Set<string>>): boolean {
  if (startId === targetId) {
    return true
  }

  const seen = new Set<string>()
  const queue = [startId]

  while (queue.length) {
    const taskId = queue.shift()!

    if (seen.has(taskId)) {
      continue
    }

    seen.add(taskId)

    for (const nextId of neighbors.get(taskId) || []) {
      if (nextId === targetId) {
        return true
      }

      if (!seen.has(nextId)) {
        queue.push(nextId)
      }
    }
  }

  return false
}

export function relatedLoopTaskIdsForRoot(
  source: Omit<TenantLoopSource, 'tasks'> & { tasks?: readonly TenantLoopTask[] },
  root: TenantLoopTask,
  tasks: readonly TenantLoopTask[] = source.tasks || []
): Set<string> {
  const neighbors = taskNeighborMap(source, tasks)
  const seen = new Set<string>()
  const queue = [root.id]

  while (queue.length > 0) {
    const taskId = queue.shift()!

    if (seen.has(taskId)) {
      continue
    }

    seen.add(taskId)

    for (const nextId of neighbors.get(taskId) || []) {
      if (!seen.has(nextId)) {
        queue.push(nextId)
      }
    }
  }

  return seen
}

function topLevelSelfAnchoredRoots(source: TenantLoopSource, tasks: readonly TenantLoopTask[]): TenantLoopTask[] {
  const neighbors = taskNeighborMap(source, tasks)

  const selfAnchored = tasks
    .filter(isSelfAnchoredLoopTask)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || a.id.localeCompare(b.id))

  return selfAnchored.filter((task, index) => {
    const connectedEarlierRoot = selfAnchored
      .slice(0, index)
      .find(other => taskGraphHasPath(task.id, other.id, neighbors))

    return !connectedEarlierRoot
  })
}

function preferredSelfAnchoredRootForTask(
  source: TenantLoopSource,
  tasks: readonly TenantLoopTask[],
  taskId: string
): TenantLoopTask | null {
  const neighbors = taskNeighborMap(source, tasks)
  const selfAnchored = topLevelSelfAnchoredRoots(source, tasks)

  return selfAnchored.find(root => taskGraphHasPath(taskId, root.id, neighbors)) || null
}

function orderedSessionLineageIds(source: TenantLoopSource): string[] {
  return Array.from(
    new Set([...(source.lineage_session_ids || []), source.session_id].filter((id): id is string => Boolean(id)))
  )
}

export function inferLoopRootTaskIdFromTenantSource(
  source: TenantLoopSource,
  tasks: readonly TenantLoopTask[] = source.tasks || []
): string {
  const byId = new Map(tasks.map(task => [task.id, task]))

  if (source.root_task_id && byId.has(source.root_task_id)) {
    const topLevelRoot = preferredSelfAnchoredRootForTask(source, tasks, source.root_task_id)

    return topLevelRoot?.id || source.root_task_id
  }

  const selfAnchoredRoots = topLevelSelfAnchoredRoots(source, tasks)

  if (selfAnchoredRoots[0]?.id) {
    return selfAnchoredRoots[0].id
  }

  for (const lineageId of orderedSessionLineageIds(source)) {
    const anchoredRows = tasks
      .filter(task => task.id && task.session_id === lineageId)
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))

    if (anchoredRows[0]?.id) {
      return anchoredRows[0].id
    }
  }

  if (source.tenant && tasks.some(task => task.id === source.tenant)) {
    return source.tenant
  }

  return source.tenant || source.session_id || source.lineage_session_ids?.[0] || ''
}

export function inferLoopRootTasksFromTenantSource(
  source: TenantLoopSource,
  tasks: readonly TenantLoopTask[] = source.tasks || []
): TenantLoopTask[] {
  const roots = topLevelSelfAnchoredRoots(source, tasks)

  if (roots.length > 0) {
    return roots
  }

  const byId = new Map(tasks.map(task => [task.id, task]))
  const inferredRoot = byId.get(inferLoopRootTaskIdFromTenantSource(source, tasks))
  const fallbackRoot = inferredRoot || tasks.find(task => taskParents(task).length === 0) || tasks[0]

  return fallbackRoot ? [fallbackRoot] : []
}

function depthByTaskId(tasks: readonly TenantLoopTask[]): Map<string, number> {
  const depths = new Map<string, number>()
  const taskIds = new Set(tasks.map(task => task.id))
  let changed = true

  for (const task of tasks) {
    depths.set(task.id, 0)
  }

  for (let pass = 0; pass < Math.max(tasks.length, 1) && changed; pass += 1) {
    changed = false

    for (const task of tasks) {
      const parentDepth = taskParents(task).reduce(
        (maxDepth, parentId) => Math.max(maxDepth, depths.get(parentId) ?? 0),
        -1
      )

      const nextDepth = parentDepth >= 0 ? parentDepth + 1 : 0

      if (nextDepth > (depths.get(task.id) ?? 0)) {
        depths.set(task.id, nextDepth)
        changed = true
      }
    }
  }

  return depths
}

function latestWorkerForTask(task: TenantLoopTask, workers: readonly LoopWorkerActivity[]): LoopWorkerActivity | null {
  const taskWorkers = workers.filter(worker => worker.task_id === task.id)

  if (taskWorkers.length === 0) {
    return null
  }

  const currentRunId = task.current_run_id || task.latest_run?.id || null

  return [...taskWorkers].sort((a, b) => {
    const aCurrent = currentRunId && a.run_id === currentRunId ? 1 : 0
    const bCurrent = currentRunId && b.run_id === currentRunId ? 1 : 0

    if (aCurrent !== bCurrent) {
      return bCurrent - aCurrent
    }

    const aActive = ACTIVE_STATUSES.has(normalizedStatus(a.status)) ? 1 : 0
    const bActive = ACTIVE_STATUSES.has(normalizedStatus(b.status)) ? 1 : 0

    if (aActive !== bActive) {
      return bActive - aActive
    }

    return (b.started_at || b.ended_at || b.run_id || 0) - (a.started_at || a.ended_at || a.run_id || 0)
  })[0]!
}

function tenantRowFromTask(
  task: TenantLoopTask,
  depths: Map<string, number>,
  workers: readonly LoopWorkerActivity[] = []
): LoopRow {
  const parents = taskParents(task)
  const children = taskChildren(task)
  const status = normalizedStatus(task.status)
  const latestRun = task.latest_run || null
  const workerActivity = task.worker_activity || latestWorkerForTask(task, workers)
  const latestRunActive = ACTIVE_STATUSES.has(normalizedStatus(latestRun?.status))
  const latestWorkerActive = ACTIVE_STATUSES.has(normalizedStatus(workerActivity?.status))
  const unfinishedRunnable = RUNNABLE_STATUSES.has(status) && !COMPLETE_STATUSES.has(status)
  const planningNode = task.is_planning_node === true

  return {
    active: planningNode
      ? Boolean(task.active)
      : ACTIVE_STATUSES.has(status) || latestRunActive || latestWorkerActive || Boolean(task.current_run_id),
    assignee: task.assignee,
    branchKind: task.branch_kind,
    body: task.body,
    childCount: children.length || task.child_count || task.children_count || 0,
    children,
    commentCount: task.comment_count || 0,
    depth: depths.get(task.id) || 0,
    externalChildTasks: task.external_child_tasks || [],
    externalParentTasks: task.external_parent_tasks || [],
    decisionGroupId: task.decision_group_id,
    executionTaskId: task.execution_task_id,
    frontier: planningNode ? Boolean(task.frontier) : unfinishedRunnable,
    latestRun,
    latestSummary:
      task.latest_summary || workerActivity?.summary || workerActivity?.summary_preview || latestRun?.summary || null,
    loopIntake: task.loop_intake || null,
    loopHandoffs: task.loop_handoffs || [],
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
    planningNode,
    priority: task.priority,
    rawTask: task,
    reviewKind: task.review_kind,
    resumeMode: task.resume_mode,
    reviewSubjectAssignee: task.review_subject_assignee,
    selectionState: task.selection_state,
    result: task.result,
    sourceSessionId: task.session_id,
    foregroundParentSessionId: task.foreground_parent_session_id,
    foregroundForkSessionId: task.foreground_fork_session_id,
    status,
    suggestedOwner: task.suggested_owner,
    taskId: task.id,
    tenant: task.tenant,
    title: task.title || task.id,
    workerActivity,
    workspaceKind: task.workspace_kind,
    workspacePath: task.workspace_path
  }
}

export function deriveLoopPanelStateFromTenantSource(
  source: TenantLoopSource | null | undefined
): LoopPanelState | null {
  if (!source) {
    return null
  }

  const sourceTasks = [...(source.tasks || []), ...(source.planning_nodes || [])].filter(
    task => task.id && (source.include_archived || !ARCHIVED_STATUSES.has(normalizedStatus(task.status)))
  )

  const tasks = compactLockedPlanningOptions(source, sourceTasks)

  const depths = depthByTaskId(tasks)
  const rows = tasks.map(task => tenantRowFromTask(task, depths, source.workers || []))
  const rootTaskId = inferLoopRootTaskIdFromTenantSource(source, tasks)

  return {
    message: '',
    rawJson: rawJson(source),
    revision: source.latest_event_id || 0,
    rootTaskId,
    rows,
    sourceNow: source.now,
    status: 'ready'
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

  const parents = stringArrayField(node, 'parents')

  return {
    active: booleanField(node, 'active'),
    branchKind: stringField(node, 'branch_kind') || undefined,
    body: stringField(node, 'body') || undefined,
    childCount: numberField(node, 'child_count'),
    children: stringArrayField(node, 'children'),
    commentCount: numberField(node, 'comment_count'),
    depth: numberField(node, 'depth'),
    decisionGroupId: stringField(node, 'decision_group_id') || undefined,
    executionTaskId: stringField(node, 'execution_task_id') || undefined,
    frontier: booleanField(node, 'frontier'),
    parentCount: parents.length || numberField(node, 'parent_count'),
    parents,
    planningNode: booleanField(node, 'is_plan_node') || booleanField(node, 'is_planning_node'),
    priority: numberField(node, 'priority') || undefined,
    selectionState: stringField(node, 'selection_state') || undefined,
    status: stringField(node, 'status') || 'triage',
    suggestedOwner: stringField(node, 'suggested_owner') || undefined,
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
