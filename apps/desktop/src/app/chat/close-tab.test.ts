import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activePaneId: null as null | string,
  closeActiveTerminal: vi.fn(),
  closeFocusedSessionTab: vi.fn(() => false),
  closeTreePane: vi.fn(),
  focusSelector: ''
}))

vi.mock('@/app/right-sidebar/terminal/terminals', () => ({
  closeActiveTerminal: mocks.closeActiveTerminal
}))

vi.mock('@/components/pane-shell/tree/store', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeTreePaneId: () => mocks.activePaneId,
  closeFocusedSessionTab: mocks.closeFocusedSessionTab,
  closeTreePane: mocks.closeTreePane
}))

vi.mock('@/lib/keybinds/combo', () => ({
  isFocusWithin: (selector: string) => selector === mocks.focusSelector
}))

vi.mock('@/store/session-states', () => ({
  closeSessionTile: vi.fn(),
  nextSessionTileForWorkspace: vi.fn(() => null)
}))

import { $rightRailActiveTabId } from '@/store/layout'
import { $previewTabs, closeRightRail, openPreview, type PreviewTarget } from '@/store/preview'

import { closeActiveTab } from './close-tab'

function fileTarget(path: string): PreviewTarget {
  return {
    kind: 'file',
    label: path,
    path,
    previewKind: 'text',
    source: path,
    url: `file://${path}`
  }
}

describe('closeActiveTab', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { activeElement: null })
    closeRightRail()
    window.localStorage.clear()
    mocks.activePaneId = null
    mocks.closeActiveTerminal.mockClear()
    mocks.closeFocusedSessionTab.mockClear()
    mocks.closeFocusedSessionTab.mockReturnValue(false)
    mocks.closeTreePane.mockClear()
    mocks.focusSelector = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    closeRightRail()
    window.localStorage.clear()
  })

  it('closes the exact native workflow pane before an unrelated open preview', () => {
    mocks.activePaneId = 'loop-workflow:session%3Aone:wf-a'
    openPreview({ kind: 'url', label: 'Preview', source: 'http://127.0.0.1:3000', url: 'http://127.0.0.1:3000' })

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeTreePane).toHaveBeenCalledWith('loop-workflow:session%3Aone:wf-a')
    expect($previewTabs.get()).toHaveLength(1)
  })

  it('falls through to a live preview when the active zone is not a workflow pane', () => {
    mocks.activePaneId = 'workspace'
    openPreview({ kind: 'url', label: 'Preview', source: 'http://127.0.0.1:3000', url: 'http://127.0.0.1:3000' })

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeTreePane).not.toHaveBeenCalled()
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('keeps a focused terminal ahead of the active workflow zone', () => {
    mocks.activePaneId = 'loop-workflow:session:wf-a'
    mocks.focusSelector = '[data-terminal]'

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeActiveTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.closeTreePane).not.toHaveBeenCalled()
  })

  it('closes the active file preview tab (⌘W happy path)', () => {
    openPreview(fileTarget('/work/notes.md'), 'manual')

    expect($previewTabs.get()).toHaveLength(1)
    expect($rightRailActiveTabId.get()).toBe('file:file:///work/notes.md')

    expect(closeActiveTab()).toBe(true)
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('closes the visible tab when the active selection points at a tab that is gone', () => {
    // The rail falls back to tabs[0] until React syncs the selection, so ⌘W has
    // to act on what is actually on screen rather than no-op'ing.
    openPreview(fileTarget('/work/notes.md'), 'manual')
    $rightRailActiveTabId.set('file:file:///work/stale.md')

    expect($previewTabs.get()).toHaveLength(1)
    expect(closeActiveTab()).toBe(true)
    expect($previewTabs.get()).toHaveLength(0)
  })
})
