import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $kanbanStatusBySession } from '@/store/composer-status'

import { LoopLauncherRow } from './loop-launcher-row'

afterEach(() => {
  cleanup()
  $kanbanStatusBySession.set({})
})

describe('LoopLauncherRow', () => {
  it('opens the Loop canvas from a full-width coding-status row', () => {
    const onOpen = vi.fn()

    $kanbanStatusBySession.set({
      'session-1': [
        {
          id: 'kanban-task:t_root',
          kanbanTaskId: 't_root',
          state: 'running',
          statusIndicator: 'attention',
          taskProgress: { blocked: 2, completed: 5, pending: 3, total: 10 },
          title: 'Prepare isolated upstream-sync candidate',
          todoStatus: 'in_progress',
          type: 'todo'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={onOpen} sessionId="session-1" />
      </I18nProvider>
    )

    const launcher = screen.getByRole('button', {
      name: /Loop 3 pending tasks, 5 completed tasks, 2 blocked tasks/
    })

    expect(launcher.className).toContain('loop-launcher-row')
    expect(launcher.querySelector('.codicon-type-hierarchy-sub')).toBeTruthy()
    expect(launcher.querySelector('.codicon-clock')).toBeTruthy()
    expect(launcher.querySelector('.codicon-check')).toBeTruthy()
    expect(launcher.querySelector('.codicon-circle-slash')).toBeTruthy()
    expect(screen.queryByText('Prepare isolated upstream-sync candidate')).toBeNull()

    fireEvent.click(launcher)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith()
  })

  it('does not treat a Loop worker as a canvas launcher signal', () => {
    $kanbanStatusBySession.set({
      'session-1': [
        {
          id: 'kanban-agent:t_root:1',
          kanbanTaskId: 't_root',
          state: 'running',
          title: 'Loop worker',
          type: 'subagent'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={() => undefined} sessionId="session-1" />
      </I18nProvider>
    )

    expect(screen.queryByRole('button', { name: /Loop/ })).toBeNull()
  })

  it('sums workflow progress without counting worker rows', () => {
    $kanbanStatusBySession.set({
      'session-1': [
        {
          id: 'kanban-task:t_first',
          kanbanTaskId: 't_first',
          state: 'running',
          taskProgress: { blocked: 1, completed: 2, pending: 3, total: 6 },
          title: 'First workflow',
          todoStatus: 'in_progress',
          type: 'todo'
        },
        {
          id: 'kanban-task:t_second',
          kanbanTaskId: 't_second',
          state: 'done',
          taskProgress: { blocked: 0, completed: 4, pending: 0, total: 4 },
          title: 'Second workflow',
          todoStatus: 'completed',
          type: 'todo'
        },
        {
          id: 'kanban-agent:t_first:1',
          kanbanTaskId: 't_first',
          state: 'failed',
          title: 'Loop worker',
          type: 'subagent'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={() => undefined} sessionId="session-1" />
      </I18nProvider>
    )

    expect(
      screen.getByRole('button', {
        name: /Loop 3 pending tasks, 6 completed tasks, 1 blocked task/
      })
    ).toBeTruthy()
  })

  it('hides empty counters', () => {
    $kanbanStatusBySession.set({
      'session-1': [
        {
          id: 'kanban-task:t_done',
          kanbanTaskId: 't_done',
          state: 'done',
          taskProgress: { blocked: 0, completed: 4, pending: 0, total: 4 },
          title: 'Completed workflow',
          todoStatus: 'completed',
          type: 'todo'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={() => undefined} sessionId="session-1" />
      </I18nProvider>
    )

    const launcher = screen.getByRole('button', { name: 'Loop 4 completed tasks' })

    expect(launcher.querySelector('.codicon-check')).toBeTruthy()
    expect(launcher.querySelector('.codicon-clock')).toBeNull()
    expect(launcher.querySelector('.codicon-circle-slash')).toBeNull()
  })
})
