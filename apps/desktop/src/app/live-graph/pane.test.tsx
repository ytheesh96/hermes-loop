import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskFeedLauncherRow } from '@/app/chat/composer/status-stack/task-feed-launcher-row'
import type { LoopSessionCommentsSource, TenantLoopSource } from '@/app/chat/loop-state'
import type * as HermesExports from '@/hermes'
import { I18nProvider } from '@/i18n'
import type { SessionInfo } from '@/types/hermes'

import type { LiveGraphSnapshot, SessionLiveGraphInput } from './model'

const mocks = vi.hoisted(() => ({
  buildGraph: vi.fn<(input: SessionLiveGraphInput) => LiveGraphSnapshot>(() => ({ edges: [], nodes: [] })),
  detectPulses: vi.fn(() => []),
  getComments: vi.fn<() => Promise<LoopSessionCommentsSource[]>>(async () => []),
  getSources: vi.fn<() => Promise<TenantLoopSource[]>>(async () => [{ board: 'default', tasks: [] }]),
  view: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesExports>()),
  getLoopSessionComments: mocks.getComments,
  getLoopSessionSources: mocks.getSources
}))

vi.mock('./model', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildSessionLiveGraph: mocks.buildGraph,
  detectLiveGraphPulses: mocks.detectPulses
}))

vi.mock('./view', () => ({
  LiveGraphPaneView: (props: Record<string, unknown>) => {
    mocks.view(props)

    return <div data-testid="live-graph-view" />
  }
}))

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 'session-one',
    input_tokens: 0,
    is_active: true,
    last_active: 1,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: 'desktop',
    started_at: 1,
    title: 'Session one',
    tool_call_count: 0,
    ...overrides
  }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
  mocks.buildGraph.mockClear()
  mocks.detectPulses.mockClear()
  mocks.getComments.mockClear()
  mocks.getSources.mockClear()
  mocks.view.mockClear()
})

afterEach(cleanup)

async function setup() {
  const [tree, model, { registry }, pane, store] = await Promise.all([
    import('@/components/pane-shell/tree/store'),
    import('@/components/pane-shell/tree/model'),
    import('@/contrib/registry'),
    import('./pane'),
    import('@/store/live-graph-panes')
  ])

  registry.register({
    area: 'panes',
    data: { placement: 'main', uncloseable: true },
    id: 'workspace',
    render: () => null,
    title: 'Session one'
  })
  tree.declareDefaultTree(model.group(['workspace'], { id: 'graph-test-main' }))
  tree.watchContributedPanes()
  pane.watchLiveGraphPanes()

  return { model, pane, registry, store, tree }
}

describe('native Graph View panes', () => {
  it('polls comments only for the active Messages view through the stored source profile', async () => {
    mocks.getSources.mockResolvedValue([
      { board: 'alpha', session_id: 'runtime-tip', tasks: [{ id: 'task-1', status: 'running', title: 'Task one' }] }
    ])
    mocks.buildGraph.mockReturnValue({
      edges: [],
      nodes: [{ board: 'alpha', entityId: 'task-1', id: 'task:alpha:task-1', kind: 'task', label: 'Task one' }]
    })
    mocks.getComments.mockResolvedValue([
      {
        board: 'alpha',
        comments: [
          {
            author: 'Builder',
            body: 'Live update',
            created_at: 10,
            id: 1,
            task_id: 'task-1',
            task_status: 'running',
            task_title: 'Task one'
          }
        ]
      }
    ])

    const { $activeGatewayProfile } = await import('@/store/profile')
    $activeGatewayProfile.set('active-profile')
    const { registry, store } = await setup()

    const paneId = store.openLiveGraphPane(
      session({ _lineage_root_id: 'root-id', id: 'runtime-tip', profile: 'session-profile' })
    )

    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={queryClient}>{contribution.render?.()}</QueryClientProvider>)
    await waitFor(() => expect(mocks.view).toHaveBeenCalled())
    expect(mocks.getComments).not.toHaveBeenCalled()

    const initialView = mocks.view.mock.calls.at(-1)?.[0] as {
      onMessageViewChange: (view: 'messages' | 'tasks') => void
    }

    act(() => initialView.onMessageViewChange('messages'))

    await waitFor(() =>
      expect(mocks.getComments).toHaveBeenCalledWith('runtime-tip', 'session-profile', ['alpha'])
    )
    expect(queryClient.getQueryData(['loop-session-comments', 'session-profile', 'runtime-tip'])).toEqual(
      mocks.getComments.mock.results.at(-1)?.value ? await mocks.getComments.mock.results.at(-1)?.value : []
    )
    await waitFor(() => {
      const messagesView = mocks.view.mock.calls.at(-1)?.[0] as {
        messageThread?: { messages?: Array<{ body: string }> }
      }

      expect(messagesView.messageThread?.messages).toEqual([expect.objectContaining({ body: 'Live update' })])
    })
    expect(queryClient.getQueryData(['loop-session-comments', 'active-profile', 'runtime-tip'])).toBeUndefined()
  })

  it('mounts a cross-profile pane and shares its source identity and task count with the composer row', async () => {
    const sources: TenantLoopSource[] = [
      {
        board: 'default',
        session_id: 'runtime-tip',
        tasks: [
          { id: 'pending', status: 'running', title: 'Pending' },
          { id: 'completed', status: 'succeeded', title: 'Completed' },
          { id: 'blocked', status: 'review_required', title: 'Blocked' }
        ]
      }
    ]

    mocks.getSources.mockResolvedValue(sources)

    const { buildSessionLiveGraph } = (await vi.importActual('./model')) as {
      buildSessionLiveGraph: (input: SessionLiveGraphInput) => LiveGraphSnapshot
    }

    mocks.buildGraph.mockImplementationOnce(buildSessionLiveGraph)

    const { $activeGatewayProfile } = await import('@/store/profile')

    $activeGatewayProfile.set('active-profile')
    const { registry, store } = await setup()

    const paneId = store.openLiveGraphPane(
      session({ _lineage_root_id: 'root-id', id: 'runtime-tip', profile: 'session-profile' })
    )

    const descriptor = store.$liveGraphPanes.get()[0]!
    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const { findByRole } = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider configClient={null}>
          {contribution.render?.()}
          <TaskFeedLauncherRow
            enabled
            onOpen={vi.fn()}
            profile={descriptor.sourceProfile}
            sourceSessionId={descriptor.sourceSessionId}
          />
        </I18nProvider>
      </QueryClientProvider>
    )

    expect(descriptor).toEqual(
      expect.objectContaining({ profile: 'active-profile', sourceProfile: 'session-profile', sourceSessionId: 'runtime-tip' })
    )
    expect(await findByRole('button', { name: /Task feed 1 pending task, 1 completed task, 1 blocked task/ })).toBeTruthy()
    await waitFor(() => expect(mocks.getSources).toHaveBeenCalledWith('runtime-tip', 'session-profile'))
    expect(queryClient.getQueryData(['loop-session-source', 'session-profile', 'runtime-tip'])).toEqual(sources)
    expect(queryClient.getQueryData(['loop-session-source', 'active-profile', 'runtime-tip'])).toBeUndefined()
    expect(mocks.buildGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: 'session-profile', sources })
    )

    const mountedGraph = (mocks.view.mock.calls.at(-1)?.[0] as {
      graph?: { nodes: Array<{ kind: string }> }
    }).graph

    expect(mountedGraph?.nodes.filter(node => node.kind === 'task')).toHaveLength(3)
  })

  it('waits for the first complete source snapshot before establishing the pulse baseline', async () => {
    let resolveSources: ((value: TenantLoopSource[]) => void) | undefined
    mocks.getSources.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSources = resolve
        })
    )

    const { registry, store } = await setup()
    const paneId = store.openLiveGraphPane(session())
    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={queryClient}>{contribution.render?.()}</QueryClientProvider>)

    await waitFor(() => expect(mocks.getSources).toHaveBeenCalled())
    expect(mocks.buildGraph).not.toHaveBeenCalled()
    expect(mocks.detectPulses).not.toHaveBeenCalled()

    await act(async () => resolveSources?.([{ board: 'default', tasks: [] }]))

    await waitFor(() => expect(mocks.buildGraph).toHaveBeenCalledTimes(1))
    expect(mocks.detectPulses).toHaveBeenCalledWith(null, expect.anything())
  })

  it('keeps the last complete graph visible when an all-board refetch fails', async () => {
    mocks.getSources
      .mockResolvedValueOnce([{ board: 'default', tasks: [] }])
      .mockRejectedValueOnce(new Error('secondary board is unreadable'))

    const { registry, store } = await setup()
    const paneId = store.openLiveGraphPane(session())
    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={queryClient}>{contribution.render?.()}</QueryClientProvider>)

    await waitFor(() => expect(mocks.buildGraph).toHaveBeenCalled())

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source'] })
    })

    await waitFor(() => expect(mocks.getSources).toHaveBeenCalledTimes(2))
    const latestView = mocks.view.mock.calls.at(-1)?.[0] as { error?: unknown; graph?: unknown }

    expect(latestView.error).toBeNull()
    expect(latestView.graph).toBeTruthy()
    expect(mocks.buildGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: [expect.objectContaining({ board: 'default' })] })
    )
  })

  it('registers and reveals one keep-alive native tab beside its source session', async () => {
    const { model, registry, store, tree } = await setup()

    let paneId = ''
    act(() => {
      paneId = store.openLiveGraphPane(session({ _lineage_root_id: 'root-one' }), {
        sourcePaneId: 'workspace'
      })
    })

    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)
    const group = model.findGroupOfPane(tree.$layoutTree.get()!, paneId)

    expect(contribution?.data).toEqual(
      expect.objectContaining({
        dock: { before: undefined, pane: 'workspace', pos: 'center' },
        keepAliveWhenInactive: true,
        placement: 'main'
      })
    )
    expect(group?.active).toBe(paneId)

    act(() => {
      store.openLiveGraphPane(session({ _lineage_root_id: 'root-one', title: 'Updated title' }))
    })
    expect(registry.getArea('panes').filter(candidate => candidate.id === paneId)).toHaveLength(1)
  }, 15_000)

  it('promotes a temporary pane id without losing its native split', async () => {
    const { model, store, tree } = await setup()
    const temporaryId = store.openLiveGraphPane(session({ id: 'runtime-one' }))
    const originalGroup = model.findGroupOfPane(tree.$layoutTree.get()!, temporaryId)!

    tree.splitTreeZone(originalGroup.id, 'right', temporaryId)
    const movedGroupId = model.findGroupOfPane(tree.$layoutTree.get()!, temporaryId)!.id

    const durableId = store.openLiveGraphPane(
      session({
        _lineage_ids: ['runtime-one', 'root-one', 'tip-one'],
        _lineage_root_id: 'root-one',
        id: 'tip-one'
      })
    )

    expect(model.findGroupOfPane(tree.$layoutTree.get()!, durableId)?.id).toBe(movedGroupId)
    expect(model.allPaneIds(tree.$layoutTree.get()!)).not.toContain(temporaryId)
  })

  it('returns native focus to the source session when the graph closes', async () => {
    const { model, store, tree } = await setup()
    const paneId = store.openLiveGraphPane(session())

    tree.closeTreePane(paneId)

    expect(model.allPaneIds(tree.$layoutTree.get()!)).not.toContain(paneId)
    expect(model.findGroupOfPane(tree.$layoutTree.get()!, 'workspace')?.active).toBe('workspace')
    expect(tree.$treeTabFocusRequest.get()?.paneId).toBe('workspace')
  })

  it('feeds activity across lineage keys without collapsing identical Loop ids from different boards', async () => {
    const { registry, store } = await setup()
    const { $loopagentsBySession } = await import('@/store/loopagents')
    const { $sessions } = await import('@/store/session')
    const { $subagentsBySession } = await import('@/store/subagents')

    const stored = session({
      _lineage_ids: ['root-one', 'tip-one'],
      _lineage_root_id: 'root-one',
      id: 'tip-one'
    })

    $sessions.set([stored])
    $loopagentsBySession.set({
      'root-one': [
        {
          board: 'alpha',
          id: 'loop-shared',
          kind: 'worker',
          parentTaskIds: [],
          sourceEvent: 'worker.started',
          status: 'running',
          taskId: 'task-one',
          title: 'Alpha worker',
          updatedAt: 1
        }
      ],
      'tip-one': [
        {
          board: 'beta',
          id: 'loop-shared',
          kind: 'worker',
          parentTaskIds: [],
          sourceEvent: 'worker.started',
          status: 'running',
          taskId: 'task-one',
          title: 'Beta worker',
          updatedAt: 1
        }
      ]
    })
    $subagentsBySession.set({
      'tip-one': [
        {
          filesRead: [],
          filesWritten: [],
          goal: 'Inspect the graph',
          id: 'subagent-one',
          parentId: null,
          startedAt: 1,
          status: 'running',
          stream: [],
          taskCount: 1,
          taskIndex: 0,
          updatedAt: 1
        }
      ]
    })

    const paneId = store.openLiveGraphPane(stored)
    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={queryClient}>{contribution.render?.()}</QueryClientProvider>)

    await waitFor(() => expect(mocks.getSources).toHaveBeenCalledWith('tip-one', 'default'))
    await waitFor(() =>
      expect(mocks.buildGraph).toHaveBeenLastCalledWith(
        expect.objectContaining({
          loopagents: expect.arrayContaining([
            expect.objectContaining({ board: 'alpha', id: 'loop-shared' }),
            expect.objectContaining({ board: 'beta', id: 'loop-shared' })
          ]),
          sources: [expect.objectContaining({ board: 'default' })],
          subagents: [expect.objectContaining({ id: 'subagent-one' })]
        })
      )
    )
    const latestInput = (mocks.buildGraph.mock.calls.at(-1) as unknown as [{ loopagents: unknown[] }] | undefined)?.[0]
    expect(latestInput?.loopagents).toHaveLength(2)
  })

  it('holds one canvas snapshot while inactive and catches up on reactivation', async () => {
    const { model, registry, store, tree } = await setup()
    const { $loopagentsBySession } = await import('@/store/loopagents')

    const paneId = store.openLiveGraphPane(session())
    const contribution = registry.getArea('panes').find(candidate => candidate.id === paneId)!
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(<QueryClientProvider client={queryClient}>{contribution.render?.()}</QueryClientProvider>)

    await waitFor(() => expect(mocks.getSources).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.buildGraph).toHaveBeenLastCalledWith(
        expect.objectContaining({ sources: [expect.objectContaining({ board: 'default' })] })
      )
    )

    const group = model.findGroupOfPane(tree.$layoutTree.get()!, paneId)!

    act(() => tree.activateTreePane(group.id, 'workspace'))

    const inactiveBuildCount = mocks.buildGraph.mock.calls.length
    const inactiveGraph = (mocks.view.mock.calls.at(-1)?.[0] as { graph?: unknown }).graph

    act(() => {
      $loopagentsBySession.set({
        'session-one': [
          {
            id: 'late-worker',
            kind: 'worker',
            parentTaskIds: [],
            sourceEvent: 'worker.started',
            status: 'running',
            taskId: 'late-task',
            title: 'Late worker',
            updatedAt: 2
          }
        ]
      })
    })

    expect(mocks.buildGraph).toHaveBeenCalledTimes(inactiveBuildCount)
    expect((mocks.view.mock.calls.at(-1)?.[0] as { graph?: unknown }).graph).toBe(inactiveGraph)

    act(() => tree.activateTreePane(group.id, paneId))

    await waitFor(() => expect(mocks.buildGraph.mock.calls.length).toBeGreaterThan(inactiveBuildCount))
    expect(mocks.buildGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ loopagents: [expect.objectContaining({ id: 'late-worker' })] })
    )
  })
})
