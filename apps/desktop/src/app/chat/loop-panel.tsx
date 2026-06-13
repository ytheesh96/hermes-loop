import { type ReactNode, useMemo, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { LoopPanelState, LoopPanelStatus, LoopRow, LoopTaskDetail, TenantLoopTask } from './loop-state'

export type LoopTaskAction = 'block' | 'decompose' | 'details' | 'kanban' | 'logs' | 'park' | 'start' | 'unblock'

function statusCopy(status: LoopPanelStatus): string {
  if (status === 'stale') {
    return 'Stale revision'
  }

  if (status === 'error') {
    return 'Error'
  }

  return 'Live draft'
}

function statusIndicatorClass(status: string): string {
  const value = status.toLowerCase()

  if (value === 'running' || value === 'in_progress' || value === 'claimed') {
    return 'size-1.5 bg-(--ui-accent) shadow-[0_0_0.625rem_color-mix(in_srgb,var(--ui-accent)_45%,transparent)]'
  }

  if (value === 'blocked' || value === 'stale') {
    return 'size-1.5 bg-amber-500'
  }

  if (value === 'error' || value === 'failed') {
    return 'size-1.5 bg-destructive'
  }

  if (value === 'done') {
    return 'size-1.5 bg-emerald-500/80'
  }

  return 'size-1 bg-(--ui-text-quaternary) opacity-80'
}

function LoopStatusIndicator({ row }: { row: LoopRow }) {
  return (
    <span
      aria-label={`Status: ${row.status}`}
      className="grid w-3.5 shrink-0 place-items-center overflow-hidden"
      role="img"
    >
      <span aria-hidden="true" className={cn('rounded-full', statusIndicatorClass(row.status))} />
    </span>
  )
}

function completedLoopRows(rows: LoopRow[]): number {
  return rows.filter(row => {
    const status = row.status.toLowerCase()

    return status === 'done' || status === 'complete' || status === 'completed'
  }).length
}

const TERMINAL_LOOP_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])
const FAILED_LOOP_STATUSES = new Set(['crashed', 'error', 'failed', 'failure', 'stale', 'timed_out', 'timeout'])

function normalizedLoopValue(value?: null | string): string {
  return (value || '').trim().toLowerCase().replaceAll('-', '_')
}

function attentionText(row: LoopRow): string {
  return [
    row.status,
    row.title,
    row.body,
    row.result,
    row.latestSummary,
    row.latestRun?.error,
    row.latestRun?.outcome,
    row.latestRun?.status,
    row.latestRun?.summary
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
}

function attentionReason(row: LoopRow): string {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)
  const runOutcome = normalizedLoopValue(row.latestRun?.outcome)
  const text = attentionText(row)

  if (status === 'blocked') {
    return row.childCount > 0 ? `Blocked · ${row.childCount} downstream` : 'Blocked'
  }

  if (FAILED_LOOP_STATUSES.has(status) || FAILED_LOOP_STATUSES.has(runStatus) || FAILED_LOOP_STATUSES.has(runOutcome)) {
    return 'Worker handoff failed'
  }

  if (text.includes('review-required') || text.includes('review required')) {
    return 'Review required'
  }

  if (text.includes('human approval') || text.includes('needs approval') || text.includes('user acceptance')) {
    return 'Approval needed'
  }

  if (status === 'foreground_handoff') {
    return 'Foreground handoff'
  }

  return 'Needs attention'
}

function attentionScore(row: LoopRow): number {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)
  const runOutcome = normalizedLoopValue(row.latestRun?.outcome)
  const text = attentionText(row)

  if (TERMINAL_LOOP_STATUSES.has(status) || status === 'running' || status === 'claimed' || status === 'in_progress') {
    return 0
  }

  let score = 0

  if (status === 'blocked') {
    score = 90
  } else if (FAILED_LOOP_STATUSES.has(status) || FAILED_LOOP_STATUSES.has(runStatus) || FAILED_LOOP_STATUSES.has(runOutcome)) {
    score = 88
  } else if (text.includes('review-required') || text.includes('review required')) {
    score = 82
  } else if (text.includes('human approval') || text.includes('needs approval') || text.includes('user acceptance')) {
    score = 78
  } else if (status === 'foreground_handoff') {
    score = 70
  }

  return score ? score + Math.min(row.childCount, 8) : 0
}

function attentionRows(rows: LoopRow[]): LoopRow[] {
  return rows
    .map((row, index) => ({ index, row, score: attentionScore(row) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.row.childCount - a.row.childCount || a.index - b.index)
    .map(item => item.row)
}

function idsFromTask(task: TenantLoopTask, key: 'children' | 'parents'): string[] {
  const includedKey = key === 'parents' ? 'included_parent_ids' : 'included_child_ids'
  const explicit = task[includedKey] || task.links?.[key] || []

  return Array.isArray(explicit) ? explicit : []
}

function latestRunFromTaskDetail(detail?: LoopTaskDetail | null): NonNullable<LoopTaskDetail['runs']>[number] | null {
  const runs = detail?.runs || []

  return runs.length ? runs[runs.length - 1]! : null
}

function detailRowFromTaskDetail(detail?: LoopTaskDetail | null, selectedTaskId?: null | string): LoopRow | null {
  const task = detail?.task

  if (!task || (selectedTaskId && task.id !== selectedTaskId)) {
    return null
  }

  const parents = detail?.links?.parents || idsFromTask(task, 'parents')
  const children = detail?.links?.children || idsFromTask(task, 'children')
  const latestRun = task.latest_run || latestRunFromTaskDetail(detail)
  const status = task.status?.trim().toLowerCase() || 'todo'

  return {
    active: Boolean(task.current_run_id),
    assignee: task.assignee,
    body: task.body,
    childCount: children.length || task.child_count || task.children_count || 0,
    children,
    commentCount: detail?.comments?.length ?? task.comment_count ?? 0,
    depth: 0,
    frontier: false,
    latestRun,
    latestSummary: task.latest_summary || latestRun?.summary || null,
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
    rawTask: task,
    result: task.result,
    status,
    taskId: task.id,
    tenant: task.tenant,
    title: task.title || task.id,
    workspaceKind: task.workspace_kind,
    workspacePath: task.workspace_path
  }
}

function selectedRowFrom(
  state: LoopPanelState | null,
  selectedTaskId?: null | string,
  selectedTaskDetail?: LoopTaskDetail | null
): LoopRow | null {
  if (!state) {
    return null
  }

  const detailRow = detailRowFromTaskDetail(selectedTaskDetail, selectedTaskId)

  if (detailRow) {
    return detailRow
  }

  if (selectedTaskId) {
    return state.rows.find(row => row.taskId === selectedTaskId) || null
  }

  return state.rows[0] || null
}

interface LoopStackRowProps {
  onSelect: (taskId: string) => void
  row: LoopRow
  selected: boolean
}

function isExpandedLoopTitleRow(row: LoopRow, selected: boolean): boolean {
  const status = row.status.toLowerCase()

  return selected || status === 'blocked' || status === 'foreground-handoff' || status === 'foreground_handoff'
}

function LoopStackRow({ onSelect, row, selected }: LoopStackRowProps) {
  const expandedTitle = isExpandedLoopTitleRow(row, selected)

  return (
    <div data-testid={`loop-card-${row.taskId}`}>
      <StatusRow
        className={cn(selected && 'bg-(--ui-row-hover-background)')}
        leading={<LoopStatusIndicator row={row} />}
        onActivate={() => onSelect(row.taskId)}
      >
        <span
          className={cn(
            'min-w-0 flex-1 text-[0.73rem] leading-4',
            expandedTitle ? 'line-clamp-2 whitespace-normal break-words' : 'truncate',
            selected ? 'text-foreground/92' : 'text-muted-foreground/75'
          )}
          data-testid={`loop-card-title-${row.taskId}`}
          title={row.title}
        >
          {row.title}
        </span>
      </StatusRow>
    </div>
  )
}

function LoopAttentionRow({ onSelect, row }: { onSelect: (taskId: string) => void; row: LoopRow }) {
  return (
    <StatusRow leading={<LoopStatusIndicator row={row} />} onActivate={() => onSelect(row.taskId)}>
      <span className="min-w-0 flex-1 text-[0.72rem] leading-4 text-foreground/85" title={row.title}>
        <span className="block truncate">{row.title}</span>
        <span className="block truncate text-[0.65rem] text-muted-foreground/70">{attentionReason(row)}</span>
      </span>
    </StatusRow>
  )
}

function LoopCollapsedAttentionQueue({ onSelectTaskId, rows }: { onSelectTaskId: (taskId: string) => void; rows: LoopRow[] }) {
  if (rows.length === 0) {
    return null
  }

  const visibleRows = rows.slice(0, 3)

  return (
    <div className="grid gap-0.5 rounded-lg border border-amber-500/25 bg-amber-500/8 px-1 py-1" data-testid="loop-attention-queue">
      <div className="px-1.5 pb-0.5 text-[0.67rem] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
        {rows.length} need attention
      </div>
      {visibleRows.map(row => (
        <LoopAttentionRow key={row.taskId} onSelect={onSelectTaskId} row={row} />
      ))}
    </div>
  )
}

interface LoopTaskStackProps {
  onSelectTaskId: (taskId: string) => void
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

export function LoopTaskStack({ onSelectTaskId, selectedTaskId, state }: LoopTaskStackProps) {
  const selected = useMemo(() => selectedRowFrom(state, selectedTaskId), [selectedTaskId, state])
  const collapsedAttentionRows = useMemo(() => attentionRows(state?.rows || []), [state])

  if (!state || state.rows.length === 0) {
    return null
  }

  return (
    <StatusSection
      collapsedContent={<LoopCollapsedAttentionQueue onSelectTaskId={onSelectTaskId} rows={collapsedAttentionRows} />}
      defaultCollapsed={false}
      icon={<Codicon className="text-muted-foreground/70" name="checklist" size="0.8rem" />}
      label={`Loop ${completedLoopRows(state.rows)}/${state.rows.length}`}
    >
      {state.rows.map(row => (
        <LoopStackRow
          key={row.taskId}
          onSelect={onSelectTaskId}
          row={row}
          selected={selected?.taskId === row.taskId}
        />
      ))}
    </StatusSection>
  )
}

interface LoopPanelProps {
  enableDebugJson?: boolean
  hidden?: boolean
  onHide?: () => void
  onSelectTaskId?: (taskId: string) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  open?: boolean
  selectedTaskDetail?: LoopTaskDetail | null
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs">
      <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">{title}</h3>
      {children}
    </section>
  )
}

function EmptyDetail({ children }: { children: ReactNode }) {
  return <p className="m-0 text-xs text-(--ui-text-tertiary)">{children}</p>
}

function relationTitle(taskId: string, rowById: Map<string, LoopRow>): string {
  return rowById.get(taskId)?.title || taskId
}

interface DependencyLinksProps {
  emptyCopy: string
  ids: string[]
  label: string
  onSelectTaskId?: (taskId: string) => void
  rowById: Map<string, LoopRow>
}

function DependencyLinks({ emptyCopy, ids, label, onSelectTaskId, rowById }: DependencyLinksProps) {
  if (ids.length === 0) {
    return <EmptyDetail>{emptyCopy}</EmptyDetail>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map(taskId => (
        <Button
          aria-label={`Select ${label} task ${taskId}`}
          className="h-auto max-w-full px-2 py-1 font-mono text-[0.68rem]"
          disabled={!onSelectTaskId}
          key={taskId}
          onClick={() => onSelectTaskId?.(taskId)}
          type="button"
          variant="secondary"
        >
          <span className="truncate">{relationTitle(taskId, rowById)}</span>
        </Button>
      ))}
    </div>
  )
}

function commentsCopy(row: LoopRow): string {
  if (row.commentCount <= 0) {
    return 'No comments yet.'
  }

  return `${row.commentCount} ${row.commentCount === 1 ? 'comment' : 'comments'} available in task detail`
}

function latestRunCopy(row: LoopRow): string {
  const run = row.latestRun

  if (!run) {
    return 'No run recorded yet.'
  }

  const id = run.id ? `#${run.id}` : row.taskId
  const status = run.status || run.outcome || 'unknown'
  const profile = run.profile ? ` · ${run.profile}` : ''

  return `Run ${id} · ${status}${profile}`
}

function normalizedRowStatus(row: LoopRow): string {
  return row.status.toLowerCase()
}

function actionsForRow(row: LoopRow): { action: LoopTaskAction; label: string; tone?: 'primary' }[] {
  const status = normalizedRowStatus(row)
  const terminal = status === 'done' || status === 'complete' || status === 'completed' || status === 'cancelled'
  const archived = status === 'archived'
  const actions: { action: LoopTaskAction; label: string; tone?: 'primary' }[] = []

  if (status === 'triage') {
    actions.push({ action: 'decompose', label: '⚗ Decompose', tone: 'primary' })
  } else if (status === 'blocked') {
    actions.push({ action: 'unblock', label: 'Unblock', tone: 'primary' })
  } else if (status === 'scheduled') {
    actions.push({ action: 'start', label: 'Start', tone: 'primary' })
  } else if (status === 'todo') {
    actions.push({ action: 'start', label: 'Start', tone: 'primary' })
  }

  if (!terminal && !archived && status !== 'blocked') {
    actions.push({ action: 'block', label: 'Block' })
  }

  if (!terminal && !archived && status !== 'scheduled') {
    actions.push({ action: 'park', label: 'Park' })
  }

  actions.push({ action: 'details', label: 'Details' })

  if (row.tenant || row.workspacePath || row.rawTask?.session_id) {
    actions.push({ action: 'kanban', label: 'Kanban' })
  }

  if (row.latestRun?.id || row.latestRun?.task_id) {
    actions.push({ action: 'logs', label: 'Logs' })
  }

  return actions
}

function actionAriaLabel(action: LoopTaskAction, label: string, row: LoopRow): string {
  if (action === 'details') {
    return `Open details for ${row.taskId}`
  }

  if (action === 'kanban') {
    return `Open Kanban for ${row.taskId}`
  }

  if (action === 'logs') {
    return `Open logs for ${row.taskId}`
  }

  return `${label.replace(/^⚗\s*/, '')} ${row.taskId}`
}

function LoopTaskActions({ onTaskAction, row }: { onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void; row: LoopRow }) {
  const actions = actionsForRow(row)

  if (!onTaskAction) {
    return <EmptyDetail>Task actions will appear here when enabled.</EmptyDetail>
  }

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="loop-task-actions">
      {actions.map(({ action, label, tone }) => (
        <Button
          aria-label={actionAriaLabel(action, label, row)}
          className="h-7 px-2 text-xs"
          key={action}
          onClick={() => onTaskAction(action, row)}
          type="button"
          variant={tone === 'primary' ? 'default' : 'outline'}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}

function LoopTaskDetails({
  detail,
  onSelectTaskId,
  onTaskAction,
  row,
  rowById
}: {
  detail?: LoopTaskDetail | null
  onSelectTaskId?: (taskId: string) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
  rowById: Map<string, LoopRow>
}) {
  const detailForRow = detail?.task?.id === row.taskId ? detail : null
  const comments = detailForRow?.comments || []

  return (
    <div className="grid gap-3">
      <DetailSection title="Task">
        <div className="grid gap-2">
          <div className="flex items-center gap-2 font-medium text-(--ui-text-primary)">
            <LoopStatusIndicator row={row} />
            <h3 className="m-0 min-w-0 truncate text-sm font-semibold text-(--ui-text-primary)">{row.title}</h3>
          </div>
          <div className="font-mono text-(--ui-text-tertiary)">{row.taskId}</div>
        </div>
      </DetailSection>

      <DetailSection title="Description">
        {row.body?.trim() ? <p className="m-0 whitespace-pre-wrap text-(--ui-text-secondary)">{row.body}</p> : <EmptyDetail>No description provided.</EmptyDetail>}
      </DetailSection>

      <DetailSection title="Parents">
        <DependencyLinks emptyCopy="No parent tasks." ids={row.parents} label="parent" onSelectTaskId={onSelectTaskId} rowById={rowById} />
        <div className="mt-2 text-(--ui-text-tertiary)">Parents: {row.parents.length ? row.parents.join(', ') : 'none'}</div>
      </DetailSection>

      <DetailSection title="Children">
        <DependencyLinks emptyCopy="No child tasks." ids={row.children} label="child" onSelectTaskId={onSelectTaskId} rowById={rowById} />
      </DetailSection>

      <DetailSection title="Comments">
        {comments.length ? (
          <div className="grid gap-2">
            {comments.map(comment => (
              <article className="grid gap-0.5" key={comment.id || `${comment.author}-${comment.created_at}`}>
                <div className="text-[0.68rem] text-(--ui-text-tertiary)">{comment.author || 'unknown'}</div>
                <p className="m-0 whitespace-pre-wrap text-(--ui-text-secondary)">{comment.body || 'No comment body.'}</p>
              </article>
            ))}
          </div>
        ) : (
          <EmptyDetail>{commentsCopy(row)}</EmptyDetail>
        )}
      </DetailSection>

      <DetailSection title="Latest run">
        <div className="grid gap-1 text-(--ui-text-secondary)">
          <div>{latestRunCopy(row)}</div>
          {row.latestRun?.summary && <div className="text-(--ui-text-tertiary)">{row.latestRun.summary}</div>}
        </div>
      </DetailSection>

      <DetailSection title="Result">
        {row.result?.trim() ? <p className="m-0 whitespace-pre-wrap text-(--ui-text-secondary)">{row.result}</p> : <EmptyDetail>No result recorded.</EmptyDetail>}
      </DetailSection>

      <DetailSection title="Summary">
        {row.latestSummary?.trim() ? <p className="m-0 whitespace-pre-wrap text-(--ui-text-secondary)">{row.latestSummary}</p> : <EmptyDetail>No summary recorded.</EmptyDetail>}
      </DetailSection>

      <DetailSection title="Metadata">
        <dl className="m-0 grid gap-1 text-(--ui-text-secondary)">
          <div>Assignee: {row.assignee || 'unassigned'}</div>
          <div>Workspace: {row.workspaceKind || 'unknown'}</div>
          {row.workspacePath && <div className="break-all font-mono text-(--ui-text-tertiary)">{row.workspacePath}</div>}
          {row.tenant && <div>Tenant: {row.tenant}</div>}
        </dl>
      </DetailSection>

      <DetailSection title="Safe actions">
        <LoopTaskActions onTaskAction={onTaskAction} row={row} />
      </DetailSection>
    </div>
  )
}

export function LoopPanel({
  enableDebugJson = false,
  hidden = false,
  onHide,
  onSelectTaskId,
  onTaskAction,
  open = false,
  selectedTaskDetail,
  selectedTaskId,
  state
}: LoopPanelProps) {
  const [debugOpen, setDebugOpen] = useState(false)

  const selected = useMemo(
    () => selectedRowFrom(state, selectedTaskId, selectedTaskDetail),
    [selectedTaskDetail, selectedTaskId, state]
  )

  const rowById = useMemo(() => {
    const rows = state?.rows || []
    const map = new Map(rows.map(row => [row.taskId, row]))
    const detailRow = detailRowFromTaskDetail(selectedTaskDetail, selectedTaskId)

    if (detailRow) {
      map.set(detailRow.taskId, detailRow)
    }

    return map
  }, [selectedTaskDetail, selectedTaskId, state])

  if (!state || hidden) {
    return null
  }

  return (
    <aside
      className={cn(
        'flex w-[min(22rem,45vw)] min-w-[14rem] shrink-0 flex-col border-l border-(--ui-stroke-secondary) bg-(--ui-sidebar-background) p-3 text-(--ui-text-secondary)',
        !open && 'hidden xl:flex'
      )}
      data-layout="docked"
      data-modal="false"
      data-state={open ? 'open' : 'preview'}
      data-testid="loop-panel"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-(--ui-text-primary)">Loop</h2>
          <p className="m-0 mt-0.5 text-xs text-(--ui-text-tertiary)">
            {statusCopy(state.status)} · rev {state.revision || '—'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state.rootTaskId && (
            <span className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)">
              {state.rootTaskId}
            </span>
          )}
          {onHide && (
            <Button aria-label="Hide Loop panel" className="size-7 p-0" onClick={onHide} type="button" variant="ghost">
              <Codicon name="close" size="0.875rem" />
            </Button>
          )}
        </div>
      </div>

      {state.message && (
        <div
          className={cn(
            'mb-3 rounded-lg border px-2 py-1.5 text-xs',
            state.status === 'stale'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          )}
        >
          {state.message}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <div className="grid gap-3">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Loop details</h3>
            <LoopTaskDetails
              detail={selectedTaskDetail}
              onSelectTaskId={onSelectTaskId}
              onTaskAction={onTaskAction}
              row={selected}
              rowById={rowById}
            />
          </div>
        ) : selectedTaskId ? (
          <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide">Selected task unavailable</h3>
            <p className="m-0">
              Task <span className="font-mono">{selectedTaskId}</span> is missing from the latest Loop source. It may have been archived,
              deleted, or refreshed out of this session lineage. Select another row or close the panel.
            </p>
          </section>
        ) : (
          <p className="m-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-tertiary)">
            No Loop rows yet. Ask Hermes to read or mutate the Loop graph.
          </p>
        )}
      </div>

      {enableDebugJson && (
        <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3">
          <Button className="h-7 px-2 text-xs" onClick={() => setDebugOpen(value => !value)} type="button" variant="ghost">
            {debugOpen ? 'Hide debug JSON' : 'Show debug JSON'}
          </Button>
          {debugOpen && (
            <pre className="mt-2 max-h-36 overflow-auto rounded border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) p-2 text-[0.65rem] text-(--ui-text-secondary)">
              {state.rawJson}
            </pre>
          )}
        </div>
      )}
    </aside>
  )
}
