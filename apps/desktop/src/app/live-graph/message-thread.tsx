import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { relativeTime } from '@/lib/time'

import { groupSessionMessageThreads, type LiveGraphMessage } from './messages'
import type { LiveGraphTaskTarget } from './task-inspector'

export interface LiveGraphMessageThreadProps {
  error?: null | string
  loading?: boolean
  messages: readonly LiveGraphMessage[]
  onRetry: () => void
  onSelectTask: (target: LiveGraphTaskTarget) => void
  sourceProfile?: string
}

export function LiveGraphMessageThread({
  error,
  loading = false,
  messages,
  onRetry,
  onSelectTask,
  sourceProfile
}: LiveGraphMessageThreadProps) {
  const { t } = useI18n()
  const showBoards = new Set(messages.map(message => message.board)).size > 1
  const profile = sourceProfile || messages[0]?.id.split('\u0000')[0] || 'default'
  const threads = useMemo(() => groupSessionMessageThreads(profile, messages), [messages, profile])
  const [initialized, setInitialized] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

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
    <div className="min-w-0" data-testid="live-graph-message-thread">
      {error && (
        <div className="border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-warning) px-3 py-2 text-[0.6875rem] text-(--ui-text-secondary)" role="status">
          {t.liveGraph.messagesStale}
        </div>
      )}
      {messages.length === 0 ? (
        <p className="m-0 px-3 py-8 text-center text-xs text-(--ui-text-tertiary)">{t.liveGraph.messagesEmpty}</p>
      ) : (
        <ol className="m-0 grid list-none gap-2 p-3">
          {threads.map(thread => {
            const expanded = expandedKeys.has(thread.key)

            const latestTimestampMs =
              thread.latestActivityAt < 10_000_000_000
                ? thread.latestActivityAt * 1000
                : thread.latestActivityAt

            const statusLabel =
              t.liveGraph.statuses[thread.status as keyof typeof t.liveGraph.statuses] ?? t.liveGraph.statuses.unknown

            return (
              <li
                className="min-w-0 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)"
                key={thread.key}
              >
                <button
                  aria-expanded={expanded}
                  aria-label={`${t.liveGraph.messagesTab}: ${thread.taskTitle}`}
                  className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-0 bg-transparent px-3 py-3 text-left text-inherit [overflow-wrap:anywhere] max-[28rem]:grid-cols-1"
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
                  <span className="min-w-0 break-words text-xs leading-5 font-semibold text-(--ui-text-primary)">
                    {thread.taskTitle}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.625rem] text-(--ui-text-tertiary)">
                    <span>{thread.messages.length}</span>
                    <time dateTime={new Date(latestTimestampMs).toISOString()}>{relativeTime(latestTimestampMs)}</time>
                    <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
                  </span>
                  <span className="min-w-0 break-words font-mono text-[0.625rem] text-(--ui-text-tertiary)">
                    {thread.taskId} · {statusLabel}
                    {showBoards ? ` · ${thread.board}` : ''}
                  </span>
                </button>
                {expanded && (
                  <div className="grid min-w-0 gap-3 border-t border-(--ui-stroke-tertiary) px-3 py-3">
                    <ol className="m-0 grid list-none gap-3 p-0">
                      {thread.messages.map(message => {
                        const timestampMs =
                          message.createdAt < 10_000_000_000 ? message.createdAt * 1000 : message.createdAt

                        return (
                          <li className="grid min-w-0 gap-1" data-testid="live-graph-thread-comment" key={message.id}>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.625rem] text-(--ui-text-tertiary)">
                              <span className="min-w-0 break-words font-semibold text-(--ui-text-secondary)">
                                {message.author || t.liveGraph.unknownCommentAuthor}
                              </span>
                              <time dateTime={new Date(timestampMs).toISOString()} title={new Date(timestampMs).toLocaleString()}>
                                {relativeTime(timestampMs)}
                              </time>
                            </div>
                            <p className="m-0 whitespace-pre-wrap break-words text-xs leading-5 text-(--ui-text-primary) [overflow-wrap:anywhere]">
                              {message.body}
                            </p>
                          </li>
                        )
                      })}
                    </ol>
                    <Button
                      aria-label={`${t.liveGraph.viewTask}: ${thread.taskTitle}`}
                      className="h-auto w-fit max-w-full justify-start px-0 text-left text-[0.6875rem]"
                      onClick={() =>
                        onSelectTask({
                          board: thread.board,
                          taskId: thread.taskId,
                          ...(thread.workflowId ? { workflowId: thread.workflowId } : {})
                        })
                      }
                      size="xs"
                      type="button"
                      variant="text"
                    >
                      <span className="break-words [overflow-wrap:anywhere]">{thread.taskTitle}</span>
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
