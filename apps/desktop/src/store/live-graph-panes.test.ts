import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const STORAGE_KEY = 'hermes.desktop.liveGraphPanes.v1'

vi.mock('@/components/pane-shell/tree/store', () => ({
  prepareTreePaneRemovalFocus: vi.fn(),
  revealTreePane: vi.fn()
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
})

describe('Graph View pane store', () => {
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
        profile: 'default',
        sessionRootId: 'root-id',
        sourcePaneId: 'workspace',
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
        sourceSessionId: 'tip/id',
        title: 'Renamed session'
      })
    ])

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    expect(persisted['work:alpha'][0]).not.toHaveProperty('key')
    expect(persisted['work:alpha'][0]).not.toHaveProperty('replacesKey')
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
