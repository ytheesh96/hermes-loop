import { afterEach, describe, expect, it } from 'vitest'

import { $workspaceIsPage, appViewForPath, isOverlayView, routeSessionId, syncWorkspaceIsPage } from './routes'

afterEach(() => {
  $workspaceIsPage.set(false)
})

describe('Graph View route', () => {
  it('is a global workspace page rather than a session or overlay route', () => {
    expect(routeSessionId('/live-graph')).toBeNull()
    expect(appViewForPath('/live-graph')).toBe('live-graph')
    expect(isOverlayView('live-graph')).toBe(false)

    syncWorkspaceIsPage('/live-graph')

    expect($workspaceIsPage.get()).toBe(true)
  })
})
