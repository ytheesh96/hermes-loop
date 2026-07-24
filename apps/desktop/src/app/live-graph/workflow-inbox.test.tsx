import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { LiveGraphNode } from './model'
import { LiveGraphWorkflowInbox } from './workflow-inbox'

interface TestMotionProps extends HTMLAttributes<HTMLElement> {
  exit?: unknown
  layout?: unknown
  layoutId?: unknown
  transition?: unknown
}

vi.mock('motion/react', async () => {
  const React = await import('react')

  const element = (tag: 'article' | 'div') =>
    function TestMotionElement({ exit, layout, layoutId, transition, ...props }: TestMotionProps) {
      return React.createElement(tag, props)
    }

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    LayoutGroup: ({ children }: { children: ReactNode }) => children,
    motion: {
      article: element('article'),
      div: element('div')
    },
    useReducedMotion: () => true
  }
})

function task(id: string, status: string, overrides: Partial<LiveGraphNode> = {}): LiveGraphNode {
  return {
    board: 'board',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    entityId: id,
    id: `task:work:board:${id}`,
    kind: 'task',
    label: `Task ${id}`,
    status,
    workflowId: 'workflow',
    ...overrides
  }
}

beforeAll(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      removeEventListener: vi.fn()
    }))
  )
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('LiveGraphWorkflowInbox', () => {
  it('separates attention tasks from active tasks and shows real status glyphs and text', () => {
    const onSelectTask = vi.fn()

    const tasks = [
      task('running', 'running', {
        assignee: 'builder-with-a-name-long-enough-to-compete-with-the-status',
        currentTool: 'Kanban Block',
        priority: 2,
        summary: 'Implementing the task inbox.'
      }),
      task('blocked', 'blocked', {
        currentTool: 'Review Diff',
        detail: 'Blocked until the review evidence is complete.'
      }),
      task('failed', 'failed', { result: 'The worker reported a bounded failure.' }),
      task('completed', 'done')
    ]

    const { container } = render(
      <LiveGraphWorkflowInbox onSelectTask={onSelectTask} tasks={tasks} workflowScope="workflow:work:board:workflow" />
    )

    const activeSection = container.querySelector('[data-live-graph-active-tasks]')!
    const attentionSection = container.querySelector('[data-live-graph-attention-tasks]')!

    expect(activeSection.querySelectorAll('[data-live-graph-task-card]')).toHaveLength(1)
    expect(attentionSection.querySelectorAll('[data-live-graph-task-card]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-live-graph-completed-task]')).toHaveLength(1)
    expect(container.querySelector('[data-live-graph-active-count]')?.textContent).toBe('1 Active')
    expect(container.querySelector('[data-live-graph-attention-count]')?.textContent).toBe('2 need attention')
    expect(container.querySelector('[data-live-graph-completed-count]')?.textContent).toBe('1 Completed')
    expect(screen.queryByText('Settled')).toBeNull()
    expect(screen.queryByRole('button', { name: /Settle task|Restore task/ })).toBeNull()

    const runningCard = activeSection.querySelector('[data-live-graph-task-card="task:work:board:running"]')!
    const blockedCard = attentionSection.querySelector('[data-live-graph-task-card="task:work:board:blocked"]')!
    const failedCard = attentionSection.querySelector('[data-live-graph-task-card="task:work:board:failed"]')!

    expect(runningCard.querySelector('.codicon-sync')).toBeTruthy()
    expect(runningCard.textContent).toContain('Running')
    expect(runningCard.querySelector('.codicon-tools')).toBeTruthy()
    expect(runningCard.querySelector('.codicon-git-branch')).toBeNull()
    expect(runningCard.querySelector('[data-live-graph-task-tool-call]')?.textContent).toBe('Kanban Block')
    expect(runningCard.querySelector('[data-live-graph-task-card-description]')?.textContent).toBe(
      'Implementing the task inbox.'
    )
    expect(runningCard.querySelector('[data-live-graph-task-card-metadata]')?.textContent).toContain('P2')
    expect(runningCard.querySelector('[data-live-graph-task-card-metadata]')?.textContent).not.toContain('running')
    expect(runningCard.querySelector('[data-live-graph-task-status="running"]')?.className).toContain('shrink-0')
    expect(blockedCard.querySelector('.codicon-warning')).toBeTruthy()
    expect(blockedCard.textContent).toContain('Blocked')
    expect(blockedCard.querySelector('[data-live-graph-task-card-description]')?.textContent).toBe(
      'Blocked until the review evidence is complete.'
    )
    expect(blockedCard.querySelector('[data-live-graph-task-tool-call]')?.textContent).toBe('Review Diff')
    expect(failedCard.querySelector('.codicon-error')).toBeTruthy()
    expect(failedCard.textContent).toContain('Failed')
    expect(failedCard.querySelector('[data-live-graph-task-card-description]')?.textContent).toBe(
      'The worker reported a bounded failure.'
    )

    expect(
      [...container.querySelectorAll('[data-live-graph-task-card] > button:first-child')].every(element =>
        element.className.includes('h-[8.5rem]')
      )
    ).toBe(true)
    expect(
      [...container.querySelectorAll('[data-live-graph-task-card-description]')].every(
        element => element.className.includes('h-8') && element.className.includes('line-clamp-2')
      )
    ).toBe(true)
    expect(
      [...container.querySelectorAll('[data-live-graph-task-card-title]')].every(
        element => !element.className.includes('h-8') && element.className.includes('line-clamp-2')
      )
    ).toBe(true)
    expect(
      [...container.querySelectorAll('[data-live-graph-task-card-metadata]')].every(element =>
        element.className.includes('mt-auto')
      )
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'View task: Task running' }))
    expect(onSelectTask).toHaveBeenCalledWith('task:work:board:running')
  })

  it('filters the inbox while preserving aggregate task counts', () => {
    const { container } = render(
      <LiveGraphWorkflowInbox
        onSelectTask={vi.fn()}
        tasks={[task('running', 'running'), task('blocked', 'blocked'), task('completed', 'done')]}
        workflowScope="workflow:work:board:workflow"
      />
    )

    const allFilter = screen.getByRole('button', { name: 'All' })
    const activeFilter = screen.getByRole('button', { name: '1 Active' })
    const completedFilter = screen.getByRole('button', { name: '1 Completed' })
    const attentionFilter = screen.getByRole('button', { name: '1 need attention' })

    expect(allFilter.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-live-graph-active-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-attention-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-completed-task]')).toBeTruthy()

    fireEvent.click(activeFilter)
    expect(activeFilter.getAttribute('aria-pressed')).toBe('true')
    expect(allFilter.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-live-graph-active-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-attention-tasks]')).toBeNull()
    expect(container.querySelector('[data-live-graph-completed-task]')).toBeNull()

    fireEvent.click(attentionFilter)
    expect(attentionFilter.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-live-graph-active-tasks]')).toBeNull()
    expect(container.querySelector('[data-live-graph-attention-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-completed-task]')).toBeNull()

    fireEvent.click(completedFilter)
    expect(completedFilter.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-live-graph-active-tasks]')).toBeNull()
    expect(container.querySelector('[data-live-graph-attention-tasks]')).toBeNull()
    expect(container.querySelector('[data-live-graph-completed-task]')).toBeTruthy()

    expect(activeFilter.textContent).toBe('1 Active')
    expect(completedFilter.textContent).toBe('1 Completed')
    expect(attentionFilter.textContent).toBe('1 need attention')

    fireEvent.click(allFilter)
    expect(allFilter.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-live-graph-active-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-attention-tasks]')).toBeTruthy()
    expect(container.querySelector('[data-live-graph-completed-task]')).toBeTruthy()
  })

  it('keeps zero-count filters available and explains empty categories', () => {
    render(
      <LiveGraphWorkflowInbox
        onSelectTask={vi.fn()}
        tasks={[task('running', 'running')]}
        workflowScope="workflow:work:board:workflow"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '0 Completed' }))
    expect(screen.getByText('No completed tasks.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '0 need attention' }))
    expect(screen.getByText('No tasks need attention.')).toBeTruthy()
  })

  it('moves a card to Completed only when its real task status changes', async () => {
    const running = task('one', 'running')

    const { container, rerender } = render(
      <LiveGraphWorkflowInbox onSelectTask={vi.fn()} tasks={[running]} workflowScope="workflow:work:board:workflow" />
    )

    expect(container.querySelectorAll('[data-live-graph-task-card]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-live-graph-completed-task]')).toHaveLength(0)

    rerender(
      <LiveGraphWorkflowInbox
        onSelectTask={vi.fn()}
        tasks={[{ ...running, status: 'done' }]}
        workflowScope="workflow:work:board:workflow"
      />
    )

    await waitFor(() => expect(container.querySelectorAll('[data-live-graph-completed-task]')).toHaveLength(1))
    expect(container.querySelectorAll('[data-live-graph-task-card]')).toHaveLength(0)
    const completedRow = container.querySelector('[data-live-graph-completed-task]')!
    expect(completedRow.querySelector('.codicon-pass-filled')).toBeNull()
    expect(completedRow.textContent).not.toContain('Completed')
    expect(screen.getByRole('heading', { name: 'Completed' })).toBeTruthy()
  })

  it('bounds completed history and reveals the remaining rows on demand', async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task(String(index + 1), 'done'))

    const { container } = render(
      <LiveGraphWorkflowInbox onSelectTask={vi.fn()} tasks={tasks} workflowScope="workflow:work:board:history" />
    )

    expect(container.querySelectorAll('[data-live-graph-completed-task]')).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    await waitFor(() => expect(container.querySelectorAll('[data-live-graph-completed-task]')).toHaveLength(12))
    expect(screen.queryByRole('button', { name: 'Show 2 more' })).toBeNull()
  })
})
