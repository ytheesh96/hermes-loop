import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { LoopPanel } from './loop-panel'
import { deriveLoopPanelState } from './loop-state'

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

    render(<LoopPanel state={state} />)

    expect(screen.getByText('Loop')).toBeTruthy()
    expect(screen.getAllByText('Design parent').length).toBeGreaterThan(0)
    expect(screen.getByText('Build child')).toBeTruthy()
    expect(screen.getByTestId('loop-row-t_child').getAttribute('style')).toContain('--loop-depth: 1')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(screen.getByTestId('loop-row-t_child'))
    expect(screen.getByText('Draft task details')).toBeTruthy()
    expect(screen.getByText('t_child')).toBeTruthy()
    expect(screen.getByText('Parents: t_parent')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /show debug json/i }))
    expect(screen.getByText(/"nodes"/)).toBeTruthy()
  })
})
