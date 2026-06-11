export type WorkMapStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked'
export type WorkMapKind = 'goal' | 'decision' | 'session-step' | 'worker-task' | 'verification' | 'publish-gate'

export interface WorkMapItem {
  attention?: string
  content: string
  dispatchable?: boolean
  evidence?: string
  id: string
  kind: WorkMapKind
  kanban_task_id?: string
  parent_id?: string
  status: WorkMapStatus
  verification_state?: string
}

const STATUSES: readonly WorkMapStatus[] = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked']
const KINDS: readonly WorkMapKind[] = ['goal', 'decision', 'session-step', 'worker-task', 'verification', 'publish-gate']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const isStatus = (value: unknown): value is WorkMapStatus => (STATUSES as readonly string[]).includes(value as string)
const isKind = (value: unknown): value is WorkMapKind => (KINDS as readonly string[]).includes(value as string)
const isTruthy = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return false
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase())
}

function parseArray(value: unknown[]): WorkMapItem[] {
  return value.flatMap(item => {
    if (!isRecord(item) || !isStatus(item.status)) {
      return []
    }

    const id = String(item.id ?? '').trim()
    const content = String(item.content ?? '').trim()
    const kind = isKind(item.kind) ? item.kind : 'session-step'

    if (!id || !content) {
      return []
    }

    const out: WorkMapItem = { id, content, status: item.status, kind }

    for (const key of ['attention', 'evidence', 'kanban_task_id', 'parent_id', 'verification_state', 'dispatchable'] as const) {
      const raw = item[key]
      if (raw === undefined || raw === null) {
        continue
      }
      if (key === 'dispatchable') {
        out.dispatchable = isTruthy(raw)
        continue
      }
      const text = String(raw).trim()
      if (text) {
        out[key] = text as never
      }
    }

    return [out]
  })
}

function parse(value: unknown, depth: number): null | WorkMapItem[] {
  if (depth > 2) {
    return null
  }

  if (Array.isArray(value)) {
    return parseArray(value)
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      return parse(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }

  if (isRecord(value)) {
    if (Object.hasOwn(value, 'work_map')) {
      return parse(value.work_map, depth + 1)
    }
    if (Object.hasOwn(value, 'workMap')) {
      return parse(value.workMap, depth + 1)
    }
  }

  return null
}

export const parseWorkMap = (value: unknown): null | WorkMapItem[] => parse(value, 0)
