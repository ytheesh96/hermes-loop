import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { LoopPanel, LoopTaskStack } from './loop-panel'
import {
  deriveLoopPanelState,
  deriveLoopPanelStateFromTenantSource,
  type LoopPanelState,
  type TenantLoopTask
} from './loop-state'

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
      <LoopPanel hidden={panelHidden} onHide={hidePanel} open={panelOpen} selectedTaskId={selectedTaskId} state={state} />
    </>
  )
}

describe('deriveLoopPanelState', () => {
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

describe('tenant-backed loop mapping', () => {
  const task = (overrides: Partial<TenantLoopTask> & { id: string; title: string }): TenantLoopTask => {
    const { id, title, ...rest } = overrides

    return {
      assignee: 'worker',
      created_at: 1,
      id,
      priority: 0,
      status: 'todo',
      title,
      ...rest
    }
  }

  it('filters archived display rows, computes counts/emphasis, and keeps closure/reviewer rows last', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 42,
      session_id: 'session-1',
      tasks: [
        task({ id: 't_review', title: 'Review implementation', assignee: 'reviewer-qa', included_parent_ids: ['t_child'] }),
        task({ id: 't_archived', title: 'Archived old row', status: 'archived' }),
        task({ id: 't_child', title: 'Build child', status: 'ready', included_parent_ids: ['t_parent'], included_child_ids: ['t_review'] }),
        task({ id: 't_parent', title: 'Design parent', status: 'done', included_child_ids: ['t_child'] }),
        task({ id: 't_closure', title: 'Close out loop', status: 'todo', included_parent_ids: ['t_review'] })
      ]
    })

    expect(state?.rootTaskId).toBe('session-1')
    expect(state?.revision).toBe(42)
    expect(state?.rows.map(row => row.taskId)).toEqual(['t_parent', 't_child', 't_review', 't_closure'])
    expect(state?.rows.map(row => row.depth)).toEqual([0, 1, 2, 3])
    expect(state?.rows.find(row => row.taskId === 't_child')).toMatchObject({
      active: true,
      childCount: 1,
      frontier: true,
      parentCount: 1
    })
    expect(state?.rows.find(row => row.taskId === 't_archived')).toBeUndefined()
  })

  it('uses source-level included links when task rows do not carry embedded ids', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      links: [{ parent_id: 't_parent', child_id: 't_child' }],
      tasks: [task({ id: 't_child', title: 'Build child' }), task({ id: 't_parent', title: 'Design parent' })]
    })

    expect(state?.rows.map(row => row.taskId)).toEqual(['t_parent', 't_child'])
    expect(state?.rows.find(row => row.taskId === 't_parent')).toMatchObject({ childCount: 1, parentCount: 0 })
    expect(state?.rows.find(row => row.taskId === 't_child')).toMatchObject({ childCount: 0, parentCount: 1, parents: ['t_parent'] })
  })

  it('keeps dependency ordering deterministic for cycles without hanging', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      tasks: [
        task({ id: 't_review', title: 'Review cycle', assignee: 'reviewer-qa', created_at: 30, included_parent_ids: ['t_b'] }),
        task({ id: 't_b', title: 'B', created_at: 20, included_parent_ids: ['t_a'] }),
        task({ id: 't_a', title: 'A', created_at: 10, included_parent_ids: ['t_b'] })
      ]
    })

    expect(state?.rows.map(row => row.taskId)).toEqual(['t_a', 't_b', 't_review'])
  })
})

describe('LoopPanel', () => {
  it('renders rows, opens useful draft details on click, and hides raw JSON behind debug', () => {
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
    expect(screen.getByText(/Build child/)).toBeTruthy()
    expect(screen.getAllByLabelText('Status: triage').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/triage/i)).toBeNull()
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.queryByText('frontier')).toBeNull()
    expect(screen.getByTestId('loop-card-t_child').getAttribute('style')).toContain('--loop-depth: 1')
    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:flex')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(screen.getByText(/Build child/))
    expect(screen.getByTestId('loop-panel').className).not.toContain('hidden xl:flex')
    expect(screen.getByTestId('loop-panel').className).not.toContain('fixed')
    expect(screen.getByTestId('loop-panel').className).toContain('w-[min(20rem,45vw)]')
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

    fireEvent.click(screen.getByRole('button', { name: /show debug json/i }))
    expect(screen.getByText(/"nodes"/)).toBeTruthy()
  })
})
