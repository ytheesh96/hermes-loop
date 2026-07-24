import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $kanbanStatusBySession } from '@/store/composer-status'
import { $loopagentsBySession, type LoopagentActivity } from '@/store/loopagents'
import { $subagentsBySession, clearSessionSubagents } from '@/store/subagents'

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
      'loop-session': [
        loopWorker({
          filesWritten: ['apps/desktop/src/store/loopagents.ts'],
          startedAt: 500,
          stream: [
            { at: 800, kind: 'tool', text: 'Read File("loopagents.ts")' },
            { at: 900, kind: 'progress', text: 'Retained structured worker activity' }
          ],
          toolCount: 2
        })
      ]
    })

    renderAgents()

    expect(screen.getByText('Spawn tree')).toBeTruthy()
    expect(screen.queryByText('No live subagents')).toBeNull()
    expect(screen.getByText('Implement Loop workers')).toBeTruthy()
    expect(screen.getByText(/^peacock ·/)).toBeTruthy()
    expect(screen.getByText('Read File("loopagents.ts")')).toBeTruthy()
    expect(screen.getByText('Retained structured worker activity')).toBeTruthy()
    expect(screen.getByText('+ apps/desktop/src/store/loopagents.ts')).toBeTruthy()
    expect(screen.queryByText('building the overlay')).toBeNull()
    expect(screen.queryByText(/worker-session-42/)).toBeNull()
  })

  it('renders active Kanban worker snapshot rows when no Loopagent event reached the store', () => {
    const rawLog = 'Warning: Unknown toolsets: moa Query: task Initializing agent... $ git status --short\n$ git diff'

    $kanbanStatusBySession.set({
      'loop-session': [
        {
          currentTool: 'Terminal',
          id: 'kanban-agent:t_worker:42',
          kanbanTaskId: 't_worker',
          activity: [
            { at: 800, kind: 'tool', text: 'Terminal("git status --short")' },
            { at: 900, kind: 'progress', text: 'Checked the current branch' }
          ],
          output: rawLog,
          profile: 'bme',
          startedAt: 500,
          state: 'running',
          title: 'Inventory pending BME tech support work',
          type: 'subagent'
        }
      ]
    })

    renderAgents()

    expect(screen.queryByText('No live subagents')).toBeNull()
    expect(screen.getByText('Inventory pending BME tech support work')).toBeTruthy()
    expect(screen.getByText(/^bme ·/)).toBeTruthy()
    expect(screen.getByText('Terminal("git status --short")')).toBeTruthy()
    expect(screen.getByText('Checked the current branch')).toBeTruthy()
    expect(screen.queryByText(rawLog)).toBeNull()
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

  it('shows one compact error headline for a failed Loop worker', () => {
    const rawError = `Worker failed while applying the patch. ${'full terminal output '.repeat(20)}`

    $loopagentsBySession.set({
      'loop-session': [
        loopWorker({
          currentTool: undefined,
          errorPreview: rawError,
          status: 'failed',
          summaryPreview: undefined
        })
      ]
    })

    renderAgents()

    expect(screen.queryByText(rawError)).toBeNull()
    expect(screen.getByText(/^Worker failed while applying the patch\..+…$/)).toBeTruthy()
    expect(screen.getByLabelText('Failed')).toBeTruthy()
  })

  it('keeps a running Loop worker active when its task is blocked', () => {
    $loopagentsBySession.set({
      'loop-session': [
        loopWorker({
          taskStatus: 'blocked',
          summaryPreview: 'review-required: stale blocked task context'
        })
      ]
    })

    renderAgents()

    expect(screen.getByLabelText('Running')).toBeTruthy()
    expect(screen.queryByLabelText('Failed')).toBeNull()
    expect(screen.queryByText('review-required: stale blocked task context')).toBeNull()
  })

  it('keeps ordinary subagent structured progress visible', () => {
    $subagentsBySession.set({
      'loop-session': [
        {
          filesRead: [],
          filesWritten: [],
          goal: 'Normal delegated worker',
          id: 'subagent:normal-worker',
          parentId: null,
          startedAt: 1_000,
          status: 'running',
          stream: [{ at: 1_100, kind: 'tool', text: 'Structured normal progress' }],
          taskCount: 1,
          taskIndex: 0,
          updatedAt: 1_100
        }
      ]
    })

    renderAgents()

    expect(screen.getByText('Normal delegated worker')).toBeTruthy()
    expect(screen.getByText('Structured normal progress')).toBeTruthy()
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
