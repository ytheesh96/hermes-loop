import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { $statusItemsBySession, type ComposerStatusItem } from '@/store/composer-status'

interface TaskFeedLauncherRowProps {
  onOpen?: (sessionId: string) => void
  sessionId: null | string
}

interface TaskFeedProgress {
  blocked: number
  completed: number
  pending: number
  total: number
}

const emptyProgress = (): TaskFeedProgress => ({ blocked: 0, completed: 0, pending: 0, total: 0 })

export function taskFeedProgress(items: readonly ComposerStatusItem[]): TaskFeedProgress {
  const summaries = new Map<string, ComposerStatusItem>()

  for (const item of items) {
    if (item.type !== 'todo' || !item.kanbanTaskId) {
      continue
    }

    const key = `${item.kanbanBoard || 'default'}:${item.kanbanWorkflowId || item.kanbanTaskId}`
    const previous = summaries.get(key)

    if (!previous || (item.taskProgress?.total || 0) >= (previous.taskProgress?.total || 0)) {
      summaries.set(key, item)
    }
  }

  return [...summaries.values()].reduce<TaskFeedProgress>((progress, item) => {
    if (item.taskProgress) {
      progress.blocked += item.taskProgress.blocked
      progress.completed += item.taskProgress.completed
      progress.pending += item.taskProgress.pending
      progress.total += item.taskProgress.total

      return progress
    }

    if (item.statusIndicator === 'attention' || item.statusIndicator === 'failed' || item.state === 'failed') {
      progress.blocked += 1
    } else if (item.todoStatus === 'completed' || item.state === 'done') {
      progress.completed += 1
    } else {
      progress.pending += 1
    }

    progress.total += 1

    return progress
  }, emptyProgress())
}

export const TaskFeedLauncherRow = memo(function TaskFeedLauncherRow({ onOpen, sessionId }: TaskFeedLauncherRowProps) {
  const { t } = useI18n()
  const itemsBySession = useStore($statusItemsBySession)
  const progress = taskFeedProgress(itemsBySession[sessionId || ''] ?? [])

  const progressLabel = [
    progress.pending > 0 ? t.statusStack.pendingTasks(progress.pending) : null,
    progress.completed > 0 ? t.statusStack.completedTasks(progress.completed) : null,
    progress.blocked > 0 ? t.statusStack.blockedTasks(progress.blocked) : null
  ]
    .filter(Boolean)
    .join(', ')

  if (!sessionId || !onOpen || progress.total === 0) {
    return null
  }

  return (
    <StatusRow
      className="task-feed-launcher-row min-h-7 rounded-t-[inherit] rounded-b-none border-b border-(--ui-stroke-tertiary) px-3.5 py-1.5 hover:bg-transparent"
      leading={<Codicon className="text-(--ui-blue)" name="inbox" size="0.8rem" />}
      onActivate={() => onOpen(sessionId)}
      trailing={
        <span
          aria-label={progressLabel}
          className="flex shrink-0 items-center gap-1.5 text-[0.72rem] leading-4 tabular-nums"
          role="img"
        >
          {progress.pending > 0 && (
            <span
              aria-hidden
              className="flex items-center gap-0.5 text-(--ui-blue)"
              title={t.statusStack.pendingTasks(progress.pending)}
            >
              <Codicon aria-hidden name="clock" size="0.7rem" />
              <span>{progress.pending}</span>
            </span>
          )}
          {progress.completed > 0 && (
            <span
              aria-hidden
              className="flex items-center gap-0.5 text-(--ui-green)"
              title={t.statusStack.completedTasks(progress.completed)}
            >
              <Codicon aria-hidden name="check" size="0.7rem" />
              <span>{progress.completed}</span>
            </span>
          )}
          {progress.blocked > 0 && (
            <span
              aria-hidden
              className="flex items-center gap-0.5 text-(--ui-red)"
              title={t.statusStack.blockedTasks(progress.blocked)}
            >
              <Codicon aria-hidden name="circle-slash" size="0.7rem" />
              <span>{progress.blocked}</span>
            </span>
          )}
        </span>
      }
      trailingVisible
    >
      <span className="min-w-0 truncate text-xs font-normal text-muted-foreground/92 transition-colors group-hover/status-row:text-foreground/90">
        {t.liveGraph.taskFeed}
      </span>
    </StatusRow>
  )
})
