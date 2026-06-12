import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { LoopPanel, LoopTaskStack } from './loop-panel'
import { deriveLoopPanelState, type LoopPanelState, loopPanelStateFromResult } from './loop-state'

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

  it('renders tenant-backed Kanban rows without a loop_graph tool message', () => {
    const state = loopPanelStateFromResult({
      ok: true,
      source: 'kanban_tenant',
      root_task_id: 'tenant:session-1',
      graph_revision: 42,
      nodes: [{ task_id: 't_tenant', title: 'Tenant row', status: 'triage', parents: [], depth: 0 }]
    })

    expect(state?.rootTaskId).toBe('tenant:session-1')
    expect(state?.revision).toBe(42)
    expect(state?.rows.map(row => row.title)).toEqual(['Tenant row'])
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
  it('renders rows as a flat dependency-ordered list and exposes rich details outside debug JSON', () => {
    const state = deriveLoopPanelState([
      toolMessage({
        ok: true,
        root_task_id: 't_root',
        graph_revision: 3,
        nodes: [
          {
            task_id: 't_parent',
            title: 'Design parent',
            status: 'ready',
            parents: [],
            children: ['t_child'],
            board: 'developer',
            tenant: 'tenant-1',
            root_task_id: 't_root',
            attention: 'review',
            verification_state: 'requested',
            handoff: { task_id: 't_parent', summary: 'Parent handoff summary', reason: 'Needs UX approval' },
            depth: 0,
            frontier: true
          },
          {
            task_id: 't_child',
            title: 'Build child',
            status: 'triage',
            parents: ['t_parent'],
            board: 'developer',
            tenant: 'tenant-1',
            root_task_id: 't_root',
            attention: 'implementation',
            verification_state: 'pending',
            handoff: { task_id: 't_child', summary: 'Child handoff summary', reason: 'Needs tests' },
            depth: 1,
            active: true
          }
        ]
      })
    ])

    render(<LoopHarness state={state!} />)

    expect(screen.getByText('Loop')).toBeTruthy()
    expect(screen.getByText('Loop 0/2')).toBeTruthy()
    expect(screen.getAllByText('Design parent').length).toBeGreaterThan(0)
    expect(screen.getByText('Build child')).toBeTruthy()
    expect(screen.getAllByText('Design parent')[0].compareDocumentPosition(screen.getByText('Build child'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.queryByText('frontier')).toBeNull()

    const parentCard = screen.getByTestId('loop-card-t_parent')
    const childCard = screen.getByTestId('loop-card-t_child')
    expect(parentCard.getAttribute('style') || '').not.toContain('--loop-depth')
    expect(childCard.getAttribute('style') || '').not.toContain('--loop-depth')
    expect(parentCard.getAttribute('style')).toBe(childCard.getAttribute('style'))

    expect(screen.getByTestId('loop-panel').className).toContain('hidden xl:flex')
    expect(screen.queryByText(/"nodes"/)).toBeNull()

    fireEvent.click(screen.getByText('Build child'))
    expect(screen.getByTestId('loop-panel').className).not.toContain('hidden xl:flex')
    expect(screen.getByTestId('loop-panel').className).not.toContain('fixed')
    expect(screen.getByTestId('loop-panel').className).toContain('w-[min(20rem,45vw)]')
    expect(screen.queryByRole('button', { name: /dismiss loop panel overlay/i })).toBeNull()
    expect(screen.getByText('Loop details')).toBeTruthy()
    expect(screen.getByText('Task ID: t_child')).toBeTruthy()
    expect(screen.getByText('Status: triage')).toBeTruthy()
    expect(screen.getByText('Board: developer')).toBeTruthy()
    expect(screen.getByText('Tenant: tenant-1')).toBeTruthy()
    expect(screen.getByText('Root: t_root')).toBeTruthy()
    expect(screen.getByText('Parents: t_parent')).toBeTruthy()
    expect(screen.getByText('Dependents: unavailable')).toBeTruthy()
    expect(screen.getByText('Attention: implementation')).toBeTruthy()
    expect(screen.getByText('Verification: pending')).toBeTruthy()
    expect(screen.getByText('Handoff summary: Child handoff summary')).toBeTruthy()
    expect(screen.getByText('Handoff reason: Needs tests')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /hide loop panel/i }))
    expect(screen.queryByTestId('loop-panel')).toBeNull()

    fireEvent.click(screen.getByText('Design parent'))
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
    expect(screen.getByText('Task ID: t_parent')).toBeTruthy()
    expect(screen.getByText('Dependents: t_child')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /show debug json/i }))
    expect(screen.getByText(/"nodes"/)).toBeTruthy()
  })

  it('uses composer status glyph semantics for loop row statuses', () => {
    const statusesByKind = {
      blocked: ['blocked', 'error', 'failed'],
      done: ['done', 'complete', 'completed'],
      pending: ['triage', 'todo', 'ready', 'open'],
      running: ['running', 'in_progress', 'claimed'],
      slashed: ['cancelled', 'canceled', 'archived']
    }

    const nodes = Object.entries(statusesByKind).flatMap(([kind, statuses]) =>
      statuses.map(status => ({
        task_id: `t_${kind}_${status}`,
        title: `${kind} ${status}`,
        status,
        parents: [],
        depth: 0
      }))
    )

    const state = loopPanelStateFromResult({ ok: true, root_task_id: 't_root', graph_revision: 1, nodes })

    render(<LoopHarness state={state!} />)

    for (const [kind, statuses] of Object.entries(statusesByKind)) {
      for (const status of statuses) {
        for (const indicator of screen.getAllByLabelText(`Status: ${status}`)) {
          expect(indicator.getAttribute('data-status-kind')).toBe(kind)
        }
      }
    }
  })
})
