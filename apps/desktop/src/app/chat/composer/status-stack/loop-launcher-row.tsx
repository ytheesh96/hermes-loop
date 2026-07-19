import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { $statusItemsBySession } from '@/store/composer-status'

interface LoopLauncherRowProps {
  onOpen?: () => void
  sessionId: null | string
}

export const LoopLauncherRow = memo(function LoopLauncherRow({ onOpen, sessionId }: LoopLauncherRowProps) {
  const { t } = useI18n()
  const itemsBySession = useStore($statusItemsBySession)

  const loopItems =
    itemsBySession[sessionId || '']?.filter(item => item.type === 'todo' && Boolean(item.kanbanTaskId)) ?? []

  const progress = loopItems.reduce(
    (total, item) => {
      if (item.taskProgress) {
        total.blocked += item.taskProgress.blocked
        total.completed += item.taskProgress.completed
        total.pending += item.taskProgress.pending
      } else if (item.todoStatus === 'completed') {
        total.completed += 1
      } else if (item.statusIndicator === 'attention' || item.state === 'failed') {
        total.blocked += 1
      } else {
        total.pending += 1
      }

      return total
    },
    { blocked: 0, completed: 0, pending: 0 }
  )

  const progressLabel = [
    progress.pending > 0 ? t.statusStack.pendingTasks(progress.pending) : null,
    progress.completed > 0 ? t.statusStack.completedTasks(progress.completed) : null,
    progress.blocked > 0 ? t.statusStack.blockedTasks(progress.blocked) : null
  ]
    .filter(Boolean)
    .join(', ')

  if (loopItems.length === 0 || !onOpen) {
    return null
  }

  return (
    <StatusRow
      className="loop-launcher-row min-h-7 rounded-t-[inherit] rounded-b-none border-b border-(--ui-stroke-tertiary) px-3.5 py-1.5 hover:bg-transparent"
      leading={<Codicon className="text-(--ui-blue)" name="type-hierarchy-sub" size="0.8rem" />}
      onActivate={() => onOpen()}
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
        {t.statusStack.loop}
      </span>
    </StatusRow>
  )
})
