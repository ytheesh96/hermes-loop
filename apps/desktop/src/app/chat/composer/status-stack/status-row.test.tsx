import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { StatusItemRow } from './status-row'

afterEach(() => cleanup())

describe('StatusItemRow worker visuals', () => {
  it('uses the shared Loop/Kanban status indicator grammar when provided', () => {
    const { container, rerender } = render(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Loop',
            id: 'kanban-task:t_triage',
            state: 'running',
            statusIndicator: 'triage',
            title: 'Draft Loop root',
            todoStatus: 'pending',
            type: 'todo'
          }}
        />
      </I18nProvider>
    )

    expect(container.querySelector('.border-dashed')).toBeTruthy()

    rerender(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Loop',
            id: 'kanban-task:t_todo',
            state: 'running',
            statusIndicator: 'pending',
            title: 'Queued Loop root',
            todoStatus: 'pending',
            type: 'todo'
          }}
        />
      </I18nProvider>
    )

    expect(container.querySelector('.codicon-pass-filled')).toBeTruthy()
    expect(container.querySelector('.border-dashed')).toBeNull()

    rerender(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Reviewer',
            id: 'kanban-agent:t_review:1',
            state: 'failed',
            statusIndicator: 'attention',
            title: 'Review required child',
            type: 'kanban-agent'
          }}
        />
      </I18nProvider>
    )

    expect(container.querySelector('.codicon-warning')).toBeTruthy()
    expect(screen.getByText('Review required child').className).not.toContain('text-destructive')

    rerender(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Peacock',
            id: 'kanban-agent:t_blocked:1',
            state: 'failed',
            statusIndicator: 'failed',
            title: 'Blocked child',
            type: 'kanban-agent'
          }}
        />
      </I18nProvider>
    )

    expect(container.querySelector('.codicon-circle-slash')).toBeTruthy()
  })

  it('renders Kanban agents without a distinct badge', () => {
    const { rerender } = render(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            id: 'kanban-agent:t_loop:7',
            currentTool: 'peacock · Terminal',
            state: 'running',
            title: 'Implement Loop worker parity',
            type: 'kanban-agent'
          }}
        />
      </I18nProvider>
    )

    expect(screen.queryByText('Kanban')).toBeNull()
    expect(screen.getByText('Peacock · Terminal')).toBeTruthy()

    rerender(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            id: 'subagent-1',
            state: 'running',
            title: 'Review diff',
            type: 'subagent'
          }}
        />
      </I18nProvider>
    )

    expect(screen.queryByText('Kanban')).toBeNull()
  })

  it('renders Loop as the secondary status for Loop task rows only', () => {
    const { rerender } = render(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Loop',
            id: 'kanban-task:t_loop',
            kanbanTaskId: 't_loop',
            state: 'running',
            title: 'Durable root task',
            todoStatus: 'pending',
            type: 'todo'
          }}
        />
      </I18nProvider>
    )

    expect(screen.getByText('Loop')).toBeTruthy()

    rerender(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            id: 'todo:local',
            state: 'running',
            title: 'Local checklist task',
            todoStatus: 'pending',
            type: 'todo'
          }}
        />
      </I18nProvider>
    )

    expect(screen.queryByText('Loop')).toBeNull()
  })

  it('shrinks long titles before clipping secondary labels', () => {
    render(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Reviewer',
            id: 'kanban-agent:t_loop:9',
            kanbanTaskId: 't_loop',
            state: 'done',
            title: 'Review and verify the Loop draft-root-first implementation handoff behavior',
            type: 'kanban-agent'
          }}
          onOpen={() => undefined}
        />
      </I18nProvider>
    )

    const titleClasses = screen.getByText(
      'Review and verify the Loop draft-root-first implementation handoff behavior'
    ).className

    const secondaryClasses = screen.getByText('Reviewer').className

    expect(titleClasses).toMatch(/(?:^|\s)w-\[18rem\](?:\s|$)/)
    expect(titleClasses).toMatch(/(?:^|\s)shrink(?:\s|$)/)
    expect(titleClasses).not.toMatch(/(?:^|\s)shrink-0(?:\s|$)/)
    expect(secondaryClasses).toMatch(/(?:^|\s)max-w-\[[^\s]+\](?:\s|$)/)
  })

  it('does not show an inline output disclosure when a row opens a Loop task', () => {
    const onOpen = vi.fn()

    const { container } = render(
      <I18nProvider configClient={null}>
        <StatusItemRow
          item={{
            currentTool: 'Peacock',
            id: 'kanban-agent:t_loop:11',
            kanbanTaskId: 't_loop',
            output: 'worker log tail',
            state: 'failed',
            title: 'Blocked Loop child',
            type: 'kanban-agent'
          }}
          onOpen={onOpen}
        />
      </I18nProvider>
    )

    expect(container.querySelector('.codicon-chevron-right')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Blocked Loop child/i }))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('worker log tail')).toBeNull()
  })
})
