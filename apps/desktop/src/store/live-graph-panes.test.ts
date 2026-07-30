import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dockPaneBeside, revealTreePane, stackPaneWith } from '@/components/pane-shell/tree/store'
import type { SessionInfo } from '@/types/hermes'

const STORAGE_KEY = 'hermes.desktop.liveGraphPanes.v1'

vi.mock('@/components/pane-shell/tree/store', () => ({
  dockPaneBeside: vi.fn(),
  prepareTreePaneRemovalFocus: vi.fn(),
  revealTreePane: vi.fn(),
  stackPaneWith: vi.fn()
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
  vi.clearAllMocks()
  vi.resetModules()
})

describe('Graph View pane store', () => {
  it('migrates legacy descriptors to graph mode', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        default: [
          {
            sessionRootId: 'root-id',
            sourceSessionId: 'runtime-tip',
            title: 'Legacy graph'
          }
        ]
      })
    )

    const store = await import('./live-graph-panes')

    expect(store.$liveGraphPanes.get()).toEqual([
      expect.objectContaining({ key: 'default:root-id', mode: 'graph' })
    ])
  })

  it('keeps one graph and one independently deduped feed for the same logical session', async () => {
    const store = await import('./live-graph-panes')
    const storedSession = session({ _lineage_root_id: 'root-id', id: 'runtime-tip' })

    const graphPaneId = store.openLiveGraphPane(storedSession)

    const feedPaneId = store.openScopedTaskFeedPane(storedSession, {
      dock: 'right',
      sourcePaneId: 'workspace'
    })

    const reopenedFeedPaneId = store.openScopedTaskFeedPane(
      { ...storedSession, title: 'Renamed feed' },
      { dock: 'right', sourcePaneId: 'workspace' }
    )

    expect(graphPaneId).toBe('live-graph:default:root-id')
    expect(feedPaneId).toBe('live-graph:feed:default:root-id')
    expect(reopenedFeedPaneId).toBe(feedPaneId)
    expect(store.$liveGraphPanes.get()).toEqual([
      expect.objectContaining({ key: 'default:root-id', mode: 'graph' }),
      expect.objectContaining({ key: 'feed:default:root-id', mode: 'feed', title: 'Renamed feed' })
    ])
  })

  it('derives the pane source identity from the stored session owner and runtime tip', async () => {
    const store = await import('./live-graph-panes')

    expect(
      store.liveGraphSessionSourceIdentity(
        session({ _lineage_root_id: 'root-id', id: 'runtime-tip', profile: 'session-profile' }),
        'active-profile'
      )
    ).toEqual({ sourceProfile: 'session-profile', sourceSessionId: 'runtime-tip' })
  })

  it('opens and reveals a cross-profile source in the active workspace without duplicating its pane', async () => {
    const { $activeGatewayProfile } = await import('./profile')
    $activeGatewayProfile.set('active-profile')
    const store = await import('./live-graph-panes')

    const storedSession = session({
      _lineage_root_id: 'root-id',
      cwd: '/repo',
      id: 'runtime-tip',
      profile: 'session-profile',
      title: 'Cross-profile graph'
    })

    const sourceIdentity = store.liveGraphSessionSourceIdentity(storedSession, $activeGatewayProfile.get())
    const paneId = store.openLiveGraphPane(storedSession, { dock: 'right', sourcePaneId: 'workspace' })
    store.openLiveGraphPane(
      { ...storedSession, title: 'Renamed graph' },
      { dock: 'right', sourcePaneId: 'workspace' }
    )
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')

    expect(paneId).toBe('live-graph:active-profile:root-id')
    expect(sourceIdentity).toEqual({ sourceProfile: 'session-profile', sourceSessionId: 'runtime-tip' })
    expect(store.$liveGraphPanes.get()).toEqual([
      expect.objectContaining({
        profile: 'active-profile',
        sessionRootId: 'root-id',
        sourceProfile: 'session-profile',
        sourceSessionId: 'runtime-tip',
        title: 'Renamed graph'
      })
    ])
    expect(revealTreePane).toHaveBeenNthCalledWith(1, paneId)
    expect(revealTreePane).toHaveBeenNthCalledWith(2, paneId)
    expect(dockPaneBeside).toHaveBeenNthCalledWith(1, paneId, 'workspace')
    expect(dockPaneBeside).toHaveBeenNthCalledWith(2, paneId, 'workspace')
    expect(persisted['active-profile']).toEqual([
      expect.objectContaining({ sourceProfile: 'session-profile', sourceSessionId: 'runtime-tip' })
    ])
    expect(persisted).not.toHaveProperty('session-profile')
  })

  it('persists an explicit dock correction for a legacy center descriptor', async () => {
    const store = await import('./live-graph-panes')
    const storedSession = session({ _lineage_root_id: 'root-id' })
    const paneId = store.openLiveGraphPane(storedSession)

    store.openLiveGraphPane(storedSession, { dock: 'right', sourcePaneId: 'workspace' })

    expect(store.$liveGraphPanes.get()[0]).toEqual(expect.objectContaining({ dock: 'right' }))
    expect(dockPaneBeside).toHaveBeenCalledWith(paneId, 'workspace')
  })

  it('applies an explicit center correction to an existing right-docked pane', async () => {
    const store = await import('./live-graph-panes')
    const storedSession = session({ _lineage_root_id: 'root-id' })
    const paneId = store.openLiveGraphPane(storedSession, { dock: 'right', sourcePaneId: 'workspace' })

    store.openLiveGraphPane(storedSession, { dock: 'center', sourcePaneId: 'workspace' })

    expect(store.$liveGraphPanes.get()).toHaveLength(1)
    expect(store.$liveGraphPanes.get()[0]).toEqual(expect.objectContaining({ dock: 'center' }))
    expect(stackPaneWith).toHaveBeenCalledWith(paneId, 'workspace')
  })

  it('sanitizes persisted descriptors and drops malformed entries', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        default: [
          null,
          { cwd: 42, dock: 'left', sessionRootId: '', sourceSessionId: 'missing-root' },
          {
            cwd: 42,
            dock: 'left',
            sessionRootId: ' root-id ',
            sourcePaneId: 'not-a-pane',
            sourceSessionId: '',
            title: ' '
          }
        ],
        work: 'not-an-array'
      })
    )

    const { $liveGraphPanes } = await import('./live-graph-panes')

    expect($liveGraphPanes.get()).toEqual([
      {
        cwd: '',
        dock: 'center',
        key: 'default:root-id',
        mode: 'graph',
        profile: 'default',
        sessionRootId: 'root-id',
        sourcePaneId: 'workspace',
        sourceProfile: 'default',
        sourceSessionId: 'root-id',
        title: 'Untitled session'
      }
    ])
  })

  it('opens one encoded pane per profile and promotes a temporary identity in place', async () => {
    const { $activeGatewayProfile } = await import('./profile')
    $activeGatewayProfile.set('work:alpha')
    const store = await import('./live-graph-panes')

    const temporaryId = store.openLiveGraphPane(
      session({ cwd: '/tmp/project', id: 'runtime/id', profile: 'work:alpha', title: 'Draft' }),
      { dock: 'right', sourcePaneId: 'session-tile:runtime/id' }
    )

    expect(temporaryId).toBe('live-graph:work%3Aalpha:runtime%2Fid')

    const durableId = store.openLiveGraphPane(
      session({
        _lineage_ids: ['runtime/id', 'root/id', 'tip/id'],
        _lineage_root_id: 'root/id',
        cwd: '/tmp/project',
        id: 'tip/id',
        profile: 'work:alpha',
        title: 'Renamed session'
      }),
      { sourcePaneId: 'workspace' }
    )

    expect(durableId).toBe('live-graph:work%3Aalpha:root%2Fid')
    expect(store.$liveGraphPanes.get()).toEqual([
      expect.objectContaining({
        dock: 'right',
        key: 'work%3Aalpha:root%2Fid',
        replacesKey: 'work%3Aalpha:runtime%2Fid',
        sessionRootId: 'root/id',
        sourcePaneId: 'session-tile:runtime/id',
        sourceProfile: 'work:alpha',
        sourceSessionId: 'tip/id',
        title: 'Renamed session'
      })
    ])

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    expect(persisted['work:alpha'][0]).not.toHaveProperty('key')
    expect(persisted['work:alpha'][0]).not.toHaveProperty('replacesKey')
  })

  it('reloads an explicit cross-profile source without retargeting it to the workspace profile', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'active-profile': [
          {
            cwd: '/repo',
            dock: 'center',
            sessionRootId: 'root-id',
            sourcePaneId: 'workspace',
            sourceProfile: 'session-profile',
            sourceSessionId: 'runtime-tip',
            title: 'Cross-profile graph'
          }
        ]
      })
    )

    const { $activeGatewayProfile } = await import('./profile')
    $activeGatewayProfile.set('active-profile')
    const store = await import('./live-graph-panes')

    expect(store.$liveGraphPanes.get()).toEqual([
      expect.objectContaining({
        profile: 'active-profile',
        sourceProfile: 'session-profile',
        sourceSessionId: 'runtime-tip'
      })
    ])
  })

  it('keeps persisted open panes isolated by active gateway profile', async () => {
    const { $activeGatewayProfile } = await import('./profile')
    const store = await import('./live-graph-panes')

    store.openLiveGraphPane(session({ id: 'default-session' }))
    expect(store.$liveGraphPanes.get().map(pane => pane.sessionRootId)).toEqual(['default-session'])

    $activeGatewayProfile.set('work')
    expect(store.$liveGraphPanes.get()).toEqual([])
    store.openLiveGraphPane(session({ id: 'work-session', profile: 'work' }))

    $activeGatewayProfile.set('default')
    expect(store.$liveGraphPanes.get().map(pane => pane.sessionRootId)).toEqual(['default-session'])

    store.closeLiveGraphPane(store.$liveGraphPanes.get()[0]!.key)
    expect(store.$liveGraphPanes.get()).toEqual([])

    $activeGatewayProfile.set('work')
    expect(store.$liveGraphPanes.get().map(pane => pane.sessionRootId)).toEqual(['work-session'])
  })
})
