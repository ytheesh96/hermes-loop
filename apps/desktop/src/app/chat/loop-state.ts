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

export interface LoopSpecificationFailure {
  backing_off?: boolean
  reason?: null | string
  retry_after?: null | number
  retry_after_seconds?: null | number
}

export interface TenantLoopTask {
  active_decomposition_child_count?: number
  age?: Record<string, null | number>
  assignee?: null | string
  body?: null | string
  child_count?: number
  children_count?: number
  comment_count?: number
  completed_at?: null | number
  created_at?: number
  created_by?: null | string
  current_run_id?: null | number
  current_step_key?: null | string
  diagnostics?: unknown[]
  external_child_tasks?: CompactLoopTask[]
  external_parent_tasks?: CompactLoopTask[]
  id: string
  included_child_ids?: string[]
  included_parent_ids?: string[]
  latest_run?: null | LoopLatestRun
  latest_summary?: null | string
  loop_intake?: null | LoopIntakeState
  links?: {
    children?: string[]
    parents?: string[]
  }
  parent_count?: number
  parents_count?: number
  priority?: number
  needs_specification?: boolean
  result?: null | string
  session_id?: null | string
  specification_failure?: null | LoopSpecificationFailure
  review_kind?: null | string
  resume_mode?: null | string
  review_subject_assignee?: null | string
  started_at?: null | number
  status: string
  suggested_owner?: null | string
  tenant?: null | string
  title: string
  warnings?: unknown
  workflow_id?: null | string
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
  /** Deprecated response-read fallback from runtimes predating workflow ids. */
  root_task_id?: null | string
  session_id?: string
  tasks?: TenantLoopTask[]
  tenant?: null | string
  tenants?: string[]
  workflow_id?: null | string
  workflow_ids?: string[]
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
  activeDecompositionChildCount?: number
  assignee?: null | string
  body?: null | string
  childCount: number
  children: string[]
  commentCount: number
  depth: number
  externalChildTasks?: CompactLoopTask[]
  externalParentTasks?: CompactLoopTask[]
  latestRun?: null | LoopLatestRun
  latestSummary?: null | string
  loopIntake?: null | LoopIntakeState
  needsSpecification?: boolean
  parentCount: number
  parents: string[]
  priority?: number
  rawTask?: TenantLoopTask
  reviewKind?: null | string
  resumeMode?: null | string
  reviewSubjectAssignee?: null | string
  result?: null | string
  sourceSessionId?: null | string
  status: string
  suggestedOwner?: null | string
  specificationFailure?: null | LoopSpecificationFailure
  taskId: string
  tenant?: null | string
  title: string
  unfinishedParentCount?: number
  workerActivity?: null | LoopWorkerActivity
  workflowId?: null | string
  workspaceKind?: null | string
  workspacePath?: null | string
}

export type LoopTaskPhase =
  | 'planning'
  | 'running'
  | 'specification_failed'
  | 'specification_retrying'
  | 'specifying'
  | 'waiting'

const EDITABLE_DEPENDENCY_STATUSES = new Set(['scheduled', 'todo', 'triage'])

export function loopTaskAllowsDependencyEdits(row: Pick<LoopRow, 'activeDecompositionChildCount' | 'status'>): boolean {
  return (
    (row.activeDecompositionChildCount || 0) === 0 &&
    EDITABLE_DEPENDENCY_STATUSES.has((row.status || '').trim().toLowerCase().replaceAll('-', '_'))
  )
}

export function loopTaskAllowsDependencySource(row: Pick<LoopRow, 'activeDecompositionChildCount'>): boolean {
  return (row.activeDecompositionChildCount || 0) === 0
}

export function loopTaskPhase(row: LoopRow): LoopTaskPhase | null {
  const status = (row.status || '').trim().toLowerCase().replaceAll('-', '_')

  const runStatus = (row.latestRun?.status || row.workerActivity?.status || '')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')

  if (
    ['claimed', 'in_progress', 'running'].includes(status) ||
    ['claimed', 'in_progress', 'running'].includes(runStatus)
  ) {
    return 'running'
  }

  const needsSpecification = row.needsSpecification === true

  if (row.specificationFailure) {
    return row.specificationFailure.backing_off ? 'specification_retrying' : 'specification_failed'
  }

  if (needsSpecification && status === 'triage') {
    return 'specifying'
  }

  if (status === 'todo' && (row.unfinishedParentCount || 0) > 0) {
    return 'waiting'
  }

  if (status === 'scheduled' && (needsSpecification || row.loopIntake?.needed === true)) {
    return 'planning'
  }

  return null
}

export function loopTaskPhaseLabel(row: LoopRow): string | null {
  const phase = loopTaskPhase(row)

  return phase
    ? {
        planning: 'Planning',
        running: 'Running',
        specification_failed: 'Specification failed',
        specification_retrying: 'Retrying specification',
        specifying: 'Specifying',
        waiting: 'Waiting for dependencies'
      }[phase]
    : null
}

export interface LoopPanelState {
  message: string
  rawJson: string
  revision: number
  rows: LoopRow[]
  sourceNow?: number
  status: LoopPanelStatus
  workflowId: string
  workflowIds: string[]
}

const ARCHIVED_STATUSES = new Set(['archived'])
const COMPLETE_STATUSES = new Set(['done', 'complete', 'completed', 'cancelled', 'archived'])
const ACTIVE_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress'])
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

export function workflowIdsFromTenantSource(
  source: TenantLoopSource,
  tasks: readonly TenantLoopTask[] = source.tasks || []
): string[] {
  const canonical = Array.from(
    new Set(
      [
        ...(source.workflow_ids || []),
        source.workflow_id,
        ...tasks.map(task => task.workflow_id)
      ].filter((value): value is string => Boolean(value?.trim()))
    )
  )

  if (canonical.length > 0) {
    return canonical
  }

  // Narrow response-read compatibility for older runtimes. The value is
  // treated as a workflow identity, never as a privileged task.
  return source.root_task_id?.trim() ? [source.root_task_id.trim()] : []
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
  workers: readonly LoopWorkerActivity[] = [],
  taskById: ReadonlyMap<string, TenantLoopTask> = new Map()
): LoopRow {
  const parents = taskParents(task)
  const children = taskChildren(task)
  const externalParentById = new Map((task.external_parent_tasks || []).map(parent => [parent.id, parent]))
  const status = normalizedStatus(task.status)
  const latestRun = task.latest_run || null
  const workerActivity = task.worker_activity || latestWorkerForTask(task, workers)
  const latestRunActive = ACTIVE_STATUSES.has(normalizedStatus(latestRun?.status))
  const latestWorkerActive = ACTIVE_STATUSES.has(normalizedStatus(workerActivity?.status))

  return {
    active: ACTIVE_STATUSES.has(status) || latestRunActive || latestWorkerActive || Boolean(task.current_run_id),
    activeDecompositionChildCount: task.active_decomposition_child_count || 0,
    assignee: task.assignee,
    body: task.body,
    childCount: children.length || task.child_count || task.children_count || 0,
    children,
    commentCount: task.comment_count || 0,
    depth: depths.get(task.id) || 0,
    externalChildTasks: task.external_child_tasks || [],
    externalParentTasks: task.external_parent_tasks || [],
    latestRun,
    latestSummary:
      task.latest_summary || workerActivity?.summary || workerActivity?.summary_preview || latestRun?.summary || null,
    loopIntake: task.loop_intake || null,
    needsSpecification: task.needs_specification,
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
    priority: task.priority,
    rawTask: task,
    reviewKind: task.review_kind,
    resumeMode: task.resume_mode,
    reviewSubjectAssignee: task.review_subject_assignee,
    result: task.result,
    sourceSessionId: task.session_id,
    status,
    suggestedOwner: task.suggested_owner,
    specificationFailure: task.specification_failure || null,
    taskId: task.id,
    tenant: task.tenant,
    title: task.title || task.id,
    unfinishedParentCount: parents.filter(parentId => {
      const parent = taskById.get(parentId) || externalParentById.get(parentId)

      return !parent || !COMPLETE_STATUSES.has(normalizedStatus(parent.status))
    }).length,
    workerActivity,
    workflowId: task.workflow_id,
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

  const tasks = (source.tasks || []).filter(
    task => task.id && (source.include_archived || !ARCHIVED_STATUSES.has(normalizedStatus(task.status)))
  )

  const workflowIds = workflowIdsFromTenantSource(source, tasks)
  const workflowId = source.workflow_id?.trim() || (workflowIds.length === 1 ? workflowIds[0]! : '')
  const depths = depthByTaskId(tasks)
  const taskById = new Map((source.tasks || []).map(task => [task.id, task]))

  const rows = tasks.map(task => ({
    ...tenantRowFromTask(task, depths, source.workers || [], taskById),
    workflowId: task.workflow_id || workflowId || null
  }))

  return {
    message: '',
    rawJson: rawJson(source),
    revision: source.latest_event_id || 0,
    rows,
    sourceNow: source.now,
    status: 'ready',
    workflowId,
    workflowIds
  }
}
