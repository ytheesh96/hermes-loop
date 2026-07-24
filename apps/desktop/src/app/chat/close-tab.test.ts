import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activePaneId: null as null | string,
  closeActiveRightRailTab: vi.fn(),
  closeActiveTerminal: vi.fn(),
  closeTreePane: vi.fn(),
  closeWorkspaceTab: vi.fn(() => false),
  filePreviewTarget: null as null | { path: string },
  focusSelector: '',
  previewTarget: null as null | { url: string }
}))

vi.mock('@/app/right-sidebar/terminal/terminals', () => ({
  closeActiveTerminal: mocks.closeActiveTerminal
}))

vi.mock('@/components/pane-shell/tree/store', () => ({
  activeTreePaneId: () => mocks.activePaneId,
  closeTreePane: mocks.closeTreePane,
  closeWorkspaceTab: mocks.closeWorkspaceTab
}))

vi.mock('@/lib/keybinds/combo', () => ({
  isFocusWithin: (selector: string) => selector === mocks.focusSelector
}))

vi.mock('@/store/preview', () => ({
  $filePreviewTarget: { get: () => mocks.filePreviewTarget },
  $previewTarget: { get: () => mocks.previewTarget },
  closeActiveRightRailTab: mocks.closeActiveRightRailTab
}))

import { closeActiveTab } from './close-tab'

beforeEach(() => {
  mocks.activePaneId = null
  mocks.closeActiveRightRailTab.mockClear()
  mocks.closeActiveTerminal.mockClear()
  mocks.closeTreePane.mockClear()
  mocks.closeWorkspaceTab.mockClear()
  mocks.closeWorkspaceTab.mockReturnValue(false)
  mocks.filePreviewTarget = null
  mocks.focusSelector = ''
  mocks.previewTarget = null
})

describe('closeActiveTab', () => {
  it('closes the exact native workflow pane before an unrelated open preview', () => {
    mocks.activePaneId = 'loop-workflow:session%3Aone:wf-a'
    mocks.previewTarget = { url: 'http://127.0.0.1:3000' }

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeTreePane).toHaveBeenCalledWith('loop-workflow:session%3Aone:wf-a')
    expect(mocks.closeActiveRightRailTab).not.toHaveBeenCalled()
    expect(mocks.closeWorkspaceTab).not.toHaveBeenCalled()
  })

  it('falls through to the preview when the active zone is not a workflow pane', () => {
    mocks.activePaneId = 'workspace'
    mocks.filePreviewTarget = { path: '/tmp/demo.txt' }

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeTreePane).not.toHaveBeenCalled()
    expect(mocks.closeActiveRightRailTab).toHaveBeenCalledTimes(1)
  })

  it('keeps a focused terminal ahead of the active workflow zone', () => {
    mocks.activePaneId = 'loop-workflow:session:wf-a'
    mocks.focusSelector = '[data-terminal]'

    expect(closeActiveTab()).toBe(true)
    expect(mocks.closeActiveTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.closeTreePane).not.toHaveBeenCalled()
  })
})
