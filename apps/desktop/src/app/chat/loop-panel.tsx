import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { StatusItemRow } from '@/app/chat/composer/status-stack/status-row'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { DiffLines } from '@/components/chat/diff-lines'
import { StatusIndicator, type StatusIndicatorKind } from '@/components/chat/status-indicator'
import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { LogView } from '@/components/ui/log-view'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { desktopGitDiff } from '@/lib/desktop-fs'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import type { ComposerStatusItem, StatusItemState } from '@/store/composer-status'
import type { PreviewTarget } from '@/store/preview'

import { loopConnectedTaskIds } from './loop-state'
import type {
  LoopPanelState,
  LoopRow,
  LoopTaskComment,
  LoopTaskDetail,
  LoopTaskHandoff,
  LoopWorkerActivity,
  TenantLoopTask
} from './loop-state'
import { LocalFilePreview } from './right-rail/preview-file'

export type LoopTaskAction =
  | 'accept-review'
  | 'archive'
  | 'archive-loop'
  | 'ask-hermes'
  | 'block'
  | 'decompose'
  | 'details'
  | 'escalate-review'
  | 'kanban'
  | 'logs'
  | 'park'
  | 'reject-review'
  | 'start'
  | 'unblock'
  | 'worker-run'
  | 'worker-session'

type LoopTaskCommentSubmit = (taskId: string, body: string) => Promise<void> | void

export type LoopArtifactSourceKind = 'artifact' | 'changed-file' | 'source'

export interface LoopArtifactSourceEntry {
  id: string
  inlineDiff?: string
  kind: LoopArtifactSourceKind
  label: string
  sourceLabel: string
  target: string
}

type LoopArtifactDiffSource = 'git' | 'inline'
type LoopArtifactDiffStatus = 'empty' | 'error' | 'idle' | 'loading' | 'ready'
type LoopArtifactTabView = 'details' | 'diff' | 'preview'

const LOOP_PANEL_DEFAULT_WIDTH = 416
const LOOP_PANEL_MIN_WIDTH = 384
const LOOP_PANEL_MAX_WIDTH = 640
const LOOP_PANEL_RESIZE_STEP = 16
const LOOP_OVERVIEW_TAB_ID = 'loop-overview'

function clampLoopPanelWidth(width: number): number {
  const viewportMax =
    typeof window === 'undefined'
      ? LOOP_PANEL_MAX_WIDTH
      : Math.max(LOOP_PANEL_MIN_WIDTH, Math.min(LOOP_PANEL_MAX_WIDTH, window.innerWidth * 0.58))

  return Math.min(viewportMax, Math.max(LOOP_PANEL_MIN_WIDTH, Math.round(width)))
}

function loopRowStatusIndicator(row: LoopRow): StatusIndicatorKind {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)
  const runOutcome = normalizedLoopValue(row.latestRun?.outcome)
  const active = isActiveLoopRow(row) || row.active

  const failed =
    FAILED_LOOP_STATUSES.has(status) || FAILED_LOOP_STATUSES.has(runStatus) || FAILED_LOOP_STATUSES.has(runOutcome)

  const attention = attentionScore(row) > 0 && !failed

  if (attention) {
    return 'attention'
  }

  if (failed) {
    return 'failed'
  }

  if (active) {
    return 'active'
  }

  if (isDoneLoopRow(row)) {
    return 'done'
  }

  if (status === 'triage') {
    return 'triage'
  }

  if (isQueuedLoopRow(row)) {
    return 'pending'
  }

  return 'unknown'
}

function LoopStatusIndicator({ row }: { row: LoopRow }) {
  return <StatusIndicator ariaLabel={`Status: ${row.status}`} kind={loopRowStatusIndicator(row)} />
}

function completedLoopRows(rows: LoopRow[]): number {
  return rows.filter(row => {
    const status = row.status.toLowerCase()

    return status === 'done' || status === 'complete' || status === 'completed'
  }).length
}

const TERMINAL_LOOP_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])

const FAILED_LOOP_STATUSES = new Set([
  'blocked',
  'crashed',
  'error',
  'failed',
  'failure',
  'stale',
  'timed_out',
  'timeout'
])

const ACTIVE_LOOP_HANDOFF_STATES = new Set(['assigned', 'batched', 'queued', 'recorded', 'reviewing', 'escalated'])

const TERMINAL_LOOP_HANDOFF_STATES = new Set([
  'approved',
  'blocked_waiting',
  'cancelled_superseded',
  'closed',
  'ignored_duplicate',
  'rejected',
  'released'
])

function normalizedLoopValue(value?: null | string): string {
  return (value || '').trim().toLowerCase().replaceAll('-', '_')
}

function isPendingLoopHandoff(handoff: LoopTaskHandoff): boolean {
  if ((handoff as { resolved_at?: unknown }).resolved_at != null) {
    return false
  }

  const queueState = normalizedLoopValue(handoff.queue_state)

  if (queueState === 'open' || queueState === 'claimed') {
    return true
  }

  if (queueState === 'resolved' || queueState === 'canceled') {
    return false
  }

  const state = normalizedLoopValue(handoff.state)

  if (!state) {
    return true
  }

  if (TERMINAL_LOOP_HANDOFF_STATES.has(state)) {
    return false
  }

  return ACTIVE_LOOP_HANDOFF_STATES.has(state)
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
    row.latestRun?.summary,
    row.reviewKind,
    row.resumeMode,
    row.reviewSubjectAssignee,
    row.foregroundParentSessionId,
    row.foregroundForkSessionId,
    ...(row.loopHandoffs || []).flatMap(handoff => [
      handoff.handoff_kind,
      handoff.intent,
      handoff.target_actor,
      handoff.queue_state,
      handoff.state,
      handoff.attention,
      handoff.verification_state,
      handoff.summary,
      handoff.reason
    ])
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
}

function isOrchestratorReviewRow(row: LoopRow): boolean {
  const reviewKind = normalizedLoopValue(row.reviewKind)
  const assignee = normalizedLoopValue(row.assignee)

  return Boolean(
    reviewKind && (assignee === 'orchestrator' || reviewKind.includes('foreground') || reviewKind.includes('triage'))
  )
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

  if (isOrchestratorReviewRow(row)) {
    return status === 'review' ? 'Orchestrator review active' : 'Orchestrator review'
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
  } else if (
    FAILED_LOOP_STATUSES.has(status) ||
    FAILED_LOOP_STATUSES.has(runStatus) ||
    FAILED_LOOP_STATUSES.has(runOutcome)
  ) {
    score = 88
  } else if (isOrchestratorReviewRow(row)) {
    score = 84
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

const ACTIVE_OVERVIEW_STATUSES = new Set(['claimed', 'in_progress', 'running'])
const QUEUED_OVERVIEW_STATUSES = new Set(['queued', 'ready', 'scheduled', 'todo', 'triage'])
const DONE_OVERVIEW_STATUSES = new Set(['archived', 'cancelled', 'complete', 'completed', 'done'])

function isDoneLoopRow(row: LoopRow): boolean {
  return DONE_OVERVIEW_STATUSES.has(normalizedLoopValue(row.status))
}

function isActiveLoopRow(row: LoopRow): boolean {
  const status = normalizedLoopValue(row.status)

  return ACTIVE_OVERVIEW_STATUSES.has(status)
}

function isQueuedLoopRow(row: LoopRow): boolean {
  const status = normalizedLoopValue(row.status)

  return QUEUED_OVERVIEW_STATUSES.has(status)
}

interface RootOverviewGroups {
  active: LoopRow[]
  attention: LoopRow[]
  completed: LoopRow[]
  other: LoopRow[]
  queued: LoopRow[]
}

interface LoopDependencyGroup {
  anchor: LoopRow
  hasDependencyLink: boolean
  ids: Set<string>
  rows: LoopRow[]
}

const LOOP_DELEGATION_CREATED_BY_PREFIX = 'loop_delegation:'

function isSelfAnchoredLoopRootRow(row: LoopRow): boolean {
  const createdBy = row.rawTask?.created_by?.trim()

  if (createdBy === `loop:${row.taskId}`) {
    return true
  }

  return Boolean(
    createdBy?.startsWith(LOOP_DELEGATION_CREATED_BY_PREFIX) && row.parents.length === 0 && row.parentCount === 0
  )
}

function dependencyGroupAnchor(rows: LoopRow[], preferredTaskId?: null | string): LoopRow {
  return (
    (preferredTaskId ? rows.find(row => row.taskId === preferredTaskId) : null) ||
    rows.find(isSelfAnchoredLoopRootRow) ||
    rows.find(row => row.parents.length === 0 && row.parentCount === 0) ||
    rows[0]!
  )
}

function loopDependencyGroups(state?: LoopPanelState | null): LoopDependencyGroup[] {
  const rows = state?.rows || []
  const remaining = new Set(rows.map(row => row.taskId))
  const groups: LoopDependencyGroup[] = []

  for (const row of rows) {
    if (!remaining.has(row.taskId)) {
      continue
    }

    const componentIds = new Set(loopConnectedTaskIds(state, row.taskId))

    if (componentIds.size === 0) {
      componentIds.add(row.taskId)
    }

    const groupRows = rows.filter(candidate => componentIds.has(candidate.taskId))

    for (const taskId of componentIds) {
      remaining.delete(taskId)
    }

    groups.push({
      anchor: dependencyGroupAnchor(groupRows, state?.rootTaskId),
      hasDependencyLink: groupRows.length > 1,
      ids: new Set(groupRows.map(candidate => candidate.taskId)),
      rows: groupRows
    })
  }

  return groups
}

function loopDependencyGroupForTask(
  state: LoopPanelState | null,
  taskId?: null | string,
  groups = loopDependencyGroups(state)
): LoopDependencyGroup | null {
  if (!groups.length) {
    return null
  }

  if (taskId) {
    return groups.find(group => group.ids.has(taskId)) || null
  }

  return groups.find(group => group.hasDependencyLink) || groups[0] || null
}

function loopDependencyGroupShowsOverview(group?: LoopDependencyGroup | null): boolean {
  return Boolean(group && (group.hasDependencyLink || isSelfAnchoredLoopRootRow(group.anchor)))
}

function loopDependencyGroupMembers(group: LoopDependencyGroup): LoopRow[] {
  return group.rows.filter(row => row.taskId !== group.anchor.taskId)
}

function rootOverviewGroups(group: LoopDependencyGroup): RootOverviewGroups {
  const descendants = loopDependencyGroupMembers(group)
  const attention = attentionRows(descendants)
  const attentionIds = new Set(attention.map(row => row.taskId))
  const active = descendants.filter(row => !attentionIds.has(row.taskId) && isActiveLoopRow(row))
  const queued = descendants.filter(row => !attentionIds.has(row.taskId) && isQueuedLoopRow(row))
  const completed = descendants.filter(row => !attentionIds.has(row.taskId) && isDoneLoopRow(row))

  const groupedIds = new Set([
    ...attention.map(row => row.taskId),
    ...active.map(row => row.taskId),
    ...queued.map(row => row.taskId),
    ...completed.map(row => row.taskId)
  ])

  return {
    active,
    attention,
    queued,
    other: descendants.filter(row => !groupedIds.has(row.taskId)),
    completed
  }
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
    branchKind: task.branch_kind,
    body: task.body,
    childCount: children.length || task.child_count || task.children_count || 0,
    children,
    commentCount: detail?.comments?.length ?? task.comment_count ?? 0,
    depth: 0,
    externalChildTasks: task.external_child_tasks,
    externalParentTasks: task.external_parent_tasks,
    decisionGroupId: task.decision_group_id,
    frontier: false,
    latestRun,
    latestSummary: task.latest_summary || latestRun?.summary || null,
    loopHandoffs: task.loop_handoffs || [],
    parentCount: parents.length || task.parent_count || task.parents_count || 0,
    parents,
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
    taskId: task.id,
    tenant: task.tenant,
    title: task.title || task.id,
    workerActivity: task.worker_activity || undefined,
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
  group?: LoopDependencyGroup
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

function loopDependencyGroupStatusIndicator(group: LoopDependencyGroup): StatusIndicatorKind {
  const indicators = group.rows.map(loopRowStatusIndicator)

  if (indicators.includes('attention')) {
    return 'attention'
  }

  if (indicators.includes('failed')) {
    return 'failed'
  }

  if (indicators.includes('active')) {
    return 'active'
  }

  if (group.rows.every(isDoneLoopRow)) {
    return 'done'
  }

  if (indicators.includes('triage')) {
    return 'triage'
  }

  if (indicators.includes('pending')) {
    return 'pending'
  }

  return indicators[0] || 'unknown'
}

function loopStackStatusIndicator(row: LoopRow, group?: LoopDependencyGroup): StatusIndicatorKind {
  return group?.hasDependencyLink ? loopDependencyGroupStatusIndicator(group) : loopRowStatusIndicator(row)
}

function loopStackStateFromIndicator(indicator: StatusIndicatorKind): StatusItemState {
  if (indicator === 'attention' || indicator === 'failed') {
    return 'failed'
  }

  if (indicator === 'active' || indicator === 'pending' || indicator === 'triage') {
    return 'running'
  }

  return 'done'
}

function pluralizeLoopUnit(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function loopStackTaskCountLabel(group?: LoopDependencyGroup): string | undefined {
  return group?.hasDependencyLink ? pluralizeLoopUnit(group.rows.length, 'task') : undefined
}

function loopStackStatusItem(row: LoopRow, group?: LoopDependencyGroup): ComposerStatusItem {
  const statusIndicator = loopStackStatusIndicator(row, group)

  return {
    currentTool: loopStackTaskCountLabel(group),
    id: `loop-card:${row.taskId}`,
    kanbanTaskId: row.taskId,
    state: loopStackStateFromIndicator(statusIndicator),
    statusIndicator,
    title: row.title,
    type: 'kanban-agent'
  }
}

function LoopStackRow({ group, onSelect, row, selected }: LoopStackRowProps) {
  const item = loopStackStatusItem(row, group)

  return (
    <div
      className={cn('rounded-md', selected && 'bg-(--ui-row-hover-background)')}
      data-testid={`loop-card-${row.taskId}`}
    >
      <StatusItemRow item={item} onOpen={() => onSelect(row.taskId)} />
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

function LoopCollapsedAttentionQueue({
  groups,
  onSelectTaskId,
  rows
}: {
  groups?: LoopDependencyGroup[]
  onSelectTaskId: (taskId: string) => void
  rows: LoopRow[]
}) {
  const attentionGroups = groups?.filter(group => group.rows.some(row => attentionScore(row) > 0)) || []
  const attentionRowsList = attentionGroups.length ? attentionGroups.map(group => group.anchor) : rows

  if (attentionRowsList.length === 0) {
    return null
  }

  const visibleRows = attentionRowsList.slice(0, 3)

  return (
    <div
      className="grid gap-0.5 rounded-lg border border-amber-500/25 bg-amber-500/8 px-1 py-1"
      data-testid="loop-attention-queue"
    >
      <div className="px-1.5 pb-0.5 text-[0.67rem] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
        {attentionRowsList.length} need attention
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
  const groups = useMemo(() => loopDependencyGroups(state), [state])
  const collapsedAttentionRows = useMemo(() => attentionRows(state?.rows || []), [state])

  if (!state || state.rows.length === 0) {
    return null
  }

  return (
    <StatusSection
      collapsedContent={
        <LoopCollapsedAttentionQueue groups={groups} onSelectTaskId={onSelectTaskId} rows={collapsedAttentionRows} />
      }
      defaultCollapsed={false}
      icon={<Codicon className="text-muted-foreground/70" name="checklist" size="0.8rem" />}
      label={`Loop ${completedLoopRows(state.rows)}/${state.rows.length}`}
    >
      {groups.map(group => (
        <LoopStackRow
          group={group}
          key={group.anchor.taskId}
          onSelect={onSelectTaskId}
          row={group.anchor}
          selected={Boolean(selected && group.ids.has(selected.taskId))}
        />
      ))}
    </StatusSection>
  )
}

interface LoopPanelProps {
  artifactSourceBaseDir?: null | string
  embedded?: boolean
  enableDebugJson?: boolean
  hidden?: boolean
  /** Monotonic signal for explicit drawer-open requests, even when the selected task id is unchanged. */
  focusRequestKey?: number
  onFocusTaskId?: (taskId: string) => void
  onHide?: () => void
  onSelectTaskId?: (taskId: string) => void
  onAddTaskComment?: LoopTaskCommentSubmit
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  open?: boolean
  selectedTaskComments?: LoopTaskComment[] | null
  selectedTaskCommentsError?: null | string
  selectedTaskDetail?: LoopTaskDetail | null
  selectedTaskDetailError?: null | string
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

function DetailSection({
  action,
  children,
  className,
  testId,
  title
}: {
  action?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
  title: string
}) {
  return (
    <section
      className={cn(
        'min-w-0 max-w-full overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs',
        className
      )}
      data-testid={testId}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="m-0 min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
          {title}
        </h3>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

function EmptyDetail({ children }: { children: ReactNode }) {
  return <p className="m-0 text-xs text-(--ui-text-tertiary)">{children}</p>
}

function loopCommentKey(comment: LoopTaskComment, index: number): string {
  return String(comment.id ?? `${comment.task_id || 'comment'}:${comment.created_at ?? index}:${index}`)
}

function formatLoopCommentTime(createdAt?: number): string {
  if (!createdAt) {
    return ''
  }

  const timestampMs = createdAt < 10_000_000_000 ? createdAt * 1000 : createdAt
  const date = new Date(timestampMs)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short'
  }).format(date)
}

function LoopTaskCommentsCard({
  detail,
  detailError,
  commentsError,
  onAddComment,
  row
}: {
  detail?: LoopTaskDetail | null
  detailError?: null | string
  commentsError?: null | string
  onAddComment?: LoopTaskCommentSubmit
  row: LoopRow
}) {
  const comments = detail?.comments || []
  const visibleCount = Math.max(comments.length, row.commentCount || 0)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<null | string>(null)
  const canSubmit = Boolean(onAddComment) && draft.trim().length > 0 && !submitting
  const helperText = submitError ? submitError : !onAddComment ? 'Commenting is unavailable in this context.' : ''

  useEffect(() => {
    setDraft('')
    setSubmitError(null)
  }, [row.taskId])

  const submitComment = useCallback(async () => {
    const body = draft.trim()

    if (!body || !onAddComment || submitting) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onAddComment(row.taskId, body)
      setDraft('')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [draft, onAddComment, row.taskId, submitting])

  return (
    <DetailSection className="overflow-visible" testId="loop-task-comments-card" title={`Comments (${visibleCount})`}>
      <div className="grid min-w-0 gap-2">
        {comments.length === 0 ? (
          <EmptyDetail>
            {commentsError
              ? `Couldn't load comments: ${commentsError}`
              : detailError
                ? `Couldn't load comments: ${detailError}`
                : detail
                  ? 'No comments yet.'
                  : visibleCount > 0
                    ? `${visibleCount} comments recorded. Loading comments…`
                    : 'No comments yet.'}
          </EmptyDetail>
        ) : (
          <div className="grid min-w-0 gap-2" data-testid="loop-task-comments-list">
            {comments.map((comment, index) => {
              const timestamp = formatLoopCommentTime(comment.created_at)

              return (
                <article
                  className="grid min-w-0 gap-1 border-b border-(--ui-stroke-tertiary) pb-2 last:border-b-0 last:pb-0"
                  data-testid="loop-task-comment"
                  key={loopCommentKey(comment, index)}
                >
                  <div className="flex min-w-0 items-center gap-2 text-[0.66rem] text-(--ui-text-tertiary)">
                    <span className="truncate font-medium text-(--ui-text-secondary)">{comment.author || 'anon'}</span>
                    {timestamp ? <time className="shrink-0 text-(--ui-text-quaternary)">{timestamp}</time> : null}
                  </div>
                  <CompactMarkdown className="min-w-0 text-(--ui-text-secondary)" text={comment.body || ''} />
                </article>
              )
            })}
          </div>
        )}

        <form
          className="grid gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) p-1.5 transition-colors focus-within:border-(--ui-stroke-secondary)"
          data-testid="loop-task-comment-composer"
          onSubmit={event => {
            event.preventDefault()
            void submitComment()
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <textarea
              aria-label={`Comment on ${row.taskId}`}
              className="h-6 min-h-6 flex-1 resize-none rounded-[3px] border-0 bg-transparent px-1.5 py-1 text-xs leading-4 text-(--ui-text-primary) outline-none placeholder:text-(--ui-text-quaternary) focus:ring-0 disabled:cursor-default disabled:opacity-50"
              disabled={!onAddComment || submitting}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submitComment()
                }
              }}
              placeholder="Add a comment…"
              rows={1}
              value={draft}
            />
            <Button className="h-6 shrink-0 px-2 text-[0.68rem]" disabled={!canSubmit} type="submit" variant="ghost">
              {submitting ? 'Commenting…' : 'Comment'}
            </Button>
          </div>
          {helperText ? (
            <span
              className={cn(
                'min-w-0 truncate text-[0.66rem] text-(--ui-text-tertiary)',
                submitError && 'text-destructive'
              )}
            >
              {helperText}
            </span>
          ) : null}
        </form>
      </div>
    </DetailSection>
  )
}

const INTERNAL_MARKDOWN_FIELD =
  /^(?:assignee|attachments|children|comments|completed_at|created_at|created_by|current_run_id|current_step_key|diagnostics|events|id|latest_run|latest_summary|links|metadata|parent_count|parents|priority|result|runs|session_id|started_at|status|tenant|warnings|workspace_kind|workspace_path)\s*:/i

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

function loopIntakeBlocksSubmit(row: LoopRow): boolean {
  const intakeState = (row.loopIntake?.state || '').trim().toLowerCase()

  return (
    row.loopIntake?.needed === true &&
    row.loopIntake.dispatchable !== true &&
    !['spec-ready', 'spec_ready', 'approved'].includes(intakeState)
  )
}

function loopSubmitTitle(row: LoopRow): string | undefined {
  return loopIntakeBlocksSubmit(row)
    ? 'Submit approves Loop intake while keeping lightweight planning nodes non-dispatchable until activation.'
    : undefined
}

function LoopTaskActions({
  onTaskAction,
  row
}: {
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
}) {
  const status = normalizedLoopValue(row.status)
  const planningNode = row.planningNode === true
  const blocked = status === 'blocked'
  const archived = status === 'archived'
  const terminal = TERMINAL_LOOP_STATUSES.has(status)

  const canSubmit =
    !planningNode &&
    (status === 'triage' || status === 'scheduled') &&
    !terminal &&
    !isTentativeDecisionOptionEndpoint(row)

  const statusAction: LoopTaskAction = blocked ? 'unblock' : 'block'
  const statusLabel = blocked ? 'Unblock' : 'Block'

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="loop-task-actions">
      {canSubmit && (
        <Button
          aria-label={`Submit ${row.taskId}`}
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={!onTaskAction}
          onClick={() => onTaskAction?.('decompose', row)}
          title={loopSubmitTitle(row)}
          type="button"
          variant="default"
        >
          <Codicon name="send" size="0.82rem" />
          <span>Submit</span>
        </Button>
      )}
      {!planningNode && !terminal && (
        <Button
          aria-label={`${statusLabel} ${row.taskId}`}
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={!onTaskAction}
          onClick={() => onTaskAction?.(statusAction, row)}
          type="button"
          variant="outline"
        >
          <Codicon name={blocked ? 'unlock' : 'lock'} size="0.82rem" />
          <span>{statusLabel}</span>
        </Button>
      )}
      <Button
        aria-label={`Ask in chat about ${row.taskId}`}
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={!onTaskAction}
        onClick={() => onTaskAction?.('ask-hermes', row)}
        type="button"
        variant="outline"
      >
        <Codicon name="comment-discussion" size="0.82rem" />
        <span>Ask in chat</span>
      </Button>
      {!planningNode && !archived && (
        <Button
          aria-label={`Archive ${row.taskId}`}
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={!onTaskAction}
          onClick={() => onTaskAction?.('archive', row)}
          type="button"
          variant="outline"
        >
          <Codicon name="archive" size="0.82rem" />
          <span>Archive</span>
        </Button>
      )}
    </div>
  )
}

function descriptionHasMarkdown(text: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\[[^\]]+\]\([^)]+\)|- \[[ xX]\])/m.test(text) ||
    /`[^`]+`/.test(text)
  )
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

function workerStatusLine(worker: LoopWorkerActivity): string {
  return [worker.status, worker.profile, worker.worker_pid ? `pid ${worker.worker_pid}` : '']
    .filter(Boolean)
    .join(' · ')
}

const ARTIFACT_SOURCE_FIELDS: {
  key: string
  kind: LoopArtifactSourceKind
  sourceLabel: string
}[] = [
  { key: 'artifacts', kind: 'artifact', sourceLabel: 'Artifact' },
  { key: 'output_files', kind: 'artifact', sourceLabel: 'Output' },
  { key: 'changed_files', kind: 'changed-file', sourceLabel: 'Changed file' },
  { key: 'source_files', kind: 'source', sourceLabel: 'Source' },
  { key: 'sources', kind: 'source', sourceLabel: 'Source' },
  { key: 'files', kind: 'changed-file', sourceLabel: 'File' }
]

function artifactSourceBasename(target: string): string {
  return target.split(/[\\/]/).filter(Boolean).pop() || target
}

function artifactSourceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function artifactSourceTarget(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  const record = artifactSourceRecord(value)

  if (!record) {
    return ''
  }

  for (const key of ['path', 'file', 'filepath', 'target', 'url', 'source', 'href']) {
    const candidate = record[key]

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return ''
}

function artifactSourceLabel(value: unknown, target: string): string {
  const record = artifactSourceRecord(value)

  if (record) {
    for (const key of ['label', 'title', 'name']) {
      const candidate = record[key]

      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  }

  return artifactSourceBasename(target)
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const INLINE_DIFF_LABEL_PATTERN = new RegExp(`^\\s*${String.fromCharCode(0x250a)}?\\s*review diff\\s*\\n`, 'i')

function cleanArtifactSourceDiff(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '').replace(INLINE_DIFF_LABEL_PATTERN, '').trim()
}

function artifactSourceDiffFromRecord(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined
  }

  for (const key of ['inline_diff', 'inlineDiff', 'unified_diff', 'unifiedDiff', 'diff', 'patch']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      const cleaned = cleanArtifactSourceDiff(value)

      if (cleaned) {
        return cleaned
      }
    }
  }

  return undefined
}

function artifactSourceInlineDiff(value: unknown, metadata: unknown, fieldValues: unknown[]): string | undefined {
  const direct = artifactSourceDiffFromRecord(artifactSourceRecord(value))

  if (direct) {
    return direct
  }

  if (fieldValues.length === 1) {
    return artifactSourceDiffFromRecord(artifactSourceRecord(metadata))
  }

  return undefined
}

function artifactSourceValues(metadata: unknown, key: string): unknown[] {
  const record = artifactSourceRecord(metadata)

  if (!record) {
    return []
  }

  const value = record[key]

  if (Array.isArray(value)) {
    return value
  }

  return value ? [value] : []
}

function artifactSourceMetadataForRow(row: LoopRow, detail?: LoopTaskDetail | null): unknown[] {
  const latestRun = detail?.runs?.at(-1) || row.latestRun || null

  const sources = [
    latestRun?.metadata,
    latestRun !== row.latestRun ? row.latestRun?.metadata : null,
    ...(row.workerActivity?.recent_task_events || []).map(event => event.payload)
  ]

  const nestedMetadata = sources.flatMap(source => {
    const record = artifactSourceRecord(source)
    const metadata = record?.metadata

    return metadata ? [metadata] : []
  })

  return [...sources, ...nestedMetadata]
}

function artifactSourceEntriesForRow(row: LoopRow, detail?: LoopTaskDetail | null): LoopArtifactSourceEntry[] {
  const seen = new Set<string>()
  const entries: LoopArtifactSourceEntry[] = []

  for (const metadata of artifactSourceMetadataForRow(row, detail)) {
    for (const field of ARTIFACT_SOURCE_FIELDS) {
      const values = artifactSourceValues(metadata, field.key)

      for (const value of values) {
        const target = artifactSourceTarget(value)

        if (!target) {
          continue
        }

        const dedupeKey = `${field.kind}:${target}`

        if (seen.has(dedupeKey)) {
          continue
        }

        seen.add(dedupeKey)
        entries.push({
          id: `${row.taskId}:${dedupeKey}`,
          inlineDiff: field.kind === 'changed-file' ? artifactSourceInlineDiff(value, metadata, values) : undefined,
          kind: field.kind,
          label: artifactSourceLabel(value, target),
          sourceLabel: field.sourceLabel,
          target
        })
      }
    }
  }

  return entries
}

function artifactSourceIcon(kind: LoopArtifactSourceKind): string {
  if (kind === 'artifact') {
    return 'files'
  }

  if (kind === 'changed-file') {
    return 'diff'
  }

  return 'file'
}

const ARTIFACT_SOURCE_GROUPS: { kind: LoopArtifactSourceKind; label: string }[] = [
  { kind: 'artifact', label: 'Artifacts' },
  { kind: 'changed-file', label: 'Changed' },
  { kind: 'source', label: 'Sources' }
]

function artifactSourceActionLabel(entry: LoopArtifactSourceEntry): string {
  if (entry.kind === 'changed-file') {
    return entry.inlineDiff ? 'Diff' : 'Changed'
  }

  return 'Open'
}

function artifactSourceSummary(items: { entry: LoopArtifactSourceEntry; row: LoopRow }[]): string {
  const counts = new Map<LoopArtifactSourceKind, number>()

  for (const { entry } of items) {
    counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1)
  }

  return ARTIFACT_SOURCE_GROUPS.map(group => {
    const count = counts.get(group.kind) || 0

    if (count === 0) {
      return ''
    }

    if (group.kind === 'artifact') {
      return `${count} artifact${count === 1 ? '' : 's'}`
    }

    if (group.kind === 'changed-file') {
      return `${count} changed`
    }

    return `${count} source${count === 1 ? '' : 's'}`
  })
    .filter(Boolean)
    .join(' · ')
}

function LoopArtifactSourcesCard({
  detail,
  hideEmpty = false,
  onOpenArtifactSource,
  rows
}: {
  detail?: LoopTaskDetail | null
  hideEmpty?: boolean
  onOpenArtifactSource?: (entry: LoopArtifactSourceEntry, row: LoopRow) => void
  rows: LoopRow[]
}) {
  const items = rows.flatMap(row => {
    const rowDetail = rows.length === 1 || detail?.task?.id === row.taskId ? detail : null

    return artifactSourceEntriesForRow(row, rowDetail).map(entry => ({ entry, row }))
  })

  if (hideEmpty && items.length === 0) {
    return null
  }

  const groupedItems = ARTIFACT_SOURCE_GROUPS.map(group => ({
    ...group,
    items: items.filter(item => item.entry.kind === group.kind)
  })).filter(group => group.items.length > 0)

  return (
    <DetailSection testId="loop-artifact-sources-card" title="Artifacts / sources">
      {items.length === 0 ? (
        <EmptyDetail>No artifact or source outputs recorded yet.</EmptyDetail>
      ) : (
        <div className="grid gap-2" data-testid="loop-artifact-sources-list">
          <p className="m-0 text-[0.66rem] text-(--ui-text-tertiary)">{artifactSourceSummary(items)}</p>
          {groupedItems.map(group => (
            <div className="grid gap-1" key={group.kind}>
              <div className="flex items-center gap-1.5 px-0.5 text-[0.62rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)">
                <Codicon name={artifactSourceIcon(group.kind)} size="0.72rem" />
                <span>{group.label}</span>
              </div>
              {group.items.map(({ entry, row }) => (
                <Button
                  aria-label={`Open ${entry.sourceLabel.toLowerCase()} ${entry.target}`}
                  className="h-auto min-w-0 items-center justify-start gap-2 px-2 py-1.5 text-left text-xs"
                  disabled={!onOpenArtifactSource}
                  key={`${row.taskId}:${entry.id}`}
                  onClick={() => onOpenArtifactSource?.(entry, row)}
                  title={entry.target}
                  type="button"
                  variant="secondary"
                >
                  <Codicon
                    className="shrink-0 text-(--ui-text-tertiary)"
                    name={artifactSourceIcon(entry.kind)}
                    size="0.82rem"
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-(--ui-text-primary)">{entry.label}</span>
                    <span className="truncate font-mono text-[0.64rem] text-(--ui-text-tertiary)">{entry.target}</span>
                    <span className="truncate text-[0.65rem] text-(--ui-text-tertiary)">
                      {entry.sourceLabel}
                      {rows.length > 1 ? ` · ${row.title || row.taskId}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 text-[0.62rem] font-medium text-(--ui-text-tertiary)">
                    {artifactSourceActionLabel(entry)}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  )
}

function artifactSourceKindLabel(kind: LoopArtifactSourceKind): string {
  if (kind === 'artifact') {
    return 'Artifact'
  }

  if (kind === 'changed-file') {
    return 'Changed file'
  }

  return 'Source'
}

function LoopArtifactViewButton({
  active,
  disabled,
  icon,
  label,
  onClick
}: {
  active: boolean
  disabled?: boolean
  icon: string
  label: string
  onClick: () => void
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn('h-6 gap-1 px-2 text-[0.68rem]', active && 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)')}
      disabled={disabled}
      onClick={onClick}
      size="xs"
      type="button"
      variant={active ? 'secondary' : 'ghost'}
    >
      <Codicon name={icon} size="0.74rem" />
      <span>{label}</span>
    </Button>
  )
}

function LoopArtifactPreviewView({ tab }: { tab: LoopPanelArtifactTab }) {
  if (tab.status === 'loading') {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center text-xs text-(--ui-text-tertiary)">
        Loading preview...
      </div>
    )
  }

  if (tab.status === 'error') {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center p-4 text-center text-xs text-(--ui-text-tertiary)">
        {tab.error || 'Preview unavailable.'}
      </div>
    )
  }

  if (tab.target) {
    return <LocalFilePreview reloadKey={0} target={tab.target} />
  }

  return (
    <div className="grid h-full min-h-[24rem] place-items-center text-xs text-(--ui-text-tertiary)">
      Preview unavailable.
    </div>
  )
}

function LoopArtifactDiffView({ tab }: { tab: LoopPanelArtifactTab }) {
  if (tab.entry.kind !== 'changed-file') {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center p-4 text-center text-xs text-(--ui-text-tertiary)">
        Diff is only available for changed files.
      </div>
    )
  }

  if (tab.diffStatus === 'loading') {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center text-xs text-(--ui-text-tertiary)">
        Loading diff...
      </div>
    )
  }

  if (tab.diffStatus === 'error') {
    return (
      <div className="grid h-full min-h-[24rem] place-items-center p-4 text-center text-xs text-(--ui-text-tertiary)">
        {tab.diffError || 'Diff unavailable.'}
      </div>
    )
  }

  if (tab.diffStatus === 'ready' && tab.diff) {
    return (
      <div className="flex h-full min-h-[24rem] min-w-0 flex-col">
        {tab.diffTruncated && (
          <div className="border-b border-(--ui-stroke-tertiary) px-3 py-1.5 text-[0.66rem] text-(--ui-text-tertiary)">
            Diff truncated for preview.
          </div>
        )}
        <DiffLines
          className="m-0 h-full max-h-none min-h-0 flex-1 rounded-none border-0 bg-transparent p-3"
          text={tab.diff}
        />
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-[24rem] place-items-center p-4 text-center text-xs text-(--ui-text-tertiary)">
      No diff recorded for this file.
    </div>
  )
}

function LoopArtifactDetailRow({ label, value }: { label: string; value?: null | string }) {
  if (!value) {
    return null
  }

  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-(--ui-text-tertiary)">{label}</dt>
      <dd className="m-0 min-w-0 break-all font-mono text-(--ui-text-secondary)">{value}</dd>
    </div>
  )
}

function LoopArtifactDetailsView({ tab }: { tab: LoopPanelArtifactTab }) {
  const diffLine =
    tab.entry.kind === 'changed-file'
      ? [tab.diffSource === 'inline' ? 'inline' : tab.diffSource === 'git' ? 'git' : '', tab.diffStatus]
          .filter(Boolean)
          .join(' · ')
      : undefined

  return (
    <div className="h-full min-h-[24rem] overflow-auto p-3 text-xs">
      <dl className="m-0 grid gap-2">
        <LoopArtifactDetailRow label="Type" value={artifactSourceKindLabel(tab.entry.kind)} />
        <LoopArtifactDetailRow label="Task" value={tab.rowTitle || tab.rowTaskId} />
        <LoopArtifactDetailRow label="Target" value={tab.entry.target} />
        <LoopArtifactDetailRow label="Preview" value={tab.target?.path || tab.target?.url || tab.error} />
        <LoopArtifactDetailRow label="Diff" value={diffLine} />
      </dl>
    </div>
  )
}

function LoopArtifactSourceTab({
  onSelectView,
  tab
}: {
  onSelectView: (tabId: string, view: LoopArtifactTabView) => void
  tab: LoopPanelArtifactTab
}) {
  const canShowDiff = tab.entry.kind === 'changed-file'

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <section
        className="min-w-0 max-w-full overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs"
        data-testid="loop-artifact-source-tab"
      >
        <div className="grid gap-2">
          <div className="flex items-center gap-2 font-medium text-(--ui-text-primary)">
            <Codicon
              className="shrink-0 text-(--ui-text-tertiary)"
              name={artifactSourceIcon(tab.entry.kind)}
              size="0.82rem"
            />
            <h3 className="m-0 min-w-0 truncate text-sm font-semibold text-(--ui-text-primary)">{tab.entry.label}</h3>
          </div>
          <div className="grid gap-1 text-[0.68rem] text-(--ui-text-tertiary)">
            <div className="truncate">
              {tab.entry.sourceLabel} · {tab.rowTitle || tab.rowTaskId}
              {tab.diffSource ? ` · ${tab.diffSource === 'inline' ? 'inline diff' : 'git diff'}` : ''}
            </div>
            <div className="break-all font-mono">{tab.entry.target}</div>
          </div>
          <div
            aria-label="Artifact view"
            className="flex w-fit max-w-full items-center gap-0.5 rounded border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) p-0.5"
          >
            <LoopArtifactViewButton
              active={tab.view === 'preview'}
              icon="open-preview"
              label="Preview"
              onClick={() => onSelectView(tab.id, 'preview')}
            />
            <LoopArtifactViewButton
              active={tab.view === 'diff'}
              disabled={!canShowDiff}
              icon="diff"
              label="Diff"
              onClick={() => onSelectView(tab.id, 'diff')}
            />
            <LoopArtifactViewButton
              active={tab.view === 'details'}
              icon="list-unordered"
              label="Details"
              onClick={() => onSelectView(tab.id, 'details')}
            />
          </div>
        </div>
      </section>

      <div className="relative min-h-[24rem] min-w-0 flex-1 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background)">
        {tab.view === 'diff' ? (
          <LoopArtifactDiffView tab={tab} />
        ) : tab.view === 'details' ? (
          <LoopArtifactDetailsView tab={tab} />
        ) : (
          <LoopArtifactPreviewView tab={tab} />
        )}
      </div>
    </div>
  )
}

function WorkerActivityDetails({
  onTaskAction,
  row
}: {
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
}) {
  const worker = row.workerActivity

  if (!worker) {
    return <EmptyDetail>No worker run metadata recorded for this task.</EmptyDetail>
  }

  const recentEvents = worker.recent_task_events || []

  return (
    <div className="grid gap-2 text-(--ui-text-secondary)">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[0.72rem] text-(--ui-text-primary)">Run #{worker.run_id}</span>
          {workerStatusLine(worker) ? (
            <span className="text-[0.68rem] text-(--ui-text-tertiary)">{workerStatusLine(worker)}</span>
          ) : null}
        </div>
        {(worker.summary || worker.summary_preview || worker.error || worker.error_preview) && (
          <p className="m-0 whitespace-pre-wrap text-[0.72rem] leading-relaxed">
            {worker.summary || worker.summary_preview || worker.error || worker.error_preview}
          </p>
        )}
      </div>

      {worker.log_tail ? (
        <LogView className="min-w-0 max-w-full max-h-32">{worker.log_tail}</LogView>
      ) : worker.log_tail_available ? (
        <EmptyDetail>Worker log exists; open logs to inspect it.</EmptyDetail>
      ) : null}

      {recentEvents.length > 0 ? (
        <div className="grid gap-0.5">
          <p className="m-0 text-[0.62rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">
            Recent events
          </p>
          {recentEvents.slice(-5).map((event, index) => (
            <p
              className="m-0 font-mono text-[0.66rem] text-(--ui-text-tertiary)"
              key={`${event.id || index}:${event.kind}`}
            >
              {event.kind || 'event'}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const loopTextValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const loopToolLabel = (name: string): string =>
  name
    .split('_')
    .filter(Boolean)
    .map(part => part[0]!.toUpperCase() + part.slice(1))
    .join(' ') || name

const loopRecordFrom = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function currentToolFromLoopRecord(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined
  }

  for (const key of ['current_tool', 'currentTool', 'current_tool_name', 'tool_name', 'active_tool', 'last_tool']) {
    const value = loopTextValue(record[key])

    if (value) {
      return loopToolLabel(value)
    }
  }

  return undefined
}

function loopWorkerCurrentTool(row: LoopRow): string | undefined {
  const worker = row.workerActivity
  const direct = currentToolFromLoopRecord(worker ? (worker as unknown as Record<string, unknown>) : null)

  if (direct) {
    return direct
  }

  for (const event of (worker?.recent_task_events || []).slice().reverse()) {
    const fromPayload = currentToolFromLoopRecord(loopRecordFrom(event.payload))

    if (fromPayload) {
      return fromPayload
    }
  }

  return currentToolFromLoopRecord(loopRecordFrom(row.latestRun?.metadata))
}

function loopAgentActivityLabel(row: LoopRow): string | undefined {
  const profile =
    loopTextValue(row.workerActivity?.profile) || loopTextValue(row.latestRun?.profile) || loopTextValue(row.assignee)

  const currentTool = loopWorkerCurrentTool(row)

  return [profile, currentTool].filter(Boolean).join(' · ') || profile || currentTool
}

interface LoopTaskGraphEdge {
  from: string
  tentative?: boolean
  to: string
}

interface LoopTaskGraphNodeLayout {
  depth: number
  index: number
  row: LoopRow
  x: number
  y: number
}

interface LoopTaskGraphChoiceGroupLayout {
  groupId: string
  height: number
  testId: string
  width: number
  x: number
  y: number
}

interface LoopTaskGraphLayout {
  choiceGroups: LoopTaskGraphChoiceGroupLayout[]
  edges: LoopTaskGraphEdge[]
  height: number
  nodes: LoopTaskGraphNodeLayout[]
  width: number
}

interface LoopTaskGraphFocusState {
  edgeKeys: Set<string>
  nodeIds: Set<string>
  taskId: null | string
}

const LOOP_GRAPH_NODE_WIDTH = 168
const LOOP_GRAPH_NODE_HEIGHT = 58
const LOOP_GRAPH_COLUMN_GAP = 18
const LOOP_GRAPH_ROW_GAP = 34
const LOOP_GRAPH_PADDING = 12
const LOOP_GRAPH_ACTION_TRAY_HEIGHT = 32
const LOOP_GRAPH_ACTION_TRAY_OVERLAP = 2
const LOOP_GRAPH_CHOICE_GROUP_PADDING = 8
const LOOP_GRAPH_CHOICE_GROUP_LABEL_HEIGHT = 20
const LOOP_GRAPH_CANVAS_PADDING = 32
const LOOP_GRAPH_MIN_ZOOM = 0.15
const LOOP_GRAPH_MAX_ZOOM = 2
const LOOP_GRAPH_ZOOM_SENSITIVITY = 0.0015

interface LoopGraphViewportSize {
  height: number
  width: number
}

interface LoopGraphView {
  scale: number
  x: number
  y: number
}

interface LoopGraphViewportMetrics {
  effectiveZoom: number
  frameHeight: number
  frameWidth: number
  offsetX: number
  offsetY: number
}

const EMPTY_LOOP_GRAPH_VIEWPORT: LoopGraphViewportSize = { height: 0, width: 0 }

const DEFAULT_LOOP_GRAPH_VIEW: LoopGraphView = { scale: 1, x: LOOP_GRAPH_CANVAS_PADDING, y: LOOP_GRAPH_CANVAS_PADDING }

function clampLoopGraphZoom(zoom: number): number {
  return Math.min(LOOP_GRAPH_MAX_ZOOM, Math.max(LOOP_GRAPH_MIN_ZOOM, zoom))
}

function frameLoopGraphView(layout: LoopTaskGraphLayout, viewport: LoopGraphViewportSize): LoopGraphView {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return DEFAULT_LOOP_GRAPH_VIEW
  }

  const availableWidth = Math.max(1, viewport.width - LOOP_GRAPH_CANVAS_PADDING * 2)
  const availableHeight = Math.max(1, viewport.height - LOOP_GRAPH_CANVAS_PADDING * 2)
  const scale = clampLoopGraphZoom(Math.min(1, availableWidth / layout.width, availableHeight / layout.height))

  return {
    scale,
    x: Math.max(LOOP_GRAPH_CANVAS_PADDING, (viewport.width - layout.width * scale) / 2),
    y: Math.max(LOOP_GRAPH_CANVAS_PADDING, (viewport.height - layout.height * scale) / 2)
  }
}

function loopGraphViewportMetrics(
  layout: LoopTaskGraphLayout,
  zoom: number,
  fullPanel: boolean,
  viewport: LoopGraphViewportSize
): LoopGraphViewportMetrics {
  const measured = fullPanel && viewport.width > 0 && viewport.height > 0
  const availableWidth = measured ? Math.max(1, viewport.width - LOOP_GRAPH_CANVAS_PADDING * 2) : layout.width
  const availableHeight = measured ? Math.max(1, viewport.height - LOOP_GRAPH_CANVAS_PADDING * 2) : layout.height
  const fitZoom = measured ? Math.min(1, availableWidth / layout.width, availableHeight / layout.height) : 1
  const effectiveZoom = fullPanel ? zoom * fitZoom : zoom
  const contentWidth = layout.width * effectiveZoom
  const contentHeight = layout.height * effectiveZoom

  if (!measured) {
    return { effectiveZoom, frameHeight: contentHeight, frameWidth: contentWidth, offsetX: 0, offsetY: 0 }
  }

  const frameWidth = Math.max(viewport.width, contentWidth + LOOP_GRAPH_CANVAS_PADDING * 2)
  const frameHeight = Math.max(viewport.height, contentHeight + LOOP_GRAPH_CANVAS_PADDING * 2)

  return {
    effectiveZoom,
    frameHeight,
    frameWidth,
    offsetX: Math.max(LOOP_GRAPH_CANVAS_PADDING, (frameWidth - contentWidth) / 2),
    offsetY: Math.max(LOOP_GRAPH_CANVAS_PADDING, (frameHeight - contentHeight) / 2)
  }
}

function loopTaskGraphAgent(row: LoopRow): string {
  return (
    loopTextValue(row.assignee) ||
    loopTextValue(row.workerActivity?.profile) ||
    loopTextValue(row.latestRun?.profile) ||
    'Unassigned'
  )
}

function loopTaskGraphAgentLabel(row: LoopRow): string | undefined {
  const agent = loopTaskGraphAgent(row)

  return agent === 'Unassigned' ? undefined : agent
}

type LoopTaskChoiceState = 'candidate' | 'chosen' | 'recommended' | 'rejected'

const LOOP_TASK_CHOICE_STATES = new Set<LoopTaskChoiceState>(['candidate', 'chosen', 'recommended', 'rejected'])

function loopDecisionGroupId(row: LoopRow): string | undefined {
  return loopTextValue(row.decisionGroupId)
}

function loopTaskChoiceState(row: LoopRow): LoopTaskChoiceState | null {
  if (normalizedLoopValue(row.branchKind) !== 'alternative') {
    return null
  }

  const state = normalizedLoopValue(row.selectionState) as LoopTaskChoiceState

  if (LOOP_TASK_CHOICE_STATES.has(state)) {
    return state
  }

  return loopDecisionGroupId(row) ? 'candidate' : null
}

function loopTaskChoiceLabel(state: LoopTaskChoiceState): string {
  return state[0]!.toUpperCase() + state.slice(1)
}

function loopTaskChoiceIcon(state: LoopTaskChoiceState): string {
  if (state === 'chosen') {
    return '✓'
  }

  if (state === 'recommended') {
    return '★'
  }

  if (state === 'rejected') {
    return '⊘'
  }

  return '◌'
}

function loopTaskChoiceAria(row: LoopRow, state: LoopTaskChoiceState): string {
  const label = loopTaskChoiceLabel(state)
  const groupId = loopDecisionGroupId(row)

  return `${label} option${groupId ? ` in decision group ${groupId}` : ''}`
}

function loopGraphTestIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'group'
}

function loopTaskGraphChoiceGroups(
  nodes: LoopTaskGraphNodeLayout[],
  layoutHeight: number,
  layoutWidth: number
): LoopTaskGraphChoiceGroupLayout[] {
  const byGroup = new Map<string, LoopTaskGraphNodeLayout[]>()

  for (const node of nodes) {
    const groupId = loopDecisionGroupId(node.row)

    if (!groupId || normalizedLoopValue(node.row.branchKind) !== 'alternative') {
      continue
    }

    byGroup.set(groupId, [...(byGroup.get(groupId) || []), node])
  }

  return Array.from(byGroup.entries())
    .map(([groupId, groupNodes]) => {
      const minX = Math.min(...groupNodes.map(node => node.x))
      const maxX = Math.max(...groupNodes.map(node => node.x + LOOP_GRAPH_NODE_WIDTH))
      const minY = Math.min(...groupNodes.map(node => node.y))
      const maxY = Math.max(...groupNodes.map(node => node.y + LOOP_GRAPH_NODE_HEIGHT))
      const x = Math.max(0, minX - LOOP_GRAPH_CHOICE_GROUP_PADDING)
      const y = Math.max(0, minY - LOOP_GRAPH_CHOICE_GROUP_LABEL_HEIGHT)
      const width = Math.min(layoutWidth - x, maxX - x + LOOP_GRAPH_CHOICE_GROUP_PADDING)
      const height = Math.min(layoutHeight - y, maxY - y + LOOP_GRAPH_CHOICE_GROUP_PADDING)

      return {
        groupId,
        height,
        testId: `loop-task-graph-choice-group-${loopGraphTestIdPart(groupId)}`,
        width,
        x,
        y
      }
    })
    .sort((a, b) => a.y - b.y || a.x - b.x || a.groupId.localeCompare(b.groupId))
}

function isTentativeDecisionOptionEndpoint(row?: LoopRow): boolean {
  if (!row) {
    return false
  }

  const branchKind = normalizedLoopValue(row.branchKind)
  const selectionState = normalizedLoopValue(row.selectionState)

  return branchKind === 'alternative' && selectionState !== 'chosen'
}

function loopTaskGraphEdges(rows: LoopRow[], fallbackRootTaskId?: string): LoopTaskGraphEdge[] {
  const rowById = new Map(rows.map(row => [row.taskId, row]))
  const edgeKeys = new Set<string>()
  const incomingTaskIds = new Set<string>()
  const edges: LoopTaskGraphEdge[] = []

  const addEdge = (from: string, to: string) => {
    if (from === to || !rowById.has(from) || !rowById.has(to)) {
      return
    }

    const key = `${from}:${to}`

    if (edgeKeys.has(key)) {
      return
    }

    const fromRow = rowById.get(from)
    const toRow = rowById.get(to)

    edgeKeys.add(key)
    incomingTaskIds.add(to)
    edges.push({
      from,
      tentative: isTentativeDecisionOptionEndpoint(fromRow) || isTentativeDecisionOptionEndpoint(toRow),
      to
    })
  }

  for (const row of rows) {
    // Loop subtasks carry their parent task IDs; render those parents as owning this row in the graph.
    for (const parentId of row.parents) {
      addEdge(parentId, row.taskId)
    }

    for (const childId of row.children) {
      addEdge(row.taskId, childId)
    }
  }

  if (fallbackRootTaskId && rowById.has(fallbackRootTaskId)) {
    for (const row of rows) {
      const hasDependencyLinks =
        row.parents.length > 0 || row.children.length > 0 || row.parentCount > 0 || row.childCount > 0

      if (row.taskId !== fallbackRootTaskId && !incomingTaskIds.has(row.taskId) && !hasDependencyLinks) {
        addEdge(fallbackRootTaskId, row.taskId)
      }
    }
  }

  return edges
}

function breakCyclesForLayout(
  edges: LoopTaskGraphEdge[],
  rootId?: string
): { dagEdges: LoopTaskGraphEdge[]; backEdges: LoopTaskGraphEdge[] } {
  const adj = new Map<string, string[]>()

  for (const edge of edges) {
    adj.set(edge.from, [...(adj.get(edge.from) || []), edge.to])
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const backEdgesSet = new Set<string>()

  const dfs = (node: string) => {
    visiting.add(node)

    for (const neighbor of adj.get(node) || []) {
      if (visiting.has(neighbor)) {
        backEdgesSet.add(`${node}:${neighbor}`)
      } else if (!visited.has(neighbor)) {
        dfs(neighbor)
      }
    }

    visiting.delete(node)
    visited.add(node)
  }

  if (rootId) {
    dfs(rootId)
  }

  for (const edge of edges) {
    if (!visited.has(edge.from)) {
      dfs(edge.from)
    }

    if (!visited.has(edge.to)) {
      dfs(edge.to)
    }
  }

  const dagEdges: LoopTaskGraphEdge[] = []
  const backEdges: LoopTaskGraphEdge[] = []

  for (const edge of edges) {
    if (backEdgesSet.has(`${edge.from}:${edge.to}`)) {
      backEdges.push(edge)
    } else {
      dagEdges.push(edge)
    }
  }

  return { dagEdges, backEdges }
}

function loopTaskGraphLayout(rows: LoopRow[]): LoopTaskGraphLayout {
  const root = rows[0]
  const graphRows = rows
  const rowIndexById = new Map(graphRows.map((row, index) => [row.taskId, index]))
  const edges = loopTaskGraphEdges(graphRows, root?.taskId)
  const { dagEdges } = breakCyclesForLayout(edges, root?.taskId)
  const outgoing = new Map<string, string[]>()
  const depthById = new Map<string, number>()

  for (const row of graphRows) {
    depthById.set(row.taskId, Math.max(0, row.depth || 0))
  }

  for (const edge of dagEdges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to])
  }

  const queue = root ? [root.taskId] : []
  const visitCounts = new Map<string, number>()

  while (queue.length > 0) {
    const taskId = queue.shift()!
    const currentDepth = depthById.get(taskId) || 0
    const nextVisitCount = (visitCounts.get(taskId) || 0) + 1

    if (nextVisitCount > rows.length) {
      continue
    }

    visitCounts.set(taskId, nextVisitCount)

    for (const childId of outgoing.get(taskId) || []) {
      const nextDepth = currentDepth + 1

      if ((depthById.get(childId) ?? -1) < nextDepth) {
        depthById.set(childId, nextDepth)
        queue.push(childId)
      }
    }
  }

  for (const row of graphRows) {
    if (!depthById.has(row.taskId)) {
      depthById.set(row.taskId, Math.max(1, row.depth || 1))
    }
  }

  const rowsByDepth = new Map<number, LoopRow[]>()

  for (const row of graphRows) {
    const depth = depthById.get(row.taskId) || 0
    const depthRows = rowsByDepth.get(depth) || []

    depthRows.push(row)
    rowsByDepth.set(depth, depthRows)
  }

  for (const depthRows of rowsByDepth.values()) {
    depthRows.sort((a, b) => (rowIndexById.get(a.taskId) || 0) - (rowIndexById.get(b.taskId) || 0))
  }

  const sortedDepths = Array.from(rowsByDepth.keys()).sort((a, b) => a - b)
  const maxRowColumns = Math.max(1, ...Array.from(rowsByDepth.values()).map(depthRows => depthRows.length))
  const graphRowCount = Math.max(1, sortedDepths.length)
  const graphBodyWidth = maxRowColumns * LOOP_GRAPH_NODE_WIDTH + Math.max(0, maxRowColumns - 1) * LOOP_GRAPH_COLUMN_GAP
  const width = LOOP_GRAPH_PADDING * 2 + Math.max(LOOP_GRAPH_NODE_WIDTH, graphBodyWidth)

  const height = Math.max(
    LOOP_GRAPH_PADDING * 2 + LOOP_GRAPH_NODE_HEIGHT,
    LOOP_GRAPH_PADDING * 2 +
      graphRowCount * LOOP_GRAPH_NODE_HEIGHT +
      Math.max(0, graphRowCount - 1) * LOOP_GRAPH_ROW_GAP
  )

  const nodes: LoopTaskGraphNodeLayout[] = []

  sortedDepths.forEach((depth, depthIndex) => {
    const depthRows = rowsByDepth.get(depth) || []

    const rowWidth =
      depthRows.length * LOOP_GRAPH_NODE_WIDTH + Math.max(0, depthRows.length - 1) * LOOP_GRAPH_COLUMN_GAP

    const rowX = LOOP_GRAPH_PADDING + Math.max(0, (graphBodyWidth - rowWidth) / 2)
    const rowY = LOOP_GRAPH_PADDING + depthIndex * (LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP)

    depthRows.forEach((row, index) => {
      nodes.push({
        depth,
        index,
        row,
        x: rowX + index * (LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_COLUMN_GAP),
        y: rowY
      })
    })
  })

  nodes.sort((a, b) => a.depth - b.depth || a.index - b.index)

  return { choiceGroups: loopTaskGraphChoiceGroups(nodes, height, width), edges, height, nodes, width }
}

function loopTaskGraphFocusState(layout: LoopTaskGraphLayout, taskId?: null | string): LoopTaskGraphFocusState {
  const selectedTaskId = taskId?.trim() || null
  const rowIds = new Set(layout.nodes.map(node => node.row.taskId))

  if (!selectedTaskId || !rowIds.has(selectedTaskId)) {
    return { edgeKeys: new Set(), nodeIds: new Set(), taskId: null }
  }

  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  for (const edge of layout.edges) {
    if (!rowIds.has(edge.from) || !rowIds.has(edge.to)) {
      continue
    }

    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to])
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from])
  }

  const nodeIds = new Set<string>([selectedTaskId])

  const visit = (startId: string, map: Map<string, string[]>) => {
    const queue = [startId]

    while (queue.length > 0) {
      const currentId = queue.shift()!

      for (const nextId of map.get(currentId) || []) {
        if (nodeIds.has(nextId)) {
          continue
        }

        nodeIds.add(nextId)
        queue.push(nextId)
      }
    }
  }

  visit(selectedTaskId, incoming)
  visit(selectedTaskId, outgoing)

  const edgeKeys = new Set(
    layout.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map(edge => `${edge.from}:${edge.to}`)
  )

  return { edgeKeys, nodeIds, taskId: selectedTaskId }
}

function loopGraphRelatedTargetBelongsToTask(taskId: string, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }

  return (
    target.closest('[data-loop-task-graph-interaction]')?.getAttribute('data-loop-task-graph-interaction') === taskId
  )
}

function LoopTaskGraphActionTray({
  layout,
  onActionEnd,
  onActionStart,
  onTaskAction
}: {
  layout: LoopTaskGraphNodeLayout
  onActionEnd: (taskId: string, relatedTarget: EventTarget | null) => void
  onActionStart: (taskId: string) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
}) {
  const { row, x, y } = layout
  const blocked = normalizedLoopValue(row.status) === 'blocked'
  const planningNode = row.planningNode === true
  const statusAction: LoopTaskAction = blocked ? 'unblock' : 'block'
  const statusLabel = blocked ? 'Unblock' : 'Block'

  const top =
    y > LOOP_GRAPH_NODE_HEIGHT
      ? y - LOOP_GRAPH_ACTION_TRAY_HEIGHT + LOOP_GRAPH_ACTION_TRAY_OVERLAP
      : y + LOOP_GRAPH_NODE_HEIGHT - LOOP_GRAPH_ACTION_TRAY_OVERLAP

  return (
    <div
      className="absolute z-30 flex items-center gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-1 shadow-nous"
      data-loop-task-graph-interaction={row.taskId}
      data-testid={`loop-task-graph-action-tray-${row.taskId}`}
      onBlur={event => onActionEnd(row.taskId, event.relatedTarget)}
      onFocus={() => onActionStart(row.taskId)}
      onMouseEnter={() => onActionStart(row.taskId)}
      onMouseLeave={event => onActionEnd(row.taskId, event.relatedTarget)}
      style={{ left: x, top }}
    >
      <Button
        aria-label={`Ask in chat about ${row.taskId}`}
        className="h-6 gap-1 px-1.5 text-[0.68rem]"
        disabled={!onTaskAction}
        onClick={event => {
          event.stopPropagation()
          onTaskAction?.('ask-hermes', row)
        }}
        type="button"
        variant="outline"
      >
        <Codicon name="comment-discussion" size="0.72rem" />
        <span>Ask</span>
      </Button>
      {!planningNode && (
        <Button
          aria-label={`${statusLabel} ${row.taskId}`}
          className="h-6 gap-1 px-1.5 text-[0.68rem]"
          disabled={!onTaskAction}
          onClick={event => {
            event.stopPropagation()
            onTaskAction?.(statusAction, row)
          }}
          type="button"
          variant="outline"
        >
          <Codicon name={blocked ? 'unlock' : 'lock'} size="0.72rem" />
          <span>{statusLabel}</span>
        </Button>
      )}
    </div>
  )
}

function LoopTaskGraphNode({
  dimmed,
  layout,
  onActionEnd,
  onActionStart,
  onOpen,
  onSelect,
  pathConnected,
  selected
}: {
  dimmed?: boolean
  layout: LoopTaskGraphNodeLayout
  onActionEnd?: (taskId: string, relatedTarget: EventTarget | null) => void
  onActionStart?: (taskId: string) => void
  onOpen?: (row: LoopRow) => void
  onSelect?: (row: LoopRow) => void
  pathConnected?: boolean
  selected?: boolean
}) {
  const { row, x, y } = layout
  const currentTool = loopWorkerCurrentTool(row)
  const agent = loopTaskGraphAgentLabel(row)
  const choiceState = loopTaskChoiceState(row)
  const choiceLabel = choiceState ? loopTaskChoiceLabel(choiceState) : null
  const choiceAria = choiceState ? loopTaskChoiceAria(row, choiceState) : null
  const decisionGroupId = loopDecisionGroupId(row)

  return (
    <button
      aria-label={`${selected ? 'Selected' : 'Select'} ${row.title} (${row.taskId})${choiceAria ? ` · ${choiceAria}` : ''}`}
      aria-pressed={selected}
      className={cn(
        'absolute z-20 flex flex-col gap-1.5 overflow-visible rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-2 text-left shadow-none transition-colors hover:border-(--ui-stroke-primary) hover:bg-(--ui-row-hover-background) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        onSelect || onOpen ? 'cursor-pointer' : 'cursor-default',
        isDoneLoopRow(row) && 'bg-(--ui-bg-secondary)/45',
        choiceState === 'candidate' && 'border-dashed border-(--ui-stroke-secondary)',
        choiceState === 'recommended' && 'border-dashed border-amber-500/60 bg-amber-500/[0.06]',
        choiceState === 'chosen' &&
          'border-(--ui-stroke-primary) bg-(--ui-row-hover-background) ring-1 ring-(--ui-stroke-primary)/40',
        choiceState === 'rejected' &&
          !selected &&
          'border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/35 opacity-65',
        pathConnected && !selected && 'border-(--ui-stroke-secondary) bg-(--ui-fill-quaternary)/45',
        selected &&
          'border-(--ui-stroke-primary) bg-(--ui-row-hover-background) shadow-nous ring-1 ring-(--ui-stroke-primary)/30',
        dimmed && 'opacity-55'
      )}
      data-choice-state={choiceState || undefined}
      data-decision-group-id={decisionGroupId || undefined}
      data-dimmed={dimmed ? 'true' : 'false'}
      data-loop-task-graph-interaction={row.taskId}
      data-path-connected={pathConnected ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`loop-task-graph-node-${row.taskId}`}
      onBlur={event => onActionEnd?.(row.taskId, event.relatedTarget)}
      onClick={() => {
        onSelect?.(row)
        onOpen?.(row)
      }}
      onFocus={() => onActionStart?.(row.taskId)}
      onMouseEnter={() => onActionStart?.(row.taskId)}
      onMouseLeave={event => onActionEnd?.(row.taskId, event.relatedTarget)}
      style={{
        height: LOOP_GRAPH_NODE_HEIGHT,
        left: x,
        top: y,
        width: LOOP_GRAPH_NODE_WIDTH
      }}
      type="button"
    >
      <div className="flex min-w-0 items-start gap-2">
        <LoopStatusIndicator row={row} />
        <span className="min-w-0 flex-1 truncate text-[0.7rem] font-medium leading-4 text-(--ui-text-primary)">
          {row.title}
        </span>
      </div>
      {(agent || currentTool || choiceLabel) && (
        <div className="flex min-w-0 items-center gap-1.5">
          {choiceState && choiceLabel ? (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-[0.2rem] border px-1.5 py-0.5 text-[0.58rem] uppercase tracking-wide',
                choiceState === 'candidate' && 'border-(--ui-stroke-tertiary) text-(--ui-text-tertiary)',
                choiceState === 'recommended' &&
                  'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                choiceState === 'chosen' &&
                  'border-(--ui-stroke-primary)/60 bg-(--ui-row-hover-background) text-(--ui-text-primary)',
                choiceState === 'rejected' && 'border-(--ui-stroke-tertiary) text-(--ui-text-quaternary)'
              )}
            >
              <span aria-hidden="true">{loopTaskChoiceIcon(choiceState)}</span>
              <span>{choiceLabel}</span>
            </span>
          ) : null}
          {agent ? (
            <span className="max-w-full truncate rounded-[0.2rem] bg-(--ui-bg-secondary) px-1.5 py-0.5 text-[0.62rem] text-(--ui-text-tertiary)">
              {agent}
            </span>
          ) : null}
          {currentTool ? (
            <span className="min-w-0 truncate text-[0.62rem] text-(--ui-text-tertiary) leading-none">
              {currentTool}
            </span>
          ) : null}
        </div>
      )}
    </button>
  )
}

function loopGraphCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function loopGraphSummaryItems(rows: LoopRow[]): { key: string; label: string }[] {
  const active = rows.filter(row => row.active || isActiveLoopRow(row)).length
  const frontier = rows.filter(row => row.frontier).length

  const choiceIds = new Set(
    rows
      .filter(row => normalizedLoopValue(row.branchKind) === 'alternative' && loopDecisionGroupId(row))
      .map(row => loopDecisionGroupId(row)!)
  )

  const blockers = rows.filter(row => normalizedLoopValue(row.status) === 'blocked').length

  const reviews = rows.filter(row => {
    const status = normalizedLoopValue(row.status)
    const text = attentionText(row)

    return (
      Boolean(row.reviewKind) ||
      status === 'review' ||
      text.includes('review-required') ||
      text.includes('review required')
    )
  }).length

  return [
    active > 0 ? { key: 'active', label: loopGraphCountLabel(active, 'active', 'active') } : null,
    frontier > 0 ? { key: 'frontier', label: loopGraphCountLabel(frontier, 'frontier', 'frontier') } : null,
    choiceIds.size > 0 ? { key: 'choice', label: loopGraphCountLabel(choiceIds.size, 'choice') } : null,
    blockers > 0 ? { key: 'blocker', label: loopGraphCountLabel(blockers, 'blocker') } : null,
    reviews > 0 ? { key: 'review', label: loopGraphCountLabel(reviews, 'review') } : null
  ].filter((item): item is { key: string; label: string } => Boolean(item))
}

function LoopGraphSummary({ rows }: { rows: LoopRow[] }) {
  const items = loopGraphSummaryItems(rows)

  if (items.length === 0) {
    return null
  }

  return (
    <div className="mb-2 flex flex-wrap gap-1" data-testid="loop-graph-summary">
      {items.map(item => (
        <span
          className="rounded border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) px-1.5 py-0.5 text-[0.62rem] text-(--ui-text-tertiary)"
          key={item.key}
        >
          {item.label}
        </span>
      ))}
    </div>
  )
}

function LoopTaskGraph({
  fullPanel = false,
  onOpenTaskTab,
  onSelectTask,
  onTaskAction,
  rows,
  selectedTaskId
}: {
  fullPanel?: boolean
  onOpenTaskTab?: (row: LoopRow) => void
  onSelectTask?: (row: LoopRow) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  rows: LoopRow[]
  selectedTaskId?: null | string
}) {
  const [zoom, setZoom] = useState(1)
  const [view, setView] = useState<LoopGraphView>(DEFAULT_LOOP_GRAPH_VIEW)
  const [hoveredTaskId, setHoveredTaskId] = useState<null | string>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<null | { pointerId: number; startX: number; startY: number; view: LoopGraphView }>(null)
  const lastAutoFrameKeyRef = useRef<null | string>(null)
  const [canvasViewport, setCanvasViewport] = useState<LoopGraphViewportSize>(EMPTY_LOOP_GRAPH_VIEWPORT)

  const measureCanvasViewport = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      if (!fullPanel) {
        return
      }

      const entry = entries.find(candidate => candidate.target === canvasRef.current) || entries[0]
      const rect = entry?.contentRect
      let width = rect?.width || 0
      let height = rect?.height || 0

      if ((!width || !height) && canvasRef.current) {
        const bounds = canvasRef.current.getBoundingClientRect()
        width = bounds.width
        height = bounds.height
      }

      if (width <= 0 || height <= 0) {
        return
      }

      setCanvasViewport(current =>
        Math.round(current.width) === Math.round(width) && Math.round(current.height) === Math.round(height)
          ? current
          : { height, width }
      )
    },
    [fullPanel]
  )

  useResizeObserver(measureCanvasViewport, canvasRef)

  const layout = useMemo(() => loopTaskGraphLayout(rows), [rows])

  const graphFrameKey = useMemo(
    () => rows.map(row => `${row.taskId}:${row.parents.join(',')}:${row.children.join(',')}`).join('|'),
    [rows]
  )

  useEffect(() => {
    if (!fullPanel) {
      return
    }

    const frameKey = `${graphFrameKey}:${Math.round(canvasViewport.width)}x${Math.round(canvasViewport.height)}`

    if (lastAutoFrameKeyRef.current === frameKey) {
      return
    }

    lastAutoFrameKeyRef.current = frameKey
    setView(frameLoopGraphView(layout, canvasViewport))
  }, [canvasViewport, fullPanel, graphFrameKey, layout])

  const viewportMetrics = useMemo(
    () => loopGraphViewportMetrics(layout, zoom, fullPanel, canvasViewport),
    [canvasViewport, fullPanel, layout, zoom]
  )

  const nodeById = useMemo(() => new Map(layout.nodes.map(node => [node.row.taskId, node])), [layout.nodes])

  const edgesWithPaths = useMemo(() => {
    return layout.edges
      .map(edge => {
        const from = nodeById.get(edge.from)
        const to = nodeById.get(edge.to)

        if (!from || !to) {
          return null
        }

        const isFeedback = from.y > to.y

        if (isFeedback) {
          return null
        }

        const isSameRow = from.y === to.y

        let startX: number, startY: number, endX: number, endY: number
        let d: string

        if (isSameRow) {
          startX = from.x + LOOP_GRAPH_NODE_WIDTH
          startY = from.y + LOOP_GRAPH_NODE_HEIGHT / 2
          endX = to.x
          endY = to.y + LOOP_GRAPH_NODE_HEIGHT / 2

          const dx = Math.abs(endX - startX) / 2
          d = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`
        } else {
          startX = from.x + LOOP_GRAPH_NODE_WIDTH / 2
          startY = from.y + LOOP_GRAPH_NODE_HEIGHT
          endX = to.x + LOOP_GRAPH_NODE_WIDTH / 2
          endY = to.y

          const isLongSpan = endY - startY > LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP + 10

          if (isLongSpan) {
            return null
          } else {
            const dy = (endY - startY) / 2
            d = `M ${startX} ${startY} C ${startX} ${startY + dy}, ${endX} ${endY - dy}, ${endX} ${endY}`
          }
        }

        return { d, edge }
      })
      .filter(Boolean) as { d: string; edge: LoopTaskGraphEdge }[]
  }, [layout.edges, nodeById])

  const selectedFocus = useMemo(() => loopTaskGraphFocusState(layout, selectedTaskId), [layout, selectedTaskId])
  const hoveredFocus = useMemo(() => loopTaskGraphFocusState(layout, hoveredTaskId), [hoveredTaskId, layout])
  const activeFocus = hoveredFocus.taskId ? hoveredFocus : selectedFocus
  const choiceGroups = layout.choiceGroups

  const zoomFullGraph = useCallback((targetScale: number, sx: number, sy: number) => {
    setView(current => {
      const nextScale = clampLoopGraphZoom(targetScale)
      const wx = (sx - current.x) / current.scale
      const wy = (sy - current.y) / current.scale

      return { scale: nextScale, x: sx - wx * nextScale, y: sy - wy * nextScale }
    })
  }, [])

  const zoomFullGraphBy = useCallback(
    (factor: number) => {
      const sx = canvasViewport.width > 0 ? canvasViewport.width / 2 : LOOP_GRAPH_CANVAS_PADDING
      const sy = canvasViewport.height > 0 ? canvasViewport.height / 2 : LOOP_GRAPH_CANVAS_PADDING

      setView(current => {
        const nextScale = clampLoopGraphZoom(current.scale * factor)
        const wx = (sx - current.x) / current.scale
        const wy = (sy - current.y) / current.scale

        return { scale: nextScale, x: sx - wx * nextScale, y: sy - wy * nextScale }
      })
    },
    [canvasViewport.height, canvasViewport.width]
  )

  const resetFullGraphZoom = useCallback(() => {
    const sx = canvasViewport.width > 0 ? canvasViewport.width / 2 : LOOP_GRAPH_CANVAS_PADDING
    const sy = canvasViewport.height > 0 ? canvasViewport.height / 2 : LOOP_GRAPH_CANVAS_PADDING

    zoomFullGraph(1, sx, sy)
  }, [canvasViewport.height, canvasViewport.width, zoomFullGraph])

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!fullPanel) {
        if (!event.ctrlKey) {
          return
        }

        event.preventDefault()
        setZoom(currentZoom => clampLoopGraphZoom(currentZoom * Math.exp(-event.deltaY * LOOP_GRAPH_ZOOM_SENSITIVITY)))

        return
      }

      event.preventDefault()

      if (event.ctrlKey || event.metaKey) {
        const bounds = event.currentTarget.getBoundingClientRect()
        const sx = event.clientX - bounds.left
        const sy = event.clientY - bounds.top
        const nextScale = clampLoopGraphZoom(view.scale * Math.exp(-event.deltaY * LOOP_GRAPH_ZOOM_SENSITIVITY))

        zoomFullGraph(nextScale, sx, sy)

        return
      }

      setView(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
    },
    [fullPanel, view.scale, zoomFullGraph]
  )

  const handleActionStart = useCallback((taskId: string) => {
    setHoveredTaskId(taskId)
  }, [])

  const handleActionEnd = useCallback((taskId: string, relatedTarget: EventTarget | null) => {
    if (loopGraphRelatedTargetBelongsToTask(taskId, relatedTarget)) {
      return
    }

    setHoveredTaskId(currentTaskId => (currentTaskId === taskId ? null : currentTaskId))
  }, [])

  const frameFullGraph = useCallback(() => {
    setView(frameLoopGraphView(layout, canvasViewport))
  }, [canvasViewport, layout])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!fullPanel || event.button !== 0) {
        return
      }

      if ((event.target as Element | null)?.closest('[data-loop-task-graph-interaction]')) {
        return
      }

      event.preventDefault()
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, view }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [fullPanel, view]
  )

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    setView({
      ...drag.view,
      x: drag.view.x + event.clientX - drag.startX,
      y: drag.view.y + event.clientY - drag.startY
    })
  }, [])

  const endPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }, [])

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!fullPanel || (event.target as Element | null)?.closest('[data-loop-task-graph-interaction]')) {
        return
      }

      frameFullGraph()
    },
    [frameFullGraph, fullPanel]
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!fullPanel || event.defaultPrevented) {
        return
      }

      const target = event.target as Element | null

      if (target?.closest('button, input, textarea, select, [contenteditable="true"]')) {
        return
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        frameFullGraph()
      }
    },
    [frameFullGraph, fullPanel]
  )

  const fullPanelTransform = fullPanel
    ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    : `scale(${viewportMetrics.effectiveZoom})`

  const toolbarButtonClass =
    'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background)/95 px-2 text-[0.68rem] font-medium text-(--ui-text-primary) shadow-nous backdrop-blur hover:bg-(--ui-fill-quaternary)'

  const toolbarIconButtonClass = cn(toolbarButtonClass, 'w-7 px-0 text-sm')

  return (
    <div
      aria-label={fullPanel ? 'Loop graph canvas' : undefined}
      className={cn(
        fullPanel
          ? 'h-full w-full min-h-0 overflow-hidden bg-(--ui-editor-surface-background) p-0'
          : 'max-h-80 min-h-48 overflow-auto rounded-md border border-(--ui-stroke-tertiary) p-3'
      )}
      data-testid="loop-task-graph"
      data-view-x={fullPanel ? Math.round(view.x) : undefined}
      data-view-y={fullPanel ? Math.round(view.y) : undefined}
      data-zoom={(fullPanel ? view.scale : viewportMetrics.effectiveZoom).toFixed(2)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={endPointerDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerDrag}
      onWheel={handleWheel}
      ref={canvasRef}
      role={fullPanel ? 'region' : undefined}
      tabIndex={fullPanel ? 0 : undefined}
    >
      {fullPanel ? null : <LoopGraphSummary rows={rows} />}
      {fullPanel ? (
        <div
          aria-label="Loop graph toolbar"
          className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background)/90 p-1 shadow-nous backdrop-blur"
          data-loop-task-graph-interaction="toolbar"
          data-testid="loop-task-graph-toolbar"
          onPointerDown={event => event.stopPropagation()}
          onWheel={event => event.stopPropagation()}
          role="toolbar"
        >
          <button
            aria-label="Zoom out"
            className={toolbarIconButtonClass}
            onClick={() => zoomFullGraphBy(0.88)}
            title="Zoom out"
            type="button"
          >
            −
          </button>
          <button
            aria-label="Zoom to 100%"
            className={toolbarButtonClass}
            onClick={resetFullGraphZoom}
            title="Zoom to 100%"
            type="button"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button
            aria-label="Zoom in"
            className={toolbarIconButtonClass}
            onClick={() => zoomFullGraphBy(1.14)}
            title="Zoom in"
            type="button"
          >
            +
          </button>
          <button
            aria-label="Frame everything · F"
            className={toolbarIconButtonClass}
            onClick={frameFullGraph}
            title="Frame everything · F"
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              viewBox="0 0 16 16"
              width="16"
            >
              <path d="M5.8 3.25H3.25V5.8" />
              <path d="M10.2 3.25h2.55V5.8" />
              <path d="M12.75 10.2v2.55H10.2" />
              <path d="M5.8 12.75H3.25V10.2" />
            </svg>
          </button>
        </div>
      ) : null}
      <div
        className={cn('relative', fullPanel ? 'h-full min-h-full w-full min-w-full' : 'mx-auto')}
        data-testid="loop-task-graph-frame"
        style={{
          height: fullPanel ? '100%' : viewportMetrics.frameHeight,
          minHeight: fullPanel ? '100%' : undefined,
          minWidth: fullPanel ? '100%' : undefined,
          width: fullPanel ? '100%' : viewportMetrics.frameWidth
        }}
      >
        <div
          className={cn('relative origin-top-left', fullPanel && 'absolute')}
          data-testid="loop-task-graph-surface"
          style={{
            height: layout.height,
            left: fullPanel ? 0 : undefined,
            top: fullPanel ? 0 : undefined,
            transform: fullPanelTransform,
            transformOrigin: '0 0',
            width: layout.width
          }}
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 text-(--ui-stroke-secondary)"
            height={layout.height}
            width={layout.width}
          >
            <defs>
              <marker
                id="loop-graph-arrow"
                markerHeight="5"
                markerWidth="5"
                orient="auto"
                refX="7"
                refY="5"
                viewBox="0 0 10 10"
              >
                <path d="M 0 1.5 L 7 5 L 0 8.5 z" fill="currentColor" />
              </marker>
              <marker
                id="loop-graph-arrow-dim"
                markerHeight="5"
                markerWidth="5"
                orient="auto"
                refX="7"
                refY="5"
                viewBox="0 0 10 10"
              >
                <path d="M 0 1.5 L 7 5 L 0 8.5 z" fill="currentColor" opacity="0.3" />
              </marker>
            </defs>
            {edgesWithPaths.map(({ d, edge }) => {
              const edgeKey = `${edge.from}:${edge.to}`

              const selectedConnected = selectedFocus.edgeKeys.has(edgeKey)
              const highlighted = activeFocus.edgeKeys.has(edgeKey)
              const hoverHighlighted = Boolean(hoveredFocus.taskId && hoveredFocus.edgeKeys.has(edgeKey))
              const dimmed = Boolean(activeFocus.taskId && !highlighted)

              let opacity: number

              if (highlighted) {
                opacity = 1
              } else if (dimmed) {
                opacity = 0.22
              } else if (edge.tentative) {
                opacity = 1
              } else {
                opacity = 0.85
              }

              const strokeWidth = edge.tentative ? (hoverHighlighted ? 2.4 : 2) : highlighted ? 1.8 : 1.35

              return (
                <path
                  className="pointer-events-none"
                  d={d}
                  data-dimmed={dimmed ? 'true' : 'false'}
                  data-selected-connected={selectedConnected ? 'true' : 'false'}
                  data-testid={`loop-task-graph-edge-${edge.from}-${edge.to}`}
                  fill="none"
                  key={edgeKey}
                  markerEnd={
                    highlighted || !activeFocus.taskId ? 'url(#loop-graph-arrow)' : 'url(#loop-graph-arrow-dim)'
                  }
                  opacity={opacity}
                  stroke="currentColor"
                  strokeDasharray={edge.tentative ? '0.5 8' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={strokeWidth}
                  style={{ transition: 'opacity 150ms ease, stroke-width 150ms ease' }}
                />
              )
            })}
          </svg>
          {choiceGroups.map(group => (
            <div
              aria-label={`Choose one decision group ${group.groupId}`}
              className="pointer-events-none absolute rounded-lg border border-dashed border-amber-500/35 bg-amber-500/[0.04]"
              data-decision-group-id={group.groupId}
              data-testid={group.testId}
              key={group.groupId}
              role="group"
              style={{
                height: group.height,
                left: group.x,
                top: group.y,
                width: group.width
              }}
              title="One option in this group should be selected"
            >
              <span className="absolute left-2 top-1 rounded bg-(--ui-surface-background) px-1.5 py-0.5 text-[0.58rem] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-300">
                Choose one
              </span>
            </div>
          ))}
          {layout.nodes.map(node => {
            const pathConnected = selectedFocus.nodeIds.has(node.row.taskId)
            const dimmed = Boolean(activeFocus.taskId && !activeFocus.nodeIds.has(node.row.taskId))
            const showActionTray = hoveredTaskId === node.row.taskId

            return (
              <Fragment key={node.row.taskId}>
                <LoopTaskGraphNode
                  dimmed={dimmed}
                  layout={node}
                  onActionEnd={handleActionEnd}
                  onActionStart={handleActionStart}
                  onOpen={onOpenTaskTab}
                  onSelect={onSelectTask}
                  pathConnected={pathConnected}
                  selected={node.row.taskId === selectedTaskId}
                />
                {showActionTray ? (
                  <LoopTaskGraphActionTray
                    layout={node}
                    onActionEnd={handleActionEnd}
                    onActionStart={handleActionStart}
                    onTaskAction={onTaskAction}
                  />
                ) : null}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

type LoopHandoffLine = { label: string; value: string }

function loopMetadataLabel(value: string): string {
  return loopToolLabel(value.replaceAll('-', '_'))
}

function loopHandoffLinesForRow(row: LoopRow): LoopHandoffLine[] {
  const lines: LoopHandoffLine[] = []

  const pushLine = (label: string, value?: null | number | string) => {
    if (value === null || value === undefined || value === '') {
      return
    }

    lines.push({ label, value: String(value) })
  }

  pushLine('Review kind', row.reviewKind ? loopMetadataLabel(row.reviewKind) : undefined)
  pushLine('Resume mode', row.resumeMode ? loopMetadataLabel(row.resumeMode) : undefined)
  pushLine('Review subject', row.reviewSubjectAssignee)
  pushLine('Task session', row.sourceSessionId)
  pushLine('Parent session', row.foregroundParentSessionId)
  pushLine('Fork session', row.foregroundForkSessionId)

  return lines
}

function loopHandoffSummary(handoff: LoopTaskHandoff): string {
  return [
    handoff.intent ? loopMetadataLabel(handoff.intent) : undefined,
    handoff.target_actor ? `Target ${loopMetadataLabel(handoff.target_actor)}` : undefined,
    handoff.queue_state ? loopMetadataLabel(handoff.queue_state) : undefined,
    handoff.handoff_kind ? loopMetadataLabel(handoff.handoff_kind) : undefined,
    handoff.state ? loopMetadataLabel(handoff.state) : undefined,
    handoff.verification_state ? loopMetadataLabel(handoff.verification_state) : undefined,
    handoff.attention ? loopMetadataLabel(handoff.attention) : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

function LoopForegroundHandoffCard({ row }: { row: LoopRow }) {
  const lines = loopHandoffLinesForRow(row)
  const handoffs = (row.loopHandoffs || []).filter(isPendingLoopHandoff)

  const hasReviewRouting = Boolean(
    row.reviewKind || row.resumeMode || row.foregroundParentSessionId || row.foregroundForkSessionId
  )

  if (!hasReviewRouting && handoffs.length === 0) {
    return null
  }

  return (
    <DetailSection testId="loop-foreground-handoff-card" title="Handoff request">
      <div className="grid gap-2 text-[0.72rem] text-(--ui-text-secondary)">
        {isOrchestratorReviewRow(row) ? (
          <div className="flex items-start gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) px-2 py-1.5">
            <StatusIndicator ariaLabel="Orchestrator review attention" kind="attention" />
            <div className="grid min-w-0 gap-0.5">
              <p className="m-0 font-medium text-(--ui-text-primary)">{attentionReason(row)}</p>
              <p className="m-0 text-[0.66rem] text-(--ui-text-tertiary)">
                This handoff remains attached to task {row.taskId}.
              </p>
            </div>
          </div>
        ) : null}

        {lines.length > 0 ? (
          <dl className="m-0 grid gap-1" data-testid="loop-foreground-lineage-list">
            {lines.map(line => (
              <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2" key={`${line.label}:${line.value}`}>
                <dt className="text-(--ui-text-tertiary)">{line.label}</dt>
                <dd className="m-0 min-w-0 break-all font-mono text-[0.68rem] text-(--ui-text-secondary)">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {handoffs.length > 0 ? (
          <div className="grid gap-1" data-testid="loop-foreground-handoff-list">
            <p className="m-0 text-[0.62rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">
              Durable handoffs
            </p>
            {handoffs.map((handoff, index) => (
              <div
                className="grid min-w-0 gap-0.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) px-2 py-1.5"
                key={handoff.id ?? `${handoff.handoff_kind}:${handoff.run_id}:${index}`}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-medium text-(--ui-text-primary)">
                    {loopHandoffSummary(handoff) || 'Loop handoff'}
                  </span>
                  {handoff.review_task_id ? (
                    <span className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.62rem] text-(--ui-text-tertiary)">
                      review {handoff.review_task_id}
                    </span>
                  ) : null}
                  {handoff.resolution_action ? (
                    <span className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.62rem] text-(--ui-text-tertiary)">
                      {loopMetadataLabel(handoff.resolution_action)}
                      {handoff.resolved_by ? ` by ${handoff.resolved_by}` : ''}
                    </span>
                  ) : null}
                </div>
                {(handoff.summary || handoff.reason) && (
                  <p className="m-0 whitespace-pre-wrap text-[0.68rem] leading-relaxed text-(--ui-text-secondary)">
                    {handoff.summary || handoff.reason}
                  </p>
                )}
                {handoff.worker_session_id || handoff.reviewer_session_id ? (
                  <p className="m-0 break-all font-mono text-[0.64rem] text-(--ui-text-tertiary)">
                    {[
                      handoff.worker_session_id && `worker ${handoff.worker_session_id}`,
                      handoff.reviewer_session_id && `reviewer ${handoff.reviewer_session_id}`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </DetailSection>
  )
}

function loopOverviewItemState(row: LoopRow): StatusItemState {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)
  const runOutcome = normalizedLoopValue(row.latestRun?.outcome)

  if (
    attentionScore(row) > 0 ||
    FAILED_LOOP_STATUSES.has(status) ||
    FAILED_LOOP_STATUSES.has(runStatus) ||
    FAILED_LOOP_STATUSES.has(runOutcome)
  ) {
    return 'failed'
  }

  if (isActiveLoopRow(row) || row.active) {
    return 'running'
  }

  return 'done'
}

function loopOverviewStatusItem(row: LoopRow, options: { preferAssigneeForQueued?: boolean } = {}): ComposerStatusItem {
  const queued = isQueuedLoopRow(row)
  const currentTool = loopWorkerCurrentTool(row)
  const profile = loopTaskGraphAgentLabel(row)

  return {
    currentTool: currentTool || (queued && !options.preferAssigneeForQueued ? 'Loop' : undefined),
    profile,
    id: `kanban-agent:${row.taskId}:${row.workerActivity?.run_id ?? row.latestRun?.id ?? 'overview'}`,
    kanbanTaskId: row.taskId,
    runId: row.workerActivity?.run_id ?? row.latestRun?.id,
    sessionId: row.workerActivity?.worker_session_id || row.latestRun?.worker_session_id || undefined,
    state: queued ? 'running' : loopOverviewItemState(row),
    statusIndicator: loopRowStatusIndicator(row),
    title: row.title,
    todoStatus: queued ? 'pending' : undefined,
    type: queued ? 'todo' : 'kanban-agent'
  }
}

function LoopRootAgentsCard({
  groups,
  onOpenTaskTab,
  onTaskAction,
  root
}: {
  groups: RootOverviewGroups
  onOpenTaskTab?: (row: LoopRow) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  root: LoopRow
}) {
  const [selectedGraphTaskId, setSelectedGraphTaskId] = useState<null | string>(null)
  const rows = [root, ...groups.active, ...groups.attention, ...groups.queued, ...groups.other, ...groups.completed]
  const selectedGraphRow = selectedGraphTaskId ? rows.find(row => row.taskId === selectedGraphTaskId) || null : null

  useEffect(() => {
    setSelectedGraphTaskId(null)
  }, [root.taskId])

  const selectGraphTask = useCallback((targetRow: LoopRow) => {
    setSelectedGraphTaskId(targetRow.taskId)
  }, [])

  return (
    <section
      aria-label="Loop graph canvas"
      className="relative flex h-full min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-(--ui-editor-surface-background) text-xs"
      data-root-overview-canvas="true"
      data-testid="loop-root-agents-card"
    >
      {rows.length === 0 ? (
        <EmptyDetail>No agents yet.</EmptyDetail>
      ) : (
        <LoopTaskGraph
          fullPanel
          onOpenTaskTab={onOpenTaskTab}
          onSelectTask={selectGraphTask}
          onTaskAction={onTaskAction}
          rows={rows}
          selectedTaskId={selectedGraphRow?.taskId || null}
        />
      )}
    </section>
  )
}

function LoopRootOverview({
  group,
  onOpenTaskTab,
  onTaskAction
}: {
  group: LoopDependencyGroup
  onOpenTaskTab?: (row: LoopRow) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
}) {
  const root = group.anchor
  const groups = rootOverviewGroups(group)

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col">
      <LoopRootAgentsCard groups={groups} onOpenTaskTab={onOpenTaskTab} onTaskAction={onTaskAction} root={root} />
    </div>
  )
}

function LoopTaskDetails({
  backLabel,
  detail,
  detailError,
  commentsError,
  onAddComment,
  onBack,
  onTaskAction,
  row
}: {
  backLabel?: null | string
  detail?: LoopTaskDetail | null
  detailError?: null | string
  commentsError?: null | string
  onAddComment?: LoopTaskCommentSubmit
  onBack?: () => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  row: LoopRow
}) {
  return (
    <div className="grid min-w-0 max-w-full gap-3">
      <section
        className="min-w-0 max-w-full overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs"
        data-testid="loop-task-card"
      >
        <div className="grid gap-2">
          {backLabel && onBack && (
            <Button
              aria-label={`Back to ${backLabel}`}
              className="h-7 justify-start px-2 text-xs"
              onClick={onBack}
              type="button"
              variant="ghost"
            >
              Back to {backLabel}
            </Button>
          )}
          <div className="flex items-center gap-2 font-medium text-(--ui-text-primary)">
            <LoopStatusIndicator row={row} />
            <LoopPriorityIndicator row={row} />
            <h3 className="m-0 min-w-0 truncate text-sm font-semibold text-(--ui-text-primary)">{row.title}</h3>
          </div>
          <LoopTaskActions onTaskAction={onTaskAction} row={row} />
        </div>
      </section>
      <LoopForegroundHandoffCard row={row} />

      {/* Markdown task description/spec with a graceful empty state. */}
      <DetailSection title="Description">
        {row.body?.trim() ? <TaskDescription text={row.body} /> : <EmptyDetail>No description provided.</EmptyDetail>}
      </DetailSection>

      <LoopTaskCommentsCard
        commentsError={commentsError}
        detail={detail}
        detailError={detailError}
        onAddComment={row.planningNode ? undefined : onAddComment}
        row={row}
      />

      <DetailSection title="Worker activity">
        <WorkerActivityDetails onTaskAction={onTaskAction} row={row} />
      </DetailSection>
    </div>
  )
}

interface LoopPanelTaskTab {
  taskId: string
  title: string
}

interface LoopPanelArtifactTab {
  diff?: string
  diffError?: string
  diffSource?: LoopArtifactDiffSource
  diffStatus: LoopArtifactDiffStatus
  diffTruncated?: boolean
  entry: LoopArtifactSourceEntry
  error?: string
  id: string
  rowTaskId: string
  rowTitle: string
  status: 'error' | 'loading' | 'ready'
  target?: PreviewTarget
  view: LoopArtifactTabView
}

interface LoopPanelTabBarProps {
  activeArtifactTabId: null | string
  activeTaskTabId: null | string
  artifactTabs: LoopPanelArtifactTab[]
  baseLabel: string
  onCloseArtifactTab: (tabId: string) => void
  onClosePane?: () => void
  onCloseTaskTab: (taskId: string) => void
  onSelectArtifactTab: (tabId: string) => void
  onSelectBaseTab: () => void
  onSelectTaskTab: (taskId: string) => void
  taskTabs: LoopPanelTaskTab[]
}

function LoopPanelTabBar({
  activeArtifactTabId,
  activeTaskTabId,
  artifactTabs,
  baseLabel,
  onCloseArtifactTab,
  onClosePane,
  onCloseTaskTab,
  onSelectArtifactTab,
  onSelectBaseTab,
  onSelectTaskTab,
  taskTabs
}: LoopPanelTabBarProps) {
  const tabs = [
    { artifactTabId: null, id: LOOP_OVERVIEW_TAB_ID, label: baseLabel, taskId: null },
    ...taskTabs.map(tab => ({
      artifactTabId: null,
      id: `loop-task:${tab.taskId}`,
      label: tab.title,
      taskId: tab.taskId
    })),
    ...artifactTabs.map(tab => ({
      artifactTabId: tab.id,
      id: `loop-artifact:${tab.id}`,
      label: tab.entry.label,
      taskId: null
    }))
  ]

  const activeTabId = activeArtifactTabId
    ? `loop-artifact:${activeArtifactTabId}`
    : activeTaskTabId
      ? `loop-task:${activeTaskTabId}`
      : LOOP_OVERVIEW_TAB_ID

  const activeTabRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  return (
    <div
      className="group/loop-tabs flex h-(--titlebar-height) shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)"
      data-testid="loop-panel-tabbar"
      style={{ paddingRight: 'calc(var(--titlebar-tools-right) + var(--titlebar-tools-width) + 0.5rem)' }}
    >
      <div
        className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
      >
        {tabs.map(tab => {
          const active = tab.artifactTabId
            ? tab.artifactTabId === activeArtifactTabId
            : tab.taskId
              ? tab.taskId === activeTaskTabId && !activeArtifactTabId
              : !activeTaskTabId && !activeArtifactTabId

          const closeTab = tab.artifactTabId
            ? () => onCloseArtifactTab(tab.artifactTabId!)
            : tab.taskId
              ? () => onCloseTaskTab(tab.taskId!)
              : onClosePane

          const selectTab = tab.artifactTabId
            ? () => onSelectArtifactTab(tab.artifactTabId!)
            : tab.taskId
              ? () => onSelectTaskTab(tab.taskId!)
              : onSelectBaseTab

          return (
            <div
              className={cn(
                'group/tab relative flex h-full min-w-36 max-w-56 shrink-0 items-center text-[0.6875rem] font-medium [-webkit-app-region:no-drag] last:border-r last:border-(--ui-stroke-quaternary)',
                active
                  ? 'bg-(--ui-editor-surface-background) text-foreground [--tab-bg:var(--ui-editor-surface-background)]'
                  : 'border-r border-(--ui-stroke-quaternary) text-(--ui-text-tertiary) [--tab-bg:var(--ui-sidebar-surface-background)] hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              data-testid={
                tab.artifactTabId
                  ? 'loop-artifact-tab'
                  : tab.taskId
                    ? `loop-task-tab-${tab.taskId}`
                    : 'loop-overview-tab'
              }
              key={tab.id}
              onAuxClick={event => {
                if (!closeTab || event.button !== 1) {
                  return
                }

                event.preventDefault()
                closeTab()
              }}
              onMouseDown={event => {
                if (closeTab && event.button === 1) {
                  event.preventDefault()
                }
              }}
              ref={active ? activeTabRef : undefined}
            >
              {active && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-(--ui-stroke-primary)" />}
              <button
                aria-selected={active}
                className="flex h-full min-w-0 max-w-full items-center overflow-hidden pl-3 pr-2 text-left outline-none"
                onClick={selectTab}
                role="tab"
                title={tab.label}
                type="button"
              >
                <span className="block min-w-0 truncate">{tab.label}</span>
              </button>
              {closeTab && (
                <>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute inset-y-0 right-0 w-9 bg-[linear-gradient(to_right,transparent,var(--tab-bg)_55%)] transition-opacity',
                      active
                        ? 'opacity-100'
                        : 'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100'
                    )}
                  />
                  <button
                    aria-label={`Close ${tab.label}`}
                    className={cn(
                      'absolute right-1.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-(--ui-text-tertiary) transition-[background-color,color,opacity] hover:bg-(--ui-bg-secondary) hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100',
                      active
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100'
                    )}
                    onClick={event => {
                      event.stopPropagation()
                      closeTab()
                    }}
                    type="button"
                  >
                    <Codicon name="close" size="0.75rem" />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function defaultArtifactTabView(entry: LoopArtifactSourceEntry): LoopArtifactTabView {
  return entry.kind === 'changed-file' ? 'diff' : 'preview'
}

function initialArtifactDiffStatus(entry: LoopArtifactSourceEntry): LoopArtifactDiffStatus {
  if (entry.kind !== 'changed-file') {
    return 'idle'
  }

  return entry.inlineDiff ? 'ready' : 'loading'
}

function artifactDiffPath(entry: LoopArtifactSourceEntry, target: PreviewTarget | null): string {
  if (target?.kind === 'file' && target.path) {
    return target.path
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(entry.target)) {
    return ''
  }

  return entry.target
}

export function LoopPanel({
  artifactSourceBaseDir,
  embedded = false,
  enableDebugJson = false,
  focusRequestKey = 0,
  hidden = false,
  onFocusTaskId,
  onHide,
  onSelectTaskId,
  onAddTaskComment,
  onTaskAction,
  open = false,
  selectedTaskComments,
  selectedTaskCommentsError,
  selectedTaskDetail,
  selectedTaskDetailError,
  selectedTaskId,
  state
}: LoopPanelProps) {
  const [debugOpen, setDebugOpen] = useState(false)
  const [navigationStack, setNavigationStack] = useState<LoopRow[]>([])
  const [focusedTaskId, setFocusedTaskId] = useState<null | string>(selectedTaskId || null)
  const [taskTabs, setTaskTabs] = useState<LoopPanelTaskTab[]>([])
  const [activeTaskTabId, setActiveTaskTabId] = useState<null | string>(null)
  const [artifactTabs, setArtifactTabs] = useState<LoopPanelArtifactTab[]>([])
  const [activeArtifactTabId, setActiveArtifactTabId] = useState<null | string>(null)
  const internalFocusTaskIdRef = useRef<null | string>(null)
  const lastFocusRequestKeyRef = useRef(focusRequestKey)
  const [panelWidth, setPanelWidth] = useState(LOOP_PANEL_DEFAULT_WIDTH)
  const stateRootTaskId = state?.rootTaskId || ''

  useEffect(() => {
    setTaskTabs([])
    setActiveTaskTabId(null)
    setArtifactTabs([])
    setActiveArtifactTabId(null)
  }, [stateRootTaskId])

  useEffect(() => {
    const nextSelectedTaskId = selectedTaskId || null
    const focusRequestChanged = focusRequestKey !== lastFocusRequestKeyRef.current
    lastFocusRequestKeyRef.current = focusRequestKey

    if (!focusRequestChanged && internalFocusTaskIdRef.current === nextSelectedTaskId) {
      internalFocusTaskIdRef.current = null

      return
    }

    internalFocusTaskIdRef.current = null
    setFocusedTaskId(nextSelectedTaskId)
    setNavigationStack([])
    setActiveTaskTabId(null)
    setActiveArtifactTabId(null)
  }, [focusRequestKey, selectedTaskId])

  const renderedTaskId = activeTaskTabId || focusedTaskId

  // Merge task detail with separately-fetched comments so the comments card
  // has the actual comment data instead of just the count from session-source.
  // Only merge when selectedTaskComments has been fetched (not undefined/loading).
  const mergedDetail = useMemo(() => {
    if (!selectedTaskDetail && selectedTaskComments === undefined) {
      return selectedTaskDetail
    }

    // If comments query hasn't resolved yet (undefined), don't merge yet -
    // let the detail's own comments (likely undefined) drive the loading state.
    if (selectedTaskComments === undefined) {
      return selectedTaskDetail
    }

    return {
      ...selectedTaskDetail,
      comments: selectedTaskComments ?? selectedTaskDetail?.comments ?? []
    }
  }, [selectedTaskDetail, selectedTaskComments])

  const selected = useMemo(
    () => selectedRowFrom(state, focusedTaskId, mergedDetail),
    [focusedTaskId, mergedDetail, state]
  )

  const activeTaskTabRow = useMemo(
    () => (activeTaskTabId ? selectedRowFrom(state, activeTaskTabId, mergedDetail) : null),
    [activeTaskTabId, mergedDetail, state]
  )

  const activeArtifactTab = useMemo(
    () => artifactTabs.find(tab => tab.id === activeArtifactTabId) || null,
    [activeArtifactTabId, artifactTabs]
  )

  const dependencyGroups = useMemo(() => loopDependencyGroups(state), [state])

  const selectedOverviewGroup = useMemo(
    () => loopDependencyGroupForTask(state, focusedTaskId || stateRootTaskId || null, dependencyGroups),
    [dependencyGroups, focusedTaskId, state, stateRootTaskId]
  )

  const overviewAnchor = selectedOverviewGroup?.anchor || null
  const loopOverviewEligible = loopDependencyGroupShowsOverview(selectedOverviewGroup)

  const showingLoopOverview = Boolean(
    loopOverviewEligible && overviewAnchor && (!focusedTaskId || focusedTaskId === overviewAnchor.taskId)
  )

  const rowById = useMemo(() => {
    const rows = state?.rows || []
    const map = new Map(rows.map(row => [row.taskId, row]))
    const detailRow = detailRowFromTaskDetail(mergedDetail, renderedTaskId)

    if (detailRow) {
      map.set(detailRow.taskId, detailRow)
    }

    return map
  }, [renderedTaskId, mergedDetail, state])

  const focusDrawerTask = useCallback(
    (taskId: string) => {
      setFocusedTaskId(taskId)
      internalFocusTaskIdRef.current = taskId

      if (onFocusTaskId) {
        onFocusTaskId(taskId)
      } else {
        onSelectTaskId?.(taskId)
      }
    },
    [onFocusTaskId, onSelectTaskId]
  )

  const selectRelatedTask = useCallback(
    (taskId: string) => {
      setActiveTaskTabId(null)
      setActiveArtifactTabId(null)

      if (selected && selected.taskId !== taskId) {
        setNavigationStack(stack => [...stack, selected].slice(-8))
      }

      focusDrawerTask(taskId)
    },
    [focusDrawerTask, selected]
  )

  const openTaskTab = useCallback(
    (row: LoopRow) => {
      setTaskTabs(tabs => {
        const existingIndex = tabs.findIndex(tab => tab.taskId === row.taskId)

        if (existingIndex >= 0) {
          return tabs.map(tab => (tab.taskId === row.taskId ? { ...tab, title: row.title || row.taskId } : tab))
        }

        return [...tabs, { taskId: row.taskId, title: row.title || row.taskId }]
      })
      setActiveTaskTabId(row.taskId)
      setActiveArtifactTabId(null)
      setNavigationStack([])
      focusDrawerTask(row.taskId)
    },
    [focusDrawerTask]
  )

  const selectTaskTab = useCallback(
    (taskId: string) => {
      setActiveTaskTabId(taskId)
      setActiveArtifactTabId(null)
      setNavigationStack([])
      focusDrawerTask(taskId)
    },
    [focusDrawerTask]
  )

  const selectBaseTab = useCallback(() => {
    setActiveTaskTabId(null)
    setActiveArtifactTabId(null)
    setNavigationStack([])

    if (activeTaskTabId && overviewAnchor) {
      focusDrawerTask(overviewAnchor.taskId)
    } else if (!focusedTaskId && overviewAnchor) {
      focusDrawerTask(overviewAnchor.taskId)
    } else if (!focusedTaskId) {
      setFocusedTaskId(null)
    }
  }, [activeTaskTabId, focusDrawerTask, focusedTaskId, overviewAnchor])

  const openArtifactTab = useCallback(
    (entry: LoopArtifactSourceEntry, row: LoopRow) => {
      const tabId = entry.id

      const nextTab: LoopPanelArtifactTab = {
        diff: entry.kind === 'changed-file' ? entry.inlineDiff : undefined,
        diffSource: entry.kind === 'changed-file' && entry.inlineDiff ? 'inline' : undefined,
        diffStatus: initialArtifactDiffStatus(entry),
        entry,
        id: tabId,
        rowTaskId: row.taskId,
        rowTitle: row.title || row.taskId,
        status: 'loading',
        view: defaultArtifactTabView(entry)
      }

      const baseDir = row.workspacePath || artifactSourceBaseDir || undefined

      setArtifactTabs(tabs => {
        const existingIndex = tabs.findIndex(tab => tab.id === tabId)

        if (existingIndex >= 0) {
          return tabs.map(tab =>
            tab.id === tabId
              ? {
                  ...tab,
                  diff: entry.kind === 'changed-file' ? entry.inlineDiff || tab.diff : undefined,
                  diffSource: entry.kind === 'changed-file' && entry.inlineDiff ? 'inline' : tab.diffSource,
                  diffStatus: entry.kind === 'changed-file' && entry.inlineDiff ? 'ready' : tab.diffStatus,
                  entry,
                  rowTaskId: row.taskId,
                  rowTitle: row.title || row.taskId,
                  view: tab.view
                }
              : tab
          )
        }

        return [...tabs, nextTab]
      })
      setActiveArtifactTabId(tabId)
      setActiveTaskTabId(null)
      setNavigationStack([])

      void normalizeOrLocalPreviewTarget(entry.target, baseDir).then(
        target => {
          setArtifactTabs(tabs =>
            tabs.map(tab =>
              tab.id === tabId
                ? {
                    ...tab,
                    error: target ? undefined : 'Preview unavailable.',
                    status: target ? 'ready' : 'error',
                    target: target || undefined
                  }
                : tab
            )
          )

          if (entry.kind !== 'changed-file' || entry.inlineDiff) {
            return
          }

          const diffPath = artifactDiffPath(entry, target)

          if (!diffPath) {
            setArtifactTabs(tabs =>
              tabs.map(tab =>
                tab.id === tabId
                  ? {
                      ...tab,
                      diffError: 'Diff unavailable for this target.',
                      diffStatus: 'error'
                    }
                  : tab
              )
            )

            return
          }

          void desktopGitDiff(diffPath).then(
            result => {
              const diff = (result.diff || '').trim()

              setArtifactTabs(tabs =>
                tabs.map(tab =>
                  tab.id === tabId
                    ? {
                        ...tab,
                        diff: diff || undefined,
                        diffError: result.error,
                        diffSource: 'git',
                        diffStatus: result.error ? 'error' : diff ? 'ready' : 'empty',
                        diffTruncated: Boolean(result.truncated)
                      }
                    : tab
                )
              )
            },
            error => {
              setArtifactTabs(tabs =>
                tabs.map(tab =>
                  tab.id === tabId
                    ? {
                        ...tab,
                        diffError: error instanceof Error ? error.message : String(error),
                        diffStatus: 'error'
                      }
                    : tab
                )
              )
            }
          )
        },
        error => {
          setArtifactTabs(tabs =>
            tabs.map(tab =>
              tab.id === tabId
                ? {
                    ...tab,
                    error: error instanceof Error ? error.message : String(error),
                    status: 'error'
                  }
                : tab
            )
          )

          if (entry.kind === 'changed-file' && !entry.inlineDiff) {
            setArtifactTabs(tabs =>
              tabs.map(tab =>
                tab.id === tabId
                  ? {
                      ...tab,
                      diffError: 'Diff unavailable while resolving the file preview.',
                      diffStatus: 'error'
                    }
                  : tab
              )
            )
          }
        }
      )
    },
    [artifactSourceBaseDir]
  )

  const selectArtifactView = useCallback((tabId: string, view: LoopArtifactTabView) => {
    setArtifactTabs(tabs => tabs.map(tab => (tab.id === tabId ? { ...tab, view } : tab)))
  }, [])

  const closeTaskTab = useCallback(
    (taskId: string) => {
      const index = taskTabs.findIndex(tab => tab.taskId === taskId)

      if (index < 0) {
        return
      }

      const nextTabs = taskTabs.filter(tab => tab.taskId !== taskId)
      setTaskTabs(nextTabs)

      if (taskId !== activeTaskTabId) {
        return
      }

      const nextTab = nextTabs[index] || nextTabs[index - 1] || null
      setNavigationStack([])

      if (nextTab) {
        setActiveTaskTabId(nextTab.taskId)
        focusDrawerTask(nextTab.taskId)

        return
      }

      setActiveTaskTabId(null)

      if (overviewAnchor) {
        focusDrawerTask(overviewAnchor.taskId)
      } else {
        setFocusedTaskId(null)
      }
    },
    [activeTaskTabId, focusDrawerTask, overviewAnchor, taskTabs]
  )

  const selectArtifactTab = useCallback((tabId: string) => {
    setActiveArtifactTabId(tabId)
    setActiveTaskTabId(null)
    setNavigationStack([])
  }, [])

  const closeArtifactTab = useCallback(
    (tabId: string) => {
      const index = artifactTabs.findIndex(tab => tab.id === tabId)

      if (index < 0) {
        return
      }

      const nextTabs = artifactTabs.filter(tab => tab.id !== tabId)
      setArtifactTabs(nextTabs)

      if (tabId !== activeArtifactTabId) {
        return
      }

      const nextTab = nextTabs[index] || nextTabs[index - 1] || null
      setActiveArtifactTabId(nextTab?.id || null)

      if (!nextTab && !focusedTaskId && overviewAnchor) {
        focusDrawerTask(overviewAnchor.taskId)
      }
    },
    [activeArtifactTabId, artifactTabs, focusDrawerTask, focusedTaskId, overviewAnchor]
  )

  const goBack = useCallback(() => {
    const previous = navigationStack.at(-1)

    if (previous) {
      focusDrawerTask(previous.taskId)
      setNavigationStack(stack => stack.slice(0, -1))
    } else if (overviewAnchor && focusedTaskId !== overviewAnchor.taskId) {
      focusDrawerTask(overviewAnchor.taskId)
    }
  }, [focusDrawerTask, focusedTaskId, navigationStack, overviewAnchor])

  const backTarget = navigationStack.at(-1)

  const detailBackLabel =
    backTarget?.taskId === overviewAnchor?.taskId
      ? 'Loop overview'
      : backTarget?.title || (overviewAnchor && focusedTaskId !== overviewAnchor.taskId ? 'Loop overview' : null)

  const detailBack = detailBackLabel ? goBack : undefined

  const openLoopOverviewTask = embedded
    ? (row: LoopRow) => {
        if (row.taskId === overviewAnchor?.taskId) {
          openTaskTab(row)

          return
        }

        selectRelatedTask(row.taskId)
      }
    : openTaskTab

  const loopTabTitle = overviewAnchor?.title || selected?.title || 'Loop'

  const baseTabLabel =
    activeTaskTabId && loopOverviewEligible
      ? loopTabTitle
      : showingLoopOverview
        ? loopTabTitle
        : selected?.title || loopTabTitle

  const missingTaskId = activeTaskTabId || focusedTaskId

  const showingRootCanvas = Boolean(
    !activeArtifactTab && !activeTaskTabId && showingLoopOverview && overviewAnchor && selectedOverviewGroup
  )

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [panelWidth]
  )

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

  if (hidden) {
    return null
  }

  return (
    <aside
      aria-hidden={false}
      className={cn(
        embedded
          ? 'relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-(--ui-text-secondary)'
          : 'relative row-start-1 min-w-0 shrink-0 overflow-hidden text-(--ui-text-secondary)',
        !embedded && !open && 'hidden xl:block'
      )}
      data-layout={embedded ? 'tabbed' : 'docked'}
      data-modal="false"
      data-pane-id="loop-panel"
      data-pane-open={open ? 'true' : 'false'}
      data-pane-side="right"
      data-state={open ? 'open' : 'preview'}
      data-testid="loop-panel"
      style={embedded ? undefined : { gridColumn: '2 / 3', minWidth: LOOP_PANEL_MIN_WIDTH, width: panelWidth }}
    >
      {!embedded && (
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
      )}

      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--ui-editor-surface-background)">
        {!embedded && (
          <LoopPanelTabBar
            activeArtifactTabId={activeArtifactTabId}
            activeTaskTabId={activeTaskTabId}
            artifactTabs={artifactTabs}
            baseLabel={baseTabLabel}
            onCloseArtifactTab={closeArtifactTab}
            onClosePane={onHide}
            onCloseTaskTab={closeTaskTab}
            onSelectArtifactTab={selectArtifactTab}
            onSelectBaseTab={selectBaseTab}
            onSelectTaskTab={selectTaskTab}
            taskTabs={taskTabs}
          />
        )}
        <div
          className={cn('flex min-h-0 min-w-0 flex-1 flex-col', showingRootCanvas ? 'p-0' : 'p-3')}
          data-testid="loop-panel-body"
        >
          {state?.message && (
            <div
              className={cn(
                'mb-3 rounded-lg border px-2 py-1.5 text-xs',
                state?.status === 'stale'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
            >
              {state.message}
            </div>
          )}

          <div className={cn('min-h-0 flex-1', showingRootCanvas ? 'overflow-hidden' : 'overflow-auto')}>
            {!state ? (
              <section
                className="grid min-w-0 gap-2 rounded-lg border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) p-3 text-xs text-(--ui-text-tertiary)"
                data-testid="loop-panel-loading"
              >
                <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--ui-text-secondary)">
                  Loading Loop canvas…
                </h3>
                <p className="m-0">
                  Fetching the Loop graph for{' '}
                  <span className="font-mono text-(--ui-text-secondary)">{missingTaskId || 'this task'}</span>.
                </p>
              </section>
            ) : activeArtifactTab ? (
              <LoopArtifactSourceTab onSelectView={selectArtifactView} tab={activeArtifactTab} />
            ) : activeTaskTabId ? (
              activeTaskTabRow ? (
                <div className="grid min-w-0 max-w-full gap-3">
                  <LoopTaskDetails
                    backLabel={
                      embedded && activeTaskTabId === overviewAnchor?.taskId && loopOverviewEligible
                        ? 'Loop overview'
                        : null
                    }
                    commentsError={selectedTaskCommentsError}
                    detail={mergedDetail}
                    onAddComment={onAddTaskComment}
                    onBack={
                      embedded && activeTaskTabId === overviewAnchor?.taskId && loopOverviewEligible
                        ? selectBaseTab
                        : undefined
                    }
                    onTaskAction={onTaskAction}
                    row={activeTaskTabRow}
                  />
                </div>
              ) : (
                <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide">Selected task unavailable</h3>
                  <p className="m-0">
                    Task <span className="font-mono">{activeTaskTabId}</span> is missing from the latest Loop source. It
                    may have been archived, deleted, or refreshed out of this session lineage. Select another tab or
                    close the panel.
                  </p>
                </section>
              )
            ) : showingLoopOverview && overviewAnchor && selectedOverviewGroup ? (
              <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col">
                <LoopRootOverview
                  group={selectedOverviewGroup}
                  onOpenTaskTab={openLoopOverviewTask}
                  onTaskAction={onTaskAction}
                />
              </div>
            ) : selected ? (
              <div className="grid min-w-0 max-w-full gap-3">
                <LoopTaskDetails
                  backLabel={detailBackLabel}
                  commentsError={selectedTaskCommentsError}
                  detail={mergedDetail}
                  detailError={selectedTaskDetailError}
                  onAddComment={onAddTaskComment}
                  onBack={detailBack}
                  onTaskAction={onTaskAction}
                  row={selected}
                />
              </div>
            ) : missingTaskId ? (
              <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide">Selected task unavailable</h3>
                <p className="m-0">
                  Task <span className="font-mono">{missingTaskId}</span> is missing from the latest Loop source. It may
                  have been archived, deleted, or refreshed out of this session lineage. Select another row or close the
                  panel.
                </p>
              </section>
            ) : (
              <p className="m-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-tertiary)">
                No Loop rows yet. Ask Hermes to read or mutate the Loop graph.
              </p>
            )}
          </div>

          {enableDebugJson && state && (
            <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3">
              <Button
                className="h-7 px-2 text-xs"
                onClick={() => setDebugOpen(value => !value)}
                type="button"
                variant="ghost"
              >
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
