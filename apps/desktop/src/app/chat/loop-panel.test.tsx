import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoopPanel, LoopTaskStack } from './loop-panel'
import { deriveLoopPanelStateFromTenantSource, type LoopPanelState } from './loop-state'
import { LoopTaskGraph, type LoopTaskGraphPosition } from './loop-task-graph'

vi.mock('./right-rail/preview-file', () => ({
  LocalFilePreview: ({ target }: { target: { path?: string; url: string } }) => (
    <div data-testid="loop-local-preview">{target.path || target.url}</div>
  )
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint
})

function returnElementFromPoint(element: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element)
  })
}

function graphNodeFrame(node: HTMLElement): HTMLElement {
  return node.parentElement as HTMLElement
}

function LoopHarness({ state }: { state: LoopPanelState }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelHidden, setPanelHidden] = useState(false)

  function selectTask(taskId: string) {
    setSelectedTaskId(taskId)
    setPanelOpen(true)
    setPanelHidden(false)
  }

  function hidePanel() {
    setPanelOpen(false)
    setPanelHidden(true)
  }

  return (
    <>
      <LoopTaskStack onSelectTaskId={selectTask} selectedTaskId={selectedTaskId} state={state} />
      <LoopPanel
        hidden={panelHidden}
        onHide={hidePanel}
        onSelectTaskId={selectTask}
        open={panelOpen}
        selectedTaskId={selectedTaskId}
        state={state}
      />
    </>
  )
}

function DetailFetchHarness({ state }: { state: LoopPanelState }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>('t_child')

  const selectedTaskDetail =
    selectedTaskId === 't_external'
      ? {
          task: {
            id: 't_external',
            title: 'External parent',
            status: 'ready',
            body: 'Fetched external body',
            included_child_ids: ['t_child'],
            included_parent_ids: []
          },
          comments: [],
          runs: [
            { id: 1, profile: 'old-worker', status: 'done', summary: 'oldest run' },
            { id: 2, profile: 'new-worker', status: 'running', summary: 'newest run' }
          ]
        }
      : null

  return (
    <LoopPanel
      onSelectTaskId={setSelectedTaskId}
      open={true}
      selectedTaskDetail={selectedTaskDetail}
      selectedTaskId={selectedTaskId}
      state={state}
    />
  )
}

function actionState() {
  return deriveLoopPanelStateFromTenantSource({
    session_id: 'sess-actions',
    tenant: 'tenant-a',
    include_archived: true,
    latest_event_id: 17,
    tasks: [
      {
        id: 't_triage',
        title: 'Needs decomposition',
        body: 'Draft Loop spec\n\n- Build the child task graph\n- Keep the evidence visible',
        status: 'triage',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_blocked',
        title: 'Blocked task',
        status: 'blocked',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_scheduled',
        title: 'Parked task',
        status: 'scheduled',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_todo',
        title: 'Ready to start',
        status: 'todo',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_done',
        title: 'Finished task',
        status: 'done',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: [],
        latest_run: { id: 9, profile: 'reviewer-qa', status: 'done', summary: 'accepted' }
      },
      {
        id: 't_archived',
        title: 'Archived task',
        status: 'archived',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      }
    ]
  })!
}

function quickActionGraphState() {
  return deriveLoopPanelStateFromTenantSource({
    session_id: 'sess-graph-actions',
    root_task_id: 't_root',
    tenant: 'tenant-a',
    latest_event_id: 512,
    tasks: [
      {
        id: 't_root',
        title: 'Root Task',
        status: 'running',
        tenant: 'tenant-a',
        included_child_ids: ['t_todo', 't_blocked', 't_triage'],
        included_parent_ids: []
      },
      {
        id: 't_todo',
        title: 'Todo child',
        body: 'Ready to route from the graph tray',
        status: 'todo',
        tenant: 'tenant-a',
        assignee: 'peacock',
        comment_count: 2,
        included_child_ids: [],
        included_parent_ids: ['t_root']
      },
      {
        id: 't_blocked',
        title: 'Blocked child',
        status: 'blocked',
        tenant: 'tenant-a',
        assignee: 'reviewer-qa',
        included_child_ids: [],
        included_parent_ids: ['t_root']
      },
      {
        id: 't_triage',
        title: 'Triage child',
        status: 'triage',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: ['t_root']
      }
    ]
  })!
}

function switchableLoopsState() {
  return deriveLoopPanelStateFromTenantSource({
    session_id: 'sess-switch-loop',
    root_task_id: 't_current_loop',
    tenant: 'tenant-a',
    tasks: [
      {
        id: 't_recent_loop',
        title: 'Recent planning Loop',
        status: 'ready',
        tenant: 'tenant-a',
        created_by: 'loop_delegation:agent',
        included_child_ids: ['t_recent_child'],
        included_parent_ids: []
      },
      {
        id: 't_recent_child',
        title: 'Recent child',
        status: 'todo',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: ['t_recent_loop']
      },
      {
        id: 't_current_loop',
        title: 'Current Loop',
        status: 'running',
        tenant: 'tenant-a',
        created_by: 'loop_delegation:agent',
        included_child_ids: ['t_current_child'],
        included_parent_ids: []
      },
      {
        id: 't_current_child',
        title: 'Current child',
        status: 'running',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: ['t_current_loop']
      },
      {
        id: 't_archived_loop',
        title: 'Archived Loop',
        status: 'archived',
        tenant: 'tenant-a',
        created_by: 'loop_delegation:agent',
        included_child_ids: [],
        included_parent_ids: []
      }
    ]
  })!
}

function collapsedAttentionState() {
  return deriveLoopPanelStateFromTenantSource({
    session_id: 'sess-attention',
    tenant: 'tenant-a',
    latest_event_id: 120,
    tasks: [
      {
        id: 't_running',
        title: 'Ordinary running task stays out of collapsed attention',
        status: 'running',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_blocked',
        title: 'Blocked release gate',
        status: 'blocked',
        tenant: 'tenant-a',
        child_count: 4,
        latest_summary: 'Waiting on foreground owner',
        included_child_ids: ['t_child_a', 't_child_b', 't_child_c', 't_child_d'],
        included_parent_ids: []
      },
      {
        id: 't_failed',
        title: 'Worker crashed while packaging',
        status: 'ready',
        tenant: 'tenant-a',
        latest_run: { id: 5, profile: 'peacock', status: 'failed', outcome: 'failed', summary: 'worker failed' },
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_review',
        title: 'Review handoff needs approval',
        status: 'ready',
        tenant: 'tenant-a',
        latest_summary: 'review-required: needs user acceptance',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_handoff',
        title: 'Foreground handoff overflow row',
        status: 'foreground-handoff',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      },
      {
        id: 't_done',
        title: 'Completed task stays out of collapsed attention',
        status: 'done',
        tenant: 'tenant-a',
        included_child_ids: [],
        included_parent_ids: []
      }
    ]
  })!
}

describe('deriveLoopPanelState', () => {
  it('maps tenant-backed session source rows without reordering the backend/composer list', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-1',
      lineage_session_ids: ['sess-root', 'sess-1'],
      root_task_id: 't_parent',
      tenant: 'tenant-a',
      tenants: ['tenant-a'],
      include_archived: false,
      latest_event_id: 42,
      now: 100,
      links: [
        { parent_id: 't_parent', child_id: 't_child' },
        { parent_id: 't_external', child_id: 't_child' }
      ],
      external_links: [{ parent_id: 't_external', child_id: 't_child' }],
      tasks: [
        {
          id: 't_child',
          title: 'Build child',
          status: 'running',
          tenant: 'tenant-a',
          assignee: 'peacock',
          body: 'Implementation details',
          latest_summary: 'in progress',
          comment_count: 2,
          latest_run: { status: 'running' },
          included_parent_ids: ['t_parent'],
          included_child_ids: []
        },
        {
          id: 't_parent',
          title: 'Design parent',
          status: 'done',
          tenant: 'tenant-a',
          included_parent_ids: [],
          included_child_ids: ['t_child']
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_parent')
    expect(state?.revision).toBe(42)
    expect(state?.rawJson).toContain('"session_id": "sess-1"')
    expect(state?.rows.map(row => row.taskId)).toEqual(['t_child', 't_parent'])
    expect(state?.rows[0]).toMatchObject({
      active: true,
      assignee: 'peacock',
      body: 'Implementation details',
      childCount: 0,
      commentCount: 2,
      latestSummary: 'in progress',
      parentCount: 1,
      parents: ['t_parent'],
      status: 'running',
      taskId: 't_child',
      title: 'Build child'
    })
  })

  it('preserves orchestrator review routing and foreground fork metadata on Loop rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-fork',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_review',
          title: 'Orchestrator blocker triage',
          status: 'review',
          assignee: 'orchestrator',
          tenant: 'tenant-a',
          review_kind: 'blocker_triage',
          resume_mode: 'fork',
          review_subject_assignee: 'peacock',
          foreground_parent_session_id: 'sess-parent',
          foreground_fork_session_id: 'sess-fork',
          loop_handoffs: [
            {
              id: 9,
              task_id: 't_review',
              root_task_id: 't_root',
              handoff_kind: 'blocked_waiting',
              state: 'batched',
              verification_state: 'needs-user',
              reviewer_session_id: 'sess-reviewer'
            }
          ],
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'running',
          tenant: 'tenant-a',
          included_parent_ids: [],
          included_child_ids: ['t_review']
        }
      ]
    })

    expect(state?.rows[0]).toMatchObject({
      reviewKind: 'blocker_triage',
      resumeMode: 'fork',
      reviewSubjectAssignee: 'peacock',
      foregroundParentSessionId: 'sess-parent',
      foregroundForkSessionId: 'sess-fork',
      loopHandoffs: [expect.objectContaining({ handoff_kind: 'blocked_waiting', reviewer_session_id: 'sess-reviewer' })]
    })
  })

  it('prefers an explicit visible root_task_id over newer lineage session children', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-current',
      lineage_session_ids: ['sess-root', 'sess-current'],
      root_task_id: 't_root',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_child',
          session_id: 'sess-current',
          created_at: 30,
          title: 'Newer prerequisite child',
          status: 'ready',
          tenant: 'tenant-a',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_root',
          session_id: 'sess-root',
          created_at: 10,
          title: 'Original dependency-gated root',
          status: 'todo',
          tenant: 'tenant-a',
          included_parent_ids: [],
          included_child_ids: ['t_child']
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_root')
  })

  it('keeps a nested latest decomposition under the outer self-anchored Loop root', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-nested-loop',
      root_task_id: 't_nested_loop',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_outer_loop',
          session_id: 'sess-nested-loop',
          created_at: 10,
          created_by: 'loop:t_outer_loop',
          title: 'Outer Loop root',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: ['t_outer_child']
        },
        {
          id: 't_outer_child',
          session_id: 'sess-nested-loop',
          created_at: 11,
          created_by: 'loop:t_outer_loop',
          title: 'Outer child',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_outer_loop'],
          included_parent_ids: []
        },
        {
          id: 't_nested_loop',
          session_id: 'sess-nested-loop',
          created_at: 20,
          created_by: 'loop:t_outer_loop',
          title: 'Nested sub-loop',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_nested_child'],
          included_parent_ids: ['t_outer_loop']
        },
        {
          id: 't_nested_child',
          session_id: 'sess-nested-loop',
          created_at: 21,
          created_by: 'loop:t_outer_loop',
          title: 'Nested child',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: []
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_outer_loop')
  })

  it('keeps legacy lineage fallback anchored to the earliest matching root row', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-current',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_child',
          session_id: 'sess-current',
          created_at: 30,
          title: 'Newer prerequisite child',
          status: 'ready',
          tenant: 'tenant-a',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_root',
          session_id: 'sess-current',
          created_at: 10,
          title: 'Original dependency-gated root',
          status: 'todo',
          tenant: 'tenant-a',
          included_parent_ids: [],
          included_child_ids: ['t_child']
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_root')
  })

  it('caps tenant depth derivation for malformed cyclic links', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-cycle',
      latest_event_id: 1,
      tasks: [
        {
          id: 't_cycle',
          title: 'Cyclic task',
          status: 'ready',
          included_parent_ids: ['t_cycle'],
          included_child_ids: ['t_cycle']
        }
      ]
    })

    expect(state?.rows[0]?.depth).toBeLessThanOrEqual(1)
    expect(state?.rows[0]?.parents).toEqual(['t_cycle'])
  })

  it('keeps the explicit real root task id separate from the conceptual tenant key', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-root-binding',
      root_task_id: 't_original_root',
      tenant: '20260615_170302_e05048',
      latest_event_id: 9,
      tasks: [
        {
          id: 't_child',
          title: 'Implementation child',
          status: 'running',
          tenant: '20260615_170302_e05048',
          included_child_ids: ['t_original_root'],
          included_parent_ids: []
        },
        {
          id: 't_original_root',
          title: 'Original draft root',
          body: 'Living root spec',
          status: 'todo',
          tenant: '20260615_170302_e05048',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_original_root')
  })
})

describe('LoopPanel', () => {
  it('adds a rough task idea from the empty Loop canvas without duplicate submits', async () => {
    let resolveCreate!: (taskId: null | string) => void

    const api = vi.fn().mockResolvedValue({
      assignees: [
        { name: 'default', on_disk: true },
        { name: 'peacock', on_disk: true },
        { name: 'retired-worker', on_disk: false }
      ]
    })

    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })

    const onCreateTask = vi.fn(
      () =>
        new Promise<null | string>(resolve => {
          resolveCreate = resolve
        })
    )

    render(<LoopPanel onCreateTask={onCreateTask} open state={null} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const surface = within(canvas).getByTestId('loop-task-graph-surface')
    const card = within(surface).getByRole('region', { name: 'Add a Loop task' })

    expect(card.className).toContain('absolute')
    expect(card.className).toContain('rounded-md')
    expect(card.className).toContain('bg-(--ui-surface-background)')
    expect(card.style.height).toBe('76px')
    expect(card.style.width).toBe('188px')
    expect(within(canvas).getByTestId('loop-task-graph-minimap-create-node')).toBeTruthy()

    const idea = screen.getByRole('textbox', { name: 'Rough idea' }) as HTMLInputElement
    const assignee = screen.getByRole('button', { name: 'Assignee' })

    expect(assignee.textContent).toContain('orchestrator')
    expect(assignee.className).toContain('rounded-[0.2rem]')
    expect(assignee.className).toContain('bg-(--ui-bg-secondary)')
    expect(assignee.className).not.toContain('desktop-input-chrome')
    expect(screen.getByRole('button', { name: 'Add task' })).toBeTruthy()

    fireEvent.mouseEnter(card)
    const actionTray = within(surface).getByTestId('loop-task-graph-create-action-tray')
    const add = within(actionTray).getByRole('button', { name: 'Add task' }) as HTMLButtonElement

    expect(card.contains(add)).toBe(false)
    expect(add.disabled).toBe(true)

    const initialView = [canvas.getAttribute('data-view-y'), canvas.getAttribute('data-zoom')]

    fireEvent.keyDown(idea, { key: '+' })
    fireEvent.wheel(idea, { deltaY: 24 })
    expect([canvas.getAttribute('data-view-y'), canvas.getAttribute('data-zoom')]).toEqual(initialView)

    fireEvent.keyDown(idea, { key: 'Enter' })
    expect(onCreateTask).not.toHaveBeenCalled()

    await waitFor(() => expect(api).toHaveBeenCalled())
    fireEvent.pointerDown(assignee, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'peacock' }))
    await waitFor(() => expect(assignee.textContent).toContain('peacock'))

    fireEvent.change(idea, { target: { value: '  Fix flaky auth test  ' } })
    fireEvent.keyDown(idea, { key: 'Enter' })

    expect(onCreateTask).toHaveBeenCalledWith('Fix flaky auth test', 'peacock')
    await waitFor(() => expect(idea.disabled).toBe(true))
    fireEvent.keyDown(idea, { key: 'Enter' })
    expect(onCreateTask).toHaveBeenCalledTimes(1)

    resolveCreate('t_created')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Rough idea' })).toBeNull())
  })

  it('renders dependency groups, opens the Loop overview on click, and omits raw JSON/debug affordances in normal view', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 3,
      root_task_id: 't_root',
      tasks: [
        {
          id: 't_parent',
          included_child_ids: ['t_child'],
          included_parent_ids: [],
          status: 'triage',
          title: 'Design parent'
        },
        {
          current_run_id: 1,
          id: 't_child',
          included_child_ids: [],
          included_parent_ids: ['t_parent'],
          status: 'triage',
          title: 'Build child'
        }
      ]
    })

    render(<LoopHarness state={state!} />)

    expect(screen.getByText('Loop 0/2')).toBeTruthy()
    expect(screen.getAllByText('Design parent').length).toBeGreaterThan(0)
    const dependencyRow = screen.getByTestId('loop-card-t_parent')
    expect(screen.queryByTestId('loop-card-t_child')).toBeNull()
    expect(within(dependencyRow).queryByText('Loop')).toBeNull()
    expect(within(dependencyRow).getByText(/2 tasks/i)).toBeTruthy()
    expect(screen.queryByText(/triage/i)).toBeNull()
    expect(screen.queryByText('active')).toBeNull()
    expect(dependencyRow.style.paddingLeft).toBe('')
    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:block')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-open')).toBe('false')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(within(dependencyRow).getByText('Design parent'))
    expect(screen.getByTestId('loop-panel').className).not.toContain('hidden xl:flex')
    expect(screen.getByTestId('loop-panel').className).not.toContain('fixed')
    expect(screen.getByTestId('loop-panel').getAttribute('data-layout')).toBe('docked')
    expect(screen.getByTestId('loop-panel').getAttribute('data-modal')).toBe('false')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-id')).toBe('loop-panel')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-open')).toBe('true')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-side')).toBe('right')
    expect(screen.getByTestId('loop-panel').getAttribute('data-state')).toBe('open')
    expect(screen.getByTestId('loop-panel').className).toContain('row-start-1')
    expect(screen.getByTestId('loop-panel').style.gridColumn).toBe('2 / 3')
    expect(screen.getByTestId('loop-panel').style.minWidth).toBe('384px')
    expect(screen.getByTestId('loop-panel').style.width).toBe('416px')
    expect(screen.getByRole('separator', { name: /resize loop-panel/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /dismiss loop panel overlay/i })).toBeNull()
    expect(screen.queryByText('Loop details')).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByText('Parents: t_parent')).toBeNull()
    expect(screen.queryByText(/triage/i)).toBeNull()

    expect(screen.queryByRole('button', { name: /hide loop panel/i })).toBeNull()

    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph-node-t_child'))
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByRole('button', { name: /show debug json/i })).toBeNull()
    expect(screen.queryByText(/"nodes"/)).toBeNull()
  }, 15_000)

  it('opens downstream graph node details from the Loop overview canvas without selected-node inspector chrome', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    expect(within(rootAgentsCard).queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(within(rootAgentsCard).queryByTestId('loop-selected-node-actions')).toBeNull()

    fireEvent.click(todoNode)

    expect(screen.getByTestId('loop-task-tab-t_todo')).toBeTruthy()
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Todo child/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByTestId('loop-selected-node-actions')).toBeNull()
  })

  it('opens root graph node details from the Loop overview canvas', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')

    expect(screen.queryByTestId('loop-task-card')).toBeNull()

    fireEvent.click(rootNode)

    expect(screen.getByTestId('loop-task-tab-t_root')).toBeTruthy()
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
  })

  it('pans and zooms the Loop overview canvas without moving task nodes', () => {
    const state = quickActionGraphState()

    const { rerender } = render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const toolbar = within(canvas).getByTestId('loop-task-graph-toolbar')
    const navigator = within(canvas).getByTestId('loop-task-graph-navigator')
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const startX = Number(canvas.getAttribute('data-view-x'))
    const startY = Number(canvas.getAttribute('data-view-y'))
    const startNodeLeft = graphNodeFrame(rootNode).style.left

    expect(within(toolbar).queryByRole('button', { name: 'Reader' })).toBeNull()
    expect(within(toolbar).queryByRole('button', { name: 'Zoom out' })).toBeNull()
    expect(within(toolbar).getByRole('button', { name: 'Tidy graph' })).toBeTruthy()
    expect((within(toolbar).getByRole('button', { name: 'Undo tidy' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(navigator).getByRole('button', { name: 'Zoom out' })).toBeTruthy()
    expect(within(navigator).getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(within(navigator).getByRole('button', { name: 'Fit to screen · F' })).toBeTruthy()

    const zoom = within(navigator).getByRole('slider', { name: 'Zoom level' })

    fireEvent.change(zoom, { target: { value: '0.75' } })
    expect(canvas.getAttribute('data-zoom')).toBe('0.75')
    expect(within(navigator).getByText('75%')).toBeTruthy()

    const hideMinimap = within(navigator).getByRole('button', { name: 'Hide mini-map' })

    fireEvent.click(hideMinimap)
    expect(within(navigator).queryByTestId('loop-task-graph-minimap')).toBeNull()
    expect(within(navigator).getByRole('button', { name: 'Show mini-map' }).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(within(navigator).getByRole('button', { name: 'Zoom in' }))
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(0.75)
    fireEvent.click(within(navigator).getByRole('button', { name: 'Show mini-map' }))
    expect(within(navigator).getByTestId('loop-task-graph-minimap')).toBeTruthy()
    fireEvent.click(within(navigator).getByRole('button', { name: 'Fit to screen · F' }))
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')

    fireEvent.wheel(canvas, { deltaX: 10, deltaY: 20 })

    expect(Number(canvas.getAttribute('data-view-x'))).toBe(startX - 10)
    expect(Number(canvas.getAttribute('data-view-y'))).toBe(startY - 20)
    expect(graphNodeFrame(rootNode).style.left).toBe(startNodeLeft)

    rerender(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)
    expect(Number(canvas.getAttribute('data-view-x'))).toBe(startX - 10)
    expect(Number(canvas.getAttribute('data-view-y'))).toBe(startY - 20)

    fireEvent.wheel(canvas, { clientX: 80, clientY: 80, ctrlKey: true, deltaY: -30 })

    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(0.75)

    rerender(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(0.75)

    fireEvent.click(within(navigator).getByRole('button', { name: 'Fit to screen · F' }))
    expect(canvas.getAttribute('data-view-x')).toBe('0')
    expect(canvas.getAttribute('data-view-y')).toBe('0')
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')

    expect(within(rootAgentsCard).queryByTestId('loop-root-agents-list')).toBeNull()
  })

  it('drags the Loop overview canvas background without selecting a graph node', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const startX = Number(canvas.getAttribute('data-view-x'))
    const startY = Number(canvas.getAttribute('data-view-y'))

    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 55, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })

    expect(Number(canvas.getAttribute('data-view-x'))).toBe(startX + 30)
    expect(Number(canvas.getAttribute('data-view-y'))).toBe(startY + 35)
    expect(screen.queryByTestId('loop-task-card')).toBeNull()
  })

  it('resets an empty canvas draft and view while cancelling an old-scope drag', async () => {
    const state = quickActionGraphState()
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)

    const { rerender } = render(
      <LoopTaskGraph fullPanel onSavePositions={onSavePositions} rows={state.rows} scopeKey="scope-a" />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')

    fireEvent.wheel(canvas, { deltaX: 30, deltaY: 18 })
    expect(canvas.getAttribute('data-view-x')).not.toBe('0')
    expect(canvas.getAttribute('data-view-y')).not.toBe('0')

    fireEvent.pointerDown(rootNode, { button: 0, clientX: 10, clientY: 10, pointerId: 20 })
    fireEvent.pointerMove(canvas, { clientX: 30, clientY: 30, pointerId: 20 })

    rerender(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} positions={[]} rows={[]} scopeKey="scope-b" />)

    await waitFor(() => {
      expect(canvas.getAttribute('data-view-x')).toBe('0')
      expect(canvas.getAttribute('data-view-y')).toBe('0')
      expect(within(canvas).getByRole('region', { name: 'Add a Loop task' })).toBeTruthy()
    })

    const draft = within(canvas).getByRole('region', { name: 'Add a Loop task' })

    expect(draft.getAttribute('data-task-kind')).toBe('task')
    expect(draft.style.left).toBe('32px')
    expect(draft.style.top).toBe('32px')

    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 80, pointerId: 20 })
    fireEvent.pointerUp(canvas, { pointerId: 20 })

    expect(onSavePositions).not.toHaveBeenCalled()
    expect(draft.style.left).toBe('32px')
    expect(draft.style.top).toBe('32px')
  })

  it('does not carry an unsubmitted title between empty session canvases', async () => {
    const { rerender } = render(<LoopTaskGraph fullPanel rows={[]} scopeKey="empty-session-a" />)
    const firstTitle = screen.getByRole('textbox', { name: 'Rough idea' })

    fireEvent.change(firstTitle, { target: { value: 'Belongs only to session A' } })
    expect((firstTitle as HTMLInputElement).value).toBe('Belongs only to session A')

    rerender(<LoopTaskGraph fullPanel rows={[]} scopeKey="empty-session-b" />)

    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Rough idea' }) as HTMLInputElement).value).toBe('')
    )
  })

  it('ignores a title-only creation result after the canvas switches sessions', async () => {
    let resolveCreate: (taskId: null | string) => void = () => undefined

    const onCreateTask = vi.fn(
      () =>
        new Promise<null | string>(resolve => {
          resolveCreate = resolve
        })
    )

    const onSavePositions = vi.fn(async () => true)

    const { rerender } = render(
      <LoopTaskGraph
        fullPanel
        onCreateTask={onCreateTask}
        onSavePositions={onSavePositions}
        rows={[]}
        scopeKey="empty-session-a"
      />
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Rough idea' }), {
      target: { value: 'Create in session A' }
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rough idea' }), { key: 'Enter' })

    rerender(
      <LoopTaskGraph
        fullPanel
        onCreateTask={onCreateTask}
        onSavePositions={onSavePositions}
        rows={[]}
        scopeKey="empty-session-b"
      />
    )
    resolveCreate('t_session_a')

    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Rough idea' }) as HTMLInputElement).value).toBe('')
    )
    expect(onSavePositions).not.toHaveBeenCalled()
  })

  it('opens title-only task creation at the double-clicked world coordinate and cancels with Escape', () => {
    const state = quickActionGraphState()
    const onCreateTask = vi.fn(async () => 't_new')

    render(<LoopTaskGraph fullPanel onCreateTask={onCreateTask} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })

    const bounds = {
      bottom: 650,
      height: 600,
      left: 100,
      right: 900,
      toJSON: () => ({}),
      top: 50,
      width: 800,
      x: 100,
      y: 50
    } as DOMRect

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(bounds)
    fireEvent.wheel(canvas, { deltaX: 30, deltaY: 18 })
    fireEvent.click(within(canvas).getByRole('button', { name: 'Zoom in' }))

    const clientX = 480
    const clientY = 330
    const viewX = Number(canvas.getAttribute('data-view-x'))
    const viewY = Number(canvas.getAttribute('data-view-y'))
    const scale = Number(canvas.getAttribute('data-zoom'))
    const expectedX = Math.max(8, Math.round((clientX - bounds.left - viewX) / scale - 188 / 2))
    const expectedY = Math.max(8, Math.round((clientY - bounds.top - viewY) / scale - 76 / 2))

    fireEvent.doubleClick(canvas, { clientX, clientY })

    const card = within(canvas).getByRole('region', { name: 'Add a Loop task' })

    expect(card.style.left).toBe(`${expectedX}px`)
    expect(card.style.top).toBe(`${expectedY}px`)

    fireEvent.keyDown(within(card).getByRole('textbox', { name: 'Rough idea' }), { key: 'Escape' })

    expect(within(canvas).queryByRole('region', { name: 'Add a Loop task' })).toBeNull()
    expect(onCreateTask).not.toHaveBeenCalled()
  })

  it('places toolbar-created task editors in an open visible slot', () => {
    class OpenCanvasResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect() {}
      observe(target: Element) {
        this.callback(
          [{ contentRect: { height: 600, width: 900 } as DOMRectReadOnly, target } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
    }

    vi.stubGlobal('ResizeObserver', OpenCanvasResizeObserver)

    const state = quickActionGraphState()

    render(<LoopTaskGraph fullPanel rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })

    fireEvent.click(within(canvas).getByRole('button', { name: 'Add task · N' }))

    const card = within(canvas).getByRole('region', { name: 'Add a Loop task' })
    const cardLeft = Number.parseFloat(card.style.left)
    const cardTop = Number.parseFloat(card.style.top)

    for (const node of within(canvas).getAllByTestId(/^loop-task-graph-node-/)) {
      const frame = graphNodeFrame(node)
      const nodeLeft = Number.parseFloat(frame.style.left)
      const nodeTop = Number.parseFloat(frame.style.top)

      const overlaps =
        cardLeft < nodeLeft + 188 && cardLeft + 188 > nodeLeft && cardTop < nodeTop + 76 && cardTop + 76 > nodeTop

      expect(overlaps).toBe(false)
    }
  })

  it('uses a screen-pixel threshold for node dragging and persists zoom-adjusted world coordinates once', async () => {
    const state = quickActionGraphState()
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)
    const onSelectTask = vi.fn()

    render(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} onSelectTask={onSelectTask} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const rootFrame = rootNode.parentElement as HTMLElement

    fireEvent.pointerDown(rootNode, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 13, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    fireEvent.click(rootNode)

    expect(onSavePositions).not.toHaveBeenCalled()
    expect(onSelectTask).toHaveBeenCalledTimes(1)

    fireEvent.click(within(canvas).getByRole('button', { name: 'Zoom in' }))

    const scale = Number(canvas.getAttribute('data-zoom'))
    const startX = Number.parseFloat(rootFrame.style.left)
    const startY = Number.parseFloat(rootFrame.style.top)
    const expectedX = Math.round(startX + 24 / scale)
    const expectedY = Math.round(startY + 12 / scale)

    fireEvent.pointerDown(rootNode, { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(canvas, { clientX: 124, clientY: 112, pointerId: 2 })
    fireEvent.pointerUp(canvas, { pointerId: 2 })

    await waitFor(() =>
      expect(onSavePositions).toHaveBeenCalledWith([{ taskId: 't_root', x: expectedX, y: expectedY }], undefined)
    )
    expect(rootFrame.style.left).toBe(`${expectedX}px`)
    expect(rootFrame.style.top).toBe(`${expectedY}px`)

    fireEvent.click(rootNode)
    expect(onSelectTask).toHaveBeenCalledTimes(1)
    fireEvent.click(rootNode)
    expect(onSelectTask).toHaveBeenCalledTimes(2)
    expect(onSavePositions).toHaveBeenCalledTimes(1)
  })

  it('does not resubmit saved positions for cards that are no longer in the graph', async () => {
    const state = quickActionGraphState()
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)

    render(
      <LoopTaskGraph
        fullPanel
        onSavePositions={onSavePositions}
        positions={[
          { taskId: 't_root', x: 100, y: 120 },
          { taskId: 't_archived', x: 200, y: 240 }
        ]}
        rows={state.rows}
      />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const scale = Number(canvas.getAttribute('data-zoom'))

    fireEvent.pointerDown(rootNode, { button: 0, clientX: 100, clientY: 100, pointerId: 23 })
    fireEvent.pointerMove(canvas, { clientX: 124, clientY: 112, pointerId: 23 })
    fireEvent.pointerUp(canvas, { pointerId: 23 })

    await waitFor(() =>
      expect(onSavePositions).toHaveBeenCalledWith(
        [{ taskId: 't_root', x: Math.round(100 + 24 / scale), y: Math.round(120 + 12 / scale) }],
        undefined
      )
    )
  })

  it('drags cards freely into negative canvas space and expands the signed graph bounds', async () => {
    const state = quickActionGraphState()
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[]) => true)

    render(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const rootFrame = graphNodeFrame(rootNode)
    const startX = Number.parseFloat(rootFrame.style.left)
    const startY = Number.parseFloat(rootFrame.style.top)

    fireEvent.pointerDown(rootNode, { button: 0, clientX: 300, clientY: 240, pointerId: 21 })
    fireEvent.pointerMove(rootNode, { clientX: 200 - startX, clientY: 140 - startY, pointerId: 21 })
    fireEvent.pointerUp(rootNode, { clientX: 200 - startX, clientY: 140 - startY, pointerId: 21 })

    await waitFor(() =>
      expect(onSavePositions).toHaveBeenCalledWith([{ taskId: 't_root', x: -100, y: -100 }], undefined)
    )
    expect(rootFrame.style.left).toBe('-100px')
    expect(rootFrame.style.top).toBe('-100px')
    expect(within(canvas).getByTestId('loop-task-graph-surface').getAttribute('data-world-left')).toBe('-132')
    expect(within(canvas).getByTestId('loop-task-graph-surface').getAttribute('data-world-top')).toBe('-132')
  })

  it('serializes rapid position saves and persists the latest position last', async () => {
    const state = quickActionGraphState()
    let resolveFirst!: (saved: boolean) => void
    let saveAttempt = 0

    const onSavePositions = vi.fn((_positions: LoopTaskGraphPosition[], _rootTaskId?: string): Promise<boolean> => {
      saveAttempt += 1

      return saveAttempt === 1
        ? new Promise<boolean>(resolve => {
            resolveFirst = resolve
          })
        : Promise.resolve(true)
    })

    render(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} rootTaskId="t_root" rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const rootFrame = graphNodeFrame(rootNode)
    const startX = Number.parseFloat(rootFrame.style.left)

    fireEvent.keyDown(rootNode, { altKey: true, key: 'ArrowRight' })
    await waitFor(() => expect(onSavePositions).toHaveBeenCalledTimes(1))

    fireEvent.keyDown(rootNode, { altKey: true, key: 'ArrowRight' })

    expect(rootFrame.style.left).toBe(`${startX + 32}px`)
    expect(onSavePositions).toHaveBeenCalledTimes(1)
    expect(onSavePositions.mock.calls[0]?.[0]).toEqual([{ taskId: 't_root', x: startX + 16, y: 32 }])

    resolveFirst(true)

    await waitFor(() => expect(onSavePositions).toHaveBeenCalledTimes(2))
    expect(onSavePositions.mock.calls[1]?.[0]).toEqual([{ taskId: 't_root', x: startX + 32, y: 32 }])
    expect(rootFrame.style.left).toBe(`${startX + 32}px`)
  })

  it('persists an Alt+Arrow keyboard nudge in world coordinates', async () => {
    const state = quickActionGraphState()
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)

    render(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} rootTaskId="t_root" rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const rootFrame = graphNodeFrame(rootNode)
    const startX = Number.parseFloat(rootFrame.style.left)
    const startY = Number.parseFloat(rootFrame.style.top)

    fireEvent.keyDown(rootNode, { altKey: true, key: 'ArrowDown' })

    await waitFor(() =>
      expect(onSavePositions).toHaveBeenCalledWith([{ taskId: 't_root', x: startX, y: startY + 16 }], 't_root')
    )
    expect(rootFrame.style.top).toBe(`${startY + 16}px`)
  })

  it('tidies persisted overrides and restores them with one-step Undo', async () => {
    const state = quickActionGraphState()

    const positions = [
      { taskId: 't_root', x: 420, y: 300 },
      { taskId: 't_todo', x: 40, y: 520 }
    ]

    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)

    render(<LoopTaskGraph fullPanel onSavePositions={onSavePositions} positions={positions} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootFrame = within(canvas).getByTestId('loop-task-graph-node-t_root').parentElement as HTMLElement
    const tidy = within(canvas).getByRole('button', { name: 'Tidy graph' })
    const undo = within(canvas).getByRole('button', { name: 'Undo tidy' }) as HTMLButtonElement

    expect(rootFrame.style.left).toBe('420px')
    fireEvent.click(tidy)

    await waitFor(() => expect(onSavePositions).toHaveBeenCalledTimes(1))
    expect(rootFrame.style.left).not.toBe('420px')
    expect(undo.disabled).toBe(false)
    expect(onSavePositions.mock.calls[0]?.[0]).toHaveLength(state.rows.length)

    fireEvent.click(undo)

    await waitFor(() => expect(onSavePositions).toHaveBeenCalledTimes(2))
    expect(rootFrame.style.left).toBe('420px')
    expect(onSavePositions.mock.calls[1]?.[0]).toEqual(positions)
    expect(undo.disabled).toBe(true)
  })

  it('links an output handle to an input handle in parent-to-child direction', () => {
    const state = quickActionGraphState()
    const onLinkTasks = vi.fn(async () => true)

    render(<LoopTaskGraph fullPanel onLinkTasks={onLinkTasks} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const output = within(canvas).getByRole('button', { name: 'Connect a follow-up from Root Task' })
    const input = within(canvas).getByRole('button', { name: 'Connect a prerequisite into Todo child' })

    returnElementFromPoint(input)
    fireEvent.pointerDown(output, { button: 0, clientX: 100, clientY: 100, pointerId: 3 })
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200, pointerId: 3 })
    expect(within(canvas).getByTestId('loop-task-graph-connection-preview')).toBeTruthy()
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 200, pointerId: 3 })

    expect(onLinkTasks).toHaveBeenCalledWith('t_root', 't_todo')
  })

  it('deletes a dependency from its edge action', async () => {
    const state = quickActionGraphState()
    const onUnlinkTasks = vi.fn(async () => true)

    const { rerender } = render(
      <LoopTaskGraph fullPanel onUnlinkTasks={onUnlinkTasks} rows={state.rows} scopeKey="scope-a" />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const hit = within(canvas).getByTestId('loop-task-graph-hit-t_root-t_todo')

    const remove = within(canvas).getByRole('button', {
      name: 'Delete dependency from Root Task to Todo child'
    })

    expect(remove.classList.contains('opacity-0')).toBe(true)
    fireEvent.mouseEnter(hit)
    expect(remove.classList.contains('opacity-100')).toBe(true)
    fireEvent.mouseLeave(hit, { relatedTarget: remove })
    expect(remove.classList.contains('opacity-100')).toBe(true)

    rerender(<LoopTaskGraph fullPanel onUnlinkTasks={onUnlinkTasks} rows={state.rows} scopeKey="scope-b" />)
    await waitFor(() => expect(remove.classList.contains('opacity-0')).toBe(true))

    fireEvent.mouseEnter(hit)
    fireEvent.click(remove)

    await waitFor(() => expect(onUnlinkTasks).toHaveBeenCalledWith('t_root', 't_todo'))
  })

  it('links existing cards through keyboard activation of output and input handles', () => {
    const state = quickActionGraphState()
    const onLinkTasks = vi.fn(async () => true)

    render(<LoopTaskGraph fullPanel onLinkTasks={onLinkTasks} rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const output = within(canvas).getByRole('button', { name: 'Connect a follow-up from Root Task' })
    const input = within(canvas).getByRole('button', { name: 'Connect a prerequisite into Todo child' })

    fireEvent.focus(output)
    fireEvent.keyDown(output, { key: 'Enter' })
    fireEvent.click(output, { detail: 0 })
    expect(output.getAttribute('aria-pressed')).toBe('true')

    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: ' ' })
    fireEvent.keyUp(input, { key: ' ' })
    fireEvent.click(input, { detail: 0 })

    expect(onLinkTasks).toHaveBeenCalledWith('t_root', 't_todo')
    expect(output.getAttribute('aria-pressed')).toBe('false')
  })

  it('turns output and input drops on empty space into follow-up and prerequisite links after creation', async () => {
    const state = quickActionGraphState()

    const onCreateTask = vi
      .fn<() => Promise<null | string>>()
      .mockResolvedValueOnce('t_new_child')
      .mockResolvedValueOnce('t_new_parent')

    const onLinkTasks = vi.fn(async () => true)
    const onSavePositions = vi.fn(async (_positions: LoopTaskGraphPosition[], _rootTaskId?: string) => true)

    render(
      <LoopTaskGraph
        fullPanel
        onCreateTask={onCreateTask}
        onLinkTasks={onLinkTasks}
        onSavePositions={onSavePositions}
        rootTaskId="t_root"
        rows={state.rows}
      />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const output = within(canvas).getByRole('button', { name: 'Connect a follow-up from Root Task' })

    returnElementFromPoint(null)
    fireEvent.pointerDown(output, { button: 0, clientX: 100, clientY: 100, pointerId: 4 })
    fireEvent.pointerUp(canvas, { clientX: 600, clientY: 500, pointerId: 4 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Rough idea' }), {
      target: { value: 'Follow-up task' }
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rough idea' }), { key: 'Enter' })

    await waitFor(() => expect(onLinkTasks).toHaveBeenCalledWith('t_root', 't_new_child'))
    expect(onSavePositions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ taskId: 't_new_child' })]),
      't_root'
    )

    const input = within(canvas).getByRole('button', { name: 'Connect a prerequisite into Todo child' })

    fireEvent.pointerDown(input, { button: 0, clientX: 300, clientY: 300, pointerId: 5 })
    fireEvent.pointerUp(canvas, { clientX: 500, clientY: 100, pointerId: 5 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Rough idea' }), {
      target: { value: 'Prerequisite task' }
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rough idea' }), { key: 'Enter' })

    await waitFor(() => expect(onLinkTasks).toHaveBeenCalledWith('t_new_parent', 't_todo'))
    expect(onCreateTask).toHaveBeenNthCalledWith(1, 'Follow-up task', 'orchestrator')
    expect(onCreateTask).toHaveBeenNthCalledWith(2, 'Prerequisite task', 'orchestrator')
  })

  it('projects manual node positions into both the connector path and minimap', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      root_task_id: 't_root',
      session_id: 'sess-position-projection',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_root',
          included_child_ids: ['t_child'],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Root'
        },
        {
          id: 't_child',
          included_child_ids: [],
          included_parent_ids: ['t_root'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Child'
        }
      ]
    })!

    render(
      <LoopTaskGraph
        fullPanel
        positions={[
          { taskId: 't_root', x: -120, y: -80 },
          { taskId: 't_child', x: 420, y: 360 }
        ]}
        rows={state.rows}
      />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const childNode = within(canvas).getByTestId('loop-task-graph-node-t_child')
    const edge = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_child')
    const rootMini = within(canvas).getByTestId('loop-task-graph-minimap-node-t_root')
    const childMini = within(canvas).getByTestId('loop-task-graph-minimap-node-t_child')

    expect((rootNode.parentElement as HTMLElement).style.left).toBe('-120px')
    expect((childNode.parentElement as HTMLElement).style.top).toBe('360px')
    expect(edge.getAttribute('d')).toMatch(/^M -26 -4\b/)
    expect(edge.closest('svg')?.classList.contains('overflow-visible')).toBe(true)
    expect(Number.parseFloat(childMini.style.left)).toBeGreaterThan(Number.parseFloat(rootMini.style.left))
    expect(Number.parseFloat(childMini.style.top)).toBeGreaterThan(Number.parseFloat(rootMini.style.top))
  })

  it('renders only reduced direct edges without inventing links for disconnected cards', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      root_task_id: 't_a',
      session_id: 'sess-real-edges',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_a',
          included_child_ids: ['t_b', 't_c'],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'A'
        },
        {
          id: 't_b',
          included_child_ids: ['t_c'],
          included_parent_ids: ['t_a'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'B'
        },
        {
          id: 't_c',
          included_child_ids: [],
          included_parent_ids: ['t_a', 't_b'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'C'
        },
        {
          id: 't_disconnected',
          included_child_ids: [],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Disconnected'
        }
      ]
    })!

    render(<LoopTaskGraph fullPanel rows={state.rows} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const primaryEdge = within(canvas).getByTestId('loop-task-graph-edge-t_a-t_b')
    const secondaryEdge = within(canvas).queryByTestId('loop-task-graph-edge-t_a-t_c')

    const edgeIds = Array.from(canvas.querySelectorAll('[data-testid^="loop-task-graph-edge-"]'))
      .map(edge => edge.getAttribute('data-testid'))
      .sort()

    expect(edgeIds).toEqual([
      'loop-task-graph-edge-t_a-t_b',
      'loop-task-graph-edge-t_b-t_c'
    ])
    expect(primaryEdge).toBeTruthy()
    expect(secondaryEdge).toBeNull()
    expect(edgeIds.some(edgeId => edgeId?.includes('disconnected'))).toBe(false)
  })

  it('keeps disconnected dependency components in separate horizontal lanes', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      root_task_id: 't_a_left',
      session_id: 'sess-separated-components',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_a_left',
          included_child_ids: ['t_a_join'],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop A left prerequisite'
        },
        {
          id: 't_b_start',
          included_child_ids: ['t_b_end'],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop B start'
        },
        {
          id: 't_a_right',
          included_child_ids: ['t_a_join'],
          included_parent_ids: [],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop A right prerequisite'
        },
        {
          id: 't_b_end',
          included_child_ids: [],
          included_parent_ids: ['t_b_start'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop B end'
        },
        {
          id: 't_a_join',
          included_child_ids: [],
          included_parent_ids: ['t_a_left', 't_a_right'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop A join'
        }
      ]
    })!

    render(
      <LoopTaskGraph
        fullPanel
        positions={state.rows.map((row, index) => ({ taskId: row.taskId, x: index * 20, y: index * 20 }))}
        rows={state.rows}
      />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    fireEvent.click(within(canvas).getByRole('button', { name: 'Tidy graph' }))

    const frame = (taskId: string) =>
      graphNodeFrame(within(canvas).getByTestId(`loop-task-graph-node-${taskId}`))

    const left = (element: HTMLElement) => Number.parseFloat(element.style.left)
    const width = (element: HTMLElement) => Number.parseFloat(element.style.width)
    const center = (element: HTMLElement) => left(element) + width(element) / 2

    const bounds = (elements: HTMLElement[]) => ({
      left: Math.min(...elements.map(left)),
      right: Math.max(...elements.map(element => left(element) + width(element)))
    })

    const aLeft = frame('t_a_left')
    const aRight = frame('t_a_right')
    const aJoin = frame('t_a_join')
    const bStart = frame('t_b_start')
    const bEnd = frame('t_b_end')
    const loopA = bounds([aLeft, aRight, aJoin])
    const loopB = bounds([bStart, bEnd])

    expect(loopA.right).toBeLessThan(loopB.left)
    expect(center(aJoin)).toBeGreaterThan(Math.min(center(aLeft), center(aRight)))
    expect(center(aJoin)).toBeLessThan(Math.max(center(aLeft), center(aRight)))
    expect(left(bStart)).toBe(left(bEnd))
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_a_left-t_a_join')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_a_right-t_a_join')).toBeTruthy()
  })

  it('omits the old root overview switch/list chrome from the graph canvas', () => {
    const state = switchableLoopsState()
    const onSelectTaskId = vi.fn()

    render(<LoopPanel onSelectTaskId={onSelectTaskId} open selectedTaskId="t_current_loop" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')

    expect(within(rootAgentsCard).queryByRole('button', { name: 'Switch Loop' })).toBeNull()
    expect(within(rootAgentsCard).queryByRole('button', { name: 'Show agents list' })).toBeNull()
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_current_loop')).toBeTruthy()
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_current_child')).toBeTruthy()
    expect(onSelectTaskId).not.toHaveBeenCalled()
  })

  it('reveals graph quick action tray on node hover and keyboard focus', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    expect(within(rootAgentsCard).queryByTestId('loop-task-graph-action-tray-t_todo')).toBeNull()

    fireEvent.mouseEnter(todoNode)

    const hoverTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    expect(within(hoverTray).getByRole('button', { name: /^Block t_todo$/i })).toBeTruthy()
    expect(within(hoverTray).getByRole('button', { name: /^Archive t_todo$/i })).toBeTruthy()
    expect(within(hoverTray).getAllByRole('button')).toHaveLength(2)

    fireEvent.mouseLeave(todoNode)
    expect(within(rootAgentsCard).queryByTestId('loop-task-graph-action-tray-t_todo')).toBeNull()

    fireEvent.focus(todoNode)

    const focusTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    expect(within(focusTray).getByRole('button', { name: /^Block t_todo$/i })).toBeTruthy()
    expect(within(focusTray).getByRole('button', { name: /^Archive t_todo$/i })).toBeTruthy()
  })

  it('docks graph quick action trays to the same bottom edge on every node', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    fireEvent.mouseEnter(rootNode)
    const rootTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_root')
    const rootNodeFrame = graphNodeFrame(rootNode)
    const rootNodeBottom = Number.parseFloat(rootNodeFrame.style.top) + Number.parseFloat(rootNodeFrame.style.height)
    const rootTrayTop = Number.parseFloat(rootTray.style.top)
    expect(rootTrayTop - rootNodeBottom).toBe(-1)

    fireEvent.mouseLeave(rootNode, { relatedTarget: rootTray })
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_root')).toBeTruthy()

    fireEvent.mouseLeave(rootTray)
    expect(within(rootAgentsCard).queryByTestId('loop-task-graph-action-tray-t_root')).toBeNull()

    fireEvent.mouseEnter(todoNode)
    const todoTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    const todoNodeFrame = graphNodeFrame(todoNode)
    const todoNodeBottom = Number.parseFloat(todoNodeFrame.style.top) + Number.parseFloat(todoNodeFrame.style.height)
    expect(Number.parseFloat(todoTray.style.top) - todoNodeBottom).toBe(rootTrayTop - rootNodeBottom)
    fireEvent.mouseLeave(todoNode, { relatedTarget: todoTray })
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')).toBeTruthy()
  })

  it('opens task details on click and asks Hermes on shift-click', () => {
    const state = quickActionGraphState()
    const onOpenTaskTab = vi.fn()
    const onSelectTask = vi.fn()
    const onTaskAction = vi.fn()

    render(
      <LoopTaskGraph
        fullPanel
        onOpenTaskTab={onOpenTaskTab}
        onSelectTask={onSelectTask}
        onTaskAction={onTaskAction}
        rows={state.rows}
      />
    )

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    fireEvent.click(todoNode)
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't_todo' }))
    expect(onOpenTaskTab).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't_todo' }))
    expect(onTaskAction).not.toHaveBeenCalled()

    fireEvent.click(todoNode, { shiftKey: true })
    expect(onTaskAction).toHaveBeenCalledWith('ask-hermes', expect.objectContaining({ taskId: 't_todo' }))
    expect(onOpenTaskTab).toHaveBeenCalledTimes(1)
  })

  it('routes the limited graph hover actions with status-aware block/unblock', () => {
    const state = quickActionGraphState()
    const onTaskAction = vi.fn()

    render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')
    const blockedNode = within(canvas).getByTestId('loop-task-graph-node-t_blocked')

    fireEvent.mouseEnter(todoNode)

    const todoTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    fireEvent.click(within(todoTray).getByRole('button', { name: /^Block t_todo$/i }))
    expect(onTaskAction).toHaveBeenCalledWith('block', expect.objectContaining({ taskId: 't_todo' }))

    fireEvent.click(within(todoTray).getByRole('button', { name: /^Archive t_todo$/i }))
    expect(onTaskAction).toHaveBeenCalledWith('archive', expect.objectContaining({ taskId: 't_todo' }))

    fireEvent.mouseLeave(todoNode)
    fireEvent.mouseEnter(blockedNode)

    const blockedTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_blocked')
    fireEvent.click(within(blockedTray).getByRole('button', { name: /^Unblock t_blocked$/i }))
    expect(onTaskAction).toHaveBeenCalledWith('unblock', expect.objectContaining({ taskId: 't_blocked' }))
  })

  it('disables graph quick action buttons when task action routing is unavailable', () => {
    const state = quickActionGraphState()

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const blockedNode = within(canvas).getByTestId('loop-task-graph-node-t_blocked')

    fireEvent.focus(blockedNode)

    const tray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_blocked')
    expect((within(tray).getByRole('button', { name: /^Unblock t_blocked$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((within(tray).getByRole('button', { name: /^Archive t_blocked$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('renders orchestrator fork lineage and task-attached foreground handoffs in the drawer', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-parent',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 206,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_review'],
          included_parent_ids: []
        },
        {
          id: 't_review',
          title: 'Orchestrator triage active',
          status: 'review',
          tenant: 'tenant-a',
          assignee: 'orchestrator',
          review_kind: 'blocker_triage',
          resume_mode: 'fork',
          review_subject_assignee: 'peacock',
          foreground_parent_session_id: 'sess-parent',
          foreground_fork_session_id: 'sess-fork',
          loop_handoffs: [
            {
              id: 4,
              root_task_id: 't_root',
              task_id: 't_review',
              handoff_kind: 'blocked_waiting',
              intent: 'unblock',
              target_actor: 'orchestrator',
              queue_state: 'open',
              state: 'batched',
              attention: 'needs-user',
              verification_state: 'needs-user',
              summary: 'Orchestrator owner must choose the recovery path.',
              review_task_id: 't_review',
              reviewer_session_id: 'sess-reviewer'
            }
          ],
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_review" state={state} />)

    const handoffCard = screen.getByTestId('loop-foreground-handoff-card')
    expect(within(handoffCard).getByRole('heading', { name: /Handoff request/i })).toBeTruthy()
    expect(within(handoffCard).getByText('Orchestrator review active')).toBeTruthy()
    expect(within(handoffCard).getByText(/attached to task t_review/i)).toBeTruthy()
    expect(within(handoffCard).getByText('Review kind')).toBeTruthy()
    expect(within(handoffCard).getByText('Blocker Triage')).toBeTruthy()
    expect(within(handoffCard).getByText('Resume mode')).toBeTruthy()
    expect(within(handoffCard).getByText('Fork')).toBeTruthy()
    expect(within(handoffCard).getByText('Parent session')).toBeTruthy()
    expect(within(handoffCard).getByText('sess-parent')).toBeTruthy()
    expect(within(handoffCard).getByText('Fork session')).toBeTruthy()
    expect(within(handoffCard).getByText('sess-fork')).toBeTruthy()
    expect(within(handoffCard).getByText(/Unblock · Target Orchestrator · Open/i)).toBeTruthy()
    expect(within(handoffCard).getByText(/Orchestrator owner must choose/i)).toBeTruthy()
    expect(within(handoffCard).getByText(/reviewer sess-reviewer/i)).toBeTruthy()
  })

  it('renders compact flat rows plus read-only drawer sections from real tenant task data', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-drawer-v1',
      tenant: 'tenant-a',
      latest_event_id: 202,
      tasks: [
        {
          id: 't_parent',
          title: 'Design parent',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Build child',
          status: 'blocked',
          priority: 5,
          tenant: 'tenant-a',
          assignee: 'peacock',
          body: 'Implement the detail panel',
          included_child_ids: ['t_grandchild'],
          included_parent_ids: ['t_parent'],
          workspace_kind: 'worktree',
          workspace_path: '/worktrees/t_child'
        },
        {
          id: 't_grandchild',
          title: 'Review child',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    const onTaskAction = vi.fn()
    render(
      <>
        <LoopTaskStack onSelectTaskId={() => undefined} selectedTaskId="t_child" state={state} />
        <LoopPanel
          onSelectTaskId={() => undefined}
          onTaskAction={onTaskAction}
          open
          selectedTaskId="t_child"
          state={state}
        />
      </>
    )

    const row = screen.getByTestId('loop-card-t_parent')
    expect(screen.queryByTestId('loop-card-t_child')).toBeNull()
    expect(row.textContent).toContain('Design parent')
    expect(row.textContent).not.toContain('Implement the detail panel')
    expect(within(row).queryByText('Loop')).toBeNull()
    expect(within(row).getByText(/3 tasks/i)).toBeTruthy()
    expect(within(row).queryByText(/1 blocking/i)).toBeNull()
    expect(within(row).queryByText(/1 follow-up/i)).toBeNull()

    expect(screen.getByText('Description')).toBeTruthy()
    expect(screen.queryByText('Evidence / proof')).toBeNull()
    expect(screen.queryByText('Lineage/source')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocking' })).toBeNull()
    const taskCard = screen.getByTestId('loop-task-card')
    expect(within(taskCard).getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(within(taskCard).queryByText('t_child')).toBeNull()
    expect(within(taskCard).getByRole('button', { name: /unblock t_child/i })).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /ask in chat about t_child/i })).toBeTruthy()
    expect(within(taskCard).getByText('Ask in chat')).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /archive t_child/i })).toBeTruthy()
    expect(screen.queryByText('Header')).toBeNull()
    expect(screen.queryByText('Safe actions')).toBeNull()
    expect(screen.queryByText('Decomposed children/follow-ups')).toBeNull()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByText('Assignee: peacock')).toBeNull()
    expect(screen.queryByText('Workspace: worktree')).toBeNull()
    expect(screen.queryByText('/worktrees/t_child')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy id for t_child/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /open source task\/details for t_child/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /refresh details for t_child/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^block t_child$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /decompose t_child/i })).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(within(taskCard).getByRole('button', { name: /unblock t_child/i }))
    expect(onTaskAction).toHaveBeenCalledWith('unblock', expect.objectContaining({ taskId: 't_child' }))
    fireEvent.click(within(taskCard).getByRole('button', { name: /ask in chat about t_child/i }))
    expect(onTaskAction).toHaveBeenCalledWith('ask-hermes', expect.objectContaining({ taskId: 't_child' }))
    fireEvent.click(within(taskCard).getByRole('button', { name: /archive t_child/i }))
    expect(onTaskAction).toHaveBeenCalledWith('archive', expect.objectContaining({ taskId: 't_child' }))
  })

  it('renders focused task comments and submits new comments through the Loop comment handler', async () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-comments',
      tenant: 'tenant-a',
      latest_event_id: 208,
      tasks: [
        {
          id: 't_child',
          title: 'Build child',
          status: 'running',
          tenant: 'tenant-a',
          body: 'Implement the detail panel',
          comment_count: 2,
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    const onAddTaskComment = vi.fn(async () => undefined)

    render(
      <LoopPanel
        onAddTaskComment={onAddTaskComment}
        open
        selectedTaskDetail={{
          comments: [
            {
              author: 'peacock',
              body: 'Agent found the implementation seam.',
              created_at: 1_700_000_000,
              id: 1,
              task_id: 't_child'
            },
            {
              author: 'reviewer-qa',
              body: 'Please add a regression test.\n\n```json\n{"long":"comment content should be allowed to scroll instead of being clipped by the card"}\n```',
              created_at: 1_700_000_060,
              id: 2,
              task_id: 't_child'
            }
          ]
        }}
        selectedTaskId="t_child"
        state={state}
      />
    )

    const commentsCard = screen.getByTestId('loop-task-comments-card')
    expect(commentsCard.className).toContain('overflow-visible')
    expect(commentsCard.className).not.toContain('overflow-hidden')
    expect(within(commentsCard).getByRole('heading', { name: /Comments \(2\)/i })).toBeTruthy()
    expect(within(commentsCard).queryByText('Task discussion and review breadcrumbs')).toBeNull()
    expect(within(commentsCard).queryByText('2 comments')).toBeNull()
    expect(within(commentsCard).getByText('peacock')).toBeTruthy()
    expect(within(commentsCard).getByText('reviewer-qa')).toBeTruthy()
    expect(within(commentsCard).getByText(/Agent found the implementation seam/i)).toBeTruthy()
    expect(within(commentsCard).getByText(/Please add a regression test/i)).toBeTruthy()

    for (const comment of within(commentsCard).getAllByTestId('loop-task-comment')) {
      expect(comment.className).toContain('min-w-0')
      expect(comment.className).not.toContain('grid-cols-[1.35rem_minmax(0,1fr)]')
    }

    expect(within(commentsCard).getByText(/comment content should be allowed/i)).toBeTruthy()

    const composer = within(commentsCard).getByTestId('loop-task-comment-composer')
    const input = within(composer).getByRole('textbox', { name: /comment on t_child/i }) as HTMLTextAreaElement
    const submit = within(composer).getByRole('button', { name: /^comment$/i })

    expect(composer.tagName).toBe('FORM')
    expect(composer.className).toContain('rounded-md')
    expect(composer.contains(input)).toBe(true)
    expect(composer.contains(submit)).toBe(true)
    expect(within(composer).queryByText(/Enter sends/i)).toBeNull()
    expect(input.className).toContain('border-0')
    expect(input.className).toContain('bg-transparent')

    fireEvent.change(input, { target: { value: 'Looks good — please merge after tests.' } })
    fireEvent.keyDown(input, { code: 'Enter', key: 'Enter' })

    await waitFor(() =>
      expect(onAddTaskComment).toHaveBeenCalledWith('t_child', 'Looks good — please merge after tests.')
    )
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('shows task detail comment load errors instead of an endless loading fallback', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-comments-error',
      tenant: 'tenant-a',
      latest_event_id: 209,
      tasks: [
        {
          id: 't_child',
          title: 'Build child',
          status: 'running',
          tenant: 'tenant-a',
          body: 'Implement the detail panel',
          comment_count: 2,
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    render(
      <LoopPanel
        open
        selectedTaskDetailError="task t_child not found on board default"
        selectedTaskId="t_child"
        state={state}
      />
    )

    const commentsCard = screen.getByTestId('loop-task-comments-card')

    expect(
      within(commentsCard).getByText(/Couldn't load comments: task t_child not found on board default/i)
    ).toBeTruthy()
    expect(within(commentsCard).queryByText(/Loading comments/i)).toBeNull()
  })

  it('renders Loop overview groups, opens focused child details, and returns back to the Loop overview', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-option-a',
      tenant: 'tenant-a',
      latest_event_id: 404,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          body: 'Root execution spec\n\n- Split the work into atomic tasks',
          status: 'running',
          tenant: 'tenant-a',
          assignee: 'foreground',
          latest_summary: 'awaiting foreground acceptance',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_running',
          title: 'Active child',
          status: 'running',
          tenant: 'tenant-a',
          assignee: 'peacock',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_review',
          title: 'Review child',
          status: 'blocked',
          tenant: 'tenant-a',
          assignee: 'reviewer-qa',
          latest_summary: 'review-required: inspect proof',
          included_child_ids: ['t_review_followup'],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_review_followup',
          title: 'Review follow-up',
          status: 'todo',
          tenant: 'tenant-a',
          assignee: 'reviewer-qa',
          included_child_ids: [],
          included_parent_ids: ['t_review', 't_root']
        },
        {
          id: 't_queued',
          title: 'Queued child',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_misc_review',
          title: 'Review-only child',
          status: 'review',
          tenant: 'tenant-a',
          assignee: 'reviewer-qa',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_done',
          title: 'Completed child',
          status: 'done',
          tenant: 'tenant-a',
          latest_summary: 'verified evidence',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ]
    })

    const onHide = vi.fn()
    render(<LoopPanel onHide={onHide} open selectedTaskId="t_root" state={state} />)

    expect(screen.queryByRole('button', { name: /Hide Loop panel/i })).toBeNull()

    const panel = screen.getByTestId('loop-panel')
    expect(panel.style.minWidth).toBe('384px')
    expect(screen.getByTestId('loop-panel-tabbar').style.paddingRight).toBe(
      'calc(var(--titlebar-tools-right) + var(--titlebar-tools-width) + 0.5rem)'
    )
    expect(screen.getByTestId('loop-overview-tab').className).toContain('min-w-36')
    expect(screen.queryByTestId('loop-task-comments-card')).toBeNull()
    fireEvent.keyDown(screen.getByRole('separator', { name: /Resize loop-panel/i }), { key: 'Home' })
    expect(panel.style.width).toBe('384px')

    expect(screen.queryByTestId('loop-root-card')).toBeNull()
    expect(screen.queryByTestId('loop-root-actions')).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.queryByRole('heading', { name: /Root Task/i })).toBeNull()
    expect(screen.queryByTestId('loop-root-state-card')).toBeNull()
    expect(screen.queryByRole('heading', { name: /Loop state/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Close Root Task/i }))
    expect(onHide).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Live draft/i)).toBeNull()
    expect(screen.queryByText(/rev 404/i)).toBeNull()
    expect(screen.queryByText('1 active')).toBeNull()
    expect(screen.queryByText('1 needs attention')).toBeNull()
    expect(screen.queryByText('1 queued')).toBeNull()
    expect(screen.queryByText('1 completed')).toBeNull()

    const agentsCard = screen.getByTestId('loop-root-agents-card')

    expect(screen.getByTestId('loop-panel-body').className).not.toContain('p-3')
    expect(agentsCard.getAttribute('data-root-overview-canvas')).toBe('true')
    expect(agentsCard.className).not.toContain('border')
    expect(agentsCard.className).not.toContain('rounded-lg')
    expect(within(agentsCard).queryByRole('heading', { name: /^Loop graph$/i })).toBeNull()
    expect(within(agentsCard).queryByRole('heading', { name: /^Agents$/i })).toBeNull()
    expect(within(agentsCard).queryByRole('button', { name: 'Show agents list' })).toBeNull()
    const canvas = within(agentsCard).getByTestId('loop-task-graph')
    expect(canvas.getAttribute('aria-label')).toBe('Loop graph canvas')
    expect(canvas.className).not.toContain('max-h-80')
    expect(canvas.className).not.toContain('border')
    expect(canvas.className).not.toContain('rounded-md')
    expect(canvas.className).not.toContain('p-3')
    const graphFrame = within(canvas).getByTestId('loop-task-graph-frame')
    expect(graphFrame.className).toContain('h-full')
    expect(graphFrame.className).not.toContain('place-items-center')
    expect(graphFrame.className).not.toContain('mx-auto')
    expect(graphFrame.style.minHeight).toBe('100%')
    expect(graphFrame.style.minWidth).toBe('100%')
    expect(screen.queryByTestId('loop-canvas-overlay')).toBeNull()
    expect(within(canvas).queryByText('Root')).toBeNull()
    expect(within(canvas).queryByTestId('loop-graph-summary')).toBeNull()
    const rootGraphNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const activeGraphNode = within(canvas).getByTestId('loop-task-graph-node-t_running')
    const reviewGraphNode = within(canvas).getByTestId('loop-task-graph-node-t_review')
    const reviewFollowupGraphNode = within(canvas).getByTestId('loop-task-graph-node-t_review_followup')
    const rootReviewEdge = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_review')
    const reviewFollowupEdge = within(canvas).getByTestId('loop-task-graph-edge-t_review-t_review_followup')

    expect(rootGraphNode).toBeTruthy()
    expect(activeGraphNode).toBeTruthy()
    expect(reviewGraphNode).toBeTruthy()
    expect(reviewFollowupGraphNode).toBeTruthy()
    expect(Number.parseFloat(graphNodeFrame(rootGraphNode).style.top)).toBeLessThan(
      Number.parseFloat(graphNodeFrame(activeGraphNode).style.top)
    )
    expect(Number.parseFloat(graphNodeFrame(activeGraphNode).style.top)).toBe(
      Number.parseFloat(graphNodeFrame(reviewGraphNode).style.top)
    )
    expect(Number.parseFloat(graphNodeFrame(reviewGraphNode).style.top)).toBeLessThan(
      Number.parseFloat(graphNodeFrame(reviewFollowupGraphNode).style.top)
    )
    expect(rootReviewEdge.getAttribute('d')).toMatch(/[LC]/)
    expect(reviewFollowupEdge.getAttribute('d')).toMatch(/[LC]/)
    expect(rootReviewEdge.getAttribute('stroke-dasharray')).toBeNull()
    expect(reviewFollowupEdge.getAttribute('stroke-dasharray')).toBeNull()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_root-t_review_followup')).toBeNull()
    expect(canvas.className).not.toContain('radial-gradient')
    expect(within(canvas).getAllByText('reviewer-qa').length).toBeGreaterThan(0)
    expect(within(agentsCard).queryByTestId('loop-root-agents-list')).toBeNull()

    fireEvent.mouseEnter(rootGraphNode)
    const rootGraphActionTray = within(agentsCard).getByTestId('loop-task-graph-action-tray-t_root')
    expect(within(rootGraphActionTray).getByRole('button', { name: /^Block t_root$/i })).toBeTruthy()
    expect(within(rootGraphActionTray).getByRole('button', { name: /^Archive t_root$/i })).toBeTruthy()
    fireEvent.mouseLeave(rootGraphNode)

    const graphSurface = within(canvas).getByTestId('loop-task-graph-surface')
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -120 })
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1)
    expect(graphSurface.style.transform).toContain('scale(')
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 120 })
    expect(Number(canvas.getAttribute('data-zoom'))).toBeCloseTo(1, 1)

    expect(within(agentsCard).queryByRole('button', { name: 'Show agents list' })).toBeNull()
    expect(within(agentsCard).queryByTestId('loop-root-agents-list')).toBeNull()
    expect(screen.queryByText('Active/running children')).toBeNull()
    expect(screen.queryByText('Needs attention')).toBeNull()
    expect(screen.queryByText('Queued/pending')).toBeNull()
    expect(screen.queryByText('Completed/audit')).toBeNull()
    expect(screen.queryByText('Execution overview')).toBeNull()
    expect(screen.queryByTestId('loop-root-card')).toBeNull()
    expect(screen.queryByTestId('loop-root-actions')).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.queryByText('Root execution spec')).toBeNull()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()

    fireEvent.click(reviewGraphNode)
    expect(screen.getByRole('tab', { name: /Root Task/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByTestId('loop-task-tab-t_review')).toBeTruthy()
    const closeReviewTab = screen.getByRole('button', { name: /Close Review child/i })
    expect(closeReviewTab.className).toContain('pointer-events-auto')
    expect(closeReviewTab.className).toContain('opacity-100')
    expect(screen.queryByRole('heading', { name: /Review decision/i })).toBeNull()
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.queryByText('review-required: inspect proof')).toBeNull()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /escalate review/i })).toBeNull()
    expect(screen.queryByText(/Review decisions are unavailable/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Back to Loop overview/i })).toBeNull()

    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Root Task/i }))
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Root Task/i })).toBeNull()

    const reopenedAgentsCard = screen.getByTestId('loop-root-agents-card')
    fireEvent.click(within(reopenedAgentsCard).getByTestId('loop-task-graph-node-t_review'))

    fireEvent.click(screen.getByRole('button', { name: /Close Review child/i }))
    expect(screen.queryByRole('tab', { name: /Review child/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Root Task/i })).toBeNull()
  })

  it('centers the graph and projects the measured canvas viewport into the minimap', async () => {
    class MeasuredResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect() {}
      observe(target: Element) {
        this.callback(
          [
            {
              contentRect: { height: 360, width: 640 } as DOMRectReadOnly,
              target
            } as ResizeObserverEntry
          ],
          this as unknown as ResizeObserver
        )
      }
      unobserve() {}
    }

    vi.stubGlobal('ResizeObserver', MeasuredResizeObserver)

    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-fit-graph-canvas',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 420,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_step_1'],
          included_parent_ids: []
        },
        ...Array.from({ length: 6 }, (_, index) => {
          const step = index + 1

          return {
            id: `t_step_${step}`,
            title: `Implementation step ${step}`,
            status: 'done',
            tenant: 'tenant-a',
            included_child_ids: step < 6 ? [`t_step_${step + 1}`] : [],
            included_parent_ids: [step === 1 ? 't_root' : `t_step_${step - 1}`]
          }
        })
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')

    expect(screen.getByTestId('loop-root-agents-card').className).toContain('w-full')
    expect(canvas.className).toContain('w-full')

    await waitFor(() => expect(Number(canvas.getAttribute('data-zoom'))).toBeLessThan(1))

    const frame = within(canvas).getByTestId('loop-task-graph-frame')
    const surface = within(canvas).getByTestId('loop-task-graph-surface')

    expect(frame.style.width).toBe('100%')
    expect(frame.style.height).toBe('100%')
    expect(surface.style.left).toBe('0px')
    expect(surface.style.top).toBe('0px')
    expect(surface.style.transform).toContain('translate(')
    expect(surface.style.transform).toMatch(/scale\(0\./)

    const minimapViewport = within(canvas).getByTestId('loop-task-graph-minimap-viewport')
    const projectedViewportX = Number.parseFloat(minimapViewport.style.left)
    const projectedViewportWidth = Number.parseFloat(minimapViewport.style.width)
    const projectedViewportHeight = Number.parseFloat(minimapViewport.style.height)
    const graphWidth = Number.parseFloat(surface.style.width)
    const zoom = Number(canvas.getAttribute('data-zoom'))
    const viewX = Number(canvas.getAttribute('data-view-x'))

    expect(projectedViewportWidth / projectedViewportHeight).toBeCloseTo(640 / 360)

    fireEvent.wheel(canvas, { deltaX: viewX - (640 - (graphWidth * zoom) / 2), deltaY: 0 })

    const pannedViewportX = Number.parseFloat(minimapViewport.style.left)
    const pannedViewportWidth = Number.parseFloat(minimapViewport.style.width)
    const pannedViewportHeight = Number.parseFloat(minimapViewport.style.height)

    expect(pannedViewportX).not.toBe(projectedViewportX)
    expect(pannedViewportWidth).toBeLessThanOrEqual(projectedViewportWidth)
    expect(pannedViewportWidth / pannedViewportHeight).toBeCloseTo(640 / 360)
  })

  it('does not count approved durable handoffs as pending root orchestration work', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-approved-handoff-root',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 406,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Completed child with approved handoff',
          status: 'done',
          latest_summary: 'review-required: stale prior blocker already approved',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_root'],
          loop_handoffs: [
            {
              id: 12,
              root_task_id: 't_root',
              task_id: 't_child',
              handoff_kind: 'blocked_waiting',
              state: 'closed',
              resolved_at: 1782002717,
              verification_state: 'approved',
              verification_status: 'approved',
              summary: 'review approved and released'
            }
          ]
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    expect(screen.queryByTestId('loop-root-state-card')).toBeNull()
    expect(screen.queryByText('Loop is complete')).toBeNull()
    expect(screen.queryByText(/Waiting on worker handoff/i)).toBeNull()
    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    expect(within(canvas).getByTestId('loop-task-graph-node-t_child')).toBeTruthy()
  })

  it('highlights the focused graph dependency path and dims sibling branches', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-selected-path',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 410,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_active', 't_review'],
          included_parent_ids: []
        },
        {
          id: 't_active',
          title: 'Active sibling branch',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_review',
          title: 'Review child',
          status: 'blocked',
          tenant: 'tenant-a',
          latest_summary: 'review-required: inspect proof',
          included_child_ids: ['t_review_followup'],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_review_followup',
          title: 'Review follow-up',
          status: 'todo',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_review']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    let agentsCard = screen.getByTestId('loop-root-agents-card')
    let canvas = within(agentsCard).getByTestId('loop-task-graph')
    expect(within(canvas).queryByTestId('loop-graph-summary')).toBeNull()

    fireEvent.focus(within(canvas).getByTestId('loop-task-graph-node-t_review'))
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByTestId('loop-selected-node-actions')).toBeNull()
    expect(screen.queryByTestId('loop-task-card')).toBeNull()

    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const selectedNode = within(canvas).getByTestId('loop-task-graph-node-t_review')
    const downstreamNode = within(canvas).getByTestId('loop-task-graph-node-t_review_followup')
    const siblingNode = within(canvas).getByTestId('loop-task-graph-node-t_active')
    const selectedEdge = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_review')
    const downstreamEdge = within(canvas).getByTestId('loop-task-graph-edge-t_review-t_review_followup')
    const siblingEdge = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_active')

    expect(selectedNode.getAttribute('data-selected')).toBe('false')
    expect(rootNode.getAttribute('data-dimmed')).toBe('false')
    expect(downstreamNode.getAttribute('data-dimmed')).toBe('false')
    expect(siblingNode.getAttribute('data-dimmed')).toBe('true')
    expect(selectedEdge.getAttribute('data-dimmed')).toBe('false')
    expect(downstreamEdge.getAttribute('data-dimmed')).toBe('false')
    expect(siblingEdge.getAttribute('data-selected-connected')).toBe('false')
    expect(siblingEdge.getAttribute('data-dimmed')).toBe('true')

    fireEvent.focus(rootNode)
    const rootActionTray = within(agentsCard).getByTestId('loop-task-graph-action-tray-t_root')
    fireEvent.focus(within(rootActionTray).getByRole('button', { name: /^Block t_root$/i }))
    expect(within(agentsCard).getByTestId('loop-task-graph-action-tray-t_root')).toBeTruthy()
  })

  it('keeps parallel upstream Loop options as siblings in selected-task graph view', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-options',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 407,
      tasks: [
        {
          id: 't_minimal',
          title: 'RECOMMENDED: Minimal live worker activation/re-entry leaf',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_selected'],
          included_parent_ids: []
        },
        {
          id: 't_two_stage',
          title: 'Option: Two-stage worker plus reviewer-qa smoke leaf chain',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_selected'],
          included_parent_ids: []
        },
        {
          id: 't_ui_dry_run',
          title: 'Option: UI dry-run branch before any worker activation',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_selected'],
          included_parent_ids: []
        },
        {
          id: 't_selected',
          title: 'RECOMMENDED: End-to-end graph-first Loop smoke test',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_minimal', 't_two_stage', 't_ui_dry_run']
        },
        {
          id: 't_root',
          title: 'graph test',
          status: 'scheduled',
          tenant: 'tenant-a',
          assignee: 'default',
          included_child_ids: [],
          included_parent_ids: ['t_selected']
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const minimalNode = within(canvas).getByTestId('loop-task-graph-node-t_minimal')
    const twoStageNode = within(canvas).getByTestId('loop-task-graph-node-t_two_stage')
    const uiDryRunNode = within(canvas).getByTestId('loop-task-graph-node-t_ui_dry_run')
    const selectedNode = within(canvas).getByTestId('loop-task-graph-node-t_selected')
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')

    expect(Number.parseFloat(graphNodeFrame(minimalNode).style.top)).toBe(
      Number.parseFloat(graphNodeFrame(twoStageNode).style.top)
    )
    expect(Number.parseFloat(graphNodeFrame(minimalNode).style.top)).toBe(
      Number.parseFloat(graphNodeFrame(uiDryRunNode).style.top)
    )
    expect(Number.parseFloat(graphNodeFrame(selectedNode).style.top)).toBeGreaterThan(
      Number.parseFloat(graphNodeFrame(minimalNode).style.top)
    )
    expect(Number.parseFloat(graphNodeFrame(rootNode).style.top)).toBeGreaterThan(
      Number.parseFloat(graphNodeFrame(selectedNode).style.top)
    )
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_minimal-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_two_stage-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_ui_dry_run-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_selected-t_root')).toBeTruthy()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_minimal-t_two_stage')).toBeNull()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_minimal-t_ui_dry_run')).toBeNull()
  })

  it('shows nested sub-loop blockers in the root overview agents card', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-nested-agents',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 405,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: []
        },
        {
          id: 't_nested_loop',
          title: 'Nested sub-loop',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_root', 't_nested_blocker']
        },
        {
          id: 't_nested_blocker',
          title: 'Nested blocker worker',
          status: 'running',
          tenant: 'tenant-a',
          assignee: 'research-worker',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: []
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')

    expect(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_nested_loop')).toBeTruthy()
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_nested_blocker')).toBeTruthy()
  })

  it('uses detail navigation instead of hidden task tabs for embedded root and child agent rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-embedded-root-agents',
      tenant: 'tenant-a',
      latest_event_id: 405,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          body: 'Root execution spec',
          status: 'running',
          tenant: 'tenant-a',
          assignee: 'foreground',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Child Task',
          body: 'Child execution spec',
          status: 'blocked',
          tenant: 'tenant-a',
          assignee: 'peacock',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ]
    })

    render(<LoopPanel embedded open selectedTaskId="t_root" state={state} />)

    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()

    let rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    fireEvent.click(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_root'))

    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByTestId('loop-task-tab-t_root')).toBeNull()
    expect(screen.queryByTestId('loop-root-agents-card')).toBeNull()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()

    let backButton = screen.getByRole('button', { name: /Back to Loop overview/i })

    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)

    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()

    rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    fireEvent.click(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_child'))

    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByTestId('loop-task-tab-t_child')).toBeNull()
    expect(screen.getByRole('heading', { name: /Child Task/i })).toBeTruthy()

    backButton = screen.getByRole('button', { name: /Back to Loop overview/i })

    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)

    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Root Task/i })).toBeNull()
  })

  it('opens root overview graph nodes instead of removed agent list rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-root-agent-worker',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'running',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Child Worker',
          status: 'running',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ],
      workers: [
        {
          run_id: 9,
          task_id: 't_child',
          task_title: 'Child Worker',
          status: 'running',
          task_status: 'running',
          worker_session_id: 'worker-session-child'
        }
      ]
    })

    const onSelectTaskId = vi.fn()
    const onTaskAction = vi.fn()

    render(
      <LoopPanel
        embedded
        onSelectTaskId={onSelectTaskId}
        onTaskAction={onTaskAction}
        open
        selectedTaskId="t_root"
        state={state}
      />
    )

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')

    expect(within(rootAgentsCard).queryByRole('button', { name: /Show agents list/i })).toBeNull()

    fireEvent.click(within(rootAgentsCard).getByTestId('loop-task-graph-node-t_child'))

    expect(onTaskAction).not.toHaveBeenCalledWith('worker-session', expect.anything())
    expect(onSelectTaskId).toHaveBeenCalledWith('t_child')
  })

  it('opens worker sessions from related agent list rows before selecting the task', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-related-agent-worker',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_root',
          title: 'Root Worker',
          status: 'running',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Child Task',
          status: 'running',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ],
      workers: [
        {
          run_id: 10,
          task_id: 't_root',
          task_title: 'Root Worker',
          status: 'running',
          task_status: 'running',
          worker_session_id: 'worker-session-root'
        }
      ]
    })

    const onSelectTaskId = vi.fn()
    const onTaskAction = vi.fn()

    render(
      <LoopPanel
        onSelectTaskId={onSelectTaskId}
        onTaskAction={onTaskAction}
        open
        selectedTaskId="t_child"
        state={state}
      />
    )

    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalledWith('worker-session', expect.anything())
    expect(onSelectTaskId).not.toHaveBeenCalled()
  })

  it('keeps a decomposed draft root anchored as the root overview even when children block the root', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-decomposed-root',
      tenant: 'tenant-a',
      latest_event_id: 406,
      tasks: [
        {
          id: 't_child',
          title: 'Implementation child',
          status: 'ready',
          tenant: 'tenant-a',
          assignee: 'peacock',
          included_child_ids: ['t_root'],
          included_parent_ids: []
        },
        {
          id: 't_root',
          title: 'Original Loop root',
          body: 'Approved draft spec',
          status: 'todo',
          tenant: 'tenant-a',
          session_id: 'sess-decomposed-root',
          assignee: 'orchestrator',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    expect(state?.rootTaskId).toBe('t_root')

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    expect(screen.queryByRole('heading', { name: /Original Loop root/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', {
        name: /^Select Implementation child/i
      })
    ).toBeTruthy()
    expect(screen.queryByTestId('loop-root-card')).toBeNull()
    expect(screen.queryByTestId('loop-root-actions')).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.queryByText('Approved draft spec')).toBeNull()
  })

  it('keeps completed roots in overview mode and does not show review controls for non-review blockers', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-option-a-done-root',
      tenant: 'tenant-a',
      latest_event_id: 405,
      tasks: [
        {
          id: 't_root',
          title: 'Root Task',
          status: 'done',
          tenant: 'tenant-a',
          latest_summary: 'final evidence accepted',
          included_child_ids: ['t_blocked'],
          included_parent_ids: []
        },
        {
          id: 't_blocked',
          title: 'Credential blocker',
          status: 'blocked',
          tenant: 'tenant-a',
          latest_summary: 'blocked: missing private token',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    expect(screen.queryByRole('heading', { name: /Root Task/i })).toBeNull()
    expect(screen.queryByText('final evidence accepted')).toBeNull()
    expect(screen.getByText('Credential blocker')).toBeTruthy()

    const blockedGraphNode = screen.getByRole('button', { name: /^Select Credential blocker/i })
    fireEvent.click(blockedGraphNode)
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Credential blocker/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /escalate review/i })).toBeNull()
  })

  it('renders a single draft Loop row as task details and routes it through Triage', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-draft-root',
      root_task_id: 't_draft_root',
      tenant: 'tenant-a',
      latest_event_id: 500,
      tasks: [
        {
          id: 't_draft_root',
          title: 'Draft root with no children',
          body: 'Spec waiting for submit',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    const onTaskAction = vi.fn()

    render(<LoopPanel onTaskAction={onTaskAction} open state={state} />)

    expect(screen.getByRole('heading', { name: /Draft root with no children/i })).toBeTruthy()
    expect(screen.getByText('Spec waiting for submit')).toBeTruthy()
    expect(screen.queryByTestId('loop-root-agents-card')).toBeNull()
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.queryByTestId('loop-root-card')).toBeNull()

    const triage = screen.getByRole('button', { name: /Triage t_draft_root/i }) as HTMLButtonElement
    expect(triage.disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /Submit t_draft_root/i })).toBeNull()
    fireEvent.click(triage)
    expect(onTaskAction).toHaveBeenCalledWith('triage', expect.objectContaining({ taskId: 't_draft_root' }))
  })

  it('keeps submit clickable for a planned slash Loop draft', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-intake-root',
      root_task_id: 't_intake_root',
      tenant: 'tenant-a',
      latest_event_id: 505,
      tasks: [
        {
          id: 't_intake_root',
          title: 'Title-only intake root',
          body: 'Needs explicit submit approval',
          status: 'scheduled',
          tenant: 'tenant-a',
          loop_intake: {
            dispatchable: false,
            needed: true,
            source: 'slash_loop_draft',
            state: 'planned'
          },
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    const onTaskAction = vi.fn()

    render(<LoopPanel onTaskAction={onTaskAction} open state={state} />)

    const submit = screen.getByRole('button', { name: /Submit t_intake_root/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    expect(submit.title).toBe('Submit this planned task graph for Kanban execution.')
    expect(screen.queryByRole('button', { name: /Triage t_intake_root/i })).toBeNull()

    fireEvent.click(submit)
    expect(onTaskAction).toHaveBeenCalledWith('submit', expect.objectContaining({ taskId: 't_intake_root' }))
  })

  it('defaults the overview to the original root even after decomposition links children before the root', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-decomposed-default-root',
      root_task_id: 't_original_root',
      tenant: 'tenant-a',
      latest_event_id: 501,
      tasks: [
        {
          id: 't_child',
          title: 'Implementation child',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_original_root'],
          included_parent_ids: []
        },
        {
          id: 't_original_root',
          title: 'Original draft root',
          body: 'Living spec after approval',
          status: 'todo',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    render(<LoopPanel open state={state} />)

    expect(screen.queryByRole('heading', { name: /Original draft root/i })).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.queryByText('Living spec after approval')).toBeNull()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', {
        name: /^Select Implementation child/i
      })
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit t_original_root/i })).toBeNull()
    expect(screen.queryByTestId('loop-task-card')).toBeNull()
  })

  it('anchors the overview to the original root even after decomposition links children before the root', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-decomposed-root',
      root_task_id: 't_original_root',
      tenant: 'tenant-a',
      latest_event_id: 502,
      tasks: [
        {
          id: 't_child',
          title: 'Implementation child',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_original_root'],
          included_parent_ids: []
        },
        {
          id: 't_original_root',
          title: 'Original draft root',
          body: 'Living spec after approval',
          status: 'todo',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_original_root" state={state} />)

    expect(screen.queryByRole('heading', { name: /Original draft root/i })).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.queryByText('Living spec after approval')).toBeNull()
    expect(screen.queryByRole('button', { name: /Submit t_original_root/i })).toBeNull()
    expect(screen.queryByTestId('loop-task-card')).toBeNull()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', {
        name: /^Select Implementation child/i
      })
    ).toBeTruthy()

    const childGraphNode = within(screen.getByTestId('loop-root-agents-card')).getByTestId(
      'loop-task-graph-node-t_child'
    )

    fireEvent.click(childGraphNode)
    expect(screen.getByTestId('loop-task-tab-t_child')).toBeTruthy()
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Implementation child/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open details for t_child/i })).toBeNull()
  })

  it('renders worker activity links, run details, and log tails in the task drawer', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-workers',
      tenant: 'tenant-a',
      latest_event_id: 303,
      now: 1_000,
      tasks: [
        {
          id: 't_worker',
          title: 'Implement worker overlay',
          status: 'running',
          tenant: 'tenant-a',
          current_run_id: 42,
          included_child_ids: [],
          included_parent_ids: []
        }
      ],
      workers: [
        {
          run_id: 42,
          task_id: 't_worker',
          task_title: 'Implement worker overlay',
          profile: 'peacock',
          status: 'running',
          task_status: 'running',
          started_at: 900,
          last_heartbeat_at: 990,
          worker_pid: 12345,
          worker_session_id: 'worker-session-42',
          summary: 'building drawer links',
          log_tail_available: true,
          log_tail: 'last worker log line',
          recent_task_events: [{ id: 9, task_id: 't_worker', kind: 'heartbeat', created_at: 990, run_id: 42 }]
        }
      ]
    })

    const onTaskAction = vi.fn()
    render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_worker" state={state} />)

    const workerActivityHeading = screen.getByText('Worker activity')
    const workerActivityCard = workerActivityHeading.closest('section')
    expect(workerActivityHeading).toBeTruthy()
    expect(workerActivityCard?.className).toContain('min-w-0')
    expect(workerActivityCard?.className).toContain('max-w-full')
    expect(workerActivityCard?.className).toContain('overflow-hidden')
    expect(screen.getByText('Run #42')).toBeTruthy()
    expect(screen.getByText('running · peacock · pid 12345')).toBeTruthy()
    expect(screen.getByText('building drawer links')).toBeTruthy()
    const logTail = screen.getByText('last worker log line')
    expect(logTail).toBeTruthy()
    expect(logTail.className).toContain('min-w-0')
    expect(logTail.className).toContain('max-w-full')
    expect(screen.getByText('heartbeat')).toBeTruthy()

    // Buttons removed per user request: "Open worker session", "Inspect run", "Worker logs"
    expect(screen.queryByRole('button', { name: /open worker session/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /inspect worker run/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /open worker logs/i })).toBeNull()
  })

  it('omits artifact and source outputs from root overview and task details drawers', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-artifacts',
      tenant: 'tenant-a',
      latest_event_id: 304,
      tasks: [
        {
          id: 't_root',
          title: 'Artifact root',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_artifacts'],
          included_parent_ids: []
        },
        {
          id: 't_artifacts',
          title: 'Build artifact drawer',
          status: 'done',
          tenant: 'tenant-a',
          workspace_kind: 'worktree',
          workspace_path: '/worktrees/t_artifacts',
          included_child_ids: [],
          included_parent_ids: ['t_root'],
          latest_run: {
            id: 77,
            profile: 'peacock',
            status: 'done',
            summary: 'outputs ready',
            metadata: {
              artifacts: ['/tmp/loop-report.pdf', { label: 'Preview page', path: 'dist/preview.html' }],
              changed_files: [
                {
                  inline_diff: [
                    '--- a/src/app/chat/loop-panel.tsx',
                    '+++ b/src/app/chat/loop-panel.tsx',
                    '@@',
                    '-old',
                    '+new'
                  ].join('\n'),
                  path: 'src/app/chat/loop-panel.tsx'
                },
                { label: 'Fallback diff', path: 'src/app/chat/fallback.ts' }
              ]
            }
          }
        }
      ]
    })!

    const { rerender } = render(
      <LoopPanel artifactSourceBaseDir="/workspace/root" open selectedTaskId="t_artifacts" state={state} />
    )

    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByTestId('loop-artifact-sources-card')).toBeNull()
    expect(screen.queryByRole('heading', { name: /Artifacts \/ sources/i })).toBeNull()
    expect(screen.queryByText('loop-report.pdf')).toBeNull()
    expect(screen.queryByText('Preview page')).toBeNull()
    expect(screen.queryByText('loop-panel.tsx')).toBeNull()
    expect(screen.queryByText('Fallback diff')).toBeNull()

    rerender(<LoopPanel artifactSourceBaseDir="/workspace/root" open selectedTaskId="t_root" state={state} />)
    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    expect(rootAgentsCard).toBeTruthy()
    expect(screen.queryByTestId('loop-artifact-sources-card')).toBeNull()
    expect(screen.queryByRole('heading', { name: /Artifacts \/ sources/i })).toBeNull()
    expect(screen.queryByText('loop-report.pdf')).toBeNull()
    expect(screen.queryByText('Preview page')).toBeNull()
    expect(screen.queryByText('loop-panel.tsx')).toBeNull()
    expect(screen.queryByText('Fallback diff')).toBeNull()
  })

  it('renders debug JSON only when explicitly enabled for development diagnostics', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 3,
      root_task_id: 't_root',
      tasks: [{ current_run_id: 1, id: 't_child', status: 'triage', title: 'Build child' }]
    })

    render(<LoopPanel enableDebugJson open selectedTaskId="t_child" state={state} />)

    expect(screen.queryByText(/"tasks"/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show debug json/i }))
    expect(screen.getByText(/"tasks"/)).toBeTruthy()
  })

  it('resizes the pane shell with the separator keyboard controls', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 3,
      root_task_id: 't_root',
      tasks: [{ current_run_id: 1, id: 't_child', status: 'triage', title: 'Build child' }]
    })

    render(<LoopPanel open selectedTaskId="t_child" state={state} />)

    const panel = screen.getByTestId('loop-panel')
    const separator = screen.getByRole('separator', { name: /resize loop-panel/i })
    expect(panel.style.width).toBe('416px')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('432px')

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(panel.style.width).toBe('416px')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(panel.style.width).toBe('384px')
  })

  it('keeps Loop composer row titles compact and one-line while using available width', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-layout',
      tenant: 'tenant-a',
      latest_event_id: 100,
      tasks: [
        {
          id: 't_long',
          title: 'Fix session-source env fallback and add regression coverage without premature title truncation',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_blocked',
          title: 'Blocked foreground handoff title should reveal enough context before opening details',
          status: 'blocked',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    render(<LoopTaskStack onSelectTaskId={() => undefined} selectedTaskId="t_long" state={state} />)

    const selectedTitle = screen.getByText(
      'Fix session-source env fallback and add regression coverage without premature title truncation'
    )

    expect(selectedTitle.className).toContain('w-[18rem]')
    expect(selectedTitle.className).toContain('min-w-0')
    expect(selectedTitle.className).toContain('max-w-[18rem]')
    expect(selectedTitle.className).toContain('truncate')
    expect(selectedTitle.className).not.toContain('line-clamp-2')

    const blockedTitle = screen.getByText(
      'Blocked foreground handoff title should reveal enough context before opening details'
    )

    expect(blockedTitle.className).toContain('w-[18rem]')
    expect(blockedTitle.className).toContain('truncate')
    expect(blockedTitle.className).not.toContain('line-clamp-2')
  })

  it('uses the shared composer status row title sizing for ordinary Loop rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-compact-layout',
      tenant: 'tenant-a',
      latest_event_id: 101,
      tasks: [
        {
          id: 't_selected',
          title: 'Currently selected row may use two lines',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_ready',
          title: 'Ordinary ready row title stays compact but uses the whole row before ellipsis',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    render(<LoopTaskStack onSelectTaskId={() => undefined} selectedTaskId="t_selected" state={state} />)

    const title = screen.getByText('Ordinary ready row title stays compact but uses the whole row before ellipsis')
    expect(title.className).toContain('w-[18rem]')
    expect(title.className).toContain('truncate')
    expect(title.className).toContain('max-w-[18rem]')
    expect(title.className).not.toContain('line-clamp-2')
  })

  it('keeps the collapsed Loop handle compact when there are no actionable handoffs', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-no-attention',
      tenant: 'tenant-a',
      latest_event_id: 110,
      tasks: [
        {
          id: 't_ready',
          title: 'Ready implementation task',
          status: 'ready',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_running',
          title: 'Running implementation task',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_done',
          title: 'Completed implementation task',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    render(<LoopTaskStack onSelectTaskId={() => undefined} state={state} />)

    fireEvent.click(screen.getByRole('button', { name: /Loop 1\/3/i }))

    expect(screen.getByText('Loop 1/3')).toBeTruthy()
    expect(screen.queryByText(/need attention/i)).toBeNull()
    expect(screen.queryByTestId('loop-attention-queue')).toBeNull()
    expect(screen.queryByText('Ready implementation task')).toBeNull()
  })

  it('shows top collapsed handoffs by severity and opens the side panel without dispatching actions', () => {
    const state = collapsedAttentionState()
    const onTaskAction = vi.fn()

    function AttentionHarness() {
      const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
      const [panelOpen, setPanelOpen] = useState(false)

      function selectTask(taskId: string) {
        setSelectedTaskId(taskId)
        setPanelOpen(true)
      }

      return (
        <>
          <LoopTaskStack onSelectTaskId={selectTask} selectedTaskId={selectedTaskId} state={state} />
          {panelOpen && (
            <LoopPanel
              onSelectTaskId={selectTask}
              onTaskAction={onTaskAction}
              open={panelOpen}
              selectedTaskId={selectedTaskId}
              state={state}
            />
          )}
        </>
      )
    }

    render(<AttentionHarness />)

    fireEvent.click(screen.getByRole('button', { name: /Loop 1\/6/i }))

    expect(screen.getByText('4 need attention')).toBeTruthy()
    expect(screen.getByTestId('loop-attention-queue')).toBeTruthy()
    expect(screen.getByText('Blocked release gate')).toBeTruthy()
    expect(screen.getByText('Worker crashed while packaging')).toBeTruthy()
    expect(screen.getByText('Review handoff needs approval')).toBeTruthy()
    expect(screen.queryByText('Foreground handoff overflow row')).toBeNull()
    expect(screen.queryByText('Ordinary running task stays out of collapsed attention')).toBeNull()
    expect(screen.queryByText('Completed task stays out of collapsed attention')).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Status: blocked Blocked release gate/i }))

    expect(screen.getByTestId('loop-panel').getAttribute('data-state')).toBe('open')
    expect(screen.getByRole('heading', { name: /Blocked release gate/i })).toBeTruthy()
    expect(onTaskAction).not.toHaveBeenCalled()
  })

  it('renders rich task detail sections from tenant metadata and navigates dependency links', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-1',
      tenant: 'tenant-a',
      latest_event_id: 99,
      tasks: [
        {
          id: 't_parent',
          title: 'Design parent',
          status: 'done',
          assignee: 'planner',
          body: 'Parent body',
          result: 'parent result',
          latest_summary: 'parent complete',
          comment_count: 0,
          included_child_ids: ['t_child', 't_cousin'],
          included_parent_ids: [],
          workspace_kind: 'scratch',
          workspace_path: '/tmp/parent'
        },
        {
          id: 't_child',
          title: 'Build child',
          status: 'blocked',
          assignee: 'peacock',
          body: 'Implement the detail panel',
          result: 'child result',
          latest_summary: 'blocked on review',
          comment_count: 2,
          current_run_id: 42,
          included_child_ids: ['t_grandchild'],
          included_parent_ids: ['t_parent'],
          latest_run: { id: 42, profile: 'peacock', status: 'running', outcome: null, summary: 'worker running' },
          workspace_kind: 'worktree',
          workspace_path: '/worktrees/t_child'
        },
        {
          id: 't_grandchild',
          title: 'Review child',
          status: 'ready',
          assignee: 'reviewer-qa',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        },
        {
          id: 't_orphan',
          title: 'Loose task',
          status: 'ready',
          assignee: 'reviewer-qa',
          included_child_ids: [],
          included_parent_ids: []
        },
        {
          id: 't_cousin',
          title: 'Cousin task',
          status: 'ready',
          assignee: 'peacock',
          included_child_ids: [],
          included_parent_ids: ['t_parent']
        }
      ]
    })

    render(<LoopHarness state={state!} />)

    const orphanRow = screen.getByTestId('loop-card-t_orphan')
    expect(within(orphanRow).queryByText('Loop')).toBeNull()
    expect(within(orphanRow).queryByText(/1 task/i)).toBeNull()

    fireEvent.click(within(screen.getByTestId('loop-card-t_parent')).getByText('Design parent'))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph-node-t_child'))

    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.getByText('Implement the detail panel')).toBeTruthy()
    expect(screen.queryByText('Evidence / proof')).toBeNull()
    expect(screen.queryByText('Lineage/source')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocking' })).toBeNull()
    const taskCard = screen.getByTestId('loop-task-card')
    expect(within(taskCard).getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(within(taskCard).queryByText('t_child')).toBeNull()
    expect(within(taskCard).getByRole('button', { name: /unblock t_child/i })).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /ask in chat about t_child/i })).toBeTruthy()
    expect(within(taskCard).getByText('Ask in chat')).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /archive t_child/i })).toBeTruthy()
    expect(screen.queryByText('Header')).toBeNull()
    expect(screen.queryByText('Safe actions')).toBeNull()
    expect(screen.queryByText('Decomposed children/follow-ups')).toBeNull()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByText('Assignee: peacock')).toBeNull()
    expect(screen.queryByText('Workspace: worktree')).toBeNull()
    expect(screen.queryByText('/worktrees/t_child')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy id for t_child/i })).toBeNull()
    expect(screen.queryByText('Comments')).toBeNull()
    expect(screen.queryByText('Latest run')).toBeNull()
    expect(screen.queryByText('Result')).toBeNull()
    expect(screen.queryByText('Summary')).toBeNull()
    expect(screen.queryByText('Metadata')).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Design parent/i }))
    expect(screen.queryByRole('heading', { name: /Design parent/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByText('parent complete')).toBeNull()

    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph-node-t_child'))
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()

    fireEvent.click(within(screen.getByTestId('loop-card-t_orphan')).getByText('Loose task'))
    expect(screen.getByRole('heading', { name: /Loose task/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByText('Assignee: reviewer-qa')).toBeNull()
  }, 15_000)

  it('hides empty drawer cards for standalone completed Loop tasks', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-standalone-complete',
      tenant: 'tenant-a',
      latest_event_id: 610,
      tasks: [
        {
          id: 't_done',
          title: 'Standalone done task',
          status: 'done',
          tenant: 'tenant-a',
          body: 'Useful task description.',
          included_child_ids: [],
          included_parent_ids: [],
          loop_handoffs: [
            {
              id: 44,
              root_task_id: 't_done',
              task_id: 't_done',
              handoff_kind: 'worker_completed',
              intent: 'approve',
              target_actor: 'foreground',
              queue_state: 'resolved',
              state: 'closed',
              resolved_at: 1782002717,
              resolution_action: 'approve_release',
              resolved_by: 'reviewer-qa',
              verification_state: 'approved',
              verification_status: 'passed',
              summary: 'Already approved and released.'
            }
          ]
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_done" state={state} />)

    expect(screen.getByRole('heading', { name: /Standalone done task/i })).toBeTruthy()
    expect(screen.getByText('Useful task description.')).toBeTruthy()
    expect(screen.queryByTestId('loop-foreground-handoff-card')).toBeNull()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
  })

  it('uses fetched task detail when selecting a dependency that is not in the flat composer rows', () => {
    const state: LoopPanelState = {
      message: '',
      rawJson: '{}',
      revision: 1,
      rootTaskId: 'tenant-a',
      status: 'ready',
      rows: [
        {
          active: true,
          childCount: 0,
          children: [],
          commentCount: 0,
          depth: 0,
          parentCount: 1,
          parents: ['t_external'],
          status: 'running',
          taskId: 't_child',
          title: 'Build child'
        }
      ]
    }

    render(<DetailFetchHarness state={state} />)

    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByText('Blocked by · Task details unavailable')).toBeNull()
    expect(screen.queryByRole('heading', { name: /External parent/i })).toBeNull()
    expect(screen.queryByText(/Run #2 · running · new-worker/)).toBeNull()
    expect(screen.queryByText('oldest run')).toBeNull()
  })

  it('cleans task markdown without losing useful formatting', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-markdown',
      tenant: 'tenant-a',
      latest_event_id: 122,
      tasks: [
        {
          id: 't_markdown',
          title: 'Markdown body task',
          status: 'ready',
          body: [
            '---',
            'assignee: peacock',
            'current_run_id: 42',
            '---',
            '# Implementation notes',
            '',
            '- [x] preserve checklist',
            '- [ ] keep links like [docs](https://example.com)',
            '',
            'Use `inline code` safely.',
            '',
            '```ts',
            'const ok = true',
            '```',
            '',
            'metadata: {"debug": true}',
            'latest_run: should stay internal'
          ].join('\n'),
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    render(<LoopPanel open selectedTaskId="t_markdown" state={state} />)

    expect(screen.getByRole('heading', { name: 'Implementation notes' })).toBeTruthy()
    expect(screen.getByText('preserve checklist')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toMatch(/^https:\/\/example\.com\/?$/)
    expect(screen.getByText('inline code')).toBeTruthy()
    expect(screen.getByText('const ok = true')).toBeTruthy()
    expect(screen.queryByText(/assignee: peacock/)).toBeNull()
    expect(screen.queryByText(/current_run_id/)).toBeNull()
    expect(screen.queryByText(/metadata:/)).toBeNull()
    expect(screen.queryByText(/latest_run:/)).toBeNull()
  })

  it('shows graceful related-task states and drawer back navigation without changing task state', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-related-states',
      tenant: 'tenant-a',
      latest_event_id: 123,
      tasks: [
        {
          id: 't_parent',
          title: 'Available prerequisite',
          status: 'done',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        },
        {
          id: 't_child',
          title: 'Blocked implementation',
          status: 'blocked',
          external_parent_tasks: [{ id: 't_archived_external', title: 'Archived blocker', status: 'archived' }],
          included_child_ids: [],
          included_parent_ids: ['t_parent', 't_missing_external', 't_archived_external']
        }
      ]
    })

    const onTaskAction = vi.fn()

    render(<LoopHarness state={state!} />)

    fireEvent.click(within(screen.getByTestId('loop-card-t_parent')).getByText('Available prerequisite'))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph-node-t_child'))
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-task-agents-card')).toBeNull()
    expect(screen.queryByText('Blocked by · Task details unavailable')).toBeNull()
    expect(screen.queryByText('Blocked by · Archived')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Available prerequisite/i }))
    expect(screen.queryByRole('heading', { name: /Available prerequisite/i })).toBeNull()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByText('Parent tasks')).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalled()
  })

  it('offers one Triage action before planning and Submit afterward', () => {
    const source = {
      latest_event_id: 1,
      root_task_id: 't_intake',
      session_id: 'sess-intake-actions',
      tasks: [
        {
          body: null,
          id: 't_intake',
          loop_intake: {
            dispatchable: false,
            needed: true,
            source: 'slash_loop_draft',
            state: 'drafted'
          },
          status: 'scheduled',
          title: 'Rough Loop task'
        }
      ]
    }

    const onTaskAction = vi.fn()
    const state = deriveLoopPanelStateFromTenantSource(source)!

    const { rerender } = render(
      <LoopPanel
        onTaskAction={onTaskAction}
        open
        selectedTaskDetail={{ task: source.tasks[0] }}
        selectedTaskId="t_intake"
        state={state}
      />
    )

    const actions = screen.getByTestId('loop-task-actions')
    const triage = within(actions).getByRole('button', { name: /triage t_intake/i })

    expect(within(actions).queryByRole('button', { name: /submit t_intake/i })).toBeNull()
    expect(within(actions).queryByRole('button', { name: /specify t_intake/i })).toBeNull()
    expect(within(actions).queryByRole('button', { name: /decompose t_intake/i })).toBeNull()

    fireEvent.click(triage)
    expect(onTaskAction).toHaveBeenCalledWith('triage', expect.objectContaining({ taskId: 't_intake' }))

    rerender(
      <LoopPanel
        onTaskAction={onTaskAction}
        open
        selectedTaskId="t_intake"
        state={deriveLoopPanelStateFromTenantSource({
          ...source,
          tasks: [
            {
              ...source.tasks[0],
              body: '**Objective**\n\nImplement the rough task.',
              loop_intake: { ...source.tasks[0].loop_intake, state: 'planned' }
            }
          ]
        })}
      />
    )

    expect(screen.queryByRole('button', { name: /triage t_intake/i })).toBeNull()
    expect(screen.getByRole('button', { name: /submit t_intake/i })).toBeTruthy()
  })

  it('does not mistake a legacy non-dispatchable approval for a planned task', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 1,
      root_task_id: 't_legacy_hold',
      session_id: 'sess-legacy-hold',
      tasks: [
        {
          body: '**Objective**\n\nSpecified but never planned.',
          id: 't_legacy_hold',
          loop_intake: {
            dispatchable: false,
            needed: true,
            source: 'desktop_submit',
            state: 'approved'
          },
          status: 'scheduled',
          title: 'Legacy held task'
        }
      ]
    })!

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_legacy_hold" state={state} />)

    expect(screen.getByRole('button', { name: /triage t_legacy_hold/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /submit t_legacy_hold/i })).toBeNull()
  })

  it('exposes standalone draft submit and focused task action utilities', () => {
    const state = actionState()
    const onTaskAction = vi.fn()

    const { rerender } = render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_triage" state={state} />)

    expect(onTaskAction).not.toHaveBeenCalled()
    const taskCard = screen.getByTestId('loop-task-card')
    const taskActions = screen.getByTestId('loop-task-actions')
    expect(within(taskCard).getByTestId('loop-task-actions')).toBe(taskActions)
    expect(within(taskCard).queryByText('t_triage')).toBeNull()
    expect(screen.queryByTestId('loop-root-card')).toBeNull()
    expect(screen.queryByTestId('loop-root-spec')).toBeNull()
    expect(screen.getByRole('heading', { name: /Description/i })).toBeTruthy()
    expect(screen.queryByText('Loop spec')).toBeNull()
    expect(screen.getByText('Draft Loop spec')).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /triage t_triage/i })).toBeTruthy()
    expect(within(taskActions).queryByRole('button', { name: /submit t_triage/i })).toBeNull()
    expect(within(taskActions).getByRole('button', { name: /^block t_triage$/i })).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /archive t_triage/i })).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /ask in chat about t_triage/i })).toBeTruthy()
    expect(within(taskActions).queryByRole('button', { name: /copy id for t_triage/i })).toBeNull()
    expect(within(taskActions).queryByRole('button', { name: /open source task\/details for t_triage/i })).toBeNull()
    expect(within(taskActions).queryByRole('button', { name: /refresh details for t_triage/i })).toBeNull()
    const drawerText = document.body.textContent || ''
    expect(drawerText.indexOf('Triage')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(drawerText.indexOf('Description')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(screen.queryByRole('heading', { name: /Quick actions/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /start t_triage/i })).toBeNull()

    fireEvent.click(within(taskActions).getByRole('button', { name: /triage t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('triage', expect.objectContaining({ taskId: 't_triage' }))
    fireEvent.click(within(taskActions).getByRole('button', { name: /archive t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('archive', expect.objectContaining({ taskId: 't_triage' }))
    fireEvent.click(within(taskActions).getByRole('button', { name: /ask in chat about t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('ask-hermes', expect.objectContaining({ taskId: 't_triage' }))

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_blocked" state={state} />)
    expect(screen.queryByTestId('loop-root-actions')).toBeNull()
    const blockedTaskActions = screen.getByTestId('loop-task-actions')
    expect(within(blockedTaskActions).getByRole('button', { name: /unblock t_blocked/i })).toBeTruthy()
    expect(within(blockedTaskActions).getByRole('button', { name: /ask in chat about t_blocked/i })).toBeTruthy()
    expect(within(blockedTaskActions).getByRole('button', { name: /archive t_blocked/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /park t_blocked/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Block t_blocked$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /triage t_blocked/i })).toBeNull()

    fireEvent.click(within(blockedTaskActions).getByRole('button', { name: /unblock t_blocked/i }))
    expect(onTaskAction).toHaveBeenCalledWith('unblock', expect.objectContaining({ taskId: 't_blocked' }))
    fireEvent.click(within(blockedTaskActions).getByRole('button', { name: /ask in chat about t_blocked/i }))
    expect(onTaskAction).toHaveBeenCalledWith('ask-hermes', expect.objectContaining({ taskId: 't_blocked' }))
    fireEvent.click(within(blockedTaskActions).getByRole('button', { name: /archive t_blocked/i }))
    expect(onTaskAction).toHaveBeenCalledWith('archive', expect.objectContaining({ taskId: 't_blocked' }))

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_todo" state={state} />)
    const readyTaskActions = screen.getByTestId('loop-task-actions')
    expect(within(readyTaskActions).getByRole('button', { name: /^block t_todo$/i })).toBeTruthy()
    expect(within(readyTaskActions).getByRole('button', { name: /ask in chat about t_todo/i })).toBeTruthy()
    expect(within(readyTaskActions).getByRole('button', { name: /archive t_todo/i })).toBeTruthy()
    expect(within(readyTaskActions).queryByRole('button', { name: /unblock t_todo/i })).toBeNull()

    fireEvent.click(within(readyTaskActions).getByRole('button', { name: /^block t_todo$/i }))
    expect(onTaskAction).toHaveBeenCalledWith('block', expect.objectContaining({ taskId: 't_todo' }))
  }, 15_000)

  it('navigates the full Loop canvas from the keyboard and minimap', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const minimap = within(canvas).getByRole('button', { name: /Navigate Loop graph minimap/i })

    fireEvent.keyDown(canvas, { key: '+' })
    expect(canvas.getAttribute('data-zoom')).toBe('1.20')

    fireEvent.keyDown(canvas, { key: '-' })
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')

    fireEvent.wheel(canvas, { deltaX: 28, deltaY: 16 })
    expect(canvas.getAttribute('data-view-x')).toBe('-28')
    expect(canvas.getAttribute('data-view-y')).toBe('-16')

    fireEvent.keyDown(canvas, { key: '0' })
    expect(canvas.getAttribute('data-view-x')).toBe('0')
    expect(canvas.getAttribute('data-view-y')).toBe('0')
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')

    fireEvent.pointerDown(minimap, { clientX: 100, clientY: 60, pointerId: 7 })
    expect(canvas.getAttribute('data-view-x')).not.toBe('0')
    expect(canvas.getAttribute('data-view-y')).not.toBe('0')
  })

  it('shows the assignee pill instead of a redundant status pill on rich nodes', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    expect(todoNode.getAttribute('data-task-kind')).toBe('task')
    expect(within(todoNode).queryByText('Todo')).toBeNull()
    expect(within(todoNode).getByText('peacock').className).toContain('rounded-[0.2rem]')
    expect(within(todoNode).getByLabelText('1 dependency')).toBeTruthy()
    expect(within(todoNode).getByLabelText('2 comments')).toBeTruthy()
  })

  it('lays out prerequisites before the original closure task regardless of source order', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-decomposed-root-order',
      root_task_id: 't_closure',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_closure',
          title: 'Original task closes after decomposition',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_followup'],
          included_parent_ids: ['t_prerequisite']
        },
        {
          id: 't_followup',
          title: 'Follow-up',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_closure']
        },
        {
          id: 't_prerequisite',
          title: 'Decomposed prerequisite',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_closure'],
          included_parent_ids: []
        }
      ]
    })!

    render(<LoopTaskGraph fullPanel rows={state.rows.map(row => ({ ...row, depth: 0 }))} />)

    const canvas = screen.getByRole('region', { name: 'Loop graph canvas' })
    const prerequisite = within(canvas).getByTestId('loop-task-graph-node-t_prerequisite')
    const closure = within(canvas).getByTestId('loop-task-graph-node-t_closure')
    const followup = within(canvas).getByTestId('loop-task-graph-node-t_followup')
    const top = (node: HTMLElement) => Number.parseFloat(graphNodeFrame(node).style.top)

    expect(top(prerequisite)).toBeLessThan(top(closure))
    expect(top(closure)).toBeLessThan(top(followup))
    expect(prerequisite.getAttribute('data-task-kind')).toBe('task')
    expect(closure.getAttribute('data-task-kind')).toBe('task')
    expect(followup.getAttribute('data-task-kind')).toBe('task')
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_prerequisite-t_closure')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_closure-t_followup')).toBeTruthy()
  })

  it('orders dependency layers and separates fan-out and fan-in connector ports', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-routed-ports',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 408,
      tasks: [
        {
          id: 't_root',
          title: 'Root',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_left_parent', 't_right_parent'],
          included_parent_ids: []
        },
        {
          id: 't_left_parent',
          title: 'Left parent',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_left_leaf', 't_join'],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_right_parent',
          title: 'Right parent',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_right_leaf', 't_join'],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_right_leaf',
          title: 'Right leaf supplied first',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_right_parent']
        },
        {
          id: 't_left_leaf',
          title: 'Left leaf supplied second',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_left_parent']
        },
        {
          id: 't_join',
          title: 'Join',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_left_parent', 't_right_parent']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const leftParent = within(canvas).getByTestId('loop-task-graph-node-t_left_parent')
    const rightParent = within(canvas).getByTestId('loop-task-graph-node-t_right_parent')
    const leftLeaf = within(canvas).getByTestId('loop-task-graph-node-t_left_leaf')
    const rightLeaf = within(canvas).getByTestId('loop-task-graph-node-t_right_leaf')
    const rootLeft = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_left_parent')
    const rootRight = within(canvas).getByTestId('loop-task-graph-edge-t_root-t_right_parent')
    const leftJoin = within(canvas).getByTestId('loop-task-graph-edge-t_left_parent-t_join')
    const rightJoin = within(canvas).getByTestId('loop-task-graph-edge-t_right_parent-t_join')

    const pathNumbers = (path: Element) =>
      path
        .getAttribute('d')!
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number)

    const leftParentX = Number.parseFloat(graphNodeFrame(leftParent).style.left)
    const rightParentX = Number.parseFloat(graphNodeFrame(rightParent).style.left)
    const leftLeafX = Number.parseFloat(graphNodeFrame(leftLeaf).style.left)
    const rightLeafX = Number.parseFloat(graphNodeFrame(rightLeaf).style.left)
    const rootLeftPath = pathNumbers(rootLeft)
    const rootRightPath = pathNumbers(rootRight)
    const leftJoinPath = pathNumbers(leftJoin)
    const rightJoinPath = pathNumbers(rightJoin)

    expect(within(leftParent).getByLabelText('3 dependencies')).toBeTruthy()
    expect((leftParentX - rightParentX) * (leftLeafX - rightLeafX)).toBeGreaterThan(0)
    expect((rootLeftPath[0]! - rootRightPath[0]!) * (leftParentX - rightParentX)).toBeGreaterThan(0)
    expect((leftJoinPath.at(-2)! - rightJoinPath.at(-2)!) * (leftParentX - rightParentX)).toBeGreaterThan(0)
    expect(rootLeft.getAttribute('d')).toMatch(/[LQ]/)
    expect(leftJoin.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  })

  it('places each direct prerequisite beside the deepest branch before a join', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-direct-prerequisites',
      root_task_id: 't_start',
      tenant: 'tenant-a',
      latest_event_id: 409,
      tasks: [
        {
          id: 't_start',
          title: 'Start',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_deep_parent'],
          included_parent_ids: []
        },
        {
          id: 't_deep_parent',
          title: 'Deep prerequisite',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_join'],
          included_parent_ids: ['t_start']
        },
        {
          id: 't_direct_parent',
          title: 'Direct prerequisite',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_join'],
          included_parent_ids: []
        },
        {
          id: 't_join',
          title: 'Join',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_deep_parent', 't_direct_parent']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_start" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const startNode = within(canvas).getByTestId('loop-task-graph-node-t_start')
    const deepParentNode = within(canvas).getByTestId('loop-task-graph-node-t_deep_parent')
    const directParentNode = within(canvas).getByTestId('loop-task-graph-node-t_direct_parent')
    const joinNode = within(canvas).getByTestId('loop-task-graph-node-t_join')
    const directEdge = within(canvas).getByTestId('loop-task-graph-edge-t_direct_parent-t_join')
    const top = (node: HTMLElement) => Number.parseFloat(graphNodeFrame(node).style.top)

    expect(top(startNode)).toBeLessThan(top(deepParentNode))
    expect(top(directParentNode)).toBe(top(deepParentNode))
    expect(top(deepParentNode)).toBeLessThan(top(joinNode))
    expect(directEdge.getAttribute('d')).toMatch(/[LQ]/)
    expect(directEdge.getAttribute('d')).not.toContain('C')
    expect(directEdge.getAttribute('data-route-rail')).toBeNull()
  })

  it('keeps missing or archived selections sticky instead of silently selecting another row', () => {
    const state = actionState()
    const onTaskAction = vi.fn()
    const { rerender } = render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_missing" state={state} />)

    expect(screen.getByText('Selected task unavailable')).toBeTruthy()
    expect(screen.getByText(/t_missing/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Needs decomposition/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /decompose t_missing/i })).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalled()

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_archived" state={state} />)
    expect(screen.getByRole('heading', { name: /Archived task/i })).toBeTruthy()
    expect(screen.queryByText('Tenant: tenant-a')).toBeNull()
    expect(screen.queryByRole('button', { name: /block t_archived/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_archived/i })).toBeNull()
  })
})
