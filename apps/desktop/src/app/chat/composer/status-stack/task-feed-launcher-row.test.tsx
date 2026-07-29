import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesExports from '@/hermes'
import { I18nProvider } from '@/i18n'

import { TaskFeedLauncherRow } from './task-feed-launcher-row'

const mocks = vi.hoisted(() => ({ getLoopSessionSources: vi.fn() }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesExports>()),
  getLoopSessionSources: mocks.getLoopSessionSources
}))

function source(statuses: string[]) {
  return {
    board: 'default',
    session_id: 'session-1',
    tasks: statuses.map((status, index) => ({ id: `task-${index}`, status, title: `Task ${index}` }))
  }
}

function renderRow(
  props: Partial<React.ComponentProps<typeof TaskFeedLauncherRow>> = {},
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  onRender: React.ProfilerOnRenderCallback = () => undefined
) {
  const onOpen = props.onOpen ?? vi.fn()

  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null}>
        <Profiler id="task-feed-launcher" onRender={onRender}>
          <TaskFeedLauncherRow
            enabled
            onOpen={onOpen}
            profile="peacock"
            sourceSessionId="session-1"
            {...props}
          />
        </Profiler>
      </I18nProvider>
    </QueryClientProvider>
  )

  return { onOpen, queryClient }
}

beforeEach(() => {
  mocks.getLoopSessionSources.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TaskFeedLauncherRow', () => {
  it('summarizes scoped graph tasks and opens the requested dock', async () => {
    mocks.getLoopSessionSources.mockResolvedValue([
      source(['scheduled', 'running', 'succeeded', 'review_required'])
    ])
    const { onOpen } = renderRow()

    const launcher = await screen.findByRole('button', {
      name: /Task feed 2 pending tasks, 1 completed task, 1 blocked task/
    })

    expect(launcher.className).toContain('task-feed-launcher-row')
    expect(mocks.getLoopSessionSources).toHaveBeenCalledWith('session-1', 'peacock')
    fireEvent.click(launcher)
    fireEvent.click(launcher, { shiftKey: true })

    expect(onOpen).toHaveBeenNthCalledWith(1, 'session-1', 'center')
    expect(onOpen).toHaveBeenNthCalledWith(2, 'session-1', 'right')
  })

  it('does not query or render for a disabled session tile', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['loop-session-source', 'peacock', 'session-1'], [source(['running'])])

    renderRow({ enabled: false }, queryClient)

    await act(async () => undefined)
    expect(mocks.getLoopSessionSources).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Task feed/ })).toBeNull()
  })

  it('stays hidden when the scoped graph has no tasks', async () => {
    mocks.getLoopSessionSources.mockResolvedValue([])
    renderRow()

    await waitFor(() => expect(mocks.getLoopSessionSources).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: /Task feed/ })).toBeNull()
  })

  it('updates from query invalidation without the graph pane being open', async () => {
    mocks.getLoopSessionSources
      .mockResolvedValueOnce([source(['scheduled'])])
      .mockResolvedValueOnce([source(['completed', 'blocked'])])
    const { queryClient } = renderRow()

    expect(await screen.findByRole('button', { name: /Task feed 1 pending task/ })).toBeTruthy()

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source'] })
    })

    expect(await screen.findByRole('button', { name: /Task feed 1 completed task, 1 blocked task/ })).toBeTruthy()
  })

  it('polls active tasks at 2 seconds and idle tasks at 10 seconds', async () => {
    vi.useFakeTimers()
    mocks.getLoopSessionSources.mockImplementation(async () => [source(['running'])])
    const onRender = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderRow({}, queryClient, onRender)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mocks.getLoopSessionSources).toHaveBeenCalledTimes(1)
    const rendersAfterInitialData = onRender.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999)
    })
    expect(mocks.getLoopSessionSources).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.getLoopSessionSources).toHaveBeenCalledTimes(2)
    expect(onRender).toHaveBeenCalledTimes(rendersAfterInitialData)

    mocks.getLoopSessionSources.mockResolvedValue([source(['completed'])])
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source'] })
    })
    const callsAfterIdle = mocks.getLoopSessionSources.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999)
    })
    expect(mocks.getLoopSessionSources).toHaveBeenCalledTimes(callsAfterIdle)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.getLoopSessionSources).toHaveBeenCalledTimes(callsAfterIdle + 1)
  })
})