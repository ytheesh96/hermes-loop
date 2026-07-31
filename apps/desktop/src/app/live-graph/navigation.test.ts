import { describe, expect, it } from 'vitest'

import { liveGraphNavigationState, readLiveGraphNavigationTarget } from './navigation'

describe('live graph route navigation', () => {
  it('keeps session and board-aware task targets bounded', () => {
    expect(readLiveGraphNavigationTarget(liveGraphNavigationState({ entityId: ' root ', kind: 'session' }))).toEqual({
      entityId: 'root',
      kind: 'session'
    })

    expect(
      readLiveGraphNavigationTarget(liveGraphNavigationState({ board: ' alpha ', entityId: ' task-1 ', kind: 'task' }))
    ).toEqual({ board: 'alpha', entityId: 'task-1', kind: 'task' })
  })

  it('rejects unrelated route state', () => {
    expect(readLiveGraphNavigationTarget(null)).toBeNull()
    expect(readLiveGraphNavigationTarget({ liveGraphTarget: { entityId: '', kind: 'task' } })).toBeNull()
    expect(readLiveGraphNavigationTarget({ liveGraphTarget: { entityId: 'x', kind: 'workflow' } })).toBeNull()
    expect(readLiveGraphNavigationTarget({ liveGraphTarget: { kind: 'feed' } })).toBeNull()
  })
})
