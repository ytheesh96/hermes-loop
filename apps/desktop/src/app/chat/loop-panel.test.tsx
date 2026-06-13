import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { LoopPanel, LoopTaskStack } from './loop-panel'
import { deriveLoopPanelState, deriveLoopPanelStateFromTenantSource, type LoopPanelState } from './loop-state'

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

afterEach(() => cleanup())

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

    expect(screen.getByText('Loop')).toBeTruthy()
    expect(screen.getByText('Loop 0/2')).toBeTruthy()
    expect(screen.getAllByText('Design parent').length).toBeGreaterThan(0)
    expect(screen.getByText('Build child')).toBeTruthy()
    expect(screen.getAllByLabelText('Status: triage').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/triage/i)).toBeNull()
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.queryByText('frontier')).toBeNull()
    expect(screen.getByTestId('loop-card-t_parent').style.paddingLeft).toBe('')
    expect(screen.getByTestId('loop-card-t_child').style.paddingLeft).toBe('')
    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:block')
    expect(screen.getByTestId('loop-panel').getAttribute('data-pane-open')).toBe('false')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(screen.getByText('Build child'))
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
    expect(screen.getByTestId('loop-panel').style.width).toBe('352px')
    expect(screen.getByRole('separator', { name: /resize loop-panel/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /dismiss loop panel overlay/i })).toBeNull()
    expect(screen.getByText('Loop details')).toBeTruthy()
    expect(screen.getAllByText('t_child').length).toBeGreaterThan(0)
    expect(screen.getByText('Blocked by')).toBeTruthy()
    expect(screen.queryByText('Parents: t_parent')).toBeNull()
    expect(screen.queryByText(/triage/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /hide loop panel/i }))
    expect(screen.queryByTestId('loop-panel')).toBeNull()

    fireEvent.click(screen.getByText('Design parent'))
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
    expect(screen.getAllByText('t_parent').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /show debug json/i })).toBeNull()
    expect(screen.queryByText(/"nodes"/)).toBeNull()
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
    expect(screen.getByText('Blocked by')).toBeTruthy()
    expect(screen.getByText('Blocking')).toBeTruthy()
    expect(screen.getByText('Decomposed children/follow-ups')).toBeTruthy()
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
    expect(panel.style.width).toBe('352px')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('368px')

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(panel.style.width).toBe('352px')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(panel.style.width).toBe('256px')
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
    expect(screen.getByText('Blocked by')).toBeTruthy()
    expect(screen.getByText('Blocking')).toBeTruthy()
    expect(screen.getByText('Decomposed children/follow-ups')).toBeTruthy()
    expect(screen.getByText('Assignee: peacock')).toBeTruthy()
    expect(screen.getByText('Workspace: worktree')).toBeTruthy()
    expect(screen.getByText('/worktrees/t_child')).toBeTruthy()
    expect(screen.getByText('Safe actions')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /copy id for t_child/i }).length).toBeGreaterThan(0)
    expect(screen.queryByText('Comments')).toBeNull()
    expect(screen.queryByText('Latest run')).toBeNull()
    expect(screen.queryByText('Result')).toBeNull()
    expect(screen.queryByText('Summary')).toBeNull()
    expect(screen.queryByText('Metadata')).toBeNull()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /select blocked by task t_parent/i }))
    expect(screen.getByRole('heading', { name: /Design parent/i })).toBeTruthy()
    expect(screen.getByText('Parent body')).toBeTruthy()
    expect(screen.getByText('Not blocked by any tasks.')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /select blocking task t_child/i })[0]!)
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /select blocking task t_grandchild/i })[0]!)
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(screen.getByText('Not blocking other tasks.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Status: ready Loose task/i }))
    expect(screen.getByRole('heading', { name: /Loose task/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(screen.getByText('Not blocked by any tasks.')).toBeTruthy()
    expect(screen.getByText('Not blocking other tasks.')).toBeTruthy()
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
    expect(screen.getByText('Task details unavailable')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /select blocked by task t_external/i }))

    expect(screen.getByRole('heading', { name: /External parent/i })).toBeTruthy()
    expect(screen.getByText('Fetched external body')).toBeTruthy()
    expect(screen.getAllByText('t_external').length).toBeGreaterThan(0)
    expect(screen.getByText('Blocking')).toBeTruthy()
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
    expect(screen.getByText('Task details unavailable')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.getByText('Archived task details unavailable')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /select blocked by task t_parent/i }))
    expect(screen.getByRole('heading', { name: /Available prerequisite/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /back to Blocked implementation/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /back to Blocked implementation/i }))
    expect(screen.getByRole('heading', { name: /Blocked implementation/i })).toBeTruthy()
    expect(screen.getByText('Blocked by')).toBeTruthy()
    expect(screen.queryByText('Parent tasks')).toBeNull()
    expect(onTaskAction).not.toHaveBeenCalled()
  })

  it('exposes only read-only safe drawer utilities and dispatches details on explicit clicks', () => {
    const state = actionState()
    const onTaskAction = vi.fn()
    const onRefresh = vi.fn()
    const { rerender } = render(<LoopPanel onRefresh={onRefresh} onTaskAction={onTaskAction} open selectedTaskId="t_triage" state={state} />)

    expect(onTaskAction).not.toHaveBeenCalled()
    const actionGroups = screen.getAllByTestId('loop-task-actions')
    expect(actionGroups).toHaveLength(1)
    expect(within(actionGroups[0]!).getByRole('button', { name: /copy id for t_triage/i })).toBeTruthy()
    expect(within(actionGroups[0]!).getByRole('button', { name: /open source task\/details for t_triage/i })).toBeTruthy()
    expect(within(actionGroups[0]!).getByRole('button', { name: /refresh details for t_triage/i })).toBeTruthy()
    const drawerText = document.body.textContent || ''
    expect(drawerText.indexOf('Header')).toBeLessThan(drawerText.indexOf('Safe actions'))
    expect(drawerText.indexOf('Safe actions')).toBeLessThan(drawerText.indexOf('Copy ID'))
    expect(screen.queryByRole('button', { name: /decompose t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /block t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_triage/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /start t_triage/i })).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /open source task\/details for t_triage/i })[0]!)
    expect(onTaskAction).toHaveBeenCalledWith('details', expect.objectContaining({ taskId: 't_triage' }))
    fireEvent.click(screen.getAllByRole('button', { name: /refresh details for t_triage/i })[0]!)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(<LoopPanel onRefresh={onRefresh} onTaskAction={onTaskAction} open selectedTaskId="t_blocked" state={state} />)
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
