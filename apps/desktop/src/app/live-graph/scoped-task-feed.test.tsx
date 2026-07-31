import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LiveGraphSnapshot } from './model'
import { ScopedTaskFeedPaneView } from './scoped-task-feed'

vi.mock('./task-inspector', () => ({
  LiveGraphTaskInspector: ({ initialFilter, node }: { initialFilter: string; node: { label: string } }) => (
    <div data-filter={initialFilter} data-testid="scoped-task-inspector">
      {node.label}
    </div>
  )
}))

const graph: LiveGraphSnapshot = {
  edges: [],
  nodes: [
    {
      assignee: 'Builder',
      board: 'alpha',
      createdAt: 15,
      entityId: 'task-1',
      id: 'task:alpha:task-1',
      kind: 'task',
      label: 'A very long task title that must remain fully readable instead of being truncated',
      rootTaskId: 'root-1',
      status: 'running',
      workflowId: 'workflow-1'
    },
    {
      assignee: 'Reviewer',
      board: 'alpha',
      createdAt: 35,
      entityId: 'task-2',
      id: 'task:alpha:task-2',
      kind: 'task',
      label: 'Review second request',
      rootTaskId: 'root-2',
      status: 'running',
      workflowId: 'workflow-1'
    }
  ],
  rootId: 'session:root-id'
}

describe('ScopedTaskFeedPaneView', () => {
  it('uses the full pane for Tasks and Messages without mounting graph chrome', () => {
    const onViewChange = vi.fn()

    render(
      <ScopedTaskFeedPaneView
        graph={graph}
        messageThread={{ loading: false, messages: [], onRetry: vi.fn() }}
        onViewChange={onViewChange}
        sourceProfile="session-profile"
      />
    )

    expect(screen.getByRole('button', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByText(/A very long task title that must remain fully readable/)).toBeTruthy()
    expect(screen.queryByTestId('live-graph-canvas')).toBeNull()
    expect(screen.queryByTestId('live-graph-task-feed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }))
    expect(onViewChange).toHaveBeenCalledWith('messages')
    expect(screen.getByText('No task comments yet.')).toBeTruthy()
  })

  it('opens a non-first thread task on Activity and Back preserves expansion and scroll', () => {
    const onViewChange = vi.fn()

    render(
      <ScopedTaskFeedPaneView
        graph={graph}
        messageThread={{
          messages: [
            {
              author: 'Builder',
              board: 'alpha',
              body: 'First comment',
              createdAt: 10,
              id: 'session-profile\u0000alpha\u00001',
              rootTaskId: 'root-1',
              status: 'running',
              taskId: 'task-1',
              taskTitle: 'Task one',
              workflowId: 'workflow-1'
            },
            {
              author: '',
              board: 'alpha',
              body: 'Second request body',
              createdAt: 30,
              id: 'session-profile\u0000alpha\u0000root\u0000root-2',
              kind: 'root',
              rootTaskId: 'root-2',
              taskId: 'root-2',
              taskTitle: 'Task two',
              workflowId: 'workflow-1'
            }
          ],
          onRetry: vi.fn()
        }}
        onViewChange={onViewChange}
        sourceProfile="session-profile"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }))
    const firstThread = screen.getByRole('button', { name: 'Messages: Task one' })
    const secondThread = screen.getByRole('button', { name: 'Messages: Task two' })
    fireEvent.click(firstThread)
    fireEvent.click(secondThread)
    expect(firstThread.getAttribute('aria-expanded')).toBe('false')
    expect(secondThread.getAttribute('aria-expanded')).toBe('true')

    const scroller = screen.getByTestId('live-graph-message-thread')
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 }
    })
    scroller.scrollTop = 240
    fireEvent.scroll(scroller)

    fireEvent.click(screen.getByRole('button', { name: /View activity: Review second request/i }))
    expect(screen.getByTestId('live-graph-selection-inspector')).toBeTruthy()
    expect(screen.getByTestId('scoped-task-inspector').getAttribute('data-filter')).toBe('activity')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Messages: Task one' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Messages: Task two' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('live-graph-message-thread').scrollTop).toBe(240)
    expect(screen.getByRole('button', { name: 'Messages' }).getAttribute('aria-pressed')).toBe('true')
    expect(onViewChange.mock.calls.map(([view]) => view)).toEqual(['messages', 'tasks', 'messages'])
  })
})