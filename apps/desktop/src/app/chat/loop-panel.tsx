import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useMemo,
  useState
} from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { CompactLoopTask, LoopPanelState, LoopPanelStatus, LoopRow, LoopTaskDetail, TenantLoopTask } from './loop-state'

export type LoopTaskAction = 'block' | 'decompose' | 'details' | 'kanban' | 'logs' | 'park' | 'start' | 'unblock'

const LOOP_PANEL_DEFAULT_WIDTH = 352
const LOOP_PANEL_MIN_WIDTH = 256
const LOOP_PANEL_MAX_WIDTH = 560
const LOOP_PANEL_RESIZE_STEP = 16

function clampLoopPanelWidth(width: number): number {
  const viewportMax = typeof window === 'undefined' ? LOOP_PANEL_MAX_WIDTH : Math.max(LOOP_PANEL_MIN_WIDTH, Math.min(LOOP_PANEL_MAX_WIDTH, window.innerWidth * 0.58))

  return Math.min(viewportMax, Math.max(LOOP_PANEL_MIN_WIDTH, Math.round(width)))
}

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
    externalChildTasks: task.external_child_tasks,
    externalParentTasks: task.external_parent_tasks,
    frontier: false,
    latestRun,
    latestSummary: task.latest_summary || latestRun?.summary || null,
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
    priority: task.priority,
    rawTask: task,
    result: task.result,
    sourceSessionId: task.session_id,
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

function priorityNeedsAttention(priority?: number): boolean {
  return typeof priority === 'number' && Number.isFinite(priority) && priority > 0
}

function LoopPriorityIndicator({ row }: { row: LoopRow }) {
  if (!priorityNeedsAttention(row.priority)) {
    return null
  }

  return (
    <span
      aria-label={`Priority: ${row.priority}`}
      className="grid w-3 shrink-0 place-items-center text-[0.65rem] leading-none text-amber-500"
      role="img"
      title={`Priority: ${row.priority}`}
    >
      <span aria-hidden="true">◆</span>
    </span>
  )
}

function LoopRelationCount({ count, label }: { count: number; label: string }) {
  if (count <= 0) {
    return null
  }

  return (
    <span
      aria-label={`${label}: ${count}`}
      className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.62rem] leading-none text-(--ui-text-tertiary)"
      role="img"
      title={`${label}: ${count}`}
    >
      {count}
    </span>
  )
}

function LoopStackRow({ onSelect, row, selected }: LoopStackRowProps) {
  const blockedByCount = row.parents.length || row.parentCount
  const blockingCount = row.children.length || row.childCount
  const followUpCount = row.childCount || row.children.length

  return (
    <div data-testid={`loop-card-${row.taskId}`}>
      <StatusRow
        className={cn(selected && 'bg-(--ui-row-hover-background)')}
        leading={<LoopStatusIndicator row={row} />}
        onActivate={() => onSelect(row.taskId)}
      >
        <LoopPriorityIndicator row={row} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[0.73rem] leading-4',
            selected ? 'text-foreground/92' : 'text-muted-foreground/75'
          )}
          data-testid={`loop-card-title-${row.taskId}`}
          title={row.title}
        >
          {row.title}
        </span>
        <span className="shrink-0 font-mono text-[0.62rem] text-(--ui-text-quaternary)" title={row.taskId}>
          {row.taskId}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <LoopRelationCount count={blockedByCount} label="Blocked by" />
          <LoopRelationCount count={blockingCount} label="Blocking" />
          <LoopRelationCount count={followUpCount} label="Children/follow-ups" />
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
  onRefresh?: () => void
  onSelectTaskId: (taskId: string) => void
  refreshing?: boolean
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

export function LoopTaskStack({ onRefresh, onSelectTaskId, refreshing = false, selectedTaskId, state }: LoopTaskStackProps) {
  const selected = useMemo(() => selectedRowFrom(state, selectedTaskId), [selectedTaskId, state])
  const collapsedAttentionRows = useMemo(() => attentionRows(state?.rows || []), [state])

  if (!state || state.rows.length === 0) {
    return null
  }

  return (
    <StatusSection
      accessory={
        onRefresh ? (
          <Button
            aria-label="Refresh Loop tasks"
            disabled={refreshing}
            onClick={onRefresh}
            size="micro"
            title="Refresh Loop tasks"
            type="button"
            variant="text"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        ) : null
      }
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
  onRefresh?: () => void
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

const INTERNAL_MARKDOWN_FIELD = /^(?:assignee|attachments|children|comments|completed_at|created_at|created_by|current_run_id|current_step_key|diagnostics|events|id|latest_run|latest_summary|links|metadata|parent_count|parents|priority|result|runs|session_id|started_at|status|tenant|warnings|workspace_kind|workspace_path)\s*:/i

function cleanTaskMarkdown(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  let start = 0

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')

    if (end > 0) {
      start = end + 1
    }
  }

  const cleaned: string[] = []
  let inFence = false

  for (const line of lines.slice(start)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      cleaned.push(line)

      continue
    }

    if (!inFence && INTERNAL_MARKDOWN_FIELD.test(line.trim())) {
      continue
    }

    cleaned.push(line)
  }

  return cleaned.join('\n').replace(/^\n+|\n+$/g, '')
}

function relatedTaskById(taskId: string, relatedTasks?: CompactLoopTask[]): CompactLoopTask | null {
  return relatedTasks?.find(task => task.id === taskId) || null
}

interface DependencyLinksProps {
  emptyCopy: string
  ids: string[]
  label: string
  onSelectTaskId?: (taskId: string) => void
  relatedTasks?: CompactLoopTask[]
  rowById: Map<string, LoopRow>
}

function DependencyLinks({ emptyCopy, ids, label, onSelectTaskId, relatedTasks, rowById }: DependencyLinksProps) {
  if (ids.length === 0) {
    return <EmptyDetail>{emptyCopy}</EmptyDetail>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map(taskId => {
        const row = rowById.get(taskId)
        const related = relatedTaskById(taskId, relatedTasks)
        const status = related?.status || row?.status
        const archived = status?.toLowerCase() === 'archived'
        const unavailable = !row && !related

        return (
          <Button
            aria-label={`Select ${label} task ${taskId}`}
            className="h-auto max-w-full px-2 py-1 text-left font-mono text-[0.68rem]"
            disabled={!onSelectTaskId}
            key={taskId}
            onClick={() => onSelectTaskId?.(taskId)}
            type="button"
            variant="secondary"
          >
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate">{related?.title || relationTitle(taskId, rowById)}</span>
              {related && related.title !== taskId && <span className="truncate text-[0.6rem] text-(--ui-text-tertiary)">{taskId}</span>}
              {archived && <span className="text-[0.6rem] text-amber-600 dark:text-amber-300">Archived</span>}
              {archived && !row && <span className="text-[0.6rem] text-(--ui-text-tertiary)">Archived task details unavailable</span>}
              {unavailable && <span className="text-[0.6rem] text-(--ui-text-tertiary)">Task details unavailable</span>}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

function copyTaskId(taskId: string): void {
  void navigator.clipboard?.writeText(taskId)
}

function LoopTaskActions({
  onRefresh,
  onTaskAction,
  row
}: {
  onRefresh?: () => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="loop-task-actions">
      <Button
        aria-label={`Copy ID for ${row.taskId}`}
        className="h-7 px-2 text-xs"
        onClick={() => copyTaskId(row.taskId)}
        type="button"
        variant="outline"
      >
        Copy ID
      </Button>
      <Button
        aria-label={`Open source task/details for ${row.taskId}`}
        className="h-7 px-2 text-xs"
        disabled={!onTaskAction}
        onClick={() => onTaskAction?.('details', row)}
        type="button"
        variant="outline"
      >
        Open source task/details
      </Button>
      <Button
        aria-label={`Refresh details for ${row.taskId}`}
        className="h-7 px-2 text-xs"
        disabled={!onRefresh}
        onClick={onRefresh}
        type="button"
        variant="outline"
      >
        Refresh
      </Button>
    </div>
  )
}

function descriptionHasMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\[[^\]]+\]\([^)]+\)|- \[[ xX]\])/m.test(text) || /`[^`]+`/.test(text)
}

function TaskDescription({ text }: { text: string }) {
  const cleanedText = cleanTaskMarkdown(text)

  if (!cleanedText.trim()) {
    return <EmptyDetail>No description provided.</EmptyDetail>
  }

  return descriptionHasMarkdown(cleanedText) ? (
    <CompactMarkdown text={cleanedText} />
  ) : (
    <p className="m-0 whitespace-pre-wrap text-(--ui-text-secondary)">{cleanedText}</p>
  )
}

function lineageItems(row: LoopRow): string[] {
  return [
    row.sourceSessionId ? `Session: ${row.sourceSessionId}` : '',
    row.tenant ? `Tenant: ${row.tenant}` : '',
    row.assignee ? `Assignee: ${row.assignee}` : '',
    row.workspaceKind ? `Workspace: ${row.workspaceKind}` : '',
    row.workspacePath || ''
  ].filter(Boolean)
}

function LoopTaskDetails({
  backLabel,
  onBack,
  onRefresh,
  onSelectTaskId,
  onTaskAction,
  row,
  rowById
}: {
  backLabel?: null | string
  detail?: LoopTaskDetail | null
  onBack?: () => void
  onRefresh?: () => void
  onSelectTaskId?: (taskId: string) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
  rowById: Map<string, LoopRow>
}) {
  const lineage = lineageItems(row)

  return (
    <div className="grid gap-3">
      <DetailSection title="Header">
        <div className="grid gap-2">
          {backLabel && onBack && (
            <Button aria-label={`Back to ${backLabel}`} className="h-7 justify-start px-2 text-xs" onClick={onBack} type="button" variant="ghost">
              Back to {backLabel}
            </Button>
          )}
          <div className="flex items-center gap-2 font-medium text-(--ui-text-primary)">
            <LoopStatusIndicator row={row} />
            <LoopPriorityIndicator row={row} />
            <h3 className="m-0 min-w-0 truncate text-sm font-semibold text-(--ui-text-primary)">{row.title}</h3>
          </div>
          <div className="font-mono text-(--ui-text-tertiary)">{row.taskId}</div>
        </div>
      </DetailSection>

      <DetailSection title="Description">
        {row.body?.trim() ? <TaskDescription text={row.body} /> : <EmptyDetail>No description provided.</EmptyDetail>}
      </DetailSection>

      <DetailSection title="Lineage/source">
        {lineage.length ? (
          <dl className="m-0 grid gap-1 text-(--ui-text-secondary)">
            {lineage.map(item => (
              <div className="break-all" key={item}>{item}</div>
            ))}
          </dl>
        ) : (
          <EmptyDetail>No lineage or source details available.</EmptyDetail>
        )}
      </DetailSection>

      <DetailSection title="Blocked by">
        <DependencyLinks
          emptyCopy="Not blocked by any tasks."
          ids={row.parents}
          label="blocked by"
          onSelectTaskId={onSelectTaskId}
          relatedTasks={row.externalParentTasks}
          rowById={rowById}
        />
      </DetailSection>

      <DetailSection title="Blocking">
        <DependencyLinks
          emptyCopy="Not blocking other tasks."
          ids={row.children}
          label="blocking"
          onSelectTaskId={onSelectTaskId}
          relatedTasks={row.externalChildTasks}
          rowById={rowById}
        />
      </DetailSection>

      <DetailSection title="Decomposed children/follow-ups">
        <DependencyLinks
          emptyCopy="No decomposed children or follow-ups."
          ids={row.children}
          label="blocking"
          onSelectTaskId={onSelectTaskId}
          relatedTasks={row.externalChildTasks}
          rowById={rowById}
        />
      </DetailSection>

      <DetailSection title="Safe actions">
        <LoopTaskActions onRefresh={onRefresh} onTaskAction={onTaskAction} row={row} />
      </DetailSection>
    </div>
  )
}

export function LoopPanel({
  enableDebugJson = false,
  hidden = false,
  onHide,
  onRefresh,
  onSelectTaskId,
  onTaskAction,
  open = false,
  selectedTaskDetail,
  selectedTaskId,
  state
}: LoopPanelProps) {
  const [debugOpen, setDebugOpen] = useState(false)
  const [navigationStack, setNavigationStack] = useState<LoopRow[]>([])
  const [panelWidth, setPanelWidth] = useState(LOOP_PANEL_DEFAULT_WIDTH)

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

  const selectRelatedTask = useCallback((taskId: string) => {
    if (selected && selected.taskId !== taskId) {
      setNavigationStack(stack => [...stack, selected])
    }

    onSelectTaskId?.(taskId)
  }, [onSelectTaskId, selected])

  const goBack = useCallback(() => {
    const previous = navigationStack.at(-1)

    if (previous) {
      onSelectTaskId?.(previous.taskId)
      setNavigationStack(stack => stack.slice(0, -1))
    }
  }, [navigationStack, onSelectTaskId])

  const backTarget = navigationStack.at(-1)

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelWidth

    const onPointerMove = (moveEvent: PointerEvent) => {
      setPanelWidth(clampLoopPanelWidth(startWidth - (moveEvent.clientX - startX)))
    }

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp, { once: true })
  }, [panelWidth])

  const resizeByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setPanelWidth(width => clampLoopPanelWidth(width + LOOP_PANEL_RESIZE_STEP))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setPanelWidth(width => clampLoopPanelWidth(width - LOOP_PANEL_RESIZE_STEP))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPanelWidth(LOOP_PANEL_MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPanelWidth(clampLoopPanelWidth(LOOP_PANEL_MAX_WIDTH))
    }
  }, [])

  if (!state || hidden) {
    return null
  }

  return (
    <aside
      aria-hidden={false}
      className={cn(
        'relative row-start-1 min-w-0 shrink-0 overflow-hidden text-(--ui-text-secondary)',
        !open && 'hidden xl:block'
      )}
      data-layout="docked"
      data-modal="false"
      data-pane-id="loop-panel"
      data-pane-open={open ? 'true' : 'false'}
      data-pane-side="right"
      data-state={open ? 'open' : 'preview'}
      data-testid="loop-panel"
      style={{ gridColumn: '2 / 3', width: panelWidth }}
    >
      <div
        aria-label="Resize loop-panel"
        aria-orientation="vertical"
        className="group absolute bottom-0 left-0 top-0 z-20 w-1 -translate-x-1/2 cursor-col-resize [-webkit-app-region:no-drag]"
        onKeyDown={resizeByKeyboard}
        onPointerDown={startResize}
        role="separator"
        tabIndex={0}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--ui-stroke-secondary)" />
        <span className="absolute inset-y-0 left-1/2 w-(--vscode-sash-hover-size,0.25rem) -translate-x-1/2 bg-(--ui-sash-hover-border) opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>

      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-editor-surface-background) pt-(--titlebar-height)">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
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
                  backLabel={backTarget?.title}
                  detail={selectedTaskDetail}
                  onBack={backTarget ? goBack : undefined}
                  onRefresh={onRefresh}
                  onSelectTaskId={onSelectTaskId ? selectRelatedTask : undefined}
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
        </div>
      </div>
    </aside>
  )
}
