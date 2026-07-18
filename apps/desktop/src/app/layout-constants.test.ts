import { afterEach, describe, expect, it, vi } from 'vitest'

import { SIDEBAR_COLLAPSE_MEDIA_QUERY } from './layout-constants'

const originalMatchMedia = window.matchMedia

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
})

function matchesAtWidth(width: number): boolean {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => {
      const maxWidth = Number.parseInt(query.match(/max-width:\s*(\d+)px/)?.[1] ?? '', 10)

      return { matches: Number.isFinite(maxWidth) && width <= maxWidth } as MediaQueryList
    })
  })

  return window.matchMedia(SIDEBAR_COLLAPSE_MEDIA_QUERY).matches
}

describe('Desktop sidebar collapse breakpoint', () => {
  it('moves collapsible rails out of the grid at the audited four-pane width', () => {
    expect(matchesAtWidth(966)).toBe(true)
  })

  it('keeps collapsible rails docked on a roomy desktop window', () => {
    expect(matchesAtWidth(1280)).toBe(false)
  })
})
