import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $kanbanStatusBySession } from '@/store/composer-status'

import { TaskFeedLauncherRow, taskFeedProgress } from './task-feed-launcher-row'

afterEach(() => {
  cleanup()
  $kanbanStatusBySession.set({})
})

describe('TaskFeedLauncherRow', () => {
  it('summarizes every workflow in the session and opens its scoped task feed', () => {
    const onOpen = vi.fn()

    $kanbanStatusBySession.set({
      'session-1': [
        {
          id: 'kanban-workflow:alpha',
          kanbanTaskId: 't_alpha',
          kanbanWorkflowId: 'wf_alpha',
          state: 'running',
          taskProgress: { blocked: 1, completed: 2, pending: 3, total: 6 },
          title: 'Alpha',
          todoStatus: 'in_progress',
          type: 'todo'
        },
        {
          id: 'kanban-workflow:beta',
          kanbanTaskId: 't_beta',
          kanbanWorkflowId: 'wf_beta',
          state: 'done',
          taskProgress: { blocked: 0, completed: 4, pending: 0, total: 4 },
          title: 'Beta',
          todoStatus: 'completed',
          type: 'todo'
        },
        {
          id: 'kanban-agent:t_alpha:1',
          kanbanTaskId: 't_alpha',
          state: 'failed',
          title: 'Worker',
          type: 'subagent'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <TaskFeedLauncherRow onOpen={onOpen} sessionId="session-1" />
      </I18nProvider>
    )

    const launcher = screen.getByRole('button', {
      name: /Task feed 3 pending tasks, 6 completed tasks, 1 blocked task/
    })

    expect(launcher.className).toContain('task-feed-launcher-row')
    expect(launcher.querySelector('.codicon-inbox')).toBeTruthy()
    expect(launcher.querySelector('.codicon-clock')).toBeTruthy()
    expect(launcher.querySelector('.codicon-check')).toBeTruthy()
    expect(launcher.querySelector('.codicon-circle-slash')).toBeTruthy()

    fireEvent.click(launcher)

    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith('session-1')
  })

  it('keeps only the newest summary for a workflow and ignores worker rows', () => {
    expect(
      taskFeedProgress([
        {
          id: 'snapshot',
          kanbanBoard: 'default',
          kanbanTaskId: 't_root',
          kanbanWorkflowId: 'wf',
          state: 'running',
          taskProgress: { blocked: 0, completed: 1, pending: 1, total: 2 },
          title: 'Snapshot',
          type: 'todo'
        },
        {
          id: 'live',
          kanbanBoard: 'default',
          kanbanTaskId: 't_root',
          kanbanWorkflowId: 'wf',
          state: 'running',
          taskProgress: { blocked: 1, completed: 2, pending: 2, total: 5 },
          title: 'Live',
          type: 'todo'
        },
        {
          id: 'worker',
          kanbanTaskId: 't_root',
          state: 'failed',
          title: 'Worker',
          type: 'subagent'
        }
      ])
    ).toEqual({ blocked: 1, completed: 2, pending: 2, total: 5 })
  })

  it('does not render without session tasks', () => {
    render(
      <I18nProvider configClient={null}>
        <TaskFeedLauncherRow onOpen={() => undefined} sessionId="session-1" />
      </I18nProvider>
    )

    expect(screen.queryByRole('button', { name: /Task feed/ })).toBeNull()
  })
})
