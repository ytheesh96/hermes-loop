import { describe, expect, it } from 'vitest'

import { safeComposerAction } from './runtime'

describe('safeComposerAction', () => {
  it('returns false for assistant-ui composer teardown races', () => {
    expect(
      safeComposerAction(() => {
        throw new Error('Composer is not available')
      })
    ).toBe(false)
  })

  it('rethrows unrelated errors', () => {
    expect(() =>
      safeComposerAction(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
  })
})
