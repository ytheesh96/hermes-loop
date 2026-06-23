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

    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Show agents list/i }))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-list')).getByRole('button', { name: /Build child/i }))
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.getByTestId('loop-task-agents-card')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByTestId('loop-task-graph-node-t_parent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /show debug json/i })).toBeNull()
    expect(screen.queryByText(/"nodes"/)).toBeNull()
  }, 15_000)

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
    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(within(agentsCard).getByRole('heading', { name: /Loop graph/i })).toBeTruthy()
    const defaultCanvas = within(agentsCard).getByTestId('loop-task-graph')
    expect(within(defaultCanvas).getByTestId('loop-task-graph-node-t_parent')).toBeTruthy()
    expect(within(defaultCanvas).getByTestId('loop-task-graph-node-t_child')).toBeTruthy()
    expect(within(defaultCanvas).getByTestId('loop-task-graph-node-t_grandchild')).toBeTruthy()
    expect(within(agentsCard).queryByTestId('loop-task-agents-list')).toBeNull()

    fireEvent.click(within(agentsCard).getByRole('button', { name: /Show agents list/i }))
    expect(within(agentsCard).getByRole('heading', { name: /Agents/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Design parent/i })).toBeTruthy()
    expect(within(agentsCard).getByText('Blocking')).toBeTruthy()
    expect(within(agentsCard).getByText('Blocked by')).toBeTruthy()
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

    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
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

    expect(within(agentsCard).getByRole('heading', { name: /^Loop graph$/i })).toBeTruthy()
    const openListButton = agentsCard.querySelector('button[aria-label="Show agents list"]')
    expect(openListButton).toBeTruthy()
    expect(openListButton?.textContent).toBe('')
    const canvas = within(agentsCard).getByTestId('loop-task-graph')
    expect(screen.queryByTestId('loop-canvas-overlay')).toBeNull()
    expect(within(canvas).queryByText('Root')).toBeNull()
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

    const graphSurface = within(canvas).getByTestId('loop-task-graph-surface')
    expect(canvas.getAttribute('data-zoom')).toBe('1.00')
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -120 })
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1)
    expect(graphSurface.style.transform).toContain('scale(')
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 120 })
    expect(Number(canvas.getAttribute('data-zoom'))).toBeCloseTo(1, 1)

    fireEvent.click(within(agentsCard).getByRole('button', { name: 'Show agents list' }))
    expect(within(agentsCard).queryByTestId('loop-task-graph')).toBeNull()
    const agentsList = within(agentsCard).getByTestId('loop-root-agents-list')

    const agentRows = within(agentsList).getAllByRole('button')

    expect(agentRows[0]?.textContent).toContain('Root Task')
    expect(agentRows[0]?.textContent?.toLowerCase()).toContain('foreground')

    const agentTitleSpans = Array.from(agentsList.querySelectorAll('span')).filter(element =>
      element.className.includes('text-[0.73rem]')
    )

    expect(agentTitleSpans.length).toBeGreaterThanOrEqual(agentRows.length)

    for (const titleSpan of agentTitleSpans) {
      expect(titleSpan.className).toContain('w-[18rem]')
      expect(titleSpan.className).toMatch(/(?:^|\s)shrink(?:\s|$)/)
      expect(titleSpan.className).not.toContain('shrink-0')
      expect(titleSpan.className).toContain('max-w-[18rem]')
    }

    expect(within(agentsList).getByRole('button', { name: /Active child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Queued child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Review-only child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Completed child/i })).toBeTruthy()
    expect(screen.queryByText('Active/running children')).toBeNull()
    expect(screen.queryByText('Needs attention')).toBeNull()
    expect(screen.queryByText('Queued/pending')).toBeNull()
    expect(screen.queryByText('Completed/audit')).toBeNull()
    expect(screen.queryByText('Execution overview')).toBeNull()
    expect(within(screen.getByTestId('loop-root-spec')).getByRole('heading', { name: /Description/i })).toBeTruthy()
    const rootActions = screen.getByTestId('loop-root-actions')
    const rootAskButton = within(rootActions).getByRole('button', { name: /ask in chat about t_root/i })
    expect(rootAskButton).toBeTruthy()
    expect(within(rootActions).getByText('Ask in chat')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()

    const reviewRow = screen
      .getAllByRole('button', { name: /Review child/i })
      .find(element => element.className.includes('group/status-row'))

    expect(reviewRow).toBeTruthy()
    expect(reviewRow!.className).toContain('group/status-row')

    fireEvent.click(reviewRow!)
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

    const reviewAgentsCard = screen.getByTestId('loop-task-agents-card')
    const rootRelationshipRow = within(reviewAgentsCard).getByRole('button', { name: /Root Task/i })
    fireEvent.click(rootRelationshipRow)
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Review decision/i })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Root Task/i }))
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()

    const reopenedAgentsCard = screen.getByTestId('loop-root-agents-card')
    fireEvent.click(within(reopenedAgentsCard).getByRole('button', { name: /Show agents list/i }))

    const reopenedReviewRow = screen
      .getAllByRole('button', { name: /Review child/i })
      .find(element => element.className.includes('group/status-row'))

    expect(reopenedReviewRow).toBeTruthy()
    fireEvent.click(reopenedReviewRow!)
    fireEvent.click(screen.getByRole('button', { name: /Close Review child/i }))
    expect(screen.queryByRole('tab', { name: /Review child/i })).toBeNull()
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
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
    fireEvent.click(within(rootAgentsCard).getByRole('button', { name: /Show agents list/i }))
    const agentsList = within(rootAgentsCard).getByTestId('loop-root-agents-list')

    expect(within(agentsList).getByRole('button', { name: /Nested sub-loop/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Nested blocker worker/i })).toBeTruthy()
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
    fireEvent.click(within(rootAgentsCard).getByRole('button', { name: /Show agents list/i }))
    let agentsList = within(rootAgentsCard).getByTestId('loop-root-agents-list')

    fireEvent.click(within(agentsList).getByRole('button', { name: /Root Task/i }))

    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByTestId('loop-task-tab-t_root')).toBeNull()
    expect(screen.queryByTestId('loop-root-agents-card')).toBeNull()
    expect(screen.getByTestId('loop-task-agents-card')).toBeTruthy()

    let backButton = screen.getByRole('button', { name: /Back to Loop overview/i })

    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)

    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()

    rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    fireEvent.click(within(rootAgentsCard).getByRole('button', { name: /Show agents list/i }))
    agentsList = within(rootAgentsCard).getByTestId('loop-root-agents-list')
    fireEvent.click(within(agentsList).getByRole('button', { name: /Child Task/i }))

    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByTestId('loop-task-tab-t_child')).toBeNull()
    expect(screen.getByRole('heading', { name: /Child Task/i })).toBeTruthy()

    backButton = screen.getByRole('button', { name: /Back to Loop overview/i })

    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)

    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
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

    expect(screen.getByRole('heading', { name: /Original Loop root/i })).toBeTruthy()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
    ).toBeTruthy()
    expect(screen.getByTestId('loop-root-spec')).toBeTruthy()
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

    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
    expect(screen.queryByText('final evidence accepted')).toBeNull()
    expect(screen.getByText('Credential blocker')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Credential blocker/i }))
    expect(screen.getByRole('heading', { name: /Credential blocker/i })).toBeTruthy()
    expect(screen.queryByText('blocked: missing private token')).toBeNull()
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
          status: 'triage',
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

  it('keeps submit clickable for slash Loop intake rows so the handler can approve and dispatch', () => {
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
          status: 'triage',
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
    expect(submit.title).toMatch(/Submit approves and dispatches/i)

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

    expect(screen.getByRole('heading', { name: /Original draft root/i })).toBeTruthy()
    expect(within(screen.getByTestId('loop-root-spec')).getByText('Living spec after approval')).toBeTruthy()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
    ).toBeTruthy()
    expect((screen.getByRole('button', { name: /Submit t_original_root/i }) as HTMLButtonElement).disabled).toBe(true)
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

    expect(screen.getByRole('heading', { name: /Original draft root/i })).toBeTruthy()
    expect(within(screen.getByTestId('loop-root-spec')).getByText('Living spec after approval')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Submit t_original_root/i })).toBeTruthy()
    expect(screen.queryByTestId('loop-task-card')).toBeNull()
    expect(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Implementation child/i })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Implementation child/i }))
    expect(screen.getByRole('heading', { name: /Implementation child/i })).toBeTruthy()
    expect(screen.getByTestId('loop-task-card')).toBeTruthy()
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

    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(agentsCard).toBeTruthy()
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

    const blockedTitle = screen.getByText('Blocked foreground handoff title should reveal enough context before opening details')
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
    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Show agents list/i }))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-list')).getByRole('button', { name: /Build child/i }))

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
    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(within(agentsCard).getByRole('heading', { name: /Loop graph/i })).toBeTruthy()
    const canvas = within(agentsCard).getByTestId('loop-task-graph')
    expect(canvas).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-node-t_parent')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-node-t_child')).toBeTruthy()
    expect(within(canvas).getByTestId('loop-task-graph-node-t_grandchild')).toBeTruthy()
    expect(within(canvas).queryByTestId('loop-task-graph-node-t_orphan')).toBeNull()
    expect(within(canvas).queryByTestId('loop-task-graph-node-t_cousin')).toBeNull()
    expect(canvas.className).not.toContain('radial-gradient')

    fireEvent.click(within(agentsCard).getByRole('button', { name: /Show agents list/i }))
    expect(within(agentsCard).getByRole('heading', { name: /Agents/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Design parent/i })).toBeTruthy()
    expect(within(agentsCard).getByText('Blocking')).toBeTruthy()
    expect(within(agentsCard).getByText('reviewer-qa')).toBeTruthy()
    expect(within(agentsCard).getByText('Blocked by')).toBeTruthy()
    expect(within(agentsCard).getByText('planner')).toBeTruthy()
    expect(within(agentsCard).queryByTestId('loop-task-graph')).toBeNull()
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

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Design parent/i }))
    expect(screen.getByRole('heading', { name: /Design parent/i })).toBeTruthy()
    expect(screen.getByTestId('loop-root-agents-card')).toBeTruthy()
    expect(screen.queryByText('parent complete')).toBeNull()

    fireEvent.click(
      within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Show agents list/i })
    )
    fireEvent.click(within(screen.getByTestId('loop-root-agents-list')).getByRole('button', { name: /Build child/i }))
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Review child/i }))
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    const reviewAgentsCard = screen.getByTestId('loop-task-agents-card')
    expect(within(reviewAgentsCard).getByRole('heading', { name: /Loop graph/i })).toBeTruthy()
    expect(within(reviewAgentsCard).getByRole('button', { name: /Build child/i })).toBeTruthy()

    const grandchildCanvas = within(reviewAgentsCard).getByTestId('loop-task-graph')
    expect(grandchildCanvas).toBeTruthy()
    expect(within(grandchildCanvas).getByTestId('loop-task-graph-node-t_child')).toBeTruthy()
    expect(within(grandchildCanvas).getByTestId('loop-task-graph-node-t_grandchild')).toBeTruthy()
    expect(within(grandchildCanvas).queryByTestId('loop-task-graph-node-t_parent')).toBeNull()

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
    fireEvent.click(
      within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Show agents list/i })
    )
    expect(
      within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Task details unavailable')
    ).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /t_external/i }))

    expect(screen.getByRole('heading', { name: /External parent/i })).toBeTruthy()
    expect(screen.getByText('Fetched external body')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-card')).queryByText('t_external')).toBeNull()
    expect(
      within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Build child/i })
    ).toBeTruthy()
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
    fireEvent.click(within(screen.getByTestId('loop-root-agents-card')).getByRole('button', { name: /Show agents list/i }))
    fireEvent.click(within(screen.getByTestId('loop-root-agents-list')).getByRole('button', { name: /Blocked implementation/i }))
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
    fireEvent.click(
      within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Show agents list/i })
    )
    expect(
      within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Task details unavailable')
    ).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Archived')).toBeTruthy()
    expect(
      within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Archived blocker/i })
    ).toBeTruthy()

    fireEvent.click(
      within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Available prerequisite/i })
    )
    expect(screen.getByRole('heading', { name: /Available prerequisite/i })).toBeTruthy()
    const blockedRows = screen.getAllByRole('button', { name: /Blocked implementation/i })
    expect(blockedRows.length).toBeGreaterThan(0)

    fireEvent.click(blockedRows.at(-1)!)
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
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
