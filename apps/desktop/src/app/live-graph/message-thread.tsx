import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { relativeTime } from '@/lib/time'

import { linkifyMessageLocalPaths } from './message-local-paths'
import { groupSessionMessageThreads, type LiveGraphMessage } from './messages'
import type { LiveGraphNode } from './model'
import type { LiveGraphTaskInspectorFilter, LiveGraphTaskTarget } from './task-inspector'

const EMPTY_TASKS: readonly LiveGraphNode[] = []
const THREAD_ENTRY_CLASS = 'grid min-w-0 max-w-full gap-1 overflow-hidden'
const THREAD_META_CLASS = 'flex min-w-0 flex-wrap items-center gap-x-2 text-[0.625rem] text-(--ui-text-tertiary)'
const THREAD_SENDER_CLASS = 'min-w-0 break-words font-semibold text-(--ui-text-secondary)'

const THREAD_BODY_CLASS =
  'min-w-0 max-w-full overflow-hidden break-words text-xs leading-relaxed text-(--ui-text-primary) [overflow-wrap:anywhere]'

export interface LiveGraphMessageThreadProps {
  error?: null | string
  loading?: boolean
  messages: readonly LiveGraphMessage[]
  onRetry: () => void
  onSelectTask: (target: LiveGraphTaskTarget, filter: LiveGraphTaskInspectorFilter) => void
  sourceProfile?: string
  tasks?: readonly LiveGraphNode[]
}

export function LiveGraphMessageThread({
  error,
  loading = false,
  messages,
  onRetry,
  onSelectTask,
  sourceProfile,
  tasks = EMPTY_TASKS
}: LiveGraphMessageThreadProps) {
  const { t } = useI18n()
  const profile = sourceProfile || messages[0]?.id.split('\u0000')[0] || 'default'
  const threads = useMemo(() => groupSessionMessageThreads(profile, messages, tasks), [messages, profile, tasks])
  const [initialized, setInitialized] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasBottomPinnedRef = useRef(true)

  useEffect(() => {
    setExpandedKeys(current => {
      const visible = new Set(threads.map(thread => thread.key))
      const next = new Set([...current].filter(key => visible.has(key)))

      if (!initialized && threads[0]) {
        next.add(threads[0].key)
      }

      return next
    })

    if (!initialized && threads.length > 0) {
      setInitialized(true)
    }
  }, [initialized, threads])

  useLayoutEffect(() => {
    const element = scrollRef.current

    if (element && wasBottomPinnedRef.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages.length, expandedKeys])

  if (loading && messages.length === 0) {
    return (
      <div className="grid min-h-32 place-items-center px-3 py-6">
        <Loader aria-label={t.liveGraph.messagesLoading} label={t.liveGraph.messagesLoading} type="lemniscate-bloom" />
      </div>
    )
  }

  if (error && messages.length === 0) {
    return (
      <div className="grid min-h-32 place-items-center gap-2 px-3 py-6 text-center">
        <p className="m-0 text-xs text-(--ui-text-secondary)">{t.liveGraph.messagesLoadFailed}</p>
        <Button onClick={onRetry} size="xs" type="button" variant="secondary">
          {t.common.retry}
        </Button>
      </div>
    )
  }

  return (
    <div
      className="h-full min-h-0 min-w-0 max-w-full overflow-x-hidden overflow-y-auto"
      data-testid="live-graph-message-thread"
      onScroll={event => {
        const element = event.currentTarget
        wasBottomPinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 16
      }}
      ref={scrollRef}
    >
      {error && (
        <div
          className="border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-warning) px-3 py-2 text-[0.6875rem] text-(--ui-text-secondary)"
          role="status"
        >
          {t.liveGraph.messagesStale}
        </div>
      )}
      {messages.length === 0 ? (
        <p className="m-0 px-3 py-8 text-center text-xs text-(--ui-text-tertiary)">{t.liveGraph.messagesEmpty}</p>
      ) : (
        <ol className="m-0 grid min-w-0 max-w-full list-none gap-3 p-3">
          {threads.map(thread => {
            const expanded = expandedKeys.has(thread.key)

            const latestTimestampMs =
              thread.latestActivityAt < 10_000_000_000 ? thread.latestActivityAt * 1000 : thread.latestActivityAt

            return (
              <li
                className="min-w-0 max-w-full overflow-x-hidden border-b border-(--ui-stroke-tertiary) pb-3 last:border-b-0"
                key={thread.key}
              >
                <button
                  aria-expanded={expanded}
                  aria-label={`${t.liveGraph.messagesTab}: ${thread.taskTitle}`}
                  className="flex w-full min-w-0 max-w-full flex-wrap items-center justify-between gap-3 border-0 bg-transparent py-1 text-left text-inherit"
                  onClick={() =>
                    setExpandedKeys(current => {
                      const next = new Set(current)

                      if (next.has(thread.key)) {
                        next.delete(thread.key)
                      } else {
                        next.add(thread.key)
                      }

                      return next
                    })
                  }
                  type="button"
                >
                  <span className="min-w-0 break-words text-xs font-semibold text-(--ui-text-primary) [overflow-wrap:anywhere]">
                    {thread.taskTitle}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
                    <time dateTime={new Date(latestTimestampMs).toISOString()}>{relativeTime(latestTimestampMs)}</time>
                    <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
                  </span>
                </button>
                {expanded && (
                  <ol className="m-0 mt-2 grid min-w-0 max-w-full list-none gap-4 border-l border-(--ui-stroke-tertiary) pl-3">
                    {thread.messages.map(message => {
                      const timestampMs =
                        message.createdAt < 10_000_000_000 ? message.createdAt * 1000 : message.createdAt

                      if (message.kind === 'assignment') {
                        const task = message.task

                        const target = {
                          ...(task.board ? { board: task.board } : {}),
                          taskId: task.entityId,
                          ...(task.workflowId ? { workflowId: task.workflowId } : {})
                        }

                        return (
                          <li
                            className={THREAD_ENTRY_CLASS}
                            data-testid="live-graph-thread-assignment"
                            data-thread-message-entry
                            key={message.id}
                          >
                            <button
                              aria-label={`View activity: ${task.label}`}
                              className="grid w-full min-w-0 max-w-full gap-1 border-0 bg-transparent p-0 text-left text-inherit hover:bg-(--ui-bg-hover) focus-visible:outline-2 focus-visible:outline-(--ui-accent)"
                              onClick={() => onSelectTask(target, 'activity')}
                              type="button"
                            >
                              <span className={THREAD_META_CLASS} data-thread-message-meta>
                                <span className={THREAD_SENDER_CLASS}>{t.liveGraph.taskTitle}</span>
                                <time dateTime={new Date(timestampMs).toISOString()}>{relativeTime(timestampMs)}</time>
                                <span className="min-w-0 break-words">Assigned to {task.assignee?.trim()}</span>
                                <span className="min-w-0 break-words">{task.status || 'unknown'}</span>
                              </span>
                              <span className={THREAD_BODY_CLASS} data-thread-message-body>
                                {task.label}
                              </span>
                            </button>
                          </li>
                        )
                      }

                      return (
                        <li
                          className={THREAD_ENTRY_CLASS}
                          data-kind={message.kind}
                          data-task-id={message.taskId}
                          data-testid={message.kind === 'root' ? 'live-graph-thread-root' : 'live-graph-thread-comment'}
                          data-thread-message-entry
                          key={message.id}
                        >
                          <div className={THREAD_META_CLASS} data-thread-message-meta>
                            <span className={THREAD_SENDER_CLASS}>
                              {message.kind === 'root'
                                ? message.legacyRoot
                                  ? 'Legacy request snapshot'
                                  : 'Request'
                                : message.author || t.liveGraph.unknownCommentAuthor}
                            </span>
                            <time
                              dateTime={new Date(timestampMs).toISOString()}
                              title={new Date(timestampMs).toLocaleString()}
                            >
                              {relativeTime(timestampMs)}
                            </time>
                            {message.kind === 'reply' && message.taskId !== message.rootTaskId && (
                              <button
                                aria-label={`Comments: ${message.taskId}`}
                                className="min-w-0 max-w-full break-all border-0 bg-transparent p-0 text-left font-mono text-inherit opacity-70"
                                onClick={() =>
                                  onSelectTask(
                                    {
                                      board: message.board,
                                      taskId: message.taskId,
                                      ...(message.workflowId ? { workflowId: message.workflowId } : {})
                                    },
                                    'comments'
                                  )
                                }
                                type="button"
                              >
                                {message.taskId}
                              </button>
                            )}
                          </div>
                          <div className={THREAD_BODY_CLASS} data-thread-message-body>
                            <CompactMarkdown text={linkifyMessageLocalPaths(message.body)} />
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
