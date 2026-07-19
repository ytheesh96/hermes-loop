import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $kanbanStatusBySession, reconcileKanbanSessionSourceForComposer } from '@/store/composer-status'
import { $loopagentsBySession } from '@/store/loopagents'
import { $previewStatusBySession } from '@/store/preview-status'
import { $threadScrolledUp } from '@/store/thread-scroll'
import { openSessionInNewWindow } from '@/store/windows'

import { ComposerStatusStack } from './index'

vi.mock('@/store/windows', () => ({
  isSecondaryWindow: () => false,
  openSessionInNewWindow: vi.fn()
}))

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

const renderStack = (sessionId: string, onOpenKanbanTask?: (taskId: string) => void) =>
  render(
    <MemoryRouter>
      <I18nProvider configClient={null}>
        <ComposerStatusStack busy={false} onOpenKanbanTask={onOpenKanbanTask} queue={null} sessionId={sessionId} />
      </I18nProvider>
    </MemoryRouter>
  )

describe('ComposerStatusStack Loop/Kanban rows', () => {
  beforeEach(() => {
    cleanup()
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
    $kanbanStatusBySession.set({})
    $loopagentsBySession.set({})
    $previewStatusBySession.set({})
    $threadScrolledUp.set(false)
    vi.mocked(openSessionInNewWindow).mockClear()
  })

  it('hides subscribed Loop workflows from Tasks while keeping active workers in Subagents', () => {
    reconcileKanbanSessionSourceForComposer({
      activeSessionId: null,
      sourceSessionId: 'logical-origin',
      source: {
        session_id: 'logical-origin',
        tasks: [
          {
            created_by: 'loop_delegation:agent',
            id: 't_subscribed_loop',
            included_child_ids: [],
            included_parent_ids: [],
            status: 'running',
            title: 'Subscribed Loop workflow'
          }
        ],
        workers: [
          {
            current_tool: 'search_files',
            profile: 'reviewer-qa',
            run_id: 77,
            status: 'running',
            task_id: 't_subscribed_loop',
            task_status: 'running',
            task_title: 'Subscribed Loop workflow',
            worker_session_id: 'worker-session-77'
          }
        ]
      }
    })

    renderStack('logical-origin')

    const subagents = screen.getByRole('button', { name: '1 Subagent' })

    expect(subagents.querySelector('.codicon-organization')).toBeTruthy()
    expect(subagents.querySelector('.codicon-agent')).toBeNull()

    fireEvent.click(subagents)

    expect(screen.queryByRole('button', { name: /Tasks/ })).toBeNull()
    expect(screen.getAllByText('Subscribed Loop workflow')).toHaveLength(1)
    expect(screen.queryByText('Loop')).toBeNull()
    expect(screen.getByText('reviewer-qa')).toBeTruthy()
    expect(screen.getByText('Search Files')).toBeTruthy()
  })

  it('opens Loop worker rows with session ids in watch windows before task drawer fallback', () => {
    const onOpenKanbanTask = vi.fn()

    $kanbanStatusBySession.set({
      'logical-origin': [
        {
          id: 'kanban-agent:t_root:77',
          kanbanTaskId: 't_root',
          profile: 'reviewer-qa',
          sessionId: 'worker-session-77',
          state: 'running',
          title: 'Root Loop worker',
          type: 'subagent'
        }
      ]
    })

    renderStack('logical-origin', onOpenKanbanTask)

    fireEvent.click(screen.getByRole('button', { name: '1 Subagent' }))
    fireEvent.click(screen.getByRole('button', { name: /Root Loop worker/i }))

    expect(openSessionInNewWindow).toHaveBeenCalledWith('worker-session-77', { profile: 'reviewer-qa', watch: true })
    expect(onOpenKanbanTask).not.toHaveBeenCalled()
  })
})
