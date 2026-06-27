import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $kanbanStatusBySession } from '@/store/composer-status'
import { $loopagentsBySession, type LoopagentActivity } from '@/store/loopagents'
import { clearSessionSubagents } from '@/store/subagents'

import { AgentsView } from '.'

vi.mock('@/lib/use-enter-animation', () => ({
  useEnterAnimation: () => undefined
}))

const loopWorker = (overrides: Partial<LoopagentActivity> = {}): LoopagentActivity => ({
  currentTool: 'search_files',
  id: 'loopagent:worker:t_worker:42',
  kind: 'worker',
  parentTaskIds: [],
  profile: 'peacock',
  runId: 42,
  sourceEvent: 'loopagent.worker.upsert',
  status: 'running',
  summaryPreview: 'building the overlay',
  taskId: 't_worker',
  taskStatus: 'running',
  title: 'Implement Loop workers',
  updatedAt: 1_000,
  workerSessionId: 'worker-session-42',
  ...overrides
})

afterEach(() => {
  cleanup()
  $kanbanStatusBySession.set({})
  $loopagentsBySession.set({})
  clearSessionSubagents('loop-session')
})

function renderAgents() {
  return render(<AgentsView onClose={() => undefined} />)
}

describe('AgentsView Loopagent workers', () => {
  it('renders live Loopagent worker activity from the session store', () => {
    $loopagentsBySession.set({
      'loop-session': [loopWorker()]
    })

    renderAgents()

    expect(screen.getByText('Spawn tree')).toBeTruthy()
    expect(screen.queryByText('No live subagents')).toBeNull()
    expect(screen.getByText('Implement Loop workers')).toBeTruthy()
    expect(screen.getByText(/peacock · Search Files · worker-session-42/)).toBeTruthy()
    expect(screen.getByText('building the overlay')).toBeTruthy()
  })

  it('renders active Kanban worker snapshot rows when no Loopagent event reached the store', () => {
    $kanbanStatusBySession.set({
      'loop-session': [
        {
          currentTool: 'Terminal',
          id: 'kanban-agent:t_worker:42',
          kanbanTaskId: 't_worker',
          profile: 'bme',
          state: 'running',
          title: 'Inventory pending BME tech support work',
          type: 'subagent'
        }
      ]
    })

    renderAgents()

    expect(screen.queryByText('No live subagents')).toBeNull()
    expect(screen.getByText('Inventory pending BME tech support work')).toBeTruthy()
    expect(screen.getByText(/bme · Terminal/)).toBeTruthy()
  })

  it('prefers live Loopagent worker events over duplicate Kanban snapshot fallback rows', () => {
    $kanbanStatusBySession.set({
      'loop-session': [
        {
          currentTool: 'Terminal',
          id: 'kanban-agent:t_worker:42',
          kanbanTaskId: 't_worker',
          profile: 'bme',
          runId: 42,
          sessionId: 'worker-session-42',
          state: 'running',
          title: 'Fallback snapshot title',
          type: 'subagent'
        }
      ]
    })
    $loopagentsBySession.set({
      'loop-session': [loopWorker()]
    })

    renderAgents()

    expect(screen.getByText('Implement Loop workers')).toBeTruthy()
    expect(screen.queryByText('Fallback snapshot title')).toBeNull()
    expect(screen.queryByText(/bme · Terminal/)).toBeNull()
  })

  it('does not clutter the tree with completed historical Loopagent workers', () => {
    $loopagentsBySession.set({
      'loop-session': [
        loopWorker({
          currentTool: undefined,
          id: 'loopagent:worker:t_done:43',
          status: 'completed',
          summaryPreview: 'finished earlier',
          taskId: 't_done',
          taskStatus: 'done',
          title: 'Finished old work',
          workerSessionId: undefined
        })
      ]
    })

    renderAgents()

    expect(screen.getByText('No live subagents')).toBeTruthy()
    expect(screen.queryByText('Finished old work')).toBeNull()
  })
})
