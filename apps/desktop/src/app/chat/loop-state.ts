import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'

export type LoopPanelStatus = 'error' | 'ready' | 'stale'

export interface LoopRow {
  active: boolean
  assignee?: string
  childCount: number
  depth: number
  frontier: boolean
  parentCount: number
  parents: string[]
  status: string
  taskId: string
  title: string
}

export interface LoopPanelState {
  message: string
  rawJson: string
  revision: number
  rootTaskId: string
  rows: LoopRow[]
  status: LoopPanelStatus
}

export interface TenantLoopTask {
  assignee?: null | string
  child_count?: number
  children_count?: number
  completed_at?: null | number
  created_at?: number
  current_run_id?: null | number
  id: string
  included_child_ids?: string[]
  included_parent_ids?: string[]
  links?: {
    children?: string[]
    parents?: string[]
  }
  parent_count?: number
  parents_count?: number
  priority?: number
  profile?: null | string
  started_at?: null | number
  status: string
  title: string
}

export interface TenantLoopSource {
  include_archived?: boolean
  latest_event_id?: number
  lineage_session_ids?: string[]
  links?: { child_id?: string; parent_id?: string }[]
  now?: number
  session_id?: string
  tasks?: TenantLoopTask[]
  tenant?: null | string
  tenants?: string[]
}

const ARCHIVED_STATUSES = new Set(['archived'])
const COMPLETE_STATUSES = new Set(['done', 'complete', 'completed', 'cancelled', 'archived'])
const RUNNABLE_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress', 'todo'])
const ACTIVE_STATUSES = new Set(['ready', 'running', 'claimed', 'in_progress'])

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

function taskParents(task: TenantLoopTask, includedTaskIds?: Set<string>): string[] {
  const explicit = task.included_parent_ids || task.links?.parents || []

  return includedTaskIds ? explicit.filter(id => includedTaskIds.has(id)) : explicit
}

function taskChildren(task: TenantLoopTask, includedTaskIds?: Set<string>): string[] {
  const explicit = task.included_child_ids || task.links?.children || []

  return includedTaskIds ? explicit.filter(id => includedTaskIds.has(id)) : explicit
}

function isClosureOrReviewerTask(task: TenantLoopTask): boolean {
  const assignee = (task.assignee || '').toLowerCase()
  const title = task.title.toLowerCase()

  return (
    assignee.includes('reviewer') ||
    assignee.includes('qa') ||
    title.includes('review') ||
    title.includes('closure') ||
    title.includes('close out') ||
    title.includes('finalize')
  )
}

function isUnfinishedRunnableTask(task: TenantLoopTask): boolean {
  const status = normalizedStatus(task.status)

  return RUNNABLE_STATUSES.has(status) && !COMPLETE_STATUSES.has(status)
}

function sortKey(task: TenantLoopTask): string {
  const created = Number.isFinite(task.created_at) ? String(task.created_at).padStart(12, '0') : '999999999999'
  const priority = Number.isFinite(task.priority) ? String(999999 - (task.priority || 0)).padStart(6, '0') : '999999'

  return `${created}:${priority}:${task.id}`
}

export function orderTenantLoopRows(tasks: readonly TenantLoopTask[]): TenantLoopTask[] {
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const taskIds = new Set(taskById.keys())
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()

  for (const task of tasks) {
    incoming.set(task.id, new Set(taskParents(task, taskIds)))
    outgoing.set(task.id, new Set(taskChildren(task, taskIds)))
  }

  for (const task of tasks) {
    for (const parentId of taskParents(task, taskIds)) {
      outgoing.get(parentId)?.add(task.id)
      incoming.get(task.id)?.add(parentId)
    }

    for (const childId of taskChildren(task, taskIds)) {
      incoming.get(childId)?.add(task.id)
      outgoing.get(task.id)?.add(childId)
    }
  }

  const lastGroup = new Set(tasks.filter(isClosureOrReviewerTask).map(task => task.id))
  const ordered: TenantLoopTask[] = []
  const emitted = new Set<string>()

  function nextReady(): TenantLoopTask | null {
    const ready = tasks.filter(task => {
      if (emitted.has(task.id)) {
        return false
      }

      return [...(incoming.get(task.id) || [])].every(parentId => emitted.has(parentId))
    })

    ready.sort((a, b) => Number(lastGroup.has(a.id)) - Number(lastGroup.has(b.id)) || sortKey(a).localeCompare(sortKey(b)))

    return ready[0] || null
  }

  while (emitted.size < tasks.length) {
    const next = nextReady()

    if (!next) {
      break
    }

    ordered.push(next)
    emitted.add(next.id)
  }

  const remaining = tasks
    .filter(task => !emitted.has(task.id))
    .sort((a, b) => Number(lastGroup.has(a.id)) - Number(lastGroup.has(b.id)) || sortKey(a).localeCompare(sortKey(b)))

  return [...ordered, ...remaining]
}

function depthByTaskId(tasks: readonly TenantLoopTask[]): Map<string, number> {
  const depths = new Map<string, number>()
  const taskIds = new Set(tasks.map(task => task.id))
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()

  function depthFor(taskId: string): number {
    const cached = depths.get(taskId)

    if (cached !== undefined) {
      return cached
    }

    if (visiting.has(taskId)) {
      return 0
    }

    const task = byId.get(taskId)

    if (!task) {
      return 0
    }

    visiting.add(taskId)

    const parents = taskParents(task, taskIds)
    const depth = parents.length ? Math.max(...parents.map(parentId => depthFor(parentId))) + 1 : 0

    visiting.delete(taskId)
    depths.set(taskId, depth)

    return depth
  }

  for (const task of tasks) {
    depthFor(task.id)
  }

  return depths
}

function tenantRowFromTask(task: TenantLoopTask, depths: Map<string, number>, taskIds: Set<string>): LoopRow {
  const parents = taskParents(task, taskIds)
  const children = taskChildren(task, taskIds)
  const status = normalizedStatus(task.status)
  const unfinishedRunnable = isUnfinishedRunnableTask(task)
  const assignee = (task.assignee || task.profile || '').trim()

  return {
    active: ACTIVE_STATUSES.has(status) || Boolean(task.current_run_id),
    assignee: assignee || undefined,
    childCount: children.length || task.child_count || task.children_count || 0,
    depth: depths.get(task.id) || 0,
    frontier: unfinishedRunnable && parents.length === 0 ? true : unfinishedRunnable,
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
    status,
    taskId: task.id,
    title: task.title || task.id
  }
}

function tasksWithSourceLinks(source: TenantLoopSource): TenantLoopTask[] {
  const tasks = source.tasks || []
  const taskIds = new Set(tasks.map(task => task.id))
  const parentIds = new Map<string, string[]>()
  const childIds = new Map<string, string[]>()

  for (const link of source.links || []) {
    if (!link.parent_id || !link.child_id || !taskIds.has(link.parent_id) || !taskIds.has(link.child_id)) {
      continue
    }

    parentIds.set(link.child_id, [...(parentIds.get(link.child_id) || []), link.parent_id])
    childIds.set(link.parent_id, [...(childIds.get(link.parent_id) || []), link.child_id])
  }

  return tasks.map(task => ({
    ...task,
    included_child_ids: task.included_child_ids || childIds.get(task.id) || [],
    included_parent_ids: task.included_parent_ids || parentIds.get(task.id) || []
  }))
}

export function deriveLoopPanelStateFromTenantSource(source: TenantLoopSource | null | undefined): LoopPanelState | null {
  if (!source) {
    return null
  }

  const displayTasks = tasksWithSourceLinks(source).filter(task => !ARCHIVED_STATUSES.has(normalizedStatus(task.status)))
  const orderedTasks = orderTenantLoopRows(displayTasks)
  const depths = depthByTaskId(orderedTasks)
  const taskIds = new Set(orderedTasks.map(task => task.id))
  const rows = orderedTasks.map(task => tenantRowFromTask(task, depths, taskIds))
  const rootTaskId = source.tenant || source.session_id || source.lineage_session_ids?.[0] || ''

  return {
    message: '',
    rawJson: rawJson(source),
    revision: source.latest_event_id || 0,
    rootTaskId,
    rows,
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
    childCount: numberField(node, 'child_count'),
    depth: numberField(node, 'depth'),
    frontier: booleanField(node, 'frontier'),
    parentCount: parents.length || numberField(node, 'parent_count'),
    parents,
    status: stringField(node, 'status') || 'triage',
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
