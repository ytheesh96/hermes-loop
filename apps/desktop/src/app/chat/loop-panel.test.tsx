import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:flex')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(screen.getByText('Build child'))
    expect(screen.getByTestId('loop-panel').className).not.toContain('hidden xl:flex')
    expect(screen.getByTestId('loop-panel').className).not.toContain('fixed')
    expect(screen.getByTestId('loop-panel').getAttribute('data-layout')).toBe('docked')
    expect(screen.getByTestId('loop-panel').getAttribute('data-modal')).toBe('false')
    expect(screen.getByTestId('loop-panel').getAttribute('data-state')).toBe('open')
    expect(screen.getByTestId('loop-panel').className).toContain('w-[min(22rem,45vw)]')
    expect(screen.queryByRole('button', { name: /dismiss loop panel overlay/i })).toBeNull()
    expect(screen.getByText('Loop details')).toBeTruthy()
    expect(screen.getByText('t_child')).toBeTruthy()
    expect(screen.getByText('Parents: t_parent')).toBeTruthy()
    expect(screen.queryByText(/triage/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /hide loop panel/i }))
    expect(screen.queryByTestId('loop-panel')).toBeNull()

    fireEvent.click(screen.getByText('Design parent'))
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
    expect(screen.getByText('t_parent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /show debug json/i })).toBeNull()
    expect(screen.queryByText(/"nodes"/)).toBeNull()
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

  it('lets Loop composer row titles claim available width and only expands priority rows to two lines', () => {
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
    expect(selectedTitle.className).not.toContain('truncate')
    expect(selectedTitle.className).toContain('line-clamp-2')
    expect(selectedTitle.getAttribute('title')).toContain('Fix session-source env fallback')

    const blockedTitle = screen.getByTestId('loop-card-title-t_blocked')
    expect(blockedTitle.className).toContain('line-clamp-2')
    expect(blockedTitle.className).not.toContain('max-w-')
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
    expect(screen.getByText('t_child')).toBeTruthy()
    expect(screen.getByText('Implement the detail panel')).toBeTruthy()
    expect(screen.getByText('Comments')).toBeTruthy()
    expect(screen.getByText('2 comments available in task detail')).toBeTruthy()
    expect(screen.getByText('Latest run')).toBeTruthy()
    expect(screen.getByText(/Run #42 · running · peacock/)).toBeTruthy()
    expect(screen.getByText('Result')).toBeTruthy()
    expect(screen.getByText('child result')).toBeTruthy()
    expect(screen.getByText('Summary')).toBeTruthy()
    expect(screen.getByText('blocked on review')).toBeTruthy()
    expect(screen.getByText('Metadata')).toBeTruthy()
    expect(screen.getByText('Assignee: peacock')).toBeTruthy()
    expect(screen.getByText('Workspace: worktree')).toBeTruthy()
    expect(screen.getByText('/worktrees/t_child')).toBeTruthy()
    expect(screen.getByText('Safe actions')).toBeTruthy()
    expect(screen.getByText('Task actions will appear here when enabled.')).toBeTruthy()
    expect(screen.queryByText(/"tasks"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /select parent task t_parent/i }))
    expect(screen.getByRole('heading', { name: /Design parent/i })).toBeTruthy()
    expect(screen.getByText('Parent body')).toBeTruthy()
    expect(screen.getByText('No comments yet.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /select child task t_child/i }))
    expect(screen.getByRole('heading', { name: /Build child/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /select child task t_grandchild/i }))
    expect(screen.getByRole('heading', { name: /Review child/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(screen.getByText('No child tasks.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Status: ready Loose task/i }))
    expect(screen.getByRole('heading', { name: /Loose task/i })).toBeTruthy()
    expect(screen.getByText('No description provided.')).toBeTruthy()
    expect(screen.getByText('No parent tasks.')).toBeTruthy()
    expect(screen.getByText('No child tasks.')).toBeTruthy()
    expect(screen.getByText('No run recorded yet.')).toBeTruthy()
    expect(screen.getByText('No result recorded.')).toBeTruthy()
    expect(screen.getByText('No summary recorded.')).toBeTruthy()
    expect(screen.getByText('Assignee: reviewer-qa')).toBeTruthy()
    expect(screen.getByText('Workspace: unknown')).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: /select parent task t_external/i }))

    expect(screen.getByRole('heading', { name: /External parent/i })).toBeTruthy()
    expect(screen.getByText('Fetched external body')).toBeTruthy()
    expect(screen.getByText('t_external')).toBeTruthy()
    expect(screen.getByText(/Run #2 · running · new-worker/)).toBeTruthy()
    expect(screen.getAllByText('newest run').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/Run #1 · done · old-worker/)).toBeNull()
    expect(screen.queryByText('oldest run')).toBeNull()
  })

  it('renders status-specific safe actions and dispatches only on explicit clicks', () => {
    const state = actionState()
    const onTaskAction = vi.fn()
    const { rerender } = render(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_triage" state={state} />)

    expect(onTaskAction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /decompose t_triage/i }).textContent).toBe('⚗ Decompose')
    expect(screen.getByRole('button', { name: /block t_triage/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /park t_triage/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /open details for t_triage/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /open kanban for t_triage/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /start t_triage/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /decompose t_triage/i }))
    expect(onTaskAction).toHaveBeenCalledWith('decompose', expect.objectContaining({ taskId: 't_triage' }))

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_blocked" state={state} />)
    expect(screen.getByRole('button', { name: /unblock t_blocked/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /park t_blocked/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Block t_blocked$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /decompose t_blocked/i })).toBeNull()

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_scheduled" state={state} />)
    expect(screen.getByRole('button', { name: /start t_scheduled/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /block t_scheduled/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /park t_scheduled/i })).toBeNull()

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_todo" state={state} />)
    expect(screen.getByRole('button', { name: /start t_todo/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /block t_todo/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /park t_todo/i })).toBeTruthy()

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_done" state={state} />)
    expect(screen.getByRole('button', { name: /open details for t_done/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /open logs for t_done/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /block t_done/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_done/i })).toBeNull()

    rerender(<LoopPanel onTaskAction={onTaskAction} open selectedTaskId="t_archived" state={state} />)
    expect(screen.getByRole('button', { name: /open details for t_archived/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /block t_archived/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_archived/i })).toBeNull()
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
    expect(screen.getByText('No run recorded yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /block t_archived/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /park t_archived/i })).toBeNull()
  })
})
