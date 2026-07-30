import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LiveGraphSnapshot } from './model'
import { ScopedTaskFeedPaneView } from './scoped-task-feed'

vi.mock('./task-inspector', () => ({
  LiveGraphTaskInspector: ({ node }: { node: { label: string } }) => (
    <div data-testid="scoped-task-inspector">{node.label}</div>
  )
}))

const graph: LiveGraphSnapshot = {
  edges: [],
  nodes: [
    {
      board: 'alpha',
      entityId: 'task-1',
      id: 'task:alpha:task-1',
      kind: 'task',
      label: 'A very long task title that must remain fully readable instead of being truncated',
      status: 'running'
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

  it('opens the exact task inspector and returns to the preserved feed view', () => {
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
              status: 'running',
              taskId: 'task-1',
              taskTitle: 'Task one',
              workflowId: null
            }
          ],
          onRetry: vi.fn()
        }}
        onViewChange={onViewChange}
        sourceProfile="session-profile"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }))
    fireEvent.click(screen.getByRole('button', { name: /View task: Task one/i }))

    expect(screen.getByTestId('scoped-task-inspector').textContent).toMatch(/very long task title/)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('First comment')).toBeTruthy()
    expect(onViewChange.mock.calls.map(([view]) => view)).toEqual(['messages', 'tasks', 'messages'])
  })
})