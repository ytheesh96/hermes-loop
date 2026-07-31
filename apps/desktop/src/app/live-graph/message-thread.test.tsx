import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LiveGraphMessageThread } from './message-thread'
import { type LiveGraphMessage, normalizeSessionThreads } from './messages'
import type { LiveGraphNode } from './model'

vi.mock('@/components/chat/preview-attachment', () => ({
  PreviewAttachment: ({ target }: { target: string }) => <button type="button">Preview {target}</button>
}))

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
  replyId: id,
  rootTaskId: 'task-1',
  taskId,
  taskTitle: 'Build projection',
  workflowId: 'workflow-1'
})

const task = (overrides: Partial<LiveGraphNode> = {}): LiveGraphNode => ({
  assignee: 'Builder',
  board: 'default',
  createdAt: 25,
  entityId: 'child-1',
  id: 'task:default:child-1',
  kind: 'task',
  label: 'Implement projection',
  status: 'running',
  workflowId: 'workflow-1',
  ...overrides
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

  it('inserts assigned tasks chronologically, omits unassigned and root tasks, and opens Activity', () => {
    const onSelectTask = vi.fn()

    render(
      <LiveGraphMessageThread
        messages={[root, reply(10, 'Decomposed', 20), reply(11, 'Child complete', 30, 'child-1')]}
        onRetry={vi.fn()}
        onSelectTask={onSelectTask}
        sourceProfile="profile"
        tasks={[
          task(),
          task(),
          task({ assignee: '  ', entityId: 'unassigned', id: 'task:default:unassigned' }),
          task({ entityId: 'task-1', id: 'task:default:task-1', label: 'Root duplicate' })
        ]}
      />
    )

    expect(
      screen.getAllByTestId(/live-graph-thread-(root|comment|assignment)/).map(item => item.textContent)
    ).toEqual([
      expect.stringContaining('Original foreground request'),
      expect.stringContaining('Decomposed'),
      expect.stringContaining('Assigned to Builder'),
      expect.stringContaining('Child complete')
    ])
    expect(screen.queryByText('Root duplicate')).toBeNull()
    expect(screen.queryByText('unassigned')).toBeNull()
    expect(screen.getAllByTestId('live-graph-thread-assignment')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /View activity: Implement projection/i }))
    expect(onSelectTask).toHaveBeenCalledWith(
      { board: 'default', taskId: 'child-1', workflowId: 'workflow-1' },
      'activity'
    )
  })

  it('orders same-time replies numerically before deterministic assignment task ids', () => {
    render(
      <LiveGraphMessageThread
        messages={[root, reply(10, 'Comment ten', 20), reply(2, 'Comment two', 20)]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
        tasks={[
          task({ createdAt: 20, entityId: 'child-b', id: 'task:default:child-b', label: 'Child B' }),
          task({ createdAt: 20, entityId: 'child-a', id: 'task:default:child-a', label: 'Child A' })
        ]}
      />
    )

    expect(
      screen.getAllByTestId(/live-graph-thread-(comment|assignment)/).map(item => item.textContent)
    ).toEqual([
      expect.stringContaining('Comment two'),
      expect.stringContaining('Comment ten'),
      expect.stringContaining('Child A'),
      expect.stringContaining('Child B')
    ])
  })

  it('places assignments only in their canonical root thread within a shared workflow', () => {
    const secondRoot: LiveGraphMessage = {
      ...root,
      body: 'Second foreground request',
      createdAt: 11,
      id: 'profile\u0000default\u0000root\u0000task-2',
      rootTaskId: 'task-2',
      taskId: 'task-2',
      taskTitle: 'Second request'
    }

    render(
      <LiveGraphMessageThread
        messages={[root, secondRoot]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
        tasks={[
          task({ entityId: 'child-1', label: 'First child', rootTaskId: 'task-1' }),
          task({ entityId: 'child-2', label: 'Second child', rootTaskId: 'task-2' })
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Messages: Second request' }))

    const threads = screen.getAllByRole('listitem').filter(item =>
      item.querySelector('[aria-label^="Messages:"]')
    )

    expect(threads[0]?.textContent).toContain('First child')
    expect(threads[0]?.textContent).not.toContain('Second child')
    expect(threads[1]?.textContent).toContain('Second child')
    expect(threads[1]?.textContent).not.toContain('First child')
    expect(screen.getAllByTestId('live-graph-thread-assignment')).toHaveLength(2)
  })

  it('renders clickable markdown and keeps long content inside min-width-zero rows', () => {
    const longUrl = `https://example.com/${'a'.repeat(160)}`
    const longTaskId = `task-${'b'.repeat(160)}`

    render(
      <LiveGraphMessageThread
        messages={[
          { ...root, body: `[Review work](${longUrl}) and [artifact](#preview/report.pdf)` },
          reply(10, 'Task metadata', 20, longTaskId)
        ]}
        onRetry={vi.fn()}
        onSelectTask={vi.fn()}
        sourceProfile="profile"
        tasks={[]}
      />
    )

    expect(screen.getByRole('link', { name: 'Review work' }).getAttribute('href')).toBe(longUrl)
    expect(screen.getByRole('button', { name: 'Preview report.pdf' })).toBeTruthy()
    expect(screen.getByTestId('live-graph-message-thread').className).toContain('overflow-x-hidden')
    expect(screen.getByTestId('live-graph-thread-comment').className).toContain('min-w-0')
    expect(screen.getByRole('button', { name: new RegExp(`Comments: ${longTaskId}`) }).className).toContain(
      'break-all'
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
