import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'

import { LiveGraphMessageThread, type LiveGraphMessageThreadProps } from './message-thread'
import type { LiveGraphNode, LiveGraphSnapshot } from './model'
import { LiveGraphTaskInspector, type LiveGraphTaskInspectorFilter, type LiveGraphTaskTarget } from './task-inspector'

export interface ScopedTaskFeedPaneViewProps {
  error?: null | string
  graph: LiveGraphSnapshot
  loading?: boolean
  messageThread: Omit<LiveGraphMessageThreadProps, 'onSelectTask'>
  onMessagesVisibleChange?: (visible: boolean) => void
  sourceProfile: string
}

function taskTarget(node: LiveGraphNode): LiveGraphTaskTarget | null {
  if (node.kind !== 'task') {
    return null
  }

  const taskId = node.entityId || node.id

  return taskId
    ? {
        ...(node.board ? { board: node.board } : {}),
        taskId,
        ...(node.workflowId ? { workflowId: node.workflowId } : {})
      }
    : null
}

function sameTask(node: LiveGraphNode, target: LiveGraphTaskTarget): boolean {
  const nodeTarget = taskTarget(node)

  return Boolean(
    nodeTarget &&
    nodeTarget.taskId === target.taskId &&
    (nodeTarget.board?.trim().toLowerCase() || 'default') === (target.board?.trim().toLowerCase() || 'default')
  )
}

export function ScopedTaskFeedPaneView({
  error,
  graph,
  loading = false,
  messageThread,
  onMessagesVisibleChange,
  sourceProfile
}: ScopedTaskFeedPaneViewProps) {
  const { t } = useI18n()
  const [selection, setSelection] = useState<{
    filter: LiveGraphTaskInspectorFilter
    node: LiveGraphNode
    target: LiveGraphTaskTarget
  } | null>(null)

  const tasks = useMemo(() => graph.nodes.filter(node => node.kind === 'task'), [graph.nodes])

  useEffect(() => {
    onMessagesVisibleChange?.(!selection)
  }, [onMessagesVisibleChange, selection])

  if (loading) {
    return (
      <div className="grid size-full place-items-center bg-(--ui-surface-background)">
        <Loader aria-label={t.liveGraph.loading} label={t.liveGraph.loading} type="lemniscate-bloom" />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        className="size-full place-content-center bg-(--ui-surface-background) p-6"
        title={t.liveGraph.loadFailed}
      />
    )
  }

  const selectTask = (node: LiveGraphNode, filter: LiveGraphTaskInspectorFilter) => {
    const target = taskTarget(node)

    if (target) {
      setSelection({ filter, node, target })
    }
  }

  return (
    <>
      {selection && (
        <div
          className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-surface-background) [overflow-wrap:anywhere]"
          data-live-graph-node-selection={selection.node.id}
          data-testid="live-graph-selection-inspector"
        >
          <div className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-3 py-2">
            <Button onClick={() => setSelection(null)} size="xs" type="button" variant="ghost">
              <Codicon name="arrow-left" />
              {t.common.back}
            </Button>
          </div>
          <div
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
            data-testid="scoped-task-feed-inspector"
          >
            <LiveGraphTaskInspector
              initialFilter={selection.filter}
              node={selection.node}
              profile={sourceProfile}
              queryDetail
              target={selection.target}
            />
          </div>
        </div>
      )}
      <div
        className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-surface-background) [overflow-wrap:anywhere]"
        data-testid="scoped-task-feed-pane"
        hidden={Boolean(selection)}
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <LiveGraphMessageThread
            {...messageThread}
            onSelectTask={(target, filter) => {
              const node = tasks.find(candidate => sameTask(candidate, target))

              if (node) {
                selectTask(node, filter)
              }
            }}
            tasks={tasks}
          />
        </div>
      </div>
    </>
  )
}
