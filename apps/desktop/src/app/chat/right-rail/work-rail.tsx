import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SetTitlebarToolGroup } from '@/app/shell/titlebar-controls'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { closeRightRail } from '@/store/preview'

import { LoopPanel, loopPanelStateForWorkflow, type LoopTaskCreateOptions } from '../loop-panel'
import type { LoopPanelController } from '../use-loop-panel-controller'

import { ChatPreviewRail } from './preview'

export const WORK_RAIL_MIN_WIDTH = '24rem'
export const WORK_RAIL_MAX_WIDTH = '42rem'

const INTRINSIC = `clamp(${WORK_RAIL_MIN_WIDTH}, 36vw, 34rem)`

export const WORK_RAIL_PANE_WIDTH = `min(${INTRINSIC}, max(0rem, calc(100vw - var(--pane-chat-sidebar-width) - var(--pane-file-browser-width, 0rem) - var(--chat-min-width))))`

type WorkRailTabId = 'loop' | 'preview'

interface ChatWorkRailProps {
  artifactSourceBaseDir?: null | string
  loop: LoopPanelController
  onCreateLoopTask?: (idea: string, options?: LoopTaskCreateOptions) => Promise<null | string>
  onRestartServer?: (url: string, context?: string) => Promise<string>
  previewKey?: string
  previewLabel?: string
  previewOpen: boolean
  setTitlebarToolGroup?: SetTitlebarToolGroup
}

interface WorkRailTab {
  id: WorkRailTabId
  label: string
  onClose: () => void
  title: string
}

function loopRailLabel(loop: LoopPanelController): string {
  const firstTask = loop.state?.rows[0]

  return firstTask?.title || 'Loop'
}

export function ChatWorkRail({
  artifactSourceBaseDir,
  loop,
  onCreateLoopTask,
  onRestartServer,
  previewKey = '',
  previewLabel = 'Preview',
  previewOpen,
  setTitlebarToolGroup
}: ChatWorkRailProps) {
  const loopOpen = loop.open && !loop.hidden

  const closeLoop = useCallback(() => {
    if (loop.activeWorkflowRef) {
      loop.onCloseWorkflowId(loop.activeWorkflowRef)
    } else {
      loop.onHide()
    }
  }, [loop])

  const [activeTabId, setActiveTabId] = useState<WorkRailTabId>('loop')
  const lastLoopKeyRef = useRef('')
  const lastLoopFocusRequestKeyRef = useRef(loop.focusRequestKey)
  const lastPreviewKeyRef = useRef('')
  const previewWasOpenRef = useRef(false)

  const tabs = useMemo<WorkRailTab[]>(
    () => [
      ...(loopOpen ? [{ id: 'loop' as const, label: 'Loop', onClose: closeLoop, title: loopRailLabel(loop) }] : []),
      ...(previewOpen
        ? [{ id: 'preview' as const, label: 'Preview', onClose: closeRightRail, title: previewLabel || 'Preview' }]
        : [])
    ],
    [closeLoop, loop, loopOpen, previewLabel, previewOpen]
  )

  useEffect(() => {
    if (!tabs.some(tab => tab.id === activeTabId)) {
      setActiveTabId(tabs[0]?.id || 'loop')
    }
  }, [activeTabId, tabs])

  useEffect(() => {
    const key = loop.tabKey || ''
    const focusRequestKey = loop.focusRequestKey
    const keyChanged = key && key !== lastLoopKeyRef.current
    const focusRequestChanged = focusRequestKey !== lastLoopFocusRequestKeyRef.current

    if (loopOpen && (keyChanged || focusRequestChanged)) {
      setActiveTabId('loop')
    }

    lastLoopKeyRef.current = key
    lastLoopFocusRequestKeyRef.current = focusRequestKey
  }, [loop.focusRequestKey, loop.tabKey, loopOpen])

  useEffect(() => {
    const openedNow = previewOpen && !previewWasOpenRef.current
    const changedTarget = previewOpen && previewKey && previewKey !== lastPreviewKeyRef.current

    if (openedNow || changedTarget) {
      setActiveTabId('preview')
    }

    previewWasOpenRef.current = previewOpen
    lastPreviewKeyRef.current = previewKey
  }, [previewKey, previewOpen])

  const activeTab = tabs.find(tab => tab.id === activeTabId) || tabs[0]
  const workflowState = loop.workflowRef ? loopPanelStateForWorkflow(loop.state, loop.workflowRef) : loop.state

  const selectedTaskId = workflowState
    ? workflowState.rows.some(row => row.taskId === loop.selectedTaskId)
      ? loop.selectedTaskId
      : null
    : loop.selectedTaskId

  if (!activeTab) {
    return null
  }

  return (
    <aside className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) text-(--ui-text-tertiary)">
      <div className="group/work-tabs flex h-(--titlebar-height) shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
        <div
          className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="work-rail-tabbar"
          role="tablist"
        >
          {tabs.map(tab => {
            const active = tab.id === activeTab.id

            return (
              <div
                className={cn(
                  'group/tab relative flex h-full min-w-28 max-w-56 shrink-0 items-center text-[0.6875rem] font-medium [-webkit-app-region:no-drag] last:border-r last:border-(--ui-stroke-quaternary)',
                  active
                    ? 'bg-(--ui-editor-surface-background) text-foreground [--tab-bg:var(--ui-editor-surface-background)]'
                    : 'border-r border-(--ui-stroke-quaternary) text-(--ui-text-tertiary) [--tab-bg:var(--ui-sidebar-surface-background)] hover:bg-(--chrome-action-hover) hover:text-foreground'
                )}
                data-testid={`work-rail-tab-${tab.id}`}
                key={tab.id}
                onAuxClick={event => {
                  if (event.button !== 1) {
                    return
                  }

                  event.preventDefault()
                  tab.onClose()
                }}
                onMouseDown={event => {
                  if (event.button === 1) {
                    event.preventDefault()
                  }
                }}
              >
                {active && (
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-(--ui-stroke-primary)" />
                )}
                <button
                  aria-selected={active}
                  className="flex h-full min-w-0 max-w-full items-center overflow-hidden pl-3 pr-2 text-left outline-none"
                  onClick={() => setActiveTabId(tab.id)}
                  role="tab"
                  title={tab.title}
                  type="button"
                >
                  <span className="block min-w-0 truncate">{tab.label}</span>
                </button>
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute inset-y-0 right-0 w-9 bg-[linear-gradient(to_right,transparent,var(--tab-bg)_55%)] transition-opacity',
                    active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100'
                  )}
                />
                <button
                  aria-label={`Close ${tab.title}`}
                  className={cn(
                    'absolute right-1.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-(--ui-text-tertiary) transition-[background-color,color,opacity] hover:bg-(--ui-bg-secondary) hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100',
                    active
                      ? 'pointer-events-auto opacity-100'
                      : 'pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100'
                  )}
                  onClick={event => {
                    event.stopPropagation()
                    tab.onClose()
                  }}
                  type="button"
                >
                  <Codicon name="close" size="0.75rem" />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab.id === 'loop' ? (
          <LoopPanel
            artifactSourceBaseDir={artifactSourceBaseDir}
            canvasScopeKey={
              loop.workflowRef
                ? `${loop.canvasScopeKey}:${encodeURIComponent(loop.workflowRef.board)}`
                : loop.canvasScopeKey
            }
            embedded
            focusRequestKey={loop.focusRequestKey}
            hidden={loop.hidden}
            onAddTaskComment={(taskId, body) => loop.onAddTaskComment(taskId, body, loop.workflowRef || undefined)}
            onCreateTask={(idea, options) =>
              (onCreateLoopTask || loop.onCreateTask)(idea, {
                ...options,
                workflowRef: loop.workflowRef || undefined
              })
            }
            onFocusTaskId={taskId => loop.onFocusTaskId(taskId, loop.workflowRef || undefined)}
            onHide={closeLoop}
            onLinkTasks={(parentId, childId) => loop.onLinkTasks(parentId, childId, loop.workflowRef || undefined)}
            onSavePositions={positions => loop.onSavePositions(positions, loop.workflowRef || undefined)}
            onSelectTaskId={taskId => loop.onSelectTaskId(taskId, loop.workflowRef || undefined)}
            onTaskAction={loop.onTaskAction}
            onUnlinkTasks={(parentId, childId) => loop.onUnlinkTasks(parentId, childId, loop.workflowRef || undefined)}
            open={loop.open}
            positions={loop.positionsByWorkflow[loop.workflowKey] ?? loop.positions}
            selectedTaskDetail={selectedTaskId ? loop.selectedTaskDetail : null}
            selectedTaskDetailError={selectedTaskId ? loop.selectedTaskDetailError : null}
            selectedTaskId={selectedTaskId}
            state={workflowState}
            workflowCanvas
            workflowId={loop.workflowId}
          />
        ) : (
          <ChatPreviewRail embedded onRestartServer={onRestartServer} setTitlebarToolGroup={setTitlebarToolGroup} />
        )}
      </div>
    </aside>
  )
}
