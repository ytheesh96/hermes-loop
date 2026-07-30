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

    fireEvent.click(screen.getByRole('button', { name: /View task: Build projection/i }))
    expect(onSelectTask).toHaveBeenCalledWith({ board: 'default', taskId: 'task-1', workflowId: 'workflow-1' })
  })

  it('groups comments into latest-first task threads while comments stay chronological', () => {
    const older = { ...message, body: 'Older comment', createdAt: 10, id: 'profile\u0000default\u00001' }
    const newer = { ...message, body: 'Newer comment', createdAt: 20, id: 'profile\u0000default\u00002' }

    const newestOther = {
      ...message,
      body: 'Newest other task',
      createdAt: 30,
      id: 'profile\u0000default\u00003',
      taskId: 'task-2',
      taskTitle: 'Review projection'
    }

    render(
      <LiveGraphMessageThread
        messages={[newer, newestOther, older]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    const threadButtons = screen.getAllByRole('button', { name: /Messages:/i })
    expect(threadButtons.map(button => button.textContent)).toEqual([
      expect.stringContaining('Review projection'),
      expect.stringContaining('Build projection')
    ])
    expect(screen.getByText('Newest other task')).toBeTruthy()
    expect(screen.queryByText('Older comment')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Messages: Build projection/i }))
    const comments = screen.getAllByTestId('live-graph-thread-comment').map(item => item.textContent)
    expect(comments).toEqual([
      expect.stringContaining('Newest other task'),
      expect.stringContaining('Older comment'),
      expect.stringContaining('Newer comment')
    ])
  })

  it('preserves explicit expansion choices when live activity reorders threads', () => {
    const build = { ...message, body: 'Build comment', createdAt: 10, id: 'profile\u0000default\u00001' }

    const review = {
      ...message,
      body: 'Review comment',
      createdAt: 20,
      id: 'profile\u0000default\u00002',
      taskId: 'task-2',
      taskTitle: 'Review projection'
    }

    const { rerender } = render(
      <LiveGraphMessageThread
        messages={[build, review]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Messages: Review projection/i }))
    fireEvent.click(screen.getByRole('button', { name: /Messages: Build projection/i }))
    rerender(
      <LiveGraphMessageThread
        messages={[review, { ...build, createdAt: 30, id: 'profile\u0000default\u00003' }]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    expect(screen.getByRole('button', { name: /Messages: Build projection/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: /Messages: Review projection/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.getAllByTestId('live-graph-thread-comment')).toHaveLength(1)
    expect(screen.getByText('Build comment')).toBeTruthy()
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
