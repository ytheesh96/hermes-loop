import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { relativeTime } from '@/lib/time'

import type { LiveGraphMessage } from './messages'
import type { LiveGraphTaskTarget } from './task-inspector'

export interface LiveGraphMessageThreadProps {
  error?: null | string
  loading?: boolean
  messages: readonly LiveGraphMessage[]
  onRetry: () => void
  onSelectTask: (target: LiveGraphTaskTarget) => void
}

export function LiveGraphMessageThread({
  error,
  loading = false,
  messages,
  onRetry,
  onSelectTask
}: LiveGraphMessageThreadProps) {
  const { t } = useI18n()
  const showBoards = new Set(messages.map(message => message.board)).size > 1

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
        <ol className="m-0 list-none divide-y divide-(--ui-stroke-tertiary) p-0">
          {messages.map(message => {
            const timestampMs = message.createdAt < 10_000_000_000 ? message.createdAt * 1000 : message.createdAt

            const statusLabel =
              t.liveGraph.statuses[message.status as keyof typeof t.liveGraph.statuses] ?? t.liveGraph.statuses.unknown

            return (
              <li className="grid min-w-0 gap-2 px-3 py-3" key={message.id}>
                <div className="flex min-w-0 items-center gap-2 text-[0.625rem] text-(--ui-text-tertiary)">
                  <span className="min-w-0 truncate font-semibold text-(--ui-text-secondary)">
                    {message.author || t.liveGraph.unknownCommentAuthor}
                  </span>
                  <time className="ml-auto shrink-0" dateTime={new Date(timestampMs).toISOString()} title={new Date(timestampMs).toLocaleString()}>
                    {relativeTime(timestampMs)}
                  </time>
                </div>
                <p className="m-0 whitespace-pre-wrap break-words text-xs leading-5 text-(--ui-text-primary)">
                  {message.body}
                </p>
                <Button
                  aria-label={`${t.liveGraph.viewTask}: ${message.taskTitle}`}
                  className="h-auto w-fit max-w-full justify-start px-0 text-left text-[0.6875rem]"
                  onClick={() =>
                    onSelectTask({
                      board: message.board,
                      taskId: message.taskId,
                      ...(message.workflowId ? { workflowId: message.workflowId } : {})
                    })
                  }
                  size="xs"
                  type="button"
                  variant="text"
                >
                  <span className="truncate">{message.taskTitle}</span>
                  <span className="shrink-0 text-(--ui-text-tertiary)">· {statusLabel}</span>
                  {showBoards && <span className="shrink-0 text-(--ui-text-tertiary)">· {message.board}</span>}
                </Button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
