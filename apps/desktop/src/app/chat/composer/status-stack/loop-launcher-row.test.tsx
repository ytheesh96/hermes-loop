import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $kanbanStatusBySession, $selectedLoopWorkflowBySession } from '@/store/composer-status'

import { LoopLauncherRow } from './loop-launcher-row'

afterEach(() => {
  cleanup()
  $kanbanStatusBySession.set({})
  $selectedLoopWorkflowBySession.set({})
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
      name: /Prepare isolated upstream-sync candidate 3 pending tasks, 5 completed tasks, 2 blocked tasks/
    })

    expect(launcher.className).toContain('loop-launcher-row')
    expect(launcher.querySelector('.codicon-type-hierarchy-sub')).toBeTruthy()
    expect(launcher.querySelector('.codicon-clock')).toBeTruthy()
    expect(launcher.querySelector('.codicon-check')).toBeTruthy()
    expect(launcher.querySelector('.codicon-circle-slash')).toBeTruthy()
    expect(screen.getByText('Prepare isolated upstream-sync candidate')).toBeTruthy()

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
        name: /First workflow 3 pending tasks, 2 completed tasks, 1 blocked task/
      })
    ).toBeTruthy()
  })

  it('opens workflows from the ellipsis menu next to Loop', () => {
    const onOpen = vi.fn()
    const onOpenWorkflow = vi.fn()

    $kanbanStatusBySession.set({
      'runtime-session': [
        {
          id: 'kanban-task:t_first',
          kanbanTaskId: 't_first',
          kanbanWorkflowId: 'wf_first',
          state: 'running',
          taskProgress: { blocked: 0, completed: 2, pending: 1, total: 3 },
          title: 'Build public Loop website',
          todoStatus: 'in_progress',
          type: 'todo'
        },
        {
          id: 'kanban-task:t_second',
          kanbanTaskId: 't_second',
          kanbanWorkflowId: 'wf_second',
          state: 'running',
          taskProgress: { blocked: 0, completed: 1, pending: 2, total: 3 },
          title: 'Finish private handoff',
          todoStatus: 'in_progress',
          type: 'todo'
        },
        {
          id: 'kanban-task:t_one_off',
          kanbanTaskId: 't_one_off',
          kanbanWorkflowId: 'wf_one_off',
          state: 'done',
          taskProgress: { blocked: 0, completed: 1, pending: 0, total: 1 },
          title: 'One-off verification delegation',
          todoStatus: 'completed',
          type: 'todo'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={onOpen} onOpenWorkflow={onOpenWorkflow} sessionId="runtime-session" />
      </I18nProvider>
    )

    const trigger = screen.getByRole('button', { name: 'Open workflow' })

    expect(trigger.querySelector('.codicon-kebab-vertical')).toBeTruthy()

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false
    })
    expect(screen.queryByRole('menuitem', { name: /One-off verification delegation/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Finish private handoff/ }))

    expect(onOpenWorkflow).toHaveBeenCalledWith({ board: 'default', workflowId: 'wf_second' })
    expect(onOpen).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', {
        name: /Finish private handoff 2 pending tasks, 1 completed task/
      })
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', {
        name: /Finish private handoff 2 pending tasks, 1 completed task/
      })
    )

    expect(onOpenWorkflow).toHaveBeenLastCalledWith({ board: 'default', workflowId: 'wf_second' })
    expect(onOpenWorkflow).toHaveBeenCalledTimes(2)
  })

  it('distinguishes duplicate workflow ids by board and opens the exact workflow', () => {
    const onOpenWorkflow = vi.fn()

    $kanbanStatusBySession.set({
      'runtime-session': [
        {
          id: 'kanban-task:alpha:t_root',
          kanbanBoard: 'alpha',
          kanbanTaskId: 't_root',
          kanbanWorkflowId: 'wf_shared',
          state: 'running',
          taskProgress: { blocked: 0, completed: 1, pending: 1, total: 2 },
          title: 'Shared workflow on alpha',
          todoStatus: 'in_progress',
          type: 'todo'
        },
        {
          id: 'kanban-task:beta:t_root',
          kanbanBoard: 'beta',
          kanbanTaskId: 't_root',
          kanbanWorkflowId: 'wf_shared',
          state: 'running',
          taskProgress: { blocked: 0, completed: 0, pending: 2, total: 2 },
          title: 'Shared workflow on beta',
          todoStatus: 'in_progress',
          type: 'todo'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={() => undefined} onOpenWorkflow={onOpenWorkflow} sessionId="runtime-session" />
      </I18nProvider>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open workflow' }), {
      button: 0,
      ctrlKey: false
    })

    expect(screen.getAllByText(/wf_shared/).map(node => node.textContent)).toEqual([
      'wf_shared · alpha',
      'wf_shared · beta'
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: /Shared workflow on beta/ }))

    expect(onOpenWorkflow).toHaveBeenCalledWith({ board: 'beta', workflowId: 'wf_shared' })
  })

  it('keeps a single-board workflow label unchanged', () => {
    $kanbanStatusBySession.set({
      'runtime-session': [
        {
          id: 'kanban-task:t_only',
          kanbanBoard: 'default',
          kanbanTaskId: 't_only',
          kanbanWorkflowId: 'wf_only',
          state: 'running',
          taskProgress: { blocked: 0, completed: 0, pending: 2, total: 2 },
          title: 'Only workflow',
          todoStatus: 'in_progress',
          type: 'todo'
        }
      ]
    })

    render(
      <I18nProvider configClient={null}>
        <LoopLauncherRow onOpen={() => undefined} onOpenWorkflow={() => undefined} sessionId="runtime-session" />
      </I18nProvider>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open workflow' }), {
      button: 0,
      ctrlKey: false
    })

    expect(screen.getByText('wf_only')).toBeTruthy()
    expect(screen.queryByText('wf_only · default')).toBeNull()
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

    const launcher = screen.getByRole('button', { name: 'Completed workflow 4 completed tasks' })

    expect(launcher.querySelector('.codicon-check')).toBeTruthy()
    expect(launcher.querySelector('.codicon-clock')).toBeNull()
    expect(launcher.querySelector('.codicon-circle-slash')).toBeNull()
  })
})
