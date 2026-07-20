import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessionTab } from '@/store/session-states'

import { useSlashCommand } from '../session/hooks/use-prompt-actions/slash'

import { onComposerInsertRefsRequest, onComposerSubmitRequest } from './composer/focus'
import { useLoopPanelController } from './use-loop-panel-controller'

const hermesMocks = vi.hoisted(() => ({
  addLoopTaskComment: vi.fn(),
  archiveLoopNodes: vi.fn(),
  createLoopDraftTask: vi.fn(),
  getLoopCanvasPositions: vi.fn(),
  getKanbanCapabilities: vi.fn(),
  getLoopSessionSource: vi.fn(),
  getLoopTaskDetail: vi.fn(),
  linkLoopTasks: vi.fn(),
  loopSourceFromDraftResult: vi.fn(
    (sessionId: string, result: { source?: unknown; task?: null | { id: string } }) =>
      result.source ||
      (result.task ? { workflow_id: result.task.id, session_id: sessionId, tasks: [result.task] } : null)
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

vi.mock('@/store/session-states', async importOriginal => ({
  ...(await importOriginal()),
  openSessionTab: vi.fn()
}))

function demoLoopSource() {
  return {
    board: 'default',
    latest_event_id: 9,
    workflow_id: 'LIVE DISPOSABLE DEMO',
    tasks: [
      {
        assignee: 'orchestrator',
        id: 'LIVE DISPOSABLE DEMO',
        included_child_ids: ['Loop draft', 'Running child', 'Done child'],
        status: 'scheduled',
        title: 'LIVE DISPOSABLE DEMO DATA'
      },
      {
        assignee: 'orchestrator',
        id: 'Loop draft',
        included_parent_ids: ['LIVE DISPOSABLE DEMO', 'Completed parent'],
        status: 'scheduled',
        title: 'Loop draft'
      },
      {
        id: 'Completed parent',
        included_child_ids: ['Loop draft'],
        status: 'done',
        title: 'Completed parent'
      },
      {
        active_decomposition_child_count: 1,
        id: 'Running child',
        included_parent_ids: ['LIVE DISPOSABLE DEMO'],
        status: 'running',
        title: 'Running child'
      },
      {
        id: 'Done child',
        included_parent_ids: ['LIVE DISPOSABLE DEMO'],
        status: 'done',
        title: 'Done child'
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
      loopSourceSessionId: 'session-1'
    })

    const activeSessionIdRef = useRef<string | null>('session-1')
    const busyRef = useRef(false)
    const selectedStoredSessionIdRef = useRef<string | null>('session-1')

    const executeSlashCommand = useSlashCommand({
      activeSessionIdRef,
      appendSessionTextMessage: vi.fn(),
      branchCurrentSession: async () => true,
      busyRef,
      copy: {} as never,
      createBackendSessionForSend: async () => 'session-1',
      handleSkinCommand: () => '',
      handoffSession: async () => ({ ok: true }),
      onOpenLoop: controller.onOpen,
      openMemoryGraph: vi.fn(),
      refreshSessions: async () => undefined,
      requestGateway: vi.fn(async () => ({}) as never),
      resumeStoredSession: vi.fn(),
      selectedStoredSessionIdRef,
      startFreshSessionDraft: vi.fn(),
      submitPromptText: async () => true
    })

    const runningRow = controller.state?.rows.find(row => row.taskId === 'Running child')
    const doneRow = controller.state?.rows.find(row => row.taskId === 'Done child')
    const pendingRow = controller.state?.rows.find(row => row.taskId === 'Loop draft')
    const rootRow = controller.state?.rows.find(row => row.taskId === 'LIVE DISPOSABLE DEMO')

    return (
      <>
        <button onClick={() => controller.onSelectTaskId('t_root')} type="button">
          Open Loop row
        </button>
        <button onClick={() => controller.onOpen()} type="button">
          Open Loop canvas
        </button>
        <button onClick={() => void executeSlashCommand('/loop')} type="button">
          Run slash Loop
        </button>
        <button onClick={() => void controller.onCreateTask('Initial Loop task')} type="button">
          Create initial Loop task
        </button>
        <button
          onClick={() =>
            void controller.onCreateTask('Fix flaky auth test', {
              childId: 't_after',
              parentId: 't_before',
              workflowId: 'LIVE DISPOSABLE DEMO'
            })
          }
          type="button"
        >
          Create linked Loop task
        </button>
        <button onClick={() => void controller.onSavePositions([{ taskId: 't_root', x: 120, y: 80 }])} type="button">
          Save Loop positions
        </button>
        <button
          onClick={() => void controller.onSavePositions([{ taskId: 't_new', x: 10, y: 20 }], 't_new')}
          type="button"
        >
          Save new Loop workflow position
        </button>
        <button onClick={() => void controller.onLinkTasks('Completed parent', 'Loop draft')} type="button">
          Connect Loop tasks
        </button>
        <button onClick={() => void controller.onUnlinkTasks('Completed parent', 'Loop draft')} type="button">
          Delete Loop dependency
        </button>
        <button onClick={() => void controller.onLinkTasks('Completed parent', 'Running child')} type="button">
          Connect running child
        </button>
        <button onClick={() => void controller.onUnlinkTasks('Completed parent', 'Done child')} type="button">
          Delete done child dependency
        </button>
        <button onClick={() => void controller.onLinkTasks('LIVE DISPOSABLE DEMO', 'Loop draft')} type="button">
          Connect from Loop workflow
        </button>
        <button onClick={() => void controller.onUnlinkTasks('LIVE DISPOSABLE DEMO', 'Loop draft')} type="button">
          Delete legacy root dependency
        </button>
        <button onClick={() => void controller.onLinkTasks('Running child', 'Loop draft')} type="button">
          Connect from compiled shell
        </button>
        <button onClick={() => runningRow && controller.onTaskAction('archive', runningRow)} type="button">
          Archive running child
        </button>
        <button onClick={() => doneRow && controller.onTaskAction('archive', doneRow)} type="button">
          Archive done child
        </button>
        <button onClick={() => pendingRow && controller.onTaskAction('archive', pendingRow)} type="button">
          Archive pending child
        </button>
        <button onClick={() => pendingRow && controller.onTaskAction('ask-hermes', pendingRow)} type="button">
          Attach pending child
        </button>
        <button onClick={() => rootRow && controller.onTaskAction('block', rootRow)} type="button">
          Block Loop workflow
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
                workflow_id: 't_new',
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
          Open new Loop workflow
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
        <output data-testid="loop-focus-request">{controller.focusRequestKey}</output>
        <output data-testid="loop-selected">{controller.selectedTaskId || ''}</output>
        <output data-testid="loop-root">{controller.state?.workflowId || ''}</output>
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
      workflowId: 'LIVE DISPOSABLE DEMO'
    })
    hermesMocks.getKanbanCapabilities.mockResolvedValue({ live_loop_graph: true })
    hermesMocks.archiveLoopNodes.mockResolvedValue({ archived: ['Loop draft'], ok: true })
    hermesMocks.linkLoopTasks.mockResolvedValue({ ok: true })
    hermesMocks.unlinkLoopTasks.mockResolvedValue({ ok: true })
    hermesMocks.saveLoopCanvasPositions.mockImplementation(async (workflowId: string, positions: unknown[]) => ({
      positions,
      workflowId
    }))
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    cleanup()
    vi.mocked(openSessionTab).mockReset()
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

  it('attaches a Loop task without inserting a canned chat prompt', async () => {
    const onInsertRefs = vi.fn()
    const unsubscribe = onComposerInsertRefsRequest(onInsertRefs)

    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /attach pending child/i }))

    await waitFor(() =>
      expect(onInsertRefs).toHaveBeenCalledWith({
        refs: [{ kind: 'task', label: 'Loop draft', value: 'Loop draft' }],
        target: 'main'
      })
    )
    unsubscribe()
  })

  it('opens the Loop canvas without selecting or creating a task', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open loop canvas/i }))

    expect(screen.getByTestId('loop-open').textContent).toBe('true')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(screen.getByTestId('loop-scope').textContent).toBe('session-1')
    expect(hermesMocks.getLoopSessionSource).not.toHaveBeenCalled()
  })

  it('routes bare /loop through Desktop slash dispatch and focuses the canvas', async () => {
    renderControllerHarness()

    expect(screen.getByTestId('loop-open').textContent).toBe('false')
    expect(screen.getByTestId('loop-focus-request').textContent).toBe('0')

    fireEvent.click(screen.getByRole('button', { name: /run slash loop/i }))

    await waitFor(() => expect(screen.getByTestId('loop-open').textContent).toBe('true'))
    expect(screen.getByTestId('loop-focus-request').textContent).toBe('1')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(hermesMocks.createLoopDraftTask).not.toHaveBeenCalled()
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

  it('keeps a requested task open when the new Loop workflow hydrates', async () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open new loop workflow/i }))

    await waitFor(() => expect(screen.getByTestId('loop-selected').textContent).toBe('t_new'))
    expect(screen.getByTestId('loop-open').textContent).toBe('true')
  })

  it('starts foreground Triage automatically after creating the initial Loop workflow', async () => {
    const submissions: Array<{ target: string; text: string }> = []
    const unsubscribe = onComposerSubmitRequest(detail => submissions.push(detail))
    hermesMocks.createLoopDraftTask.mockResolvedValue({
      source: {
        board: 'default',
        workflow_id: 't_initial',
        session_id: 'session-1',
        tasks: [{ id: 't_initial', status: 'scheduled', title: 'Initial Loop task' }]
      },
      task: { id: 't_initial', status: 'scheduled', title: 'Initial Loop task' }
    })

    renderControllerHarness()
    fireEvent.click(screen.getByRole('button', { name: /create initial loop task/i }))

    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]).toEqual({
      target: 'main',
      text: '/loop-triage Triage Loop workflow task t_initial on Kanban board default: Initial Loop task'
    })
    expect(hermesMocks.createLoopDraftTask).toHaveBeenCalledWith(expect.objectContaining({ assignee: null }))
    expect(hermesMocks.createLoopDraftTask).toHaveBeenCalledWith(
      expect.not.objectContaining({
        childIds: expect.anything(),
        parents: expect.anything(),
        workflowId: expect.anything()
      })
    )
    expect(hermesMocks.getKanbanCapabilities).not.toHaveBeenCalled()

    unsubscribe()
  })

  it('creates a title-only task with its root and initial graph edges in one request', async () => {
    hermesMocks.createLoopDraftTask.mockResolvedValue({
      source: {
        board: 'default',
        workflow_id: 't_created',
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

    renderControllerHarness({ gatewayOpen: true })
    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /create linked loop task/i }))

    await waitFor(() =>
      expect(hermesMocks.createLoopDraftTask).toHaveBeenCalledWith(
        expect.objectContaining({
          childIds: ['t_after'],
          idempotencyKey: expect.stringMatching(/^loop-draft:session-1:/),
          parents: ['t_before'],
          workflowId: 'LIVE DISPOSABLE DEMO',
          sessionId: 'session-1',
          title: 'Fix flaky auth test'
        })
      )
    )
    expect(hermesMocks.getKanbanCapabilities).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
  })

  it.each(['missing capability route', 'unsupported capability'])(
    '%s blocks live-node creation before POST',
    async mode => {
      if (mode === 'missing capability route') {
        hermesMocks.getKanbanCapabilities.mockRejectedValueOnce(new Error('404 Not Found'))
      } else {
        hermesMocks.getKanbanCapabilities.mockResolvedValueOnce({ live_loop_graph: false })
      }

      renderControllerHarness({ gatewayOpen: true })
      await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
      fireEvent.click(screen.getByRole('button', { name: /create linked loop task/i }))

      await waitFor(() =>
        expect(notificationMocks.notifyError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Backend update required: this Hermes backend does not support live Loop graph editing.'
          }),
          'Create Loop task failed'
        )
      )
      expect(hermesMocks.createLoopDraftTask).not.toHaveBeenCalled()
    }
  )

  it('keeps the existing authoring canvas stable when another title-only task is added', async () => {
    hermesMocks.createLoopDraftTask.mockResolvedValue({
      source: {
        workflow_id: 't_created',
        session_id: 'session-1',
        tasks: [{ id: 't_created', status: 'scheduled', title: 'Fix flaky auth test' }]
      },
      task: { id: 't_created', status: 'scheduled', title: 'Fix flaky auth test' }
    })

    renderControllerHarness({ gatewayOpen: true })
    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /create linked loop task/i }))

    await waitFor(() => expect(hermesMocks.createLoopDraftTask).toHaveBeenCalled())
    expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO')
    expect(screen.getByTestId('loop-selected').textContent).toBe('')
    expect(hermesMocks.mergeLoopDraftSource).not.toHaveBeenCalled()
  })

  it('loads and saves durable positions for the current or newly created Loop workflow', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: /save new loop workflow position/i }))
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

  it('lets a pending child add and remove a completed parent through the Loop source', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    hermesMocks.getLoopSessionSource.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /connect loop tasks/i }))

    await waitFor(() =>
      expect(hermesMocks.linkLoopTasks).toHaveBeenCalledWith(
        'Completed parent',
        'Loop draft',
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
      expect(hermesMocks.unlinkLoopTasks).toHaveBeenCalledWith(
        'Completed parent',
        'Loop draft',
        'default',
        'default',
        'LIVE DISPOSABLE DEMO',
        'session-1'
      )
    )
    await waitFor(() => expect(hermesMocks.getLoopSessionSource).toHaveBeenCalled())
  })

  it('rejects dependency mutations once the child is running or complete', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    hermesMocks.linkLoopTasks.mockClear()
    hermesMocks.unlinkLoopTasks.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /connect running child/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete done child dependency/i }))

    expect(hermesMocks.linkLoopTasks).not.toHaveBeenCalled()
    expect(hermesMocks.unlinkLoopTasks).not.toHaveBeenCalled()
    expect(notificationMocks.notify).toHaveBeenCalledTimes(2)
    expect(notificationMocks.notify).toHaveBeenLastCalledWith({
      kind: 'warning',
      message: 'Dependencies can only be changed while the child task is pending.'
    })
  })

  it('treats every workflow task uniformly while guarding active history mutations', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /connect from loop workflow/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete legacy root dependency/i }))
    fireEvent.click(screen.getByRole('button', { name: /connect from compiled shell/i }))
    fireEvent.click(screen.getByRole('button', { name: /archive running child/i }))
    fireEvent.click(screen.getByRole('button', { name: /archive done child/i }))
    fireEvent.click(screen.getByRole('button', { name: /block loop workflow/i }))

    await waitFor(() =>
      expect(hermesMocks.linkLoopTasks).toHaveBeenCalledWith(
        'LIVE DISPOSABLE DEMO',
        'Loop draft',
        'default',
        'default',
        'LIVE DISPOSABLE DEMO',
        'session-1'
      )
    )
    expect(hermesMocks.unlinkLoopTasks).toHaveBeenCalledWith(
      'LIVE DISPOSABLE DEMO',
      'Loop draft',
      'default',
      'default',
      'LIVE DISPOSABLE DEMO',
      'session-1'
    )
    expect(hermesMocks.updateLoopTaskStatus).toHaveBeenCalledWith(
      'LIVE DISPOSABLE DEMO',
      'blocked',
      'default',
      expect.objectContaining({ board: 'default' })
    )
    expect(notificationMocks.notify).toHaveBeenCalledTimes(3)
  })

  it('archives pending graph nodes through one guarded root-scoped mutation', async () => {
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /archive pending child/i }))

    await waitFor(() =>
      expect(hermesMocks.archiveLoopNodes).toHaveBeenCalledWith(
        'LIVE DISPOSABLE DEMO',
        ['Loop draft'],
        'default',
        'default',
        'session-1'
      )
    )
    expect(hermesMocks.updateLoopTaskStatus).not.toHaveBeenCalledWith(
      'Loop draft',
      'archived',
      expect.anything(),
      expect.anything()
    )
  })

  it('surfaces an atomic archive conflict without falling back to per-task status writes', async () => {
    hermesMocks.archiveLoopNodes.mockRejectedValueOnce(new Error('409 graph changed'))
    renderControllerHarness({ gatewayOpen: true })

    await waitFor(() => expect(screen.getByTestId('loop-root').textContent).toBe('LIVE DISPOSABLE DEMO'))
    fireEvent.click(screen.getByRole('button', { name: /archive pending child/i }))

    await waitFor(() =>
      expect(notificationMocks.notifyError).toHaveBeenCalledWith(expect.any(Error), 'Archive Loop task failed')
    )
    expect(hermesMocks.updateLoopTaskStatus).not.toHaveBeenCalled()
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

  it('opens Loop worker sessions in profile-aware watch tabs', () => {
    renderControllerHarness()

    fireEvent.click(screen.getByRole('button', { name: /open worker session/i }))

    expect(openSessionTab).toHaveBeenCalledWith('worker-session-7', {
      profile: 'reviewer-qa',
      runningHint: true,
      watch: true
    })
  })
})
