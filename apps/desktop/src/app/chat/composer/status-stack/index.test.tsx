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
import { openSessionInNewWindow } from '@/store/windows'

import { ComposerStatusStack } from './index'

vi.mock('@/store/windows', () => ({
  isSecondaryWindow: () => false,
  openSessionInNewWindow: vi.fn()
}))

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

function RootRowOverviewHarness({
  initialSelectedTaskId = 't_root',
  state
}: {
  initialSelectedTaskId?: string
  state: LoopPanelState
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialSelectedTaskId)
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

function dependencyGatedRootClickSource(): TenantLoopSource {
  return {
    latest_event_id: 11,
    root_task_id: 't_current_root',
    session_id: 'logical-origin',
    tasks: [
      {
        created_by: 'loop:t_current_root',
        id: 't_current_root',
        included_child_ids: [],
        included_parent_ids: [],
        status: 'running',
        title: 'Current Loop row'
      },
      {
        created_by: 'loop:t_dependency_root',
        id: 't_plan_a',
        included_child_ids: ['t_dependency_root'],
        included_parent_ids: [],
        status: 'done',
        title: 'Parentless prerequisite A'
      },
      {
        created_by: 'loop:t_dependency_root',
        id: 't_plan_b',
        included_child_ids: ['t_dependency_root'],
        included_parent_ids: [],
        status: 'done',
        title: 'Parentless prerequisite B'
      },
      {
        created_by: 'loop:t_dependency_root',
        id: 't_dependency_root',
        included_child_ids: [],
        included_parent_ids: ['t_plan_a', 't_plan_b'],
        status: 'running',
        title: 'Dependency-gated Loop root'
      }
    ]
  }
}

function standaloneDelegatedRootClickSource(): TenantLoopSource {
  return {
    latest_event_id: 12,
    root_task_id: 't_14fe5ade',
    session_id: 'logical-origin',
    tasks: [
      {
        created_by: 'loop_delegation:agent',
        id: 't_f2298d7d',
        included_child_ids: [],
        included_parent_ids: [],
        links: { children: [], parents: [] },
        session_id: '20260624_140203_f3e3b1',
        status: 'done',
        title:
          'Remove the root summary/actions card (`data-testid="loop-root-card"`/`loop-root-actions`) and the root Description/spec section (`data-testid="loop-root-spec"`) from the Hermes Desktop Loop overview drawer, update tests, verify, and commit locally without pushing.'
      }
    ],
    workers: [
      {
        outcome: 'done',
        profile: 'reviewer-qa',
        run_id: 81,
        status: 'done',
        summary: 'accepted',
        task_id: 't_f2298d7d',
        task_status: 'done',
        task_title:
          'Remove the root summary/actions card (`data-testid="loop-root-card"`/`loop-root-actions`) and the root Description/spec section (`data-testid="loop-root-spec"`) from the Hermes Desktop Loop overview drawer, update tests, verify, and commit locally without pushing.',
        worker_session_id: 'worker-session-81'
      }
    ]
  }
}

describe('ComposerStatusStack Loop/Kanban rows', () => {
  beforeEach(() => {
    cleanup()
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    $kanbanStatusBySession.set({})
    $loopagentsBySession.set({})
    $previewStatusBySession.set({})
    $threadScrolledUp.set(false)
    vi.mocked(openSessionInNewWindow).mockClear()
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

    fireEvent.click(screen.getByRole('button', { name: '1 Subagent' }))

    expect(screen.getAllByText('Subscribed Loop root')).toHaveLength(2)
    expect(screen.getByText('Loop')).toBeTruthy()
    expect(screen.getByText('reviewer-qa')).toBeTruthy()
    expect(screen.getByText('Search Files')).toBeTruthy()
  })

  it('opens Loop worker rows with session ids in watch windows before task drawer fallback', () => {
    const onOpenKanbanTask = vi.fn()

    $kanbanStatusBySession.set({
      'logical-origin': [
        {
          id: 'kanban-agent:t_root:77',
          kanbanTaskId: 't_root',
          profile: 'reviewer-qa',
          sessionId: 'worker-session-77',
          state: 'running',
          title: 'Root Loop worker',
          type: 'subagent'
        }
      ]
    })

    renderStack('logical-origin', onOpenKanbanTask)

    fireEvent.click(screen.getByRole('button', { name: '1 Subagent' }))
    fireEvent.click(screen.getByRole('button', { name: /Root Loop worker/i }))

    expect(openSessionInNewWindow).toHaveBeenCalledWith('worker-session-77', { profile: 'reviewer-qa', watch: true })
    expect(onOpenKanbanTask).not.toHaveBeenCalled()
  })

  it('keeps Loop task rows focused on the task drawer even if a session id is present', () => {
    const onOpenKanbanTask = vi.fn()

    $kanbanStatusBySession.set({
      'logical-origin': [
        {
          id: 'kanban-task:t_root',
          kanbanTaskId: 't_root',
          sessionId: 'worker-session-77',
          state: 'running',
          title: 'Root Loop task',
          todoStatus: 'in_progress',
          type: 'todo'
        }
      ]
    })

    renderStack('logical-origin', onOpenKanbanTask)

    fireEvent.click(screen.getByRole('button', { name: /Root Loop task/i }))

    expect(onOpenKanbanTask).toHaveBeenCalledWith('t_root')
    expect(openSessionInNewWindow).not.toHaveBeenCalled()
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

    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph-node-t_child'))
    expect(screen.getByRole('heading', { name: /Focused child/i })).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('composer-status-host')).getByRole('button', { name: /Root Loop row/i }))

    expect(screen.queryByRole('heading', { name: /Focused child/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.getByTestId('loop-panel-body').className).not.toContain('p-3')
  })

  it('opens dependency-gated self-anchored Loop root rows to the overview canvas', () => {
    const source = dependencyGatedRootClickSource()
    const state = deriveLoopPanelStateFromTenantSource(source)!

    reconcileKanbanSessionSourceForComposer({
      activeSessionId: null,
      source,
      sourceSessionId: 'logical-origin'
    })

    render(<RootRowOverviewHarness initialSelectedTaskId="t_current_root" state={state} />)

    fireEvent.click(
      within(screen.getByTestId('composer-status-host')).getByRole('button', { name: /Dependency-gated Loop root/i })
    )

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')

    expect(screen.queryByTestId('loop-task-card')).toBeNull()
    expect(screen.getByTestId('loop-panel-body').className).not.toContain('p-3')
    expect(within(canvas).getByTestId('loop-task-graph-node-t_dependency_root')).toBeTruthy()

    expect(within(rootAgentsCard).queryByRole('button', { name: 'Show agents list' })).toBeNull()
    expect(within(rootAgentsCard).queryByTestId('loop-root-agents-list')).toBeNull()
  })

  it('opens standalone delegated Loop root rows to a single-node overview canvas', () => {
    const source = standaloneDelegatedRootClickSource()
    const state = deriveLoopPanelStateFromTenantSource(source)!

    reconcileKanbanSessionSourceForComposer({
      activeSessionId: null,
      source,
      sourceSessionId: 'logical-origin'
    })

    render(<RootRowOverviewHarness initialSelectedTaskId="t_current_root" state={state} />)

    fireEvent.click(
      within(screen.getByTestId('composer-status-host')).getByRole('button', {
        name: /Remove the root summary\/actions card/i
      })
    )

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')

    expect(screen.queryByTestId('loop-task-card')).toBeNull()
    expect(screen.getByTestId('loop-panel-body').className).not.toContain('p-3')
    expect(within(canvas).getByTestId('loop-task-graph-node-t_f2298d7d')).toBeTruthy()
    expect(canvas.querySelectorAll('[data-testid^="loop-task-graph-edge-"]')).toHaveLength(0)
  })

  it('renders standalone delegated Loop source rows under the active runtime session', () => {
    const source = standaloneDelegatedRootClickSource()

    reconcileKanbanSessionSourceForComposer({
      activeSessionId: 'runtime-tip',
      source,
      sourceSessionId: 'logical-origin'
    })

    renderStack('runtime-tip')

    expect(screen.getByText(/Remove the root summary\/actions card/i)).toBeTruthy()
    expect(screen.getByText('Loop')).toBeTruthy()
  })
})
