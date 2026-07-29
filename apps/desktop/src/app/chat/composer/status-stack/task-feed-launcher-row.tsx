import { useQuery } from '@tanstack/react-query'
import { memo } from 'react'

import {
  LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS,
  LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS,
  loopSessionSourceRefetchInterval
} from '@/app/chat/loop-refresh'
import type { TenantLoopSource } from '@/app/chat/loop-state'
import { liveGraphTaskProgress } from '@/app/live-graph/model'
import { StatusRow } from '@/components/chat/status-row'
import { Codicon } from '@/components/ui/codicon'
import { getLoopSessionSources } from '@/hermes'
import { useI18n } from '@/i18n'

interface TaskFeedLauncherRowProps {
  enabled: boolean
  onOpen?: (sessionId: string, dock: 'center' | 'right') => void
  profile: string
  sourceSessionId: null | string
}

function sourceRefetchInterval(sources?: readonly TenantLoopSource[]): number {
  return sources?.some(source => loopSessionSourceRefetchInterval(source) === LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS)
    ? LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS
    : LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
}

export const TaskFeedLauncherRow = memo(function TaskFeedLauncherRow({
  enabled,
  onOpen,
  profile,
  sourceSessionId
}: TaskFeedLauncherRowProps) {
  const { t } = useI18n()

  const sourceQuery = useQuery({
    queryKey: ['loop-session-source', profile, sourceSessionId],
    queryFn: () => getLoopSessionSources(sourceSessionId!, profile),
    enabled: enabled && Boolean(onOpen && profile && sourceSessionId),
    notifyOnChangeProps: ['data'],
    refetchInterval: query => sourceRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
    select: liveGraphTaskProgress,
    staleTime: LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS
  })

  const progress = sourceQuery.data ?? { blocked: 0, completed: 0, pending: 0, total: 0 }

  const progressLabel = [
    progress.pending > 0 ? t.statusStack.pendingTasks(progress.pending) : null,
    progress.completed > 0 ? t.statusStack.completedTasks(progress.completed) : null,
    progress.blocked > 0 ? t.statusStack.blockedTasks(progress.blocked) : null
  ]
    .filter(Boolean)
    .join(', ')

  if (!enabled || !sourceSessionId || !onOpen || progress.total === 0) {
    return null
  }

  return (
    <StatusRow
      className="task-feed-launcher-row min-h-7 rounded-t-[inherit] rounded-b-none border-b border-(--ui-stroke-tertiary) px-3.5 py-1.5 hover:bg-transparent"
      leading={<Codicon className="text-(--ui-blue)" name="inbox" size="0.8rem" />}
      onActivate={event => onOpen(sourceSessionId, event.shiftKey ? 'right' : 'center')}
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
