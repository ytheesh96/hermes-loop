import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessionInNewWindow } from '@/store/windows'

import { useLoopPanelController } from './use-loop-panel-controller'

const hermesMocks = vi.hoisted(() => ({
  addLoopTaskComment: vi.fn(),
  createLoopDraftTask: vi.fn(),
  decomposeLoopTask: vi.fn(),
  getLoopCanvasPositions: vi.fn(),
  getLoopSessionSource: vi.fn(),
  getLoopTaskDetail: vi.fn(),
  linkLoopTasks: vi.fn(),
  loopSourceFromDraftResult: vi.fn(
    (sessionId: string, result: { source?: unknown; task?: null | { id: string } }) =>
      result.source ||
      (result.task ? { root_task_id: result.task.id, session_id: sessionId, tasks: [result.task] } : null)
  ),
  mergeLoopDraftSource: vi.fn((_current: unknown, incoming: unknown) => incoming),
  reviewLoopHandoffForTask: vi.fn(),
  saveLoopCanvasPositions: vi.fn(),
  setApiRequestProfile: vi.fn(),
  unlinkLoopTasks: vi.fn(),
  updateLoopTaskStatus: vi.fn()
}))

const notificationMocks = vi.hoisted(() => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/hermes', () => hermesMocks)
vi.mock('@/store/notifications', () => notificationMocks)

vi.mock('@/store/windows', () => ({
  isSecondaryWindow: () => false,
  openSessionInNewWindow: vi.fn()
}))

function demoLoopSource() {
  return {
    board: 'default',
    latest_event_id: 9,
    root_task_id: 'LIVE DISPOSABLE DEMO',
    tasks: [
      {
        assignee: 'orchestrator',
        children: ['Loop draft'],
        id: 'LIVE DISPOSABLE DEMO',
        status: 'scheduled',
        title: 'LIVE DISPOSABLE DEMO DATA'
      },
      {
        assignee: 'orchestrator',
        id: 'Loop draft',
        parents: ['LIVE DISPOSABLE DEMO'],
        status: 'scheduled',
        title: 'Loop draft'
      }
    ]
  }
}

function renderControllerHarness({ gatewayOpen = false }: { gatewayOpen?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })

  function Harness() {
    const controller = useLoopPanelController({
      activeSessionId: 'session-1',
      gatewayOpen,
      loopSourceSessionId: 'session-1',
      onAddContextRef: vi.fn()
    })

    return (
      <>
        <button onClick={() => controller.onSelectTaskId('t_root')} type="button">
          Open Loop row
        </button>
        <button onClick={() => controller.onOpen()} type="button">
          Open Loop canvas
        </button>
        <button onClick={() => void controller.onCreateTask('Fix flaky auth test', 'peacock')} type="button">
          Create Loop task
        </button>
        <button onClick={() => void controller.onSavePositions([{ taskId: 't_root', x: 120, y: 80 }])} type="button">
          Save Loop positions
        </button>
        <button
          onClick={() => void controller.onSavePositions([{ taskId: 't_new', x: 10, y: 20 }], 't_new')}
          type="button"
        >
          Save new Loop root position
        </button>
        <button onClick={() => void controller.onLinkTasks('t_parent', 't_child')} type="button">
          Connect Loop tasks
        </button>
        <button onClick={() => void controller.onUnlinkTasks('t_parent', 't_child')} type="button">
          Delete Loop dependency
        </button>
        <button
          onClick={() =>
            queryClient.setQueriesData({ queryKey: ['loop-session-source'] }, source =>
              source && typeof source === 'object'
                ? {
                    ...source,
                    latest_event_id: Number((source as { latest_event_id?: number }).latest_event_id || 0) + 1
                  }
                : source
            )
          }
          type="button"
        >
          Refresh Loop source
        </button>
        <button
          onClick={() => {
            controller.onSelectTaskId('t_new')
            queryClient.setQueriesData(
              { queryKey: ['loop-session-source'] },
              {
                board: 'default',
                root_task_id: 't_new',
                session_id: 'session-1',
                tasks: [
                  {
                    assignee: 'orchestrator',
                    id: 't_new',
                    session_id: 'session-1',
                    status: 'scheduled',
                    title: 'New Loop task'
                  }
                ]
              }
            )
          }}
          type="button"
        >
          Open new Loop root
        </button>
        <button
          onClick={() =>
            controller.onTaskAction('worker-session', {
              active: true,
              assignee: 'reviewer-qa',
              childCount: 0,
              children: [],
              commentCount: 0,
              depth: 0,
              latestRun: { id: 7, profile: 'reviewer-qa', status: 'running', worker_session_id: 'worker-session-7' },
              parentCount: 0,
              parents: [],
              status: 'running',
              taskId: 't_worker',
              title: 'Worker task'
            })
          }
          type="button"
        >
          Open worker session
        </button>
        <output data-testid="loop-open">{String(controller.open)}</output>
        <output data-testid="loop-selected">{controller.selectedTaskId || ''}</output>
        <output data-testid="loop-root">{controller.state?.rootTaskId || ''}</output>
        <output data-testid="loop-scope">{controller.canvasScopeKey}</output>
        <output data-testid="loop-positions">{JSON.stringify(controller.positions)}</output>
      </>
    )
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  )
}

describe('useLoopPanelController', () => {
  beforeEach(() => {
    hermesMocks.getLoopSessionSource.mockResolvedValue(demoLoopSource())
    hermesMocks.getLoopTaskDetail.mockResolvedValue({ task: null })
    hermesMocks.getLoopCanvasPositions.mockResolvedValue({
      positions: [{ taskId: 'LIVE DISPOSABLE DEMO', updatedAt: 42, x: 100, y: 200 }],
      rootTaskId: 'LIVE DISPOSABLE DEMO'
    })
    hermesMocks.linkLoopTasks.mockResolvedValue({ ok: true })
    hermesMocks.unlinkLoopTasks.mockResolvedValue({ ok: true })
    hermesMocks.saveLoopCanvasPositions.mockImplementation(async (rootTaskId: string, positions: unknown[]) => ({
      positions,
      rootTaskId
    }))
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    cleanup()
    vi.mocked(openSessionInNewWindow).mockReset()
    Object.values(hermesMocks).forEach(mock => mock.mockReset())
    Object.values(notificationMocks).forEach(mock => mock.mockReset())
    window.history.replaceState(null, '', '/')
  })

  it('opens and selects a Loop row', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open loop row/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    expect(screen.getByTestId('loop-selected').textContent).toBe('t_root')
  })

  it('opens the Loop canvas without selecting or creating a task', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open loop canvas/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(screen.getByTestId('loop-scope').textContent).toBe('session-1')
    expect(hermesMocks.getLoopSessionSource).not.toHaveBeenCalled()
  })

  it('keeps an explicitly opened canvas visible when its source hydrates', async () => {
    let resolveSource!: (source: ReturnType<typeof demoLoopSource>) => void

    hermesMocks.getLoopSessionSource.mockReturnValue(
      new Promise<ReturnType<typeof demoLoopSource>>(resolve => {
        resolveSource = resolve
      })
    )

    renderControllerHarness({ gatewayOpen: true })
    fireEvent.click(screen.getByRole('button', { name: /open loop canvas/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    resolveSource(demoLoopSource())

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    expect(screen.getByTestId('loop-open').textContent).toBe('true')
  })

  it('opens a hydrated canvas without selecting its persistence anchor', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /open loop canvas/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(hermesMocks.getLoopCanvasPositions).toHaveBeenCalledWith(
      'LIVE DISPOSABLE DEMO',
      'default',
      'default',
      'session-1'
    )
  })

  it('keeps a requested task open when the new Loop root hydrates', async () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open new loop root/i }))

    await waitFor(() => expect(screen.getByTestId('loop-selected').textContent).toBe('t_new'))
    expect(screen.getByTestId('loop-open').textContent).toBe('true')
  })

  it('creates a title-only task through the draft API and opens the persisted row', async () => {
    hermesMocks.createLoopDraftTask.mockResolvedValue({
      source: {
        board: 'default',
        root_task_id: 't_created',
        session_id: 'session-1',
        tasks: [
          {
            assignee: 'peacock',
            id: 't_created',
            session_id: 'session-1',
            status: 'scheduled',
            title: 'Fix flaky auth test'
          }
        ]
      },
      task: {
        assignee: 'peacock',
        id: 't_created',
        session_id: 'session-1',
        status: 'scheduled',
        title: 'Fix flaky auth test'
      }
    })

    renderControllerHarness()
    fireEvent.click(screen.getByRole('button', { name: /create loop task/i }))

    await waitFor(() =>
      expect(hermesMocks.createLoopDraftTask).toHaveBeenCalledWith(
        expect.objectContaining({
          assignee: 'peacock',
          idempotencyKey: expect.stringMatching(/^loop-draft:session-1:/),
          sessionId: 'session-1',
          title: 'Fix flaky auth test'
        })
      )
    )
    await waitFor(() => expect(screen.getByTestId('loop-selected').textContent).toBe('t_created'))
    expect(screen.getByTestId('loop-root').textContent).toBe('t_created')
    expect(screen.getByTestId('loop-open').textContent).toBe('true')
  })

  it('keeps the existing authoring canvas stable when another title-only task is added', async () => {
    hermesMocks.createLoopDraftTask.mockResolvedValue({
      source: {
        root_task_id: 't_created',
        session_id: 'session-1',
        tasks: [{ id: 't_created', status: 'scheduled', title: 'Fix flaky auth test' }]
      },
      task: { id: 't_created', status: 'scheduled', title: 'Fix flaky auth test' }
    })

    renderControllerHarness({ gatewayOpen: true })
    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /create loop task/i }))

    await waitFor(() => expect(hermesMocks.createLoopDraftTask).toHaveBeenCalled())
    expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(hermesMocks.mergeLoopDraftSource).not.toHaveBeenCalled()
  })

  it('loads and saves durable positions for the current or newly created Loop root', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() =>
      expect(hermesMocks.getLoopCanvasPositions).toHaveBeenCalledWith(
        'LIVE DISPOSABLE DEMO',
        'default',
        'default',
        'session-1'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('loop-positions').textContent).toBe(
        '[{"taskId":"LIVE DISPOSABLE DEMO","updatedAt":42,"x":100,"y":200}]'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: /save loop positions/i }))
    await waitFor(() =>
      expect(hermesMocks.saveLoopCanvasPositions).toHaveBeenCalledWith(
        'LIVE DISPOSABLE DEMO',
        [{ taskId: 't_root', x: 120, y: 80 }],
        'default',
        'default',
        'session-1'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: /save new loop root position/i }))
    await waitFor(() =>
      expect(hermesMocks.saveLoopCanvasPositions).toHaveBeenCalledWith(
        't_new',
        [{ taskId: 't_new', x: 10, y: 20 }],
        'default',
        'default',
        'session-1'
      )
    )
  })

  it('links and unlinks tasks through the Loop source', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    hermesMocks.getLoopSessionSource.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /connect loop tasks/i }))

    await waitFor(() =>
      expect(hermesMocks.linkLoopTasks).toHaveBeenCalledWith(
        't_parent',
        't_child',
        'default',
        'default',
        'LIVE DISPOSABLE DEMO',
        'session-1'
      )
    )
    await waitFor(() => expect(hermesMocks.getLoopSessionSource).toHaveBeenCalled())

    hermesMocks.getLoopSessionSource.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /delete loop dependency/i }))

    await waitFor(() =>
      expect(hermesMocks.unlinkLoopTasks).toHaveBeenCalledWith('t_parent', 't_child', 'default', 'default')
    )
    await waitFor(() => expect(hermesMocks.getLoopSessionSource).toHaveBeenCalled())
  })

  it('surfaces layout-save and dependency-link failures without mutating source state', async () => {
    hermesMocks.saveLoopCanvasPositions.mockRejectedValueOnce(new Error('disk full'))
    hermesMocks.linkLoopTasks.mockRejectedValueOnce(new Error('cycle detected'))
    hermesMocks.unlinkLoopTasks.mockRejectedValueOnce(new Error('database locked'))
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    hermesMocks.getLoopSessionSource.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /save loop positions/i }))
    fireEvent.click(screen.getByRole('button', { name: /connect loop tasks/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete loop dependency/i }))

    await waitFor(() =>
      expect(notificationMocks.notifyError).toHaveBeenCalledWith(expect.any(Error), 'Save Loop layout failed')
    )
    await waitFor(() =>
      expect(notificationMocks.notifyError).toHaveBeenCalledWith(expect.any(Error), 'Connect Loop tasks failed')
    )
    await waitFor(() =>
      expect(notificationMocks.notifyError).toHaveBeenCalledWith(expect.any(Error), 'Delete Loop dependency failed')
    )
    expect(hermesMocks.getLoopSessionSource).not.toHaveBeenCalled()
  })

  it('auto-opens the Loop rail from a public demo launch query once session-source rows hydrate', async () => {
    window.history.replaceState(null, '', '/?loop=1&loopTask=Loop%20draft')

    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-open').textContent).toBe('true'))
    expect(screen.getByTestId('loop-selected').textContent).toBe('Loop draft')
  })

  it('auto-opens a bare Loop launch query without selecting the persistence anchor', async () => {
    window.history.replaceState(null, '', '/?loop=1')

    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-open').textContent).toBe('true'))
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
  })

  it('does not reselect the launch-query Loop row after the user changes selection', async () => {
    window.history.replaceState(null, '', '/?loop=1&loopTask=Loop%20draft')

    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-selected').textContent).toBe('Loop draft'))
    fireEvent.click(screen.getByRole('button', { name: /open loop row/i }))
    expect(screen.getByTestId('loop-selected').textContent).toBe('t_root')

    fireEvent.click(screen.getByRole('button', { name: /refresh loop source/i }))

    await waitFor(() => expect(screen.getByTestId('loop-selected').textContent).toBe('t_root'))
  })

  it('opens Loop worker sessions with the worker profile so cross-profile watch windows hydrate', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open worker session/i }))

    expect(openSessionInNewWindow).toHaveBeenCalledWith('worker-session-7', {
      profile: 'reviewer-qa',
      watch: true
    })
  })
})
