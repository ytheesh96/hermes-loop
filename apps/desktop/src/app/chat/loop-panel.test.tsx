import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

const toolMessage = (result: unknown, args: Record<string, unknown> = { action: 'read', root_task_id: 't_root' }): ChatMessage => ({
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
        onRefresh={() => undefined}
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

    expect(state?.rootTaskId).toBe('tenant-a')
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
      toolMessage({ ok: false, error: 'stale_revision', message: 'expected revision 7, current revision is 8', current_revision: 8 })
    ])

    expect(state?.status).toBe('stale')
    expect(state?.revision).toBe(7)
    expect(state?.message).toContain('current revision is 8')
    expect(state?.rawJson).toContain('stale_revision')
  })
})

describe('LoopPanel', () => {
  it('renders rows, opens useful draft details on click, and omits raw JSON/debug affordances in normal view', () => {
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
    const buildChildRow = screen.getByTestId('loop-card-t_child')
    expect(within(buildChildRow).getByText('Build child')).toBeTruthy()
    expect(screen.getAllByLabelText('Status: triage').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/triage/i)).toBeNull()
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.queryByText('frontier')).toBeNull()
    expect(screen.getByTestId('loop-card-t_parent').style.paddingLeft).toBe('')
    expect(screen.getByTestId('loop-card-t_child').style.paddingLeft).toBe('')
    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:block')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-open')).toBe('false')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(within(buildChildRow).getByText('Build child'))
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
    expect(screen.getAllByText('t_child').length).toBeGreaterThan(0)
    expect(screen.getByTestId('loop-task-agents-card')).toBeTruthy()
    expect(screen.queryByText('Parents: t_parent')).toBeNull()
    expect(screen.queryByText(/triage/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /hide loop panel/i }))
    expect(screen.queryByTestId('loop-panel')).toBeNull()

    fireEvent.click(screen.getByText('Design parent'))
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
    expect(screen.getAllByText('t_parent').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /show debug json/i })).toBeNull()
    expect(screen.queryByText(/"nodes"/)).toBeNull()
  }, 15_000)

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
    const onRefresh = vi.fn()
    render(
      <>
        <LoopTaskStack onSelectTaskId={() => undefined} selectedTaskId="t_child" state={state} />
        <LoopPanel
          onRefresh={onRefresh}
          onSelectTaskId={() => undefined}
          onTaskAction={onTaskAction}
          open
          selectedTaskId="t_child"
          state={state}
        />
      </>
    )

    const row = screen.getByTestId('loop-card-t_child')
    expect(row.textContent).toContain('Build child')
    expect(row.textContent).toContain('t_child')
    expect(row.textContent).not.toContain('Implement the detail panel')
    expect(within(row).getByLabelText('Priority: 5')).toBeTruthy()
    expect(within(row).getByLabelText('Blocked by: 1')).toBeTruthy()
    expect(within(row).getByLabelText('Blocking: 1')).toBeTruthy()
    expect(within(row).getByLabelText('Children/follow-ups: 1')).toBeTruthy()

    expect(screen.getByText('Description')).toBeTruthy()
    expect(screen.getByText('Lineage/source')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocking' })).toBeNull()
    const taskCard = screen.getByTestId('loop-task-card')
    expect(within(taskCard).getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /copy id for t_child/i })).toBeTruthy()
    expect(screen.queryByText('Header')).toBeNull()
    expect(screen.queryByText('Safe actions')).toBeNull()
    expect(screen.queryByText('Decomposed children/follow-ups')).toBeNull()
    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(within(agentsCard).getByRole('heading', { name: /Agents/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Design parent/i })).toBeTruthy()
    expect(within(agentsCard).getByText('Blocking')).toBeTruthy()
    expect(within(agentsCard).getByText('Blocked by')).toBeTruthy()
    expect(screen.getByText('Assignee: peacock')).toBeTruthy()
    expect(screen.getByText('Workspace: worktree')).toBeTruthy()
    expect(screen.getByText('/worktrees/t_child')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /copy id for t_child/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /open source task\/details for t_child/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /refresh details for t_child/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /unblock t_child/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /block t_child/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /decompose t_child/i })).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /open source task\/details for t_child/i })[0]!)
    expect(onTaskAction).toHaveBeenCalledWith('details', expect.objectContaining({ taskId: 't_child' }))
    fireEvent.click(screen.getAllByRole('button', { name: /refresh details for t_child/i })[0]!)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('renders root overview groups, opens focused child details, and returns back to the root overview', () => {
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
          included_child_ids: ['t_running', 't_review', 't_queued', 't_done'],
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
          included_child_ids: [],
          included_parent_ids: ['t_root']
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

    const panel = screen.getByTestId('loop-panel')
    expect(panel.style.minWidth).toBe('384px')
    expect(screen.getByTestId('loop-panel-tabbar').style.paddingRight).toBe(
      'calc(var(--titlebar-tools-right) + var(--titlebar-tools-width) + 0.5rem)'
    )
    expect(screen.getByTestId('loop-overview-tab').className).toContain('min-w-36')
    fireEvent.keyDown(screen.getByRole('separator', { name: /Resize loop-panel/i }), { key: 'Home' })
    expect(panel.style.width).toBe('384px')

    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Close Root Task/i }))
    expect(onHide).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Live draft/i)).toBeNull()
    expect(screen.queryByText(/rev 404/i)).toBeNull()
    expect(screen.queryByText('1 active')).toBeNull()
    expect(screen.queryByText('1 needs attention')).toBeNull()
    expect(screen.queryByText('1 queued')).toBeNull()
    expect(screen.queryByText('1 completed')).toBeNull()
    const agentsCard = screen.getByTestId('loop-root-agents-card')
    const agentsList = within(agentsCard).getByTestId('loop-root-agents-list')
    expect(within(agentsCard).getByRole('heading', { name: /Agents/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Active child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Queued child/i })).toBeTruthy()
    expect(within(agentsList).getByRole('button', { name: /Completed child/i })).toBeTruthy()
    expect(screen.queryByText('Active/running children')).toBeNull()
    expect(screen.queryByText('Needs attention')).toBeNull()
    expect(screen.queryByText('Queued/pending')).toBeNull()
    expect(screen.queryByText('Completed/audit')).toBeNull()
    expect(screen.queryByText('Execution overview')).toBeNull()
    expect(within(screen.getByTestId('loop-root-spec')).getByRole('heading', { name: /Description/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()

    const reviewRow = screen.getAllByRole('button', { name: /Review child/i }).find(element => element.className.includes('group/status-row'))
    expect(reviewRow).toBeTruthy()
    expect(reviewRow!.className).toContain('group/status-row')

    fireEvent.click(reviewRow!)
    expect(screen.getByRole('tab', { name: /Root Task/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByTestId('loop-task-tab-t_review')).toBeTruthy()
    const closeReviewTab = screen.getByRole('button', { name: /Close Review child/i })
    expect(closeReviewTab.className).toContain('pointer-events-auto')
    expect(closeReviewTab.className).toContain('opacity-100')
    expect(screen.getByRole('heading', { name: /Review decision/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByText('review-required: inspect proof')).toBeTruthy()
    expect(screen.getByRole('button', { name: /accept review/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /reject review/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /escalate review/i })).toBeTruthy()
    expect((screen.getByRole('button', { name: /accept review/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Review decisions are unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Back to root overview/i })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Root Task/i }))
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()

    const reopenedReviewRow = screen.getAllByRole('button', { name: /Review child/i }).find(element => element.className.includes('group/status-row'))
    expect(reopenedReviewRow).toBeTruthy()
    fireEvent.click(reopenedReviewRow!)
    fireEvent.click(screen.getByRole('button', { name: /Close Review child/i }))
    expect(screen.queryByRole('tab', { name: /Review child/i })).toBeNull()
    expect(screen.getByRole('heading', { name: /Root Task/i })).toBeTruthy()
  })

  it('enables review decision controls when a Loop action handler is connected', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-review-actions',
      tenant: 'tenant-a',
      latest_event_id: 405,
      tasks: [
        {
          id: 't_review',
          title: 'Review handoff child',
          status: 'ready',
          tenant: 'tenant-a',
          latest_summary: 'review-required: inspect proof packet',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })!
    const onTaskAction = vi.fn()

    render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_review" state={state} />)

    const accept = screen.getByRole('button', { name: /accept review/i }) as HTMLButtonElement
    const reject = screen.getByRole('button', { name: /reject review/i }) as HTMLButtonElement
    const escalate = screen.getByRole('button', { name: /escalate review/i }) as HTMLButtonElement

    expect(accept.disabled).toBe(false)
    expect(reject.disabled).toBe(false)
    expect(escalate.disabled).toBe(false)

    fireEvent.click(accept)
    fireEvent.click(reject)
    fireEvent.click(escalate)

    expect(onTaskAction).toHaveBeenNthCalledWith(1, 'accept-review', expect.objectContaining({ taskId: 't_review' }))
    expect(onTaskAction).toHaveBeenNthCalledWith(2, 'reject-review', expect.objectContaining({ taskId: 't_review' }))
    expect(onTaskAction).toHaveBeenNthCalledWith(3, 'escalate-review', expect.objectContaining({ taskId: 't_review' }))
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
    expect(screen.getByText('blocked: missing private token')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject review/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /escalate review/i })).toBeNull()
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

    fireEvent.click(screen.getByRole('button', { name: /open worker session worker-session-42/i }))
    expect(onTaskAction).toHaveBeenCalledWith('worker-session', expect.objectContaining({ taskId: 't_worker' }))
    fireEvent.click(screen.getByRole('button', { name: /inspect worker run #42/i }))
    expect(onTaskAction).toHaveBeenCalledWith('worker-run', expect.objectContaining({ taskId: 't_worker' }))
    fireEvent.click(screen.getByRole('button', { name: /open worker logs for t_worker/i }))
    expect(onTaskAction).toHaveBeenCalledWith('logs', expect.objectContaining({ taskId: 't_worker' }))
  })

  it('renders clickable artifact and source outputs from task metadata', async () => {
    const gitDiff = vi.fn(async (path: string) => ({
      diff: ['--- a/src/app/chat/fallback.ts', '+++ b/src/app/chat/fallback.ts', '@@', '-before', '+fallback'].join('\n'),
      path,
      root: '/worktrees/t_artifacts'
    }))

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { gitDiff }
    })

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
                  inline_diff: ['--- a/src/app/chat/loop-panel.tsx', '+++ b/src/app/chat/loop-panel.tsx', '@@', '-old', '+new'].join('\n'),
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

    const card = screen.getByTestId('loop-artifact-sources-card')
    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(agentsCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(card).getByRole('heading', { name: /Artifacts \/ sources/i })).toBeTruthy()
    expect(within(card).getByText('loop-report.pdf')).toBeTruthy()
    expect(within(card).getByText('Preview page')).toBeTruthy()
    expect(within(card).getByText('loop-panel.tsx')).toBeTruthy()
    expect(within(card).getByText('Fallback diff')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: /open artifact \/tmp\/loop-report\.pdf/i }))
    expect((await screen.findByRole('tab', { name: /loop-report\.pdf/i })).getAttribute('aria-selected')).toBe('true')
    let artifactTab = screen.getByTestId('loop-artifact-source-tab')
    expect(within(artifactTab).getByText('loop-report.pdf')).toBeTruthy()
    expect(within(artifactTab).getByText('/tmp/loop-report.pdf')).toBeTruthy()
    expect((await screen.findByTestId('loop-local-preview')).textContent).toBe('/tmp/loop-report.pdf')

    fireEvent.click(screen.getByRole('tab', { name: /Build artifact drawer/i }))
    const reopenedCard = screen.getByTestId('loop-artifact-sources-card')
    fireEvent.click(within(reopenedCard).getByRole('button', { name: /open changed file src\/app\/chat\/loop-panel\.tsx/i }))
    expect((await screen.findByRole('tab', { name: /loop-panel\.tsx/i })).getAttribute('aria-selected')).toBe('true')
    artifactTab = screen.getByTestId('loop-artifact-source-tab')
    expect(within(artifactTab).getByText('loop-panel.tsx')).toBeTruthy()
    expect(within(artifactTab).getByText('src/app/chat/loop-panel.tsx')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Diff/i }).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText('+new')).toBeTruthy()
    expect(gitDiff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Preview/i }))
    expect(await screen.findByText('/worktrees/t_artifacts/src/app/chat/loop-panel.tsx')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /Build artifact drawer/i }))
    const fallbackCard = screen.getByTestId('loop-artifact-sources-card')
    fireEvent.click(within(fallbackCard).getByRole('button', { name: /open changed file src\/app\/chat\/fallback\.ts/i }))
    expect((await screen.findByRole('tab', { name: /Fallback diff/i })).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText('+fallback')).toBeTruthy()
    expect(gitDiff).toHaveBeenCalledWith('/worktrees/t_artifacts/src/app/chat/fallback.ts')

    rerender(<LoopPanel artifactSourceBaseDir="/workspace/root" open selectedTaskId="t_root" state={state} />)
    const rootAgentsCard = screen.getByTestId('loop-root-agents-card')
    const rootCard = screen.getByTestId('loop-artifact-sources-card')
    expect(rootAgentsCard.compareDocumentPosition(rootCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(rootCard).getByText('Preview page')).toBeTruthy()
    expect(within(rootCard).getAllByText(/Artifact · Build artifact drawer/).length).toBe(2)

    fireEvent.click(within(rootCard).getByRole('button', { name: /open artifact dist\/preview\.html/i }))
    expect((await screen.findByRole('tab', { name: /Preview page/i })).getAttribute('aria-selected')).toBe('true')
    artifactTab = screen.getByTestId('loop-artifact-source-tab')
    expect(within(artifactTab).getByText('Preview page')).toBeTruthy()
    expect(within(artifactTab).getByText('dist/preview.html')).toBeTruthy()
    expect(await screen.findByText('/worktrees/t_artifacts/dist/preview.html')).toBeTruthy()
  }, 30_000)

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

    const selectedTitle = screen.getByTestId('loop-card-title-t_long')
    expect(selectedTitle.className).toContain('flex-1')
    expect(selectedTitle.className).toContain('min-w-0')
    expect(selectedTitle.className).not.toContain('max-w-')
    expect(selectedTitle.className).toContain('truncate')
    expect(selectedTitle.className).not.toContain('line-clamp-2')
    expect(selectedTitle.getAttribute('title')).toContain('Fix session-source env fallback')

    const blockedTitle = screen.getByTestId('loop-card-title-t_blocked')
    expect(blockedTitle.className).toContain('truncate')
    expect(blockedTitle.className).not.toContain('line-clamp-2')
    expect(blockedTitle.getAttribute('title')).toContain('Blocked foreground handoff title')
  })

  it('keeps ordinary Loop composer rows compact and one-line until true row overflow', () => {
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

    const title = screen.getByTestId('loop-card-title-t_ready')
    expect(title.className).toContain('flex-1')
    expect(title.className).toContain('truncate')
    expect(title.className).not.toContain('max-w-')
    expect(title.className).not.toContain('line-clamp-2')
    expect(title.getAttribute('title')).toContain('Ordinary ready row title')
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

  it('offers an explicit refresh affordance for externally-created Loop rows', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      session_id: 'sess-refresh',
      tenant: 'tenant-a',
      latest_event_id: 111,
      tasks: [
        {
          id: 't_done',
          title: 'Existing Loop task',
          status: 'done',
          tenant: 'tenant-a',
          included_child_ids: [],
          included_parent_ids: []
        }
      ]
    })

    const onRefresh = vi.fn()
    const onSelectTaskId = vi.fn()

    render(<LoopTaskStack onRefresh={onRefresh} onSelectTaskId={onSelectTaskId} state={state} />)

    fireEvent.click(screen.getByRole('button', { name: /refresh loop/i }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onSelectTaskId).not.toHaveBeenCalled()
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
            <LoopPanel onSelectTaskId={selectTask} onTaskAction={onTaskAction} open={panelOpen} selectedTaskId={selectedTaskId} state={state} />
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
          included_child_ids: ['t_child'],
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
        }
      ]
    })

    render(<LoopHarness state={state!} />)

    fireEvent.click(screen.getByRole('button', { name: /Status: blocked Build child/i }))

    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(screen.getAllByText('t_child').length).toBeGreaterThan(0)
    expect(screen.getByText('Implement the detail panel')).toBeTruthy()
    expect(screen.getByText('Lineage/source')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Blocking' })).toBeNull()
    const taskCard = screen.getByTestId('loop-task-card')
    expect(within(taskCard).getByRole('heading', { name: /Build child/i })).toBeTruthy()
    expect(within(taskCard).getByRole('button', { name: /copy id for t_child/i })).toBeTruthy()
    expect(screen.queryByText('Header')).toBeNull()
    expect(screen.queryByText('Safe actions')).toBeNull()
    expect(screen.queryByText('Decomposed children/follow-ups')).toBeNull()
    const agentsCard = screen.getByTestId('loop-task-agents-card')
    expect(within(agentsCard).getByRole('heading', { name: /Agents/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Review child/i })).toBeTruthy()
    expect(within(agentsCard).getByRole('button', { name: /Design parent/i })).toBeTruthy()
    expect(within(agentsCard).getByText(/Blocking .*reviewer-qa/i)).toBeTruthy()
    expect(within(agentsCard).getByText(/Blocked by .*planner/i)).toBeTruthy()
    expect(screen.getByText('Assignee: peacock')).toBeTruthy()
    expect(screen.getByText('Workspace: worktree')).toBeTruthy()
    expect(screen.getByText('/worktrees/t_child')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /copy id for t_child/i }).length).toBeGreaterThan(0)
    expect(screen.queryByText('Comments')).toBeNull()
    expect(screen.queryByText('Latest run')).toBeNull()
    expect(screen.queryByText('Result')).toBeNull()
    expect(screen.queryByText('Summary')).toBeNull()
    expect(screen.queryByText('Metadata')).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Design parent/i }))
    expect(screen.getByRole('heading', { name: /Design parent/i })).toBeTruthy()
    expect(screen.queryByText('parent complete')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /Build child/i })[0]!)
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Review child/i }))
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Build child/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Status: ready Loose task/i }))
    expect(screen.getByRole('heading', { name: /Loose task/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByText('No agents yet.')).toBeTruthy()
    expect(screen.getByText('Assignee: reviewer-qa')).toBeTruthy()
  }, 15_000)

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
    expect(within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Task details unavailable')).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /t_external/i }))

    expect(screen.getByRole('heading', { name: /External parent/i })).toBeTruthy()
    expect(screen.getByText('Fetched external body')).toBeTruthy()
    expect(screen.getAllByText('t_external').length).toBeGreaterThan(0)
    expect(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Build child/i })).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: /Status: blocked Blocked implementation/i }))
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Task details unavailable')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByText('Blocked by · Archived')).toBeTruthy()
    expect(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Archived blocker/i })).toBeTruthy()

    fireEvent.click(within(screen.getByTestId('loop-task-agents-card')).getByRole('button', { name: /Available prerequisite/i }))
    expect(screen.getByRole('heading', { name: /Available prerequisite/i })).toBeTruthy()
    const blockedRows = screen.getAllByRole('button', { name: /Blocked implementation/i })
    expect(blockedRows.length).toBeGreaterThan(0)

    fireEvent.click(blockedRows.at(-1)!)
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Blocked by' })).toBeNull()
    expect(screen.queryByText('Parent tasks')).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalled()
  })

  it('exposes root draft quick actions and keeps child drawer utilities read-only', () => {
    const state = actionState()
    const onTaskAction = vi.fn()
    const onRefresh = vi.fn()
    const { rerender } = render(<LoopPanel onRefresh={onRefresh} onTaskAction={onTaskAction} open selectedTaskId="t_triage" state={state} />)

    expect(onTaskAction).not.toHaveBeenCalled()
    const rootCard = screen.getByTestId('loop-root-card')
    const rootActions = screen.getByTestId('loop-root-actions')
    expect(within(rootCard).getByTestId('loop-root-actions')).toBe(rootActions)
    expect(within(rootCard).queryByTestId('loop-root-spec')).toBeNull()
    const rootSpec = screen.getByTestId('loop-root-spec')
    expect(within(rootSpec).getByRole('heading', { name: /Description/i })).toBeTruthy()
    expect(screen.queryByText('Loop spec')).toBeNull()
    expect(within(rootSpec).getByText('Draft Loop spec')).toBeTruthy()
    expect(within(rootActions).getByRole('button', { name: /submit t_triage/i })).toBeTruthy()
    expect(within(rootActions).getByRole('button', { name: /archive loop tasks for t_triage/i })).toBeTruthy()
    expect(within(rootActions).getByRole('button', { name: /ask hermes about t_triage/i })).toBeTruthy()
    expect(within(rootActions).queryByRole('button', { name: /copy id for t_triage/i })).toBeNull()
    expect(within(rootActions).queryByRole('button', { name: /open source task\/details for t_triage/i })).toBeNull()
    expect(within(rootActions).queryByRole('button', { name: /refresh details for t_triage/i })).toBeNull()
    const drawerText = document.body.textContent || ''
    expect(drawerText.indexOf('Submit')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(drawerText.indexOf('Description')).toBeLessThan(drawerText.indexOf('Draft Loop spec'))
    expect(screen.queryByRole('heading', { name: /Quick actions/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /block t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /start t_triage/i })).toBeNull()

    fireEvent.click(within(rootActions).getByRole('button', { name: /submit t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('decompose', expect.objectContaining({ taskId: 't_triage' }))
    fireEvent.click(within(rootActions).getByRole('button', { name: /archive loop tasks for t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('archive-loop', expect.objectContaining({ taskId: 't_triage' }))
    fireEvent.click(within(rootActions).getByRole('button', { name: /ask hermes about t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('ask-hermes', expect.objectContaining({ taskId: 't_triage' }))

    rerender(<LoopPanel onRefresh={onRefresh} onTaskAction={onTaskAction} open selectedTaskId="t_blocked" state={state} />)
    expect(screen.queryByTestId('loop-root-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: /unblock t_blocked/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_blocked/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Block t_blocked$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /decompose t_blocked/i })).toBeNull()
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
    expect(screen.getByText('Tenant: tenant-a')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /block t_archived/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_archived/i })).toBeNull()
  })
})
