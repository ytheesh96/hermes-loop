import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LiveGraphMessageThread } from './message-thread'
import type { LiveGraphMessage } from './messages'

const message: LiveGraphMessage = {
  author: 'Builder',
  board: 'default',
  body: 'Implemented the source projection.\nTests are green.',
  createdAt: 1_700_000_000,
  id: 'profile\u0000default\u00001',
  status: 'completed',
  taskId: 'task-1',
  taskTitle: 'Build projection',
  workflowId: 'workflow-1'
}

describe('LiveGraphMessageThread', () => {
  it('renders a read-only message with clickable task provenance', () => {
    const onSelectTask = vi.fn()

    render(<LiveGraphMessageThread messages={[message]} onRetry={vi.fn()} onSelectTask={onSelectTask} />)

    expect(screen.getByText(/Implemented the source projection\.\s+Tests are green\./)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Build projection/i }))
    expect(onSelectTask).toHaveBeenCalledWith({ board: 'default', taskId: 'task-1', workflowId: 'workflow-1' })
  })

  it('distinguishes loading, empty, initial error, and stale refresh failure', () => {
    const { rerender } = render(
      <LiveGraphMessageThread loading messages={[]} onRetry={vi.fn()} onSelectTask={vi.fn()} />
    )

    expect(screen.getByRole('status', { name: 'Loading messages…' })).toBeTruthy()

    rerender(<LiveGraphMessageThread messages={[]} onRetry={vi.fn()} onSelectTask={vi.fn()} />)
    expect(screen.getByText('No task comments yet.')).toBeTruthy()

    const onRetry = vi.fn()
    rerender(
      <LiveGraphMessageThread error="offline" messages={[]} onRetry={onRetry} onSelectTask={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(
      <LiveGraphMessageThread error="offline" messages={[message]} onRetry={vi.fn()} onSelectTask={vi.fn()} />
    )
    expect(screen.getByText('Showing the last complete thread. Refresh failed.')).toBeTruthy()
    expect(screen.getByText(/Implemented the source projection\.\s+Tests are green\./)).toBeTruthy()
  })
})
