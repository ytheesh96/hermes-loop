import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LiveGraphMessageThread } from './message-thread'
import { type LiveGraphMessage, normalizeSessionThreads } from './messages'

const root: LiveGraphMessage = {
  author: '',
  board: 'default',
  body: 'Original foreground request',
  createdAt: 10,
  id: 'profile\u0000default\u0000root\u0000task-1',
  kind: 'root',
  legacyRoot: false,
  rootTaskId: 'task-1',
  taskId: 'task-1',
  taskTitle: 'Build projection',
  workflowId: 'workflow-1'
}

const reply = (id: number, body: string, createdAt: number, taskId = 'task-1'): LiveGraphMessage => ({
  author: 'Builder',
  board: 'default',
  body,
  createdAt,
  id: `profile\u0000default\u0000reply\u0000${id}`,
  kind: 'reply',
  legacyRoot: false,
  rootTaskId: 'task-1',
  taskId,
  taskTitle: 'Build projection',
  workflowId: 'workflow-1'
})

describe('LiveGraphMessageThread', () => {
  it('renders the request first followed by flat chronological replies without composer or task cards', () => {
    render(
      <LiveGraphMessageThread
        messages={[reply(12, 'Child complete', 30, 'child-1'), root, reply(10, 'Decomposed', 20)]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    const rows = [
      ...screen.getAllByTestId(/live-graph-thread-(root|comment)/)
    ].map(item => item.textContent)
    expect(rows).toEqual([
      expect.stringContaining('Original foreground request'),
      expect.stringContaining('Decomposed'),
      expect.stringContaining('Child complete')
    ])
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /View task/i })).toBeNull()
    expect(screen.queryByText(/completed|unknown/i)).toBeNull()
  })

  it('renders same-timestamp replies by numeric comment id', () => {
    const messages = normalizeSessionThreads('profile', [
      {
        board: 'default',
        latest_reply_id: 10,
        replies: [
          {
            author: 'Builder',
            body: 'Comment ten',
            created_at: 20,
            id: 10,
            root_task_id: 'task-1',
            task_id: 'task-1'
          },
          {
            author: 'Builder',
            body: 'Comment two',
            created_at: 20,
            id: 2,
            root_task_id: 'task-1',
            task_id: 'task-1'
          }
        ],
        threads: [
          {
            created_at: 10,
            description: 'Original foreground request',
            latest_reply_id: 10,
            legacy_root: false,
            origin_session_id: 'session-1',
            root_task_id: 'task-1',
            tenant: 'tenant-1',
            title: 'Build projection',
            workflow_id: 'workflow-1'
          }
        ]
      }
    ])

    render(
      <LiveGraphMessageThread
        messages={messages}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    expect(screen.getAllByTestId('live-graph-thread-comment').map(item => item.textContent)).toEqual([
      expect.stringContaining('Comment two'),
      expect.stringContaining('Comment ten')
    ])
  })

  it('keeps threads in immutable root creation order when later replies arrive', () => {
    const firstRoot = { ...root, taskTitle: 'First request' }
    const secondRoot: LiveGraphMessage = {
      ...root,
      body: 'Second foreground request',
      createdAt: 20,
      id: 'profile\u0000default\u0000root\u0000task-2',
      rootTaskId: 'task-2',
      taskId: 'task-2',
      taskTitle: 'Second request'
    }
    const lateSecondReply: LiveGraphMessage = {
      ...reply(20, 'Late activity', 100, 'task-2'),
      rootTaskId: 'task-2',
      taskTitle: 'Second request'
    }

    render(
      <LiveGraphMessageThread
        messages={[secondRoot, lateSecondReply, firstRoot]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )

    expect(screen.getAllByRole('button', { name: /Messages:/ }).map(item => item.getAttribute('aria-label'))).toEqual([
      'Messages: First request',
      'Messages: Second request'
    ])
  })

  it('keeps explicit thread expansion state when a new reply arrives', () => {
    const { rerender } = render(
      <LiveGraphMessageThread
        messages={[root, reply(10, 'Decomposed', 20)]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )
    const threadButton = screen.getByRole('button', { name: /Messages: Build projection/i })
    fireEvent.click(threadButton)
    expect(threadButton.getAttribute('aria-expanded')).toBe('false')

    rerender(
      <LiveGraphMessageThread
        messages={[root, reply(10, 'Decomposed', 20), reply(11, 'Done', 30)]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
      />
    )
    expect(screen.getByRole('button', { name: /Messages: Build projection/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('distinguishes loading, empty, initial error, and stale refresh failure', () => {
    const { rerender } = render(
      <LiveGraphMessageThread loading messages={[]} onRetry={vi.fn()} onSelectTask={vi.fn()} />
    )
    expect(screen.getByRole('status', { name: 'Loading messages…' })).toBeTruthy()

    rerender(<LiveGraphMessageThread messages={[]} onRetry={vi.fn()} onSelectTask={vi.fn()} />)
    expect(screen.getByText('No task comments yet.')).toBeTruthy()

    const onRetry = vi.fn()
    rerender(<LiveGraphMessageThread error="offline" messages={[]} onRetry={onRetry} onSelectTask={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(
      <LiveGraphMessageThread error="offline" messages={[root]} onRetry={vi.fn()} onSelectTask={vi.fn()} />
    )
    expect(screen.getByText('Showing the last complete thread. Refresh failed.')).toBeTruthy()
    expect(screen.getByText('Original foreground request')).toBeTruthy()
  })

  it('pins appends only while the reader is already at the bottom', () => {
    const threadMessages = [root, reply(10, 'Decomposed', 20), reply(11, 'Done', 30)]
    const { rerender } = render(
      <LiveGraphMessageThread
        messages={threadMessages}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="source-profile"
      />
    )
    const scroller = screen.getByTestId('live-graph-message-thread')
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 }
    })

    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    rerender(
      <LiveGraphMessageThread
        messages={[...threadMessages, { ...threadMessages[2]!, body: 'new while reading', createdAt: 40, id: 'reply-3' }]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="source-profile"
      />
    )
    expect(scroller.scrollTop).toBe(100)

    scroller.scrollTop = 900
    fireEvent.scroll(scroller)
    rerender(
      <LiveGraphMessageThread
        messages={[...threadMessages, { ...threadMessages[2]!, body: 'new at bottom', createdAt: 50, id: 'reply-4' }]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="source-profile"
      />
    )
    expect(scroller.scrollTop).toBe(1_000)
  })
})
