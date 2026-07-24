import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { type LoopWorkflowRef, loopWorkflowRefKey } from '@/app/chat/loop-state'
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
  composerStatusWorkflowRef,
  selectLoopWorkflowForSession
} from '@/store/composer-status'

interface LoopLauncherRowProps {
  onOpen?: () => void
  onOpenWorkflow?: (workflow: LoopWorkflowRef) => void
  sessionId: null | string
}

export const LoopLauncherRow = memo(function LoopLauncherRow({
  onOpen,
  onOpenWorkflow,
  sessionId
}: LoopLauncherRowProps) {
  const { t } = useI18n()
  const itemsBySession = useStore($statusItemsBySession)
  const selectedWorkflowsBySession = useStore($selectedLoopWorkflowBySession)

  const loopItems =
    itemsBySession[sessionId || '']?.filter(item => item.type === 'todo' && Boolean(item.kanbanTaskId)) ?? []

  const workflowSummaries = [
    ...new Map(
      loopItems.map(item => {
        const workflow = composerStatusWorkflowRef(item)!

        return [loopWorkflowRefKey(workflow), item] as const
      })
    ).values()
  ]

  const graphWorkflows = workflowSummaries.filter(item => (item.taskProgress?.total || 0) > 1)
  const workflows = graphWorkflows.length > 0 ? graphWorkflows : workflowSummaries

  const duplicateWorkflowIds = new Set(
    workflows
      .filter((item, index) =>
        workflows.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index &&
            candidate.kanbanWorkflowId === item.kanbanWorkflowId &&
            composerStatusWorkflowRef(candidate)?.board !== composerStatusWorkflowRef(item)?.board
        )
      )
      .map(item => item.kanbanWorkflowId)
  )

  const selectedWorkflow =
    workflows.find(item => {
      const workflow = composerStatusWorkflowRef(item)

      return workflow && loopWorkflowRefKey(workflow) === selectedWorkflowsBySession[sessionId || '']
    }) ||
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
        const workflow = composerStatusWorkflowRef(selectedWorkflow)

        if (onOpenWorkflow && workflow) {
          onOpenWorkflow(workflow)

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
        {workflows.length > 0 && onOpenWorkflow && (
          <span
            className="flex shrink-0 items-center"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={t.statusStack.openWorkflow}
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
                  {t.statusStack.openWorkflow}
                </DropdownMenuLabel>
                {workflows.map(item => (
                  <DropdownMenuItem
                    className="items-start gap-2"
                    key={loopWorkflowRefKey(composerStatusWorkflowRef(item)!)}
                    onSelect={() => {
                      const workflow = composerStatusWorkflowRef(item)!

                      selectLoopWorkflowForSession(sessionId || '', workflow)
                      onOpenWorkflow(workflow)
                    }}
                  >
                    <Codicon
                      className={
                        loopWorkflowRefKey(composerStatusWorkflowRef(item)!) ===
                        loopWorkflowRefKey(composerStatusWorkflowRef(selectedWorkflow)!)
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
                          {duplicateWorkflowIds.has(item.kanbanWorkflowId)
                            ? ` · ${composerStatusWorkflowRef(item)!.board}`
                            : ''}
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
