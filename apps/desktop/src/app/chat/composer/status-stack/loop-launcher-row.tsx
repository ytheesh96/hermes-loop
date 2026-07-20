import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import {
  $selectedLoopWorkflowBySession,
  $statusItemsBySession,
  selectLoopWorkflowForSession
} from '@/store/composer-status'

interface LoopLauncherRowProps {
  onOpen?: () => void
  onSelectWorkflow?: (taskId: string) => void
  sessionId: null | string
}

export const LoopLauncherRow = memo(function LoopLauncherRow({
  onOpen,
  onSelectWorkflow,
  sessionId
}: LoopLauncherRowProps) {
  const { t } = useI18n()
  const itemsBySession = useStore($statusItemsBySession)
  const selectedWorkflowsBySession = useStore($selectedLoopWorkflowBySession)

  const loopItems =
    itemsBySession[sessionId || '']?.filter(item => item.type === 'todo' && Boolean(item.kanbanTaskId)) ?? []

  const workflowSummaries = [
    ...new Map(loopItems.map(item => [item.kanbanWorkflowId || item.kanbanTaskId, item] as const)).values()
  ]

  const graphWorkflows = workflowSummaries.filter(item => (item.taskProgress?.total || 0) > 1)
  const workflows = graphWorkflows.length > 0 ? graphWorkflows : workflowSummaries

  const selectedWorkflow =
    workflows.find(item => item.kanbanWorkflowId === selectedWorkflowsBySession[sessionId || '']) ||
    workflows.find(item => item.state !== 'done') ||
    workflows[0]

  const progress = selectedWorkflow?.taskProgress || {
    blocked: selectedWorkflow?.statusIndicator === 'attention' || selectedWorkflow?.state === 'failed' ? 1 : 0,
    completed: selectedWorkflow?.todoStatus === 'completed' ? 1 : 0,
    pending:
      selectedWorkflow &&
      selectedWorkflow.todoStatus !== 'completed' &&
      selectedWorkflow.statusIndicator !== 'attention' &&
      selectedWorkflow.state !== 'failed'
        ? 1
        : 0,
    total: selectedWorkflow ? 1 : 0
  }

  const progressLabel = [
    progress.pending > 0 ? t.statusStack.pendingTasks(progress.pending) : null,
    progress.completed > 0 ? t.statusStack.completedTasks(progress.completed) : null,
    progress.blocked > 0 ? t.statusStack.blockedTasks(progress.blocked) : null
  ]
    .filter(Boolean)
    .join(', ')

  if (!selectedWorkflow || !onOpen) {
    return null
  }

  return (
    <StatusRow
      className="loop-launcher-row min-h-7 rounded-t-[inherit] rounded-b-none border-b border-(--ui-stroke-tertiary) px-3.5 py-1.5 hover:bg-transparent"
      leading={<Codicon className="text-(--ui-blue)" name="type-hierarchy-sub" size="0.8rem" />}
      onActivate={() => {
        if (onSelectWorkflow && selectedWorkflow.kanbanTaskId) {
          onSelectWorkflow(selectedWorkflow.kanbanTaskId)

          return
        }

        onOpen()
      }}
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
      <span className="flex min-w-0 items-center gap-0.5">
        <span className="min-w-0 truncate text-xs font-normal text-muted-foreground/92 transition-colors group-hover/status-row:text-foreground/90">
          {selectedWorkflow.title}
        </span>
        {workflows.length > 0 && onSelectWorkflow && (
          <span
            className="flex shrink-0 items-center"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={t.statusStack.switchWorkflow}
                  className="size-5 shrink-0 text-muted-foreground/65 hover:text-foreground"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Codicon name="kebab-vertical" size="0.8rem" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                aria-label={t.statusStack.workflows}
                className="w-72"
                side="top"
                sideOffset={6}
              >
                <DropdownMenuLabel className="text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
                  {t.statusStack.switchWorkflow}
                </DropdownMenuLabel>
                {workflows.map(item => (
                  <DropdownMenuItem
                    className="items-start gap-2"
                    key={item.kanbanWorkflowId || item.kanbanTaskId}
                    onSelect={() => {
                      selectLoopWorkflowForSession(sessionId || '', item.kanbanWorkflowId || item.kanbanTaskId!)
                      onSelectWorkflow(item.kanbanTaskId!)
                    }}
                  >
                    <Codicon
                      className={
                        item.kanbanWorkflowId === selectedWorkflow.kanbanWorkflowId
                          ? 'mt-0.5 text-(--ui-green)'
                          : 'mt-0.5 text-transparent'
                      }
                      name="check"
                      size="0.75rem"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-(--ui-text-primary)">{item.title}</span>
                      {item.kanbanWorkflowId && (
                        <span className="block truncate text-[0.65rem] text-(--ui-text-tertiary)">
                          {item.kanbanWorkflowId}
                        </span>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </span>
    </StatusRow>
  )
})
