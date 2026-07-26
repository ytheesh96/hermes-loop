import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { memo, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { formatAgo } from '@/lib/time'

import {
  LIVE_GRAPH_ATTENTION_STATUSES,
  LIVE_GRAPH_COMPLETED_STATUSES,
  LIVE_GRAPH_WAITING_STATUSES,
  type LiveGraphNode,
  normalizeLiveGraphStatus
} from './model'

const COMPLETED_PAGE_SIZE = 10
const COMPLETED_PAGE_INCREMENT = 25
const WORKFLOW_AGE_REFRESH_INTERVAL_MS = 60_000

type SessionWorkflowInboxFilter = 'active' | 'all' | 'attention' | 'completed'

interface StatusPresentation {
  color: string
  icon: string
  rank: number
}

const DEFAULT_STATUS_PRESENTATION: StatusPresentation = {
  color: 'var(--ui-text-quaternary)',
  icon: 'circle-outline',
  rank: 4
}

const WAITING_STATUS_PRESENTATION: StatusPresentation = {
  color: 'var(--ui-purple)',
  icon: 'clock',
  rank: 3
}

const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  blocked: { color: 'var(--ui-yellow)', icon: 'warning', rank: 1 },
  closed: { color: 'var(--ui-green)', icon: 'pass-filled', rank: 4 },
  completed: { color: 'var(--ui-green)', icon: 'pass-filled', rank: 4 },
  failed: { color: 'var(--ui-red)', icon: 'error', rank: 2 },
  interrupted: { color: 'var(--ui-yellow)', icon: 'warning', rank: 1 },
  open: { color: 'var(--ui-cyan)', icon: 'circle-filled', rank: 0 },
  running: { color: 'var(--ui-cyan)', icon: 'sync', rank: 0 }
}

export interface LiveGraphWorkflowFeedItem {
  activeTaskCount: number
  attentionTaskCount: number
  completedTaskCount: number
  node: LiveGraphNode
}

export interface LiveGraphSessionWorkflowInboxProps {
  onSelectWorkflow: (nodeId: string) => void
  sessionScope: string
  workflows: readonly LiveGraphWorkflowFeedItem[]
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function statusPresentation(status: string): StatusPresentation {
  return (
    STATUS_PRESENTATION[status] ||
    (LIVE_GRAPH_WAITING_STATUSES.has(status) ? WAITING_STATUS_PRESENTATION : DEFAULT_STATUS_PRESENTATION)
  )
}

function needsAttention(status: unknown): boolean {
  return LIVE_GRAPH_ATTENTION_STATUSES.has(normalizeLiveGraphStatus(status))
}

function workflowSort(left: LiveGraphWorkflowFeedItem, right: LiveGraphWorkflowFeedItem): number {
  const rank = (item: LiveGraphWorkflowFeedItem) => statusPresentation(normalizeLiveGraphStatus(item.node.status)).rank

  return (
    rank(left) - rank(right) ||
    (right.node.createdAt ?? 0) - (left.node.createdAt ?? 0) ||
    left.node.label.localeCompare(right.node.label)
  )
}

function completedWorkflowSort(left: LiveGraphWorkflowFeedItem, right: LiveGraphWorkflowFeedItem): number {
  return (right.node.createdAt ?? 0) - (left.node.createdAt ?? 0) || left.node.label.localeCompare(right.node.label)
}

function workflowTimestampMs(workflow: LiveGraphNode): number | null {
  const value = workflow.createdAt

  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null
  }

  const timestampMs = value < 1_000_000_000_000 ? value * 1000 : value

  return timestampMs <= 8_640_000_000_000_000 ? timestampMs : null
}

function WorkflowStatus({ status }: { status: string }) {
  const { t } = useI18n()
  const normalized = normalizeLiveGraphStatus(status)
  const presentation = statusPresentation(normalized)
  const label = (t.liveGraph.statuses as Record<string, string>)[normalized] || status || t.liveGraph.statuses.unknown

  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5 text-[0.625rem] text-(--ui-text-tertiary)"
      data-live-graph-workflow-status={normalized}
    >
      <Codicon className="shrink-0" name={presentation.icon} style={{ color: presentation.color }} />
      <span className="truncate">{label}</span>
    </span>
  )
}

interface WorkflowCardProps {
  item: LiveGraphWorkflowFeedItem
  nowMs: number
  onSelect: () => void
  reducedMotion: boolean
}

function WorkflowCard({ item, nowMs, onSelect, reducedMotion }: WorkflowCardProps) {
  const { t } = useI18n()
  const { node } = item
  const board = clean(node.board)
  const timestampMs = workflowTimestampMs(node)

  return (
    <motion.article
      className="relative min-w-0 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) shadow-[0_1px_0_color-mix(in_srgb,var(--ui-text-primary)_4%,transparent)] transition-colors duration-150 hover:border-(--stroke-nous) hover:bg-(--ui-bg-tertiary) focus-within:border-(--ui-stroke-primary) motion-reduce:transition-none"
      data-live-graph-workflow-card={node.id}
      exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
      layout="position"
      layoutId={`live-graph-session-workflow:${node.id}`}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }}
    >
      <button
        aria-label={`${t.liveGraph.viewWorkflow}: ${node.label}`}
        className="flex h-[7.25rem] w-full min-w-0 cursor-default flex-col border-0 bg-transparent px-3 py-2.5 text-left text-inherit outline-none"
        onClick={onSelect}
        type="button"
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[0.625rem] font-medium text-(--ui-text-secondary)">
            <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="git-branch" />
            <span className="truncate">{board || t.liveGraph.workflow}</span>
          </span>
          <WorkflowStatus status={node.status || 'unknown'} />
        </span>
        <span
          className="mt-1.5 min-w-0 line-clamp-2 text-xs leading-4 font-semibold text-(--ui-text-primary)"
          data-live-graph-workflow-card-title
        >
          {node.label}
        </span>
        <span className="mt-auto flex min-w-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
          <span className="min-w-0 truncate" data-live-graph-workflow-task-counts>
            <strong className="font-semibold text-(--ui-text-secondary)">{item.activeTaskCount}</strong>{' '}
            {t.liveGraph.activeTasks}
            <span aria-hidden="true"> · </span>
            <strong className="font-semibold text-(--ui-text-secondary)">{item.completedTaskCount}</strong>{' '}
            {t.liveGraph.completedTasks}
            {item.attentionTaskCount > 0 && (
              <>
                <span aria-hidden="true"> · </span>
                <strong className="font-semibold text-(--ui-yellow)">{item.attentionTaskCount}</strong>{' '}
                {t.liveGraph.attentionTasks}
              </>
            )}
          </span>
          {timestampMs !== null && (
            <time
              className="ml-auto shrink-0"
              data-live-graph-workflow-age
              dateTime={new Date(timestampMs).toISOString()}
            >
              {formatAgo(timestampMs, t.agents, nowMs)}
            </time>
          )}
        </span>
      </button>
    </motion.article>
  )
}

interface CompletedWorkflowRowProps {
  item: LiveGraphWorkflowFeedItem
  nowMs: number
  onSelect: () => void
  reducedMotion: boolean
}

function CompletedWorkflowRow({ item, nowMs, onSelect, reducedMotion }: CompletedWorkflowRowProps) {
  const { t } = useI18n()
  const { node } = item
  const timestampMs = workflowTimestampMs(node)

  return (
    <motion.div
      className="relative min-w-0 rounded-md transition-colors duration-150 hover:bg-(--ui-bg-tertiary) focus-within:bg-(--ui-bg-tertiary) motion-reduce:transition-none"
      data-live-graph-completed-workflow={node.id}
      exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
      layout="position"
      layoutId={`live-graph-session-workflow:${node.id}`}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }}
    >
      <button
        aria-label={`${t.liveGraph.viewWorkflow}: ${node.label}`}
        className="flex h-8 w-full min-w-0 cursor-default items-center gap-2 border-0 bg-transparent px-2 text-left text-inherit outline-none"
        onClick={onSelect}
        type="button"
      >
        <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="git-branch" />
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-(--ui-text-secondary)">{node.label}</span>
        {timestampMs !== null && (
          <time
            className="shrink-0 text-[0.625rem] text-(--ui-text-quaternary)"
            data-live-graph-workflow-age
            dateTime={new Date(timestampMs).toISOString()}
          >
            {formatAgo(timestampMs, t.agents, nowMs)}
          </time>
        )}
      </button>
    </motion.div>
  )
}

export const LiveGraphSessionWorkflowInbox = memo(function LiveGraphSessionWorkflowInbox({
  onSelectWorkflow,
  sessionScope,
  workflows
}: LiveGraphSessionWorkflowInboxProps) {
  const { t } = useI18n()
  const reducedMotion = Boolean(useReducedMotion())
  const [filter, setFilter] = useState<SessionWorkflowInboxFilter>('all')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [visibleCompletedCount, setVisibleCompletedCount] = useState(COMPLETED_PAGE_SIZE)

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), WORKFLOW_AGE_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  const { activeWorkflows, attentionWorkflows, completedWorkflows } = useMemo(() => {
    const active: LiveGraphWorkflowFeedItem[] = []
    const attention: LiveGraphWorkflowFeedItem[] = []
    const completed: LiveGraphWorkflowFeedItem[] = []

    for (const workflow of workflows) {
      if (LIVE_GRAPH_COMPLETED_STATUSES.has(normalizeLiveGraphStatus(workflow.node.status))) {
        completed.push(workflow)
      } else if (needsAttention(workflow.node.status)) {
        attention.push(workflow)
      } else {
        active.push(workflow)
      }
    }

    return {
      activeWorkflows: active.sort(workflowSort),
      attentionWorkflows: attention.sort(workflowSort),
      completedWorkflows: completed.sort(completedWorkflowSort)
    }
  }, [workflows])

  const visibleCompletedWorkflows = completedWorkflows.slice(0, visibleCompletedCount)
  const hiddenCompletedCount = Math.max(0, completedWorkflows.length - visibleCompletedWorkflows.length)
  const showActiveWorkflows = filter === 'all' || filter === 'active'
  const showAttentionWorkflows = filter === 'all' || filter === 'attention'
  const showCompletedWorkflows = filter === 'all' || filter === 'completed'

  return (
    <LayoutGroup id={`live-graph-session-workflow-inbox:${sessionScope}`}>
      <div
        aria-label={t.liveGraph.workflowInbox}
        className="grid min-w-0 gap-4 border-t border-(--ui-stroke-tertiary) px-3 py-3"
        data-testid="live-graph-session-workflow-inbox"
        role="region"
      >
        <div
          aria-label={t.liveGraph.workflowInbox}
          className="flex min-w-0 flex-nowrap items-center gap-1"
          role="group"
        >
          <Button
            aria-pressed={filter === 'all'}
            className="h-6 px-1.5 text-[0.625rem]"
            data-live-graph-all-workflows-filter
            onClick={() => setFilter('all')}
            size="xs"
            type="button"
            variant={filter === 'all' ? 'secondary' : 'ghost'}
          >
            {t.liveGraph.allTasks}
          </Button>
          <Button
            aria-pressed={filter === 'active'}
            className="h-6 px-1.5 text-[0.625rem]"
            data-live-graph-active-workflow-count
            onClick={() => setFilter('active')}
            size="xs"
            type="button"
            variant={filter === 'active' ? 'secondary' : 'ghost'}
          >
            <strong className="font-semibold text-(--ui-text-primary)">{activeWorkflows.length}</strong>{' '}
            {t.liveGraph.activeTasks}
          </Button>
          <Button
            aria-pressed={filter === 'completed'}
            className="h-6 px-1.5 text-[0.625rem]"
            data-live-graph-completed-workflow-count
            onClick={() => setFilter('completed')}
            size="xs"
            type="button"
            variant={filter === 'completed' ? 'secondary' : 'ghost'}
          >
            <strong className="font-semibold text-(--ui-text-primary)">{completedWorkflows.length}</strong>{' '}
            {t.liveGraph.completedTasks}
          </Button>
          <Button
            aria-pressed={filter === 'attention'}
            className="h-6 px-1.5 text-[0.625rem] text-(--ui-yellow)"
            data-live-graph-attention-workflow-count
            onClick={() => setFilter('attention')}
            size="xs"
            type="button"
            variant={filter === 'attention' ? 'secondary' : 'ghost'}
          >
            <strong className="font-semibold">{attentionWorkflows.length}</strong> {t.liveGraph.attentionTasks}
          </Button>
        </div>

        {showAttentionWorkflows && (attentionWorkflows.length > 0 || filter === 'attention') && (
          <section
            aria-labelledby={`live-graph-attention-workflows:${sessionScope}`}
            className="grid min-w-0 gap-2"
            data-live-graph-attention-workflows
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-yellow) uppercase"
                id={`live-graph-attention-workflows:${sessionScope}`}
              >
                {t.liveGraph.attentionTasks}
              </h3>
              <span className="font-mono text-[0.625rem] text-(--ui-text-quaternary)">{attentionWorkflows.length}</span>
            </div>
            {attentionWorkflows.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3 text-[0.6875rem] text-(--ui-text-tertiary)">
                <Codicon className="text-(--ui-green)" name="pass-filled" />
                {t.liveGraph.noAttentionWorkflows}
              </div>
            ) : (
              <div className="grid min-w-0 gap-2">
                <AnimatePresence initial={false}>
                  {attentionWorkflows.map(workflow => (
                    <WorkflowCard
                      item={workflow}
                      key={workflow.node.id}
                      nowMs={nowMs}
                      onSelect={() => onSelectWorkflow(workflow.node.id)}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </section>
        )}

        {showActiveWorkflows && (
          <section
            aria-labelledby={`live-graph-active-workflows:${sessionScope}`}
            className="grid min-w-0 gap-2"
            data-live-graph-active-workflows
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase"
                id={`live-graph-active-workflows:${sessionScope}`}
              >
                {t.liveGraph.activeTasks}
              </h3>
              <span className="font-mono text-[0.625rem] text-(--ui-text-quaternary)">{activeWorkflows.length}</span>
            </div>
            {activeWorkflows.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3 text-[0.6875rem] text-(--ui-text-tertiary)">
                <Codicon className="text-(--ui-green)" name="pass-filled" />
                {t.liveGraph.allWorkflowsCompleted}
              </div>
            ) : (
              <div className="grid min-w-0 gap-2">
                <AnimatePresence initial={false}>
                  {activeWorkflows.map(workflow => (
                    <WorkflowCard
                      item={workflow}
                      key={workflow.node.id}
                      nowMs={nowMs}
                      onSelect={() => onSelectWorkflow(workflow.node.id)}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </section>
        )}

        {showCompletedWorkflows && (completedWorkflows.length > 0 || filter === 'completed') && (
          <section aria-labelledby={`live-graph-completed-workflows:${sessionScope}`} className="grid min-w-0 gap-1">
            <div className="flex items-center gap-2 py-0.5">
              <h3
                className="m-0 shrink-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase"
                id={`live-graph-completed-workflows:${sessionScope}`}
              >
                {t.liveGraph.completedTasks}
              </h3>
              <span className="h-px min-w-0 flex-1 bg-(--ui-stroke-tertiary)" />
              <span className="font-mono text-[0.625rem] text-(--ui-text-quaternary)">{completedWorkflows.length}</span>
            </div>
            {completedWorkflows.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3 text-[0.6875rem] text-(--ui-text-tertiary)">
                <Codicon className="text-(--ui-text-quaternary)" name="circle-outline" />
                {t.liveGraph.noCompletedWorkflows}
              </div>
            ) : (
              <div className="grid min-w-0 gap-0.5">
                <AnimatePresence initial={false}>
                  {visibleCompletedWorkflows.map(workflow => (
                    <CompletedWorkflowRow
                      item={workflow}
                      key={workflow.node.id}
                      nowMs={nowMs}
                      onSelect={() => onSelectWorkflow(workflow.node.id)}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
            {hiddenCompletedCount > 0 && (
              <Button
                className="mt-1 h-7 justify-start px-2 text-[0.625rem]"
                onClick={() => setVisibleCompletedCount(current => current + COMPLETED_PAGE_INCREMENT)}
                size="xs"
                type="button"
                variant="text"
              >
                <Codicon name="chevron-down" />
                {t.liveGraph.showMoreCompleted(hiddenCompletedCount)}
              </Button>
            )}
          </section>
        )}
      </div>
    </LayoutGroup>
  )
})
