import { describe, expect, it } from 'vitest'

import { parseWorkMap } from './work-map'

describe('parseWorkMap', () => {
  it('normalizes nested payloads, defaults kinds, and drops invalid items', () => {
    const parsed = parseWorkMap({
      work_map: JSON.stringify([
        { id: 'alpha', content: '  Draft loop  ', status: 'pending', dispatchable: 'yes' },
        { id: 'beta', content: 'Review handoff', status: 'blocked', kind: 'publish-gate', attention: ' needs-orchestrator ', verification_state: ' pending ', dispatchable: 'false' },
        { id: '', content: 'skip me', status: 'pending' },
        { id: 'gamma', content: 'skip me too', status: 'unknown' }
      ])
    })

    expect(parsed).toEqual([
      {
        id: 'alpha',
        content: 'Draft loop',
        status: 'pending',
        kind: 'session-step',
        dispatchable: true
      },
      {
        id: 'beta',
        content: 'Review handoff',
        status: 'blocked',
        kind: 'publish-gate',
        attention: 'needs-orchestrator',
        verification_state: 'pending',
        dispatchable: false
      }
    ])
  })
})
