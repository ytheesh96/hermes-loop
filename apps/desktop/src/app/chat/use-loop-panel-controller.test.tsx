import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PREVIEW_PANE_ID } from '@/store/layout'
import { $paneStates } from '@/store/panes'
import { openSessionInNewWindow } from '@/store/windows'

import { useLoopPanelController } from './use-loop-panel-controller'

vi.mock('@/store/windows', () => ({
  openSessionInNewWindow: vi.fn()
}))

function renderControllerHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })

  function Harness() {
    const controller = useLoopPanelController({
      activeSessionId: 'session-1',
      gatewayOpen: false,
      loopSourceSessionId: 'session-1',
      onAddContextRef: vi.fn()
    })

    return (
      <>
        <button onClick={() => controller.onSelectTaskId('t_root')} type="button">
          Open Loop row
        </button>
        <button
          onClick={() =>
            controller.onTaskAction('worker-session', {
              active: true,
              assignee: 'reviewer-qa',
              childCount: 0,
              children: [],
              commentCount: 0,
              depth: 0,
              frontier: true,
              latestRun: { id: 7, profile: 'reviewer-qa', status: 'running', worker_session_id: 'worker-session-7' },
              parentCount: 0,
              parents: [],
              status: 'running',
              taskId: 't_worker',
              title: 'Worker task'
            })
          }
          type="button"
        >
          Open worker session
        </button>
        <output data-testid="loop-open">{String(controller.open)}</output>
        <output data-testid="loop-selected">{controller.selectedTaskId || ''}</output>
      </>
    )
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  )
}

describe('useLoopPanelController', () => {
  beforeEach(() => {
    $paneStates.set({ [PREVIEW_PANE_ID]: { open: false } })
  })

  afterEach(() => {
    cleanup()
    $paneStates.set({})
    vi.mocked(openSessionInNewWindow).mockReset()
  })

  it('reopens the shared work rail pane when a Loop row is selected from a persisted-closed state', () => {
    renderControllerHarness()

    expect($paneStates.get()[PREVIEW_PANE_ID]?.open).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /open loop row/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    expect(screen.getByTestId('loop-selected').textContent).toBe('t_root')
    expect($paneStates.get()[PREVIEW_PANE_ID]?.open).toBe(true)
  })

  it('opens Loop worker sessions with the worker profile so cross-profile watch windows hydrate', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open worker session/i }))

    expect(openSessionInNewWindow).toHaveBeenCalledWith('worker-session-7', {
      profile: 'reviewer-qa',
      watch: true
    })
  })
})
