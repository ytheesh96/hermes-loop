import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

import type { LoopLatestRun, LoopTaskDetail, LoopTaskRun } from '@/app/chat/loop-state'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { getLoopTaskDetail, getSessionMessages } from '@/hermes'
import { useI18n } from '@/i18n'
import { relativeTime } from '@/lib/time'
import type { SessionMessage } from '@/types/hermes'

import { type LiveGraphNode, normalizeLiveGraphStatus } from './model'
import { WorkerSessionFeed } from './worker-session-feed'

const INSPECTOR_PREVIEW_CHARACTERS = 240
const INSPECTOR_PREVIEW_LINES = 5

export interface LiveGraphTaskTarget {
  board?: string
  taskId: string
  workflowId?: string
}

type LiveGraphTaskInspectorFilter = 'activity' | 'all' | 'comments' | 'details'

interface LiveGraphTaskInspectorContentProps {
  detail?: LoopTaskDetail | null
  detailError?: string
  loading?: boolean
  node: LiveGraphNode
  onOpenTask?: (target: LiveGraphTaskTarget) => void
  target: LiveGraphTaskTarget
  transcriptError?: string
  transcriptLoading?: boolean
  transcriptMessages?: SessionMessage[]
  workerSessionId?: string
}

function TaskInspectorTextSection({
  collapseLabel,
  expandLabel,
  label,
  value
}: {
  collapseLabel: string
  expandLabel: string
  label: string
  value: string
}) {
  const [expanded, setExpanded] = useState(false)
  const lineCount = value.split(/\r?\n/).length
  const collapsible = value.length > INSPECTOR_PREVIEW_CHARACTERS || lineCount > INSPECTOR_PREVIEW_LINES

  return (
    <section className="grid min-w-0 max-w-full gap-1">
      <h3 className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">{label}</h3>
      <p
        className={
          'm-0 whitespace-pre-wrap break-words text-[0.6875rem] leading-4 text-(--ui-text-secondary)' +
          (collapsible && !expanded ? ' line-clamp-5' : '')
        }
        data-live-graph-inspector-section-text
        data-live-graph-inspector-truncated={collapsible && !expanded ? 'true' : undefined}
      >
        {value}
      </p>
      {collapsible && (
        <Button
          aria-expanded={expanded}
          aria-label={(expanded ? collapseLabel : expandLabel) + ' ' + label}
          className="-ml-2 h-5 w-fit justify-start px-2 text-[0.625rem]"
          onClick={() => setExpanded(current => !current)}
          size="xs"
          type="button"
          variant="text"
        >
          <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          {expanded ? collapseLabel : expandLabel}
        </Button>
      )}
    </section>
  )
}

function taskTimestamp(timestamp?: null | number): string {
  if (!timestamp) {
    return ''
  }

  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp

  return Number.isFinite(timestampMs) ? relativeTime(timestampMs) : ''
}

function workerSessionIdFromRun(run?: LoopLatestRun | null): string {
  if (run?.worker_session_id) {
    return run.worker_session_id.trim()
  }

  if (!run?.metadata || typeof run.metadata !== 'object' || Array.isArray(run.metadata)) {
    return ''
  }

  const workerSessionId = (run.metadata as Record<string, unknown>).worker_session_id

  return typeof workerSessionId === 'string' ? workerSessionId.trim() : ''
}

function runLabel(run: LoopTaskRun, index: number): string {
  return `#${run.id ?? index + 1}`
}

function TaskInspectorSection({ children, label, testId }: { children: ReactNode; label: string; testId: string }) {
  return (
    <section
      className="grid min-w-0 max-w-full gap-2 border-t border-(--ui-stroke-tertiary) px-3 py-3 first:border-t-0"
      data-testid={testId}
    >
      <h3 className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">{label}</h3>
      {children}
    </section>
  )
}

function LiveGraphTaskInspectorContent({
  detail,
  detailError,
  loading = false,
  node,
  onOpenTask,
  target,
  transcriptError,
  transcriptLoading = false,
  transcriptMessages = [],
  workerSessionId
}: LiveGraphTaskInspectorContentProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<LiveGraphTaskInspectorFilter>('all')
  const task = detail?.task
  const comments = detail?.comments ?? []
  const runs = detail?.runs ?? []
  const description = task?.body || node.detail || ''
  const summary = task?.latest_summary || task?.latest_run?.summary || node.summary || ''
  const result = task?.result || node.result || ''
  const title = task?.title || node.label || node.id
  const status = normalizeLiveGraphStatus(task?.status || node.status)
  const statusLabel = t.liveGraph.statuses[status as keyof typeof t.liveGraph.statuses] ?? t.liveGraph.statuses.unknown
  const assignee = task?.assignee || node.assignee || ''
  const priority = task?.priority ?? node.priority
  const workflowId = task?.workflow_id || target.workflowId || ''

  const activityTextSections = [
    { id: 'summary', label: t.liveGraph.summary, value: summary },
    { id: 'result', label: t.liveGraph.result, value: result }
  ].filter(section => section.value)

  const showComments = filter === 'all' || filter === 'comments'
  const showActivity = filter === 'all' || filter === 'activity'
  const showDetails = filter === 'all' || filter === 'details'

  return (
    <div className="min-w-0 max-w-full" data-live-graph-inspector-details>
      <div className="sticky top-0 z-10 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2">
        <SegmentedControl
          className="w-full"
          onChange={setFilter}
          options={[
            { id: 'all', label: t.liveGraph.taskViewAll },
            { id: 'comments', label: t.liveGraph.taskViewComments },
            { id: 'activity', label: t.liveGraph.taskViewActivity },
            { id: 'details', label: t.liveGraph.taskViewDetails }
          ]}
          value={filter}
        />
      </div>

      <div className="[&>section:first-child]:border-t-0">
        {showComments && (
          <TaskInspectorSection label={t.liveGraph.taskViewComments} testId="live-graph-task-comments">
            {loading ? (
              <Loader
                aria-label={t.liveGraph.taskDetailLoading}
                className="size-6 text-(--ui-text-tertiary)"
                label={t.liveGraph.taskDetailLoading}
                type="lemniscate-bloom"
              />
            ) : detailError ? (
              <p className="m-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                {t.liveGraph.taskDetailLoadFailed}
              </p>
            ) : comments.length === 0 ? (
              <p className="m-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                {t.liveGraph.taskCommentsEmpty}
              </p>
            ) : (
              <div className="grid min-w-0 gap-2">
                {comments.map((comment, index) => {
                  const timestamp = taskTimestamp(comment.created_at)

                  return (
                    <article
                      className="grid min-w-0 gap-1 border-b border-(--ui-stroke-tertiary) pb-2 last:border-b-0 last:pb-0"
                      key={String(comment.id ?? `${comment.task_id || target.taskId}:${comment.created_at ?? index}`)}
                    >
                      <div className="flex min-w-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
                        <span className="truncate font-medium text-(--ui-text-secondary)">
                          {comment.author || t.liveGraph.unknownCommentAuthor}
                        </span>
                        {timestamp && <time className="shrink-0">{timestamp}</time>}
                      </div>
                      <p className="m-0 whitespace-pre-wrap break-words text-[0.6875rem] leading-4 text-(--ui-text-secondary)">
                        {comment.body || ''}
                      </p>
                    </article>
                  )
                })}
              </div>
            )}
          </TaskInspectorSection>
        )}

        {showActivity && (
          <TaskInspectorSection label={t.liveGraph.taskViewActivity} testId="live-graph-task-activity">
            {transcriptLoading ? (
              <Loader
                aria-label={t.liveGraph.taskWorkerTranscriptLoading}
                className="size-6 text-(--ui-text-tertiary)"
                label={t.liveGraph.taskWorkerTranscriptLoading}
                type="lemniscate-bloom"
              />
            ) : transcriptError || detailError ? (
              <p className="m-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                {t.liveGraph.taskWorkerTranscriptLoadFailed}
              </p>
            ) : (
              <WorkerSessionFeed
                emptyLabel={t.liveGraph.taskWorkerTranscriptEmpty}
                messages={transcriptMessages}
                sessionId={workerSessionId}
              />
            )}

            {(activityTextSections.length > 0 || runs.length > 0) && (
              <div className="grid min-w-0 gap-2 border-t border-(--ui-stroke-tertiary) pt-2">
                <h4 className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">
                  {t.liveGraph.taskRunHistory}
                </h4>
                {activityTextSections.map(section => (
                  <TaskInspectorTextSection
                    collapseLabel={t.liveGraph.showLess}
                    expandLabel={t.liveGraph.showMore}
                    key={target.taskId + ':activity:' + section.id}
                    label={section.label}
                    value={section.value}
                  />
                ))}
                {runs.map((run, index) => {
                  const timestamp = taskTimestamp(run.ended_at || run.started_at)
                  const runStatus = run.outcome || run.status || ''
                  const runText = run.summary || run.error || ''

                  return (
                    <article
                      className="grid min-w-0 gap-1 border-t border-(--ui-stroke-tertiary) pt-2 first:border-t-0 first:pt-0"
                      key={String(run.id ?? `${run.task_id || target.taskId}:${run.started_at ?? index}`)}
                    >
                      <div className="flex min-w-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
                        <span className="font-mono">{runLabel(run, index)}</span>
                        {runStatus && <span className="truncate">{runStatus}</span>}
                        {timestamp && <time className="ml-auto shrink-0">{timestamp}</time>}
                      </div>
                      {runText && (
                        <p className="m-0 whitespace-pre-wrap break-words text-[0.6875rem] leading-4 text-(--ui-text-secondary)">
                          {runText}
                        </p>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
            {filter === 'activity' && loading && !transcriptLoading && (
              <Loader
                aria-label={t.liveGraph.taskDetailLoading}
                className="size-6 text-(--ui-text-tertiary)"
                label={t.liveGraph.taskDetailLoading}
                type="lemniscate-bloom"
              />
            )}
            {filter === 'activity' && detailError && activityTextSections.length === 0 && !transcriptError && (
              <p className="m-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                {t.liveGraph.taskDetailLoadFailed}
              </p>
            )}
          </TaskInspectorSection>
        )}

        {showDetails && (
          <TaskInspectorSection label={t.liveGraph.taskViewDetails} testId="live-graph-task-details">
            {description && (
              <TaskInspectorTextSection
                collapseLabel={t.liveGraph.showLess}
                expandLabel={t.liveGraph.showMore}
                key={target.taskId + ':details:description'}
                label={t.liveGraph.description}
                value={description}
              />
            )}
            <dl className="m-0 grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.625rem] leading-4">
              {[
                { id: 'title', label: t.liveGraph.taskTitle, value: title },
                { id: 'status', label: t.liveGraph.status, value: statusLabel },
                { id: 'task', label: t.liveGraph.taskId, value: target.taskId },
                { id: 'assignee', label: t.liveGraph.assignee, value: assignee },
                {
                  id: 'priority',
                  label: t.liveGraph.priority,
                  value: priority === undefined ? '' : `P${priority}`
                },
                { id: 'board', label: t.liveGraph.board, value: target.board || '' },
                { id: 'workflow', label: t.liveGraph.workflow, value: workflowId }
              ]
                .filter(item => item.value)
                .map(item => (
                  <div className="contents" key={item.id}>
                    <dt className="text-(--ui-text-tertiary)">{item.label}</dt>
                    <dd
                      className={
                        'm-0 min-w-0 text-(--ui-text-secondary)' +
                        (item.id === 'title' || item.id === 'status' ? ' break-words' : ' break-all font-mono')
                      }
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
            </dl>
            {onOpenTask && (
              <Button onClick={() => onOpenTask(target)} size="sm" variant="secondary">
                <Codicon name="go-to-file" />
                {t.liveGraph.openTask}
              </Button>
            )}
          </TaskInspectorSection>
        )}
      </div>
    </div>
  )
}

function LiveGraphTaskInspectorWithDetail(
  props: Omit<LiveGraphTaskInspectorContentProps, 'detail' | 'detailError' | 'loading'> & {
    profile?: string
  }
) {
  const query = useQuery({
    queryKey: ['live-graph-task-detail', props.profile || 'default', props.target.board, props.target.taskId],
    queryFn: () => getLoopTaskDetail(props.target.taskId, props.profile, props.target.board),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000
  })

  const latestRun = query.data?.task?.latest_run

  const latestWorkerRun = workerSessionIdFromRun(latestRun)
    ? latestRun
    : [...(query.data?.runs ?? [])]
        .filter(run => Boolean(workerSessionIdFromRun(run)))
        .sort(
          (left, right) =>
            (right.ended_at || right.started_at || right.id || 0) - (left.ended_at || left.started_at || left.id || 0)
        )[0]

  const workerActivity = query.data?.task?.worker_activity
  const workerSessionId = workerActivity?.worker_session_id?.trim() || workerSessionIdFromRun(latestWorkerRun)
  const workerProfile = workerActivity?.profile || latestWorkerRun?.profile || props.profile

  const transcriptQuery = useQuery({
    enabled: Boolean(workerSessionId),
    queryKey: ['live-graph-task-worker-transcript', workerProfile || 'default', workerSessionId],
    queryFn: () => getSessionMessages(workerSessionId, workerProfile),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000
  })

  return (
    <LiveGraphTaskInspectorContent
      {...props}
      detail={query.data}
      detailError={query.error ? (query.error instanceof Error ? query.error.message : String(query.error)) : undefined}
      loading={query.isLoading}
      transcriptError={
        transcriptQuery.error
          ? transcriptQuery.error instanceof Error
            ? transcriptQuery.error.message
            : String(transcriptQuery.error)
          : undefined
      }
      transcriptLoading={query.isLoading || transcriptQuery.isLoading}
      transcriptMessages={transcriptQuery.data?.messages}
      workerSessionId={workerSessionId}
    />
  )
}

export function LiveGraphTaskInspector(
  props: Omit<LiveGraphTaskInspectorContentProps, 'detail' | 'detailError' | 'loading'> & {
    profile?: string
    queryDetail: boolean
  }
) {
  return props.queryDetail ? (
    <LiveGraphTaskInspectorWithDetail {...props} />
  ) : (
    <LiveGraphTaskInspectorContent {...props} />
  )
}
