import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { PRIMARY_ICON_BTN } from '@/app/chat/composer/controls'
import type { LoopLatestRun, LoopTaskDetail, LoopTaskRun } from '@/app/chat/loop-state'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { composerFill, composerSurfaceGlass } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { addLoopTaskComment, getLoopTaskDetail, getSessionMessages } from '@/hermes'
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

export type LiveGraphTaskInspectorFilter = 'activity' | 'comments' | 'details'

interface LiveGraphTaskInspectorContentProps {
  detail?: LoopTaskDetail | null
  detailError?: string
  initialFilter?: LiveGraphTaskInspectorFilter
  loading?: boolean
  node: LiveGraphNode
  onAddComment?: (body: string) => Promise<void>
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
    <section aria-label={label} className="grid min-w-0 max-w-full gap-3 px-3 py-3" data-testid={testId}>
      {children}
    </section>
  )
}

function TaskCommentComposer({
  onAddComment,
  taskId
}: {
  onAddComment: (body: string) => Promise<void>
  taskId: string
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitFailed, setSubmitFailed] = useState(false)
  const canSubmit = draft.trim().length > 0 && !submitting

  useEffect(() => {
    setDraft('')
    setSubmitFailed(false)
  }, [taskId])

  const submitComment = async () => {
    const body = draft.trim()

    if (!body || submitting) {
      return
    }

    setSubmitting(true)
    setSubmitFailed(false)

    try {
      await onAddComment(body)
      setDraft('')
    } catch {
      setSubmitFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="group/composer shrink-0 bg-(--ui-bg-elevated) px-3 pt-2 pb-3"
      data-slot="composer-root"
      data-testid="live-graph-task-comment-composer"
      onSubmit={event => {
        event.preventDefault()
        void submitComment()
      }}
    >
      <div className="relative isolate overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))]">
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 -z-10 ${composerFill} ${composerSurfaceGlass}`}
        />
        <textarea
          aria-label={t.liveGraph.taskCommentComposerLabel}
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          className="block min-h-8 max-h-24 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-xs leading-4 text-(--ui-text-primary) outline-none placeholder:text-(--ui-text-tertiary) disabled:cursor-default disabled:opacity-60"
          disabled={submitting}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submitComment()
            }
          }}
          placeholder={t.liveGraph.taskCommentPlaceholder}
          rows={1}
          spellCheck
          value={draft}
        />
        <div className="flex min-w-0 items-center gap-2 px-3 pb-2">
          {submitFailed && (
            <span className="min-w-0 flex-1 text-[0.625rem] leading-4 text-destructive" role="alert">
              {t.liveGraph.taskCommentSubmitFailed}
            </span>
          )}
          <Button
            aria-label={submitting ? t.liveGraph.taskCommentSubmitting : t.liveGraph.taskCommentSubmit}
            className={`${PRIMARY_ICON_BTN} ml-auto`}
            disabled={!canSubmit}
            size="icon"
            type="submit"
          >
            <Codicon className={submitting ? 'animate-spin' : undefined} name={submitting ? 'loading' : 'arrow-up'} />
          </Button>
        </div>
      </div>
    </form>
  )
}

function LiveGraphTaskInspectorContent({
  detail,
  detailError,
  initialFilter = 'activity',
  loading = false,
  node,
  onAddComment,
  onOpenTask,
  target,
  transcriptError,
  transcriptLoading = false,
  transcriptMessages = [],
  workerSessionId
}: LiveGraphTaskInspectorContentProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<LiveGraphTaskInspectorFilter>(initialFilter)
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

  const runHistoryTextSections = [
    { id: 'summary', label: t.liveGraph.summary, value: summary },
    { id: 'result', label: t.liveGraph.result, value: result }
  ].filter(section => section.value)

  const showComments = filter === 'comments'
  const showActivity = filter === 'activity'
  const showDetails = filter === 'details'
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!showActivity) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      transcriptEndRef.current?.scrollIntoView?.({ block: 'end' })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [showActivity, transcriptLoading, transcriptMessages])

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col" data-live-graph-inspector-details>
      <div
        aria-label={t.liveGraph.inspector}
        className="flex min-w-0 shrink-0 flex-nowrap items-center gap-1 px-3 pt-3 pb-2"
        role="group"
      >
        {[
          { id: 'activity' as const, label: t.liveGraph.taskViewActivity },
          { id: 'comments' as const, label: t.liveGraph.taskViewComments },
          { id: 'details' as const, label: t.liveGraph.description }
        ].map(option => (
          <Button
            aria-pressed={filter === option.id}
            className="h-6 px-1.5 text-[0.625rem]"
            key={option.id}
            onClick={() => setFilter(option.id)}
            size="xs"
            type="button"
            variant={filter === option.id ? 'secondary' : 'ghost'}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {showComments && (
          <section
            aria-label={t.liveGraph.taskViewComments}
            className="flex h-full min-h-0 flex-col"
            data-testid="live-graph-task-comments"
          >
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
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
                <p className="m-0 py-2 text-center text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
                  {t.liveGraph.taskCommentsEmpty}
                </p>
              ) : (
                <div className="grid min-w-0 gap-3" data-testid="live-graph-task-comments-list">
                  {comments.map((comment, index) => {
                    const timestamp = taskTimestamp(comment.created_at)

                    return (
                      <article
                        className="flex w-full min-w-0 max-w-full items-start gap-2.5 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-2.5 shadow-[0_1px_0_color-mix(in_srgb,var(--ui-text-primary)_4%,transparent)]"
                        data-testid="live-graph-task-comment"
                        key={String(comment.id ?? `${comment.task_id || target.taskId}:${comment.created_at ?? index}`)}
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)"
                        >
                          <Codicon name="account" />
                        </span>
                        <div className="grid min-w-0 flex-1 gap-1 overflow-hidden">
                          <div className="flex min-w-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
                            <span className="truncate font-semibold text-(--ui-text-secondary)">
                              {comment.author || t.liveGraph.unknownCommentAuthor}
                            </span>
                            {timestamp && <time className="ml-auto shrink-0">{timestamp}</time>}
                          </div>
                          <CompactMarkdown
                            className="min-w-0 max-w-full overflow-hidden break-words text-[0.6875rem] leading-4 text-(--ui-text-secondary) [overflow-wrap:anywhere]"
                            text={comment.body || ''}
                          />
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
            {onAddComment && <TaskCommentComposer onAddComment={onAddComment} taskId={target.taskId} />}
          </section>
        )}

        {showActivity && (
          <div className="h-full overflow-x-hidden overflow-y-auto">
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
              <div aria-hidden data-live-graph-transcript-end ref={transcriptEndRef} />
            </TaskInspectorSection>
          </div>
        )}

        {showDetails && (
          <div className="h-full overflow-y-auto">
            <TaskInspectorSection label={t.liveGraph.description} testId="live-graph-task-details">
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
              {(runHistoryTextSections.length > 0 || runs.length > 0) && (
                <div className="grid min-w-0 gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-2.5">
                  <h4 className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">
                    {t.liveGraph.taskRunHistory}
                  </h4>
                  {runHistoryTextSections.map(section => (
                    <TaskInspectorTextSection
                      collapseLabel={t.liveGraph.showLess}
                      expandLabel={t.liveGraph.showMore}
                      key={target.taskId + ':details:' + section.id}
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
                        className="grid min-w-0 gap-1 rounded-md bg-(--ui-bg-tertiary) px-2.5 py-2"
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
              {onOpenTask && (
                <Button onClick={() => onOpenTask(target)} size="sm" variant="secondary">
                  <Codicon name="go-to-file" />
                  {t.liveGraph.openTask}
                </Button>
              )}
            </TaskInspectorSection>
          </div>
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
  const queryClient = useQueryClient()

  const detailQueryKey = [
    'live-graph-task-detail',
    props.profile || 'default',
    props.target.board,
    props.target.taskId
  ] as const

  const query = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => getLoopTaskDetail(props.target.taskId, props.profile, props.target.board),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000
  })

  const commentMutation = useMutation({
    mutationFn: async (body: string) => {
      const result = await addLoopTaskComment(props.target.taskId, body, props.profile, 'desktop', props.target.board)

      if (!result.ok) {
        throw new Error('Task comment was not accepted')
      }

      return result
    },
    onSuccess: result => {
      if (result.comment) {
        queryClient.setQueryData<LoopTaskDetail>(detailQueryKey, current =>
          current
            ? {
                ...current,
                comments: [...(current.comments ?? []), result.comment!]
              }
            : current
        )
      }

      void queryClient.invalidateQueries({ queryKey: detailQueryKey })
    }
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
      onAddComment={body => commentMutation.mutateAsync(body).then(() => undefined)}
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
