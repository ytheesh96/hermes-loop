import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LoopPanel } from '@/app/chat/loop-panel'
import { deriveLoopPanelStateFromTenantSource, type LoopPanelState, type TenantLoopSource } from '@/app/chat/loop-state'
import { I18nProvider } from '@/i18n'
import { $kanbanStatusBySession, reconcileKanbanSessionSourceForComposer } from '@/store/composer-status'
import { $loopagentsBySession } from '@/store/loopagents'
import { $previewStatusBySession } from '@/store/preview-status'
import { $threadScrolledUp } from '@/store/thread-scroll'

import { ComposerStatusStack } from './index'

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

const renderStack = (sessionId: string, onOpenKanbanTask?: (taskId: string) => void) =>
  render(
    <MemoryRouter>
      <I18nProvider configClient={null}>
        <ComposerStatusStack busy={false} onOpenKanbanTask={onOpenKanbanTask} queue={null} sessionId={sessionId} />
      </I18nProvider>
    </MemoryRouter>
  )

function rootClickSource(): TenantLoopSource {
  return {
    latest_event_id: 10,
    root_task_id: 't_root',
    session_id: 'logical-origin',
    tasks: [
      {
        id: 't_root',
        included_child_ids: ['t_child'],
        included_parent_ids: [],
        status: 'running',
        title: 'Root Loop row'
      },
      {
        id: 't_child',
        included_child_ids: [],
        included_parent_ids: ['t_root'],
        status: 'running',
        title: 'Focused child'
      }
    ]
  }
}

function RootRowOverviewHarness({ state }: { state: LoopPanelState }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>('t_root')
  const [focusRequestKey, setFocusRequestKey] = useState(0)

  const openKanbanTask = (taskId: string) => {
    setSelectedTaskId(taskId)
    setFocusRequestKey(key => key + 1)
  }

  return (
    <MemoryRouter>
      <I18nProvider configClient={null}>
        <div data-testid="composer-status-host">
          <ComposerStatusStack busy={false} onOpenKanbanTask={openKanbanTask} queue={null} sessionId="logical-origin" />
        </div>
        <LoopPanel embedded focusRequestKey={focusRequestKey} open selectedTaskId={selectedTaskId} state={state} />
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('ComposerStatusStack Loop/Kanban rows', () => {
  beforeEach(() => {
    cleanup()
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    $kanbanStatusBySession.set({})
    $loopagentsBySession.set({})
    $previewStatusBySession.set({})
    $threadScrolledUp.set(false)
  })

  it('renders subscribed Loop roots in Tasks and active subscribed workers as visible Subagents rows', () => {
    reconcileKanbanSessionSourceForComposer({
      activeSessionId: null,
      sourceSessionId: 'logical-origin',
      source: {
        session_id: 'logical-origin',
        tasks: [
          {
            created_by: 'loop_delegation:agent',
            id: 't_subscribed_loop',
            included_child_ids: [],
            included_parent_ids: [],
            status: 'running',
            title: 'Subscribed Loop root'
          }
        ],
        workers: [
          {
            current_tool: 'search_files',
            profile: 'reviewer-qa',
            run_id: 77,
            status: 'running',
            task_id: 't_subscribed_loop',
            task_status: 'running',
            task_title: 'Subscribed Loop root',
            worker_session_id: 'worker-session-77'
          }
        ]
      }
    })

    renderStack('logical-origin')

    expect(screen.getAllByText('Subscribed Loop root')).toHaveLength(2)
    expect(screen.getByText('Loop')).toBeTruthy()
    expect(screen.getByText('reviewer-qa')).toBeTruthy()
    expect(screen.getByText('Search Files')).toBeTruthy()
  })

  it('prefers opening durable Loop task rows over worker-session windows when both ids are present', () => {
    const onOpenKanbanTask = vi.fn()

    $kanbanStatusBySession.set({
      'logical-origin': [
        {
          id: 'kanban-agent:t_root:77',
          kanbanTaskId: 't_root',
          sessionId: 'worker-session-77',
          state: 'running',
          title: 'Root Loop worker',
          type: 'subagent'
        }
      ]
    })

    renderStack('logical-origin', onOpenKanbanTask)

    fireEvent.click(screen.getByRole('button', { name: /Root Loop worker/i }))

    expect(onOpenKanbanTask).toHaveBeenCalledWith('t_root')
  })

  it('returns an already-selected Loop root row click to the overview drawer', () => {
    const source = rootClickSource()
    const state = deriveLoopPanelStateFromTenantSource(source)!

    reconcileKanbanSessionSourceForComposer({
      activeSessionId: null,
      source,
      sourceSessionId: 'logical-origin'
    })

    render(<RootRowOverviewHarness state={state} />)

    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: 'Show agents list' }))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-list')).getByRole('button', { name: /Focused child/i }))
    expect(screen.getByRole('heading', { name: /Focused child/i })).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('composer-status-host')).getByRole('button', { name: /Root Loop row/i }))

    expect(screen.queryByRole('heading', { name: /Focused child/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.getByTestId('loop-panel-body').className).not.toContain('p-3')
  })
})
