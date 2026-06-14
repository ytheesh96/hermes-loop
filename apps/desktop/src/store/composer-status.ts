import { atom, computed } from 'nanostores'

import type { LoopWorkerActivity, TenantLoopSource, TenantLoopTask } from '@/app/chat/loop-state'
import type { TodoItem, TodoStatus } from '@/lib/todos'

import { $gateway } from './gateway'
import { $subagentsBySession, type SubagentProgress } from './subagents'
import { $todosBySession } from './todos'

/** Composer status stack feed — merged todos, Kanban, subagents, background per session. */
export type StatusItemState = 'done' | 'failed' | 'running'
export type StatusItemType = 'background' | 'kanban-agent' | 'subagent' | 'todo'

export interface ComposerStatusItem {
  /** background: non-zero exit shown inline when failed. */
  exitCode?: number
  /** subagent: active tool label shown on the right. */
  currentTool?: string
  id: string
  /** background process: captured stdout/stderr tail for the inline viewer. */
  output?: string
  /** Kanban/Loop task id. Row click focuses the durable task in the Loop side panel. */
  kanbanTaskId?: string
  /** Kanban worker run id for the durable agent row. */
  runId?: number
  /** subagent: its own stored session id — row click opens that session window
   *  (livestreamed by the gateway's child-session mirror). Kanban-agent rows
   *  use the same field for their durable worker session transcript when the
   *  backend recorded one. */
  sessionId?: string
  state: StatusItemState
  title: string
  /** todo: the full four-state status driving the row's checkmark glyph. */
  todoStatus?: TodoStatus
  type: StatusItemType
}

// Writable source for background work, synced from the gateway's process
// registry (`terminal(background=true)` spawns) via `process.list`.
export const $backgroundStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})

// Durable Loop/Kanban activity derived from the kanban dashboard session-source
// payload. Kept separate from delegate_task subagents so the UI can present the
// same click-through grammar without implying these are synchronous children.
export const $kanbanStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})

// Rows the user X-ed away. The registry keeps finished processes around for a
// while, so without this every refresh would resurrect a dismissed row.
const dismissedBySession = new Map<string, Set<string>>()

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
const PENDING_KANBAN_TASK_STATUSES = new Set(['queued', 'ready', 'scheduled', 'todo', 'triage'])
const DONE_KANBAN_TASK_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])
const FAILED_KANBAN_RUN_STATES = new Set(['crashed', 'error', 'failed', 'gave_up', 'interrupted', 'spawn_failed', 'timed_out', 'timeout'])

const normalized = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase().replaceAll('-', '_') : '')

const taskParentIds = (task: TenantLoopTask): string[] => task.included_parent_ids || task.links?.parents || []

const isRootKanbanTask = (task: TenantLoopTask): boolean => taskParentIds(task).length === 0

const kanbanTaskTodoStatus = (task: TenantLoopTask): TodoStatus => {
  const status = normalized(task.status)

  if (DONE_KANBAN_TASK_STATUSES.has(status)) {
    return 'completed'
  }

  if (PENDING_KANBAN_TASK_STATUSES.has(status)) {
    return 'pending'
  }

  return 'in_progress'
}

const kanbanTaskToItem = (task: TenantLoopTask): ComposerStatusItem => {
  const todoStatus = kanbanTaskTodoStatus(task)

  return {
    id: `kanban-task:${task.id}`,
    kanbanTaskId: task.id,
    state: todoStatus === 'completed' ? 'done' : 'running',
    title: task.title || task.id,
    todoStatus,
    type: 'todo'
  }
}

const workerAttentionText = (worker: LoopWorkerActivity): string =>
  [worker.summary, worker.summary_preview, worker.error, worker.error_preview, worker.outcome, worker.status, worker.task_status]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()

const workerNeedsForegroundAttention = (worker: LoopWorkerActivity): boolean => {
  const status = normalized(worker.status)
  const outcome = normalized(worker.outcome)
  const taskStatus = normalized(worker.task_status)
  const text = workerAttentionText(worker)

  return (
    taskStatus === 'blocked' ||
    status === 'blocked' ||
    outcome === 'blocked' ||
    FAILED_KANBAN_RUN_STATES.has(status) ||
    FAILED_KANBAN_RUN_STATES.has(outcome) ||
    text.includes('review-required') ||
    text.includes('review required') ||
    text.includes('human approval') ||
    text.includes('needs approval')
  )
}

const workerIsActive = (worker: LoopWorkerActivity): boolean => {
  const status = normalized(worker.status)
  const taskStatus = normalized(worker.task_status)

  return ACTIVE_KANBAN_TASK_STATUSES.has(status) || ACTIVE_KANBAN_TASK_STATUSES.has(taskStatus)
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

const kanbanWorkerToItem = (worker: LoopWorkerActivity): ComposerStatusItem => ({
  currentTool: [worker.profile, worker.status || worker.outcome].filter(Boolean).join(' · ') || undefined,
  id: `kanban-agent:${worker.task_id}:${worker.run_id}`,
  kanbanTaskId: worker.task_id,
  output: worker.log_tail || worker.summary || worker.summary_preview || worker.error || worker.error_preview || undefined,
  runId: worker.run_id,
  sessionId: worker.worker_session_id || undefined,
  state: kanbanWorkerState(worker),
  title: worker.task_title || worker.task_id,
  type: 'kanban-agent'
})

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

export function reconcileKanbanSessionSource(sid: string, source: TenantLoopSource | null | undefined) {
  if (!sid) {
    return
  }

  if (!source) {
    writeKanbanStatus(sid, [])

    return
  }

  const visibleTasks = (source.tasks || []).filter(task => task.id && normalized(task.status) !== 'archived')
  const rootTask = visibleTasks.find(isRootKanbanTask) || visibleTasks[0]
  const tasks = rootTask ? [kanbanTaskToItem(rootTask)] : []

  const rootTaskId = rootTask?.id

  const agents = (source.workers || [])
    .filter(worker => worker.task_id && Number.isFinite(worker.run_id) && worker.task_id !== rootTaskId)
    .filter(worker => workerIsActive(worker) || workerNeedsForegroundAttention(worker))
    .map(kanbanWorkerToItem)

  writeKanbanStatus(sid, [...tasks, ...agents])
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
  const displaySessionId = activeSessionId || sourceSessionId || ''

  if (!displaySessionId) {
    return
  }

  if (sourceSessionId && sourceSessionId !== displaySessionId) {
    writeKanbanStatus(sourceSessionId, [])
  }

  reconcileKanbanSessionSource(displaySessionId, source)
}

// The single thing the stack reads: a typed, merged item list per session.
export const $statusItemsBySession = computed(
  [$subagentsBySession, $backgroundStatusBySession, $todosBySession, $kanbanStatusBySession],
  (subs, background, todos, kanban) => {
    const out: Record<string, ComposerStatusItem[]> = {}

    const push = (sid: string, items: ComposerStatusItem[]) => {
      if (items.length > 0) {
        out[sid] = out[sid] ? [...out[sid], ...items] : items
      }
    }

    for (const [sid, list] of Object.entries(todos)) {
      push(sid, list.map(todoToItem))
    }

    for (const [sid, list] of Object.entries(kanban)) {
      push(sid, list)
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
const TYPE_ORDER: readonly StatusItemType[] = ['todo', 'subagent', 'kanban-agent', 'background']

export interface StatusGroup {
  items: ComposerStatusItem[]
  type: StatusItemType
}

export function groupStatusItems(items: readonly ComposerStatusItem[]): StatusGroup[] {
  const byType = new Map<StatusItemType, ComposerStatusItem[]>()

  for (const item of items) {
    const list = byType.get(item.type)

    if (list) {
      list.push(item)
    } else {
      byType.set(item.type, [item])
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
  const dismissed = dismissedBySession.get(sid) ?? new Set<string>()
  dismissed.add(id)
  dismissedBySession.set(sid, dismissed)

  const list = $backgroundStatusBySession.get()[sid] ?? []

  writeBackground(
    sid,
    list.filter(item => item.id !== id)
  )
}

/** X on a running row: kill the process for real, then drop the row. */
export function stopBackgroundProcess(sid: string, id: string) {
  void $gateway
    .get()
    ?.request('process.kill', { process_id: id, session_id: sid })
    .catch(() => undefined)
  dismissBackgroundProcess(sid, id)
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
