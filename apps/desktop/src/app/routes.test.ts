import { afterEach, describe, expect, it } from 'vitest'

import {
  $workspaceIsPage,
  appViewForPath,
  isOverlayView,
  NEW_CHAT_ROUTE,
  primaryRouteSelectedSessionId,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE,
  syncWorkspaceRoute
} from './routes'

const SESS_A = 'sess-a'
const SESS_B = 'sess-b'

afterEach(() => {
  $workspaceIsPage.set(false)
})

describe('Graph View route', () => {
  it('is a global workspace page rather than a session or overlay route', () => {
    expect(routeSessionId('/live-graph')).toBeNull()
    expect(appViewForPath('/live-graph')).toBe('live-graph')
    expect(isOverlayView('live-graph')).toBe(false)

    syncWorkspaceRoute('/live-graph')

    expect($workspaceIsPage.get()).toBe(true)
  })
})

describe('primaryRouteSelectedSessionId', () => {
  it('prefers the routed session id over a stale/different store selection (#59305)', () => {
    // The route already committed to B while the store selection hasn't
    // caught up yet (still reads A) — the route wins.
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_B), SESS_A)).toBe(SESS_B)
  })

  it('returns null on the new-chat route even with a leftover selection from the previous chat', () => {
    expect(primaryRouteSelectedSessionId(NEW_CHAT_ROUTE, SESS_A)).toBeNull()
  })

  it('falls back to the store selection on a non-chat route (settings, overlays)', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, SESS_A)).toBe(SESS_A)
  })

  it('falls back to the store selection when the route matches the same session', () => {
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_A), SESS_A)).toBe(SESS_A)
  })

  it('returns null on a non-chat route with no store selection', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, null)).toBeNull()
  })
})
