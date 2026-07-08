import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { LoopPanel, LoopTaskStack } from './loop-panel'
import { deriveLoopPanelState, deriveLoopPanelStateFromTenantSource, type LoopPanelState } from './loop-state'

vi.mock('./right-rail/preview-file', () => ({
  LocalFilePreview: ({ target }: { target: { path?: string; url: string } }) => (
    <div data-testid="loop-local-preview">{target.path || target.url}</div>
  )
}))

const toolMessage = (
  result: unknown,
  args: Record<string, unknown> = { action: 'read', root_task_id: 't_root' }
): ChatMessage => ({
  id: `msg-${Math.random()}`,
  role: 'assistant',
  parts: [
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'loop_graph',
      args: args as never,
      result,
      isError: false
    } as never
  ]
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

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
            branch_kind: 'alternative',
            decision_group_id: 'external-choice',
            selection_state: 'chosen',
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
        included_child_ids: ['t_todo', 't_blocked'],
        included_parent_ids: []
      },
      {
        id: 't_todo',
        title: 'Todo child',
        body: 'Ready to route from the graph tray',
        status: 'todo',
        tenant: 'tenant-a',
        assignee: 'peacock',
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

  it('renders the latest triage-backed graph rows in dependency-derived order', () => {
    const state = deriveLoopPanelState([
      toolMessage({
        ok: true,
        root_task_id: 't_root',
        graph_revision: 12,
        nodes: [
          { task_id: 't_parent', title: 'Parent task', status: 'triage', parents: [], depth: 0, frontier: true },
          { task_id: 't_peer', title: 'Peer task', status: 'triage', parents: [], depth: 0 },
          { task_id: 't_child', title: 'Child task', status: 'triage', parents: ['t_parent'], depth: 1, active: true }
        ]
      })
    ])

    expect(state?.revision).toBe(12)
    expect(state?.rows.map(row => row.taskId)).toEqual(['t_parent', 't_peer', 't_child'])
    expect(state?.rows.map(row => row.depth)).toEqual([0, 0, 1])
  })

  it('keeps stale/error tool results visible without adopting giant JSON as rows', () => {
    const state = deriveLoopPanelState([
      toolMessage({ ok: true, root_task_id: 't_root', graph_revision: 7, nodes: [] }),
      toolMessage({
        ok: false,
        error: 'stale_revision',
        message: 'expected revision 7, current revision is 8',
        current_revision: 8
      })
    ])

    expect(state?.status).toBe('stale')
    expect(state?.revision).toBe(7)
    expect(state?.message).toContain('current revision is 8')
    expect(state?.rawJson).toContain('stale_revision')
  })
})

describe('LoopPanel', () => {
  it('renders dependency groups, opens the Loop overview on click, and omits raw JSON/debug affordances in normal view', () => {
    const state = deriveLoopPanelState([
      toolMessage({
        ok: true,
        root_task_id: 't_root',
        graph_revision: 3,
        nodes: [
          { task_id: 't_parent', title: 'Design parent', status: 'triage', parents: [], depth: 0, frontier: true },
          { task_id: 't_child', title: 'Build child', status: 'triage', parents: ['t_parent'], depth: 1, active: true }
        ]
      })
    ])

    render(<LoopHarness state={state!} />)

    expect(screen.getByText('Loop 0/2')).toBeTruthy()
    expect(screen.getAllByText('Design parent').length).toBeGreaterThan(0)
    const dependencyRow = screen.getByTestId('loop-card-t_parent')
    expect(screen.queryByTestId('loop-card-t_child')).toBeNull()
    expect(within(dependencyRow).queryByText('Loop')).toBeNull()
    expect(within(dependencyRow).getByText(/2 tasks/i)).toBeTruthy()
    expect(screen.queryByText(/triage/i)).toBeNull()
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.queryByText('frontier')).toBeNull()
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
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const startX = Number(canvas.getAttribute('data-view-x'))
    const startY = Number(canvas.getAttribute('data-view-y'))
    const startNodeLeft = rootNode.style.left

    expect(within(toolbar).queryByRole('button', { name: 'Reader' })).toBeNull()
    expect(within(toolbar).getByRole('button', { name: 'Zoom out' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Zoom to 100%' }).textContent).toBe('100%')
    expect(within(toolbar).getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: 'Frame everything · F' })).toBeTruthy()
    expect(within(toolbar).queryByRole('button', { name: 'Tidy up layout · T' })).toBeNull()

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Zoom in' }))
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Zoom to 100%' }))
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')

    fireEvent.wheel(canvas, { deltaX: 10, deltaY: 20 })

    expect(Number(canvas.getAttribute('data-view-x'))).toBe(startX - 10)
    expect(Number(canvas.getAttribute('data-view-y'))).toBe(startY - 20)
    expect(rootNode.style.left).toBe(startNodeLeft)

    rerender(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)
    expect(Number(canvas.getAttribute('data-view-x'))).toBe(startX - 10)
    expect(Number(canvas.getAttribute('data-view-y'))).toBe(startY - 20)

    fireEvent.wheel(canvas, { clientX: 80, clientY: 80, ctrlKey: true, deltaY: -30 })

    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1)

    rerender(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1)

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
    expect(within(hoverTray).getByRole('button', { name: /Ask in chat about t_todo/i })).toBeTruthy()
    expect(within(hoverTray).getByRole('button', { name: /^Block t_todo$/i })).toBeTruthy()

    fireEvent.mouseLeave(todoNode)
    expect(within(rootAgentsCard).queryByTestId('loop-task-graph-action-tray-t_todo')).toBeNull()

    fireEvent.focus(todoNode)

    const focusTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    expect(within(focusTray).getByRole('button', { name: /Ask in chat about t_todo/i })).toBeTruthy()
    expect(within(focusTray).getByRole('button', { name: /^Block t_todo$/i })).toBeTruthy()
  })

  it('keeps top graph quick action trays overlapping the node hover corridor', () => {
    const state = quickActionGraphState()

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const rootNode = within(canvas).getByTestId('loop-task-graph-node-t_root')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')

    fireEvent.mouseEnter(rootNode)
    const rootTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_root')
    const rootNodeBottom = Number.parseFloat(rootNode.style.top) + Number.parseFloat(rootNode.style.height)
    const rootTrayTop = Number.parseFloat(rootTray.style.top)
    expect(rootTrayTop).toBeLessThanOrEqual(rootNodeBottom)

    fireEvent.mouseLeave(rootNode, { relatedTarget: rootTray })
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_root')).toBeTruthy()

    fireEvent.mouseLeave(rootTray)
    expect(within(rootAgentsCard).queryByTestId('loop-task-graph-action-tray-t_root')).toBeNull()

    fireEvent.mouseEnter(todoNode)
    const todoTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    expect(Number.parseFloat(todoTray.style.top)).toBeLessThanOrEqual(Number.parseFloat(todoNode.style.top))
    fireEvent.mouseLeave(todoNode, { relatedTarget: todoTray })
    expect(within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')).toBeTruthy()
  })

  it('routes graph quick actions with row data and status-aware block/unblock', () => {
    const state = quickActionGraphState()
    const onTaskAction = vi.fn()

    render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_root" state={state} />)

    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const canvas = within(rootAgentsCard).getByTestId('loop-task-graph')
    const todoNode = within(canvas).getByTestId('loop-task-graph-node-t_todo')
    const blockedNode = within(canvas).getByTestId('loop-task-graph-node-t_blocked')

    fireEvent.mouseEnter(todoNode)

    const todoTray = within(rootAgentsCard).getByTestId('loop-task-graph-action-tray-t_todo')
    fireEvent.click(within(todoTray).getByRole('button', { name: /Ask in chat about t_todo/i }))
    expect(onTaskAction).toHaveBeenCalledWith(
      'ask-hermes',
      expect.objectContaining({
        parents: expect.arrayContaining(['t_root']),
        status: 'todo',
        taskId: 't_todo',
        title: 'Todo child'
      })
    )

    fireEvent.click(within(todoTray).getByRole('button', { name: /^Block t_todo$/i }))
    expect(onTaskAction).toHaveBeenCalledWith('block', expect.objectContaining({ taskId: 't_todo' }))

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
    expect(
      (within(tray).getByRole('button', { name: /Ask in chat about t_blocked/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((within(tray).getByRole('button', { name: /^Unblock t_blocked$/i }) as HTMLButtonElement).disabled).toBe(
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
    expect(Number.parseFloat(rootGraphNode.style.top)).toBeLessThan(Number.parseFloat(activeGraphNode.style.top))
    expect(Number.parseFloat(activeGraphNode.style.top)).toBe(Number.parseFloat(reviewGraphNode.style.top))
    expect(Number.parseFloat(reviewGraphNode.style.top)).toBeLessThan(
      Number.parseFloat(reviewFollowupGraphNode.style.top)
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
    expect(within(rootGraphActionTray).getByRole('button', { name: /Ask in chat about t_root/i })).toBeTruthy()
    expect(within(rootGraphActionTray).getByRole('button', { name: /^Block t_root$/i })).toBeTruthy()
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

  it('centers and fits the graph surface inside the measured full canvas viewport', async () => {
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
    fireEvent.focus(within(rootActionTray).getByRole('button', { name: /Ask in chat about t_root/i }))
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

    expect(Number.parseFloat(minimalNode.style.top)).toBe(Number.parseFloat(twoStageNode.style.top))
    expect(Number.parseFloat(minimalNode.style.top)).toBe(Number.parseFloat(uiDryRunNode.style.top))
    expect(Number.parseFloat(selectedNode.style.top)).toBeGreaterThan(Number.parseFloat(minimalNode.style.top))
    expect(Number.parseFloat(rootNode.style.top)).toBeGreaterThan(Number.parseFloat(selectedNode.style.top))
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_minimal-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_two_stage-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_ui_dry_run-t_selected')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_selected-t_root')).toBeTruthy()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_minimal-t_two_stage')).toBeNull()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_minimal-t_ui_dry_run')).toBeNull()
  })

  it('renders unconfirmed decision-option edges as dotted and confirmed choices as solid', () => {
    const candidateState = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-decision-options',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 408,
      tasks: [
        {
          id: 't_option_a',
          title: 'Option A',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'candidate',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_option_b',
          title: 'Option B',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'candidate',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_option_a', 't_option_b']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })

    const { rerender } = render(<LoopPanel open selectedTaskId="t_root" state={candidateState} />)

    let canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    expect(
      within(canvas).getByTestId('loop-task-graph-edge-t_option_a-t_anchor').getAttribute('stroke-dasharray')
    ).toBe('0.5 8')
    expect(
      within(canvas).getByTestId('loop-task-graph-edge-t_option_b-t_anchor').getAttribute('stroke-dasharray')
    ).toBe('0.5 8')
    expect(within(canvas).getByTestId('loop-task-graph-edge-t_option_a-t_anchor').getAttribute('stroke-width')).toBe(
      '2'
    )
    expect(
      within(canvas).getByTestId('loop-task-graph-edge-t_anchor-t_root').getAttribute('stroke-dasharray')
    ).toBeNull()

    const confirmedState = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-decision-options',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 409,
      tasks: [
        {
          id: 't_option_a',
          title: 'Option A',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'chosen',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_option_a']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })

    rerender(<LoopPanel open selectedTaskId="t_root" state={confirmedState} />)

    canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    expect(
      within(canvas).getByTestId('loop-task-graph-edge-t_option_a-t_anchor').getAttribute('stroke-dasharray')
    ).toBeNull()
    expect(within(canvas).queryByTestId('loop-task-graph-edge-t_option_b-t_anchor')).toBeNull()
  })

  it('renders grouped decision alternatives with choose-one chrome and state pills', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-choice-groups',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 410,
      tasks: [
        {
          id: 't_candidate',
          title: 'Candidate option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'candidate',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_recommended',
          title: 'Recommended option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'recommended',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_chosen',
          title: 'Chosen option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'chosen',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_rejected',
          title: 'Rejected option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'rejected',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_candidate', 't_recommended', 't_chosen', 't_rejected']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    const group = within(canvas).getByTestId('loop-task-graph-choice-group-choice-1')
    expect(within(group).getByText('Choose one')).toBeTruthy()
    expect(group.getAttribute('title')).toBe('One option in this group should be selected')

    const candidate = within(canvas).getByTestId('loop-task-graph-node-t_candidate')
    expect(candidate.getAttribute('data-choice-state')).toBe('candidate')
    expect(candidate.getAttribute('data-decision-group-id')).toBe('choice-1')
    expect(candidate.getAttribute('aria-label')).toContain('Candidate option in decision group choice-1')
    expect(within(candidate).getByText('Candidate')).toBeTruthy()

    const recommended = within(canvas).getByTestId('loop-task-graph-node-t_recommended')
    expect(recommended.getAttribute('data-choice-state')).toBe('recommended')
    expect(within(recommended).getByText('Recommended')).toBeTruthy()

    const chosen = within(canvas).getByTestId('loop-task-graph-node-t_chosen')
    expect(chosen.getAttribute('data-choice-state')).toBe('chosen')
    expect(within(chosen).getByText('Chosen')).toBeTruthy()

    const rejected = within(canvas).getByTestId('loop-task-graph-node-t_rejected')
    expect(rejected.getAttribute('data-choice-state')).toBe('rejected')
    expect(within(rejected).getByText('Rejected')).toBeTruthy()
  })

  it('falls back cleanly when decision metadata is incomplete', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-choice-fallback',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 411,
      tasks: [
        {
          id: 't_no_group',
          title: 'Alternative without group',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          selection_state: 'rejected',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_no_branch',
          title: 'Grouped but not alternative',
          status: 'scheduled',
          tenant: 'tenant-a',
          decision_group_id: 'choice-2',
          selection_state: 'candidate',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_no_group', 't_no_branch']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    expect(within(canvas).queryByText('Choose one')).toBeNull()

    const noGroup = within(canvas).getByTestId('loop-task-graph-node-t_no_group')
    expect(noGroup.getAttribute('data-choice-state')).toBe('rejected')
    expect(noGroup.getAttribute('data-decision-group-id')).toBeNull()
    expect(within(noGroup).getByText('Rejected')).toBeTruthy()

    const noBranch = within(canvas).getByTestId('loop-task-graph-node-t_no_branch')
    expect(noBranch.getAttribute('data-choice-state')).toBeNull()
    expect(within(noBranch).queryByText('Candidate')).toBeNull()
  })

  it('treats a grouped alternative without selection state as a candidate option', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-single-choice',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 411,
      tasks: [
        {
          id: 't_single_option',
          title: 'Only visible option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-3',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_single_option']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })!

    render(<LoopPanel open selectedTaskId="t_root" state={state} />)

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    expect(within(canvas).getByTestId('loop-task-graph-choice-group-choice-3')).toBeTruthy()

    const option = within(canvas).getByTestId('loop-task-graph-node-t_single_option')
    expect(option.getAttribute('data-choice-state')).toBe('candidate')
    expect(within(option).getByText('Candidate')).toBeTruthy()
  })

  it('renders and selects decision alternatives without dispatching work', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-graph-choice-no-dispatch',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 412,
      tasks: [
        {
          id: 't_candidate',
          title: 'Candidate option',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-4',
          selection_state: 'candidate',
          included_child_ids: ['t_anchor'],
          included_parent_ids: []
        },
        {
          id: 't_anchor',
          title: 'Decision anchor',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: ['t_root'],
          included_parent_ids: ['t_candidate']
        },
        {
          id: 't_root',
          title: 'Root task',
          status: 'scheduled',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: ['t_anchor']
        }
      ]
    })!

    const onSelectTaskId = vi.fn()
    const onTaskAction = vi.fn()

    const { rerender } = render(
      <LoopPanel
        onSelectTaskId={onSelectTaskId}
        onTaskAction={onTaskAction}
        open
        selectedTaskId="t_root"
        state={state}
      />
    )

    expect(onTaskAction).not.toHaveBeenCalled()

    const canvas = within(screen.getByTestId('loop-root-agents-card')).getByTestId('loop-task-graph')
    fireEvent.click(within(canvas).getByTestId('loop-task-graph-node-t_candidate'))

    expect(onSelectTaskId).toHaveBeenCalledWith('t_candidate')
    expect(onTaskAction).not.toHaveBeenCalled()

    rerender(
      <LoopPanel
        onSelectTaskId={onSelectTaskId}
        onTaskAction={onTaskAction}
        open
        selectedTaskId="t_candidate"
        state={state}
      />
    )

    expect(screen.getByRole('heading', { name: /Candidate option/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit t_candidate/i })).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalled()
  })

  it('does not expose Submit for scheduled unconfirmed decision-option rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-option-submit-suppressed',
      root_task_id: 't_root',
      tenant: 'tenant-a',
      latest_event_id: 412,
      tasks: [
        {
          id: 't_root',
          title: 'Root task',
          status: 'running',
          tenant: 'tenant-a',
          included_child_ids: ['t_option'],
          included_parent_ids: []
        },
        {
          id: 't_option',
          title: 'Option A',
          status: 'scheduled',
          tenant: 'tenant-a',
          branch_kind: 'alternative',
          decision_group_id: 'choice-1',
          selection_state: 'candidate',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        }
      ]
    })

    render(<LoopPanel onTaskAction={vi.fn()} open selectedTaskId="t_option" state={state} />)

    expect(screen.getByRole('heading', { name: /Option A/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit t_option/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Ask in chat about t_option/i })).toBeTruthy()
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
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
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

    const blockedGraphNode = screen.getByRole('button', { name: /Credential blocker/i })
    fireEvent.click(blockedGraphNode)
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Credential blocker/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-selected-node-inspector')).toBeNull()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /escalate review/i })).toBeNull()
  })

  it('renders a single draft Loop row as task details and gates submit through decompose', () => {
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

    const submit = screen.getByRole('button', { name: /Submit t_draft_root/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(onTaskAction).toHaveBeenCalledWith('decompose', expect.objectContaining({ taskId: 't_draft_root' }))
  })

  it('keeps submit clickable for slash Loop intake rows so the handler can approve planning', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-intake-root',
      root_task_id: 't_intake_root',
      tenant: 'tenant-a',
      latest_event_id: 505,
      tasks: [
        {
          id: 't_intake_root',
          title: 'Title-only intake root',
          body: 'Needs explicit activation approval',
          status: 'scheduled',
          tenant: 'tenant-a',
          loop_intake: {
            dispatchable: false,
            needed: true,
            source: 'slash_loop_draft',
            state: 'drafted'
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
    expect(submit.title).toMatch(/Submit approves Loop intake/i)

    fireEvent.click(submit)
    expect(onTaskAction).toHaveBeenCalledWith('decompose', expect.objectContaining({ taskId: 't_intake_root' }))
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
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
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
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
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
    const state = deriveLoopPanelState([
      toolMessage({
        ok: true,
        root_task_id: 't_root',
        graph_revision: 3,
        nodes: [{ task_id: 't_child', title: 'Build child', status: 'triage', parents: [], depth: 0, active: true }]
      })
    ])

    render(<LoopPanel enableDebugJson open selectedTaskId="t_child" state={state} />)

    expect(screen.queryByText(/"nodes"/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show debug json/i }))
    expect(screen.getByText(/"nodes"/)).toBeTruthy()
  })

  it('resizes the pane shell with the separator keyboard controls', () => {
    const state = deriveLoopPanelState([
      toolMessage({
        ok: true,
        root_task_id: 't_root',
        graph_revision: 3,
        nodes: [{ task_id: 't_child', title: 'Build child', status: 'triage', parents: [], depth: 0, active: true }]
      })
    ])

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
          frontier: true,
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
    expect(within(taskActions).getByRole('button', { name: /submit t_triage/i })).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /^block t_triage$/i })).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /archive t_triage/i })).toBeTruthy()
    expect(within(taskActions).getByRole('button', { name: /ask in chat about t_triage/i })).toBeTruthy()
    expect(within(taskActions).queryByRole('button', { name: /copy id for t_triage/i })).toBeNull()
    expect(within(taskActions).queryByRole('button', { name: /open source task\/details for t_triage/i })).toBeNull()
    expect(within(taskActions).queryByRole('button', { name: /refresh details for t_triage/i })).toBeNull()
    const drawerText = document.body.textContent || ''
    expect(drawerText.indexOf('Submit')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(drawerText.indexOf('Description')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(screen.queryByRole('heading', { name: /Quick actions/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /start t_triage/i })).toBeNull()

    fireEvent.click(within(taskActions).getByRole('button', { name: /submit t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('decompose', expect.objectContaining({ taskId: 't_triage' }))
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
    expect(screen.queryByRole('button', { name: /decompose t_blocked/i })).toBeNull()

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
