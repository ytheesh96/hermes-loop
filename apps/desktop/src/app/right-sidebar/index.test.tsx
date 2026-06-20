import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveLoopPanelStateFromTenantSource } from '@/app/chat/loop-state'
import type { HermesReadDirResult } from '@/global'
import {
  $filePreviewTabs,
  $filePreviewTarget,
  $previewTarget,
  clearSessionPreviewRegistry,
  type PreviewTarget
} from '@/store/preview'
import { $activeSessionId, $connection, setCurrentCwd } from '@/store/session'

import { resetProjectTreeState } from './files/use-project-tree'

import { RightSidebarPane } from './index'

const readDir = vi.fn<(path: string) => Promise<HermesReadDirResult>>()
const selectPaths = vi.fn()
const normalizePreviewTarget = vi.fn<(target: string, baseDir?: string) => Promise<PreviewTarget | null>>()
let rectDescriptor: PropertyDescriptor | undefined

function ok(entries: { name: string; path: string; isDirectory: boolean }[]): HermesReadDirResult {
  return { entries }
}

function htmlPreview(path: string): PreviewTarget {
  return {
    kind: 'file',
    label: path.split('/').pop() || path,
    language: 'html',
    path,
    previewKind: 'html',
    source: path,
    url: `file://${path}`
  }
}

function installBridge() {
  ;(
    window as unknown as {
      hermesDesktop: {
        normalizePreviewTarget: typeof normalizePreviewTarget
        readDir: typeof readDir
        selectPaths: typeof selectPaths
      }
    }
  ).hermesDesktop = { normalizePreviewTarget, readDir, selectPaths }
}

describe('RightSidebarPane', () => {
  beforeAll(() => {
    const proto = window.HTMLElement.prototype as unknown as Record<string, () => unknown>

    proto.hasPointerCapture ??= () => false
    proto.releasePointerCapture ??= () => undefined
    proto.scrollIntoView ??= () => undefined
    proto.setPointerCapture ??= () => undefined

    rectDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'getBoundingClientRect')
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 240,
        height: 240,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })
  })

  afterAll(() => {
    if (rectDescriptor) {
      Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', rectDescriptor)
    } else {
      delete (window.HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })

  beforeEach(() => {
    $connection.set(null)
    $activeSessionId.set('session-1')
    $previewTarget.set(null)
    $filePreviewTabs.set([])
    clearSessionPreviewRegistry()
    resetProjectTreeState()
    setCurrentCwd('/repo')
    readDir.mockReset()
    selectPaths.mockReset()
    normalizePreviewTarget.mockReset()
    readDir.mockResolvedValue(ok([{ name: 'README.md', path: '/repo/README.md', isDirectory: false }]))
    selectPaths.mockResolvedValue(['/repo-next'])
    normalizePreviewTarget.mockImplementation(async target => htmlPreview(target))
    installBridge()
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    $activeSessionId.set(null)
    $previewTarget.set(null)
    $filePreviewTabs.set([])
    clearSessionPreviewRegistry()
    setCurrentCwd('')
    resetProjectTreeState()
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('refreshes the current tree without opening the folder picker', async () => {
    const onChangeCwd = vi.fn()

    render(<RightSidebarPane onActivateFile={vi.fn()} onActivateFolder={vi.fn()} onChangeCwd={onChangeCwd} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh tree' }).hasAttribute('disabled')).toBe(false)
    )
    await screen.findByText('README.md')

    fireEvent.click(screen.getByRole('button', { name: 'repo' }))

    await waitFor(() => {
      expect(screen.queryByText('README.md')).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: 'repo' }))

    await screen.findByText('README.md')

    readDir.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tree' }))

    await waitFor(() => expect(readDir).toHaveBeenCalledWith('/repo'))
    expect(selectPaths).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))

    await waitFor(() =>
      expect(selectPaths).toHaveBeenCalledWith({
        defaultPath: '/repo',
        directories: true,
        multiple: false,
        title: 'Change working directory'
      })
    )
    await waitFor(() => expect(onChangeCwd).toHaveBeenCalledWith('/repo-next'))
  })

  it('opens html files as rendered previews from the file tree', async () => {
    readDir.mockResolvedValue(ok([{ name: 'index.html', path: '/repo/index.html', isDirectory: false }]))
    normalizePreviewTarget.mockResolvedValue(htmlPreview('/repo/index.html'))

    render(<RightSidebarPane onActivateFile={vi.fn()} onActivateFolder={vi.fn()} onChangeCwd={vi.fn()} />)

    const file = await screen.findByText('index.html')

    fireEvent.click(file)

    await waitFor(() => {
      expect($previewTarget.get()).toMatchObject({ path: '/repo/index.html', renderMode: 'preview' })
    })
    expect($filePreviewTarget.get()).toBeNull()
  })

  it('shows Loop changed files as a collapsible tree and opens files in source mode', async () => {
    const loopState = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 42,
      session_id: 'session-1',
      tasks: [
        {
          id: 't_loop',
          title: 'Loop implementation',
          status: 'done',
          tenant: 'tenant-a',
          workspace_kind: 'worktree',
          workspace_path: '/worktrees/t_loop',
          latest_run: {
            id: 7,
            metadata: {
              changed_files: [
                { path: 'src/app/chat/loop-panel.tsx', status: 'modified' },
                { path: 'src/app/right-sidebar/index.tsx', status: 'added' },
                { path: 'src/obsolete.ts', status: 'deleted' }
              ]
            },
            status: 'done'
          }
        }
      ],
      tenant: 'tenant-a'
    })

    normalizePreviewTarget.mockImplementation(async target => htmlPreview(target))

    render(
      <RightSidebarPane
        loopState={loopState}
        onActivateFile={vi.fn()}
        onActivateFolder={vi.fn()}
        onChangeCwd={vi.fn()}
      />
    )

    const section = screen.getByTestId('right-sidebar-changed-files')
    const explorerFile = await screen.findByText('README.md')

    expect(section).toBeTruthy()
    expect(explorerFile.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(section.className).toContain('basis-[22rem]')
    expect(section.className).toContain('max-h-[50%]')
    expect(screen.getByText('Changed files')).toBeTruthy()
    expect(screen.getByText('loop-panel.tsx')).toBeTruthy()
    expect(screen.getByText('index.tsx')).toBeTruthy()
    expect(screen.getByText('obsolete.ts')).toBeTruthy()
    expect(screen.getByText('M')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('D')).toBeTruthy()
    for (const statusBadge of ['M', 'A', 'D']) {
      const badgeSlot = screen.getByText(statusBadge).parentElement
      const badgeRow = badgeSlot?.parentElement

      expect(badgeSlot?.className).toContain('w-4')
      expect(badgeSlot?.className).toContain('justify-self-end')
      expect(badgeRow?.className).toContain('grid')
      expect(badgeRow?.className).toContain('overflow-hidden')
      expect(badgeRow?.style.gridTemplateColumns).toBe('auto minmax(0, 1fr) 1rem')
      expect(badgeRow?.style.width).toBeTruthy()
      expect(badgeRow?.style.maxWidth).toBe(badgeRow?.style.width)
    }

    const showFlatButton = within(section).getByRole('button', { name: 'Show changed files as flat list' })
    expect(showFlatButton.querySelector('.codicon-list-unordered')).toBeTruthy()

    fireEvent.click(showFlatButton)

    await screen.findByText('loop-panel.tsx')
    expect(screen.queryByText('src/app/chat/loop-panel.tsx')).toBeNull()
    expect(screen.queryByText('src/app/right-sidebar/index.tsx')).toBeNull()
    expect(screen.queryByText('src/obsolete.ts')).toBeNull()
    expect(screen.getByText('index.tsx')).toBeTruthy()
    expect(screen.getByText('obsolete.ts')).toBeTruthy()
    const showTreeButton = within(section).getByRole('button', { name: 'Show changed files as file tree' })
    expect(showTreeButton.querySelector('.codicon-list-tree')).toBeTruthy()

    fireEvent.click(screen.getByText('index.tsx'))

    await waitFor(() => {
      expect(normalizePreviewTarget).toHaveBeenCalledWith('/worktrees/t_loop/src/app/right-sidebar/index.tsx', '/repo')
      expect($filePreviewTarget.get()).toMatchObject({
        path: '/worktrees/t_loop/src/app/right-sidebar/index.tsx',
        renderMode: 'source'
      })
    })

    fireEvent.click(showTreeButton)

    await screen.findByText('loop-panel.tsx')

    fireEvent.click(screen.getByRole('button', { name: 'repo' }))

    await waitFor(() => {
      expect(screen.queryByText('README.md')).toBeNull()
    })
    expect(section.className).toContain('flex-1')
    expect(section.className).not.toContain('basis-[22rem]')
    expect(section.className).not.toContain('max-h-[50%]')

    const changedFilesToggle = within(section).getByRole('button', { name: /Changed files/ })

    fireEvent.click(changedFilesToggle)

    await waitFor(() => {
      expect(screen.queryByText('loop-panel.tsx')).toBeNull()
    })

    fireEvent.click(changedFilesToggle)

    await screen.findByText('loop-panel.tsx')

    fireEvent.click(screen.getByText('src'))

    await waitFor(() => {
      expect(screen.queryByText('index.tsx')).toBeNull()
    })

    fireEvent.click(screen.getByText('src'))

    await screen.findByText('index.tsx')

    fireEvent.click(screen.getByText('index.tsx'))

    await waitFor(() => {
      expect(normalizePreviewTarget).toHaveBeenCalledWith('/worktrees/t_loop/src/app/right-sidebar/index.tsx', '/repo')
      expect($filePreviewTarget.get()).toMatchObject({
        path: '/worktrees/t_loop/src/app/right-sidebar/index.tsx',
        renderMode: 'source'
      })
    })
    expect($previewTarget.get()).toBeNull()
  }, 10000)

  it('changes Loop changed files between overview aggregate and focused task details', () => {
    const onActivateFile = vi.fn()
    const loopState = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 43,
      root_task_id: 't_root',
      session_id: 'session-1',
      tasks: [
        {
          id: 't_root',
          included_child_ids: ['t_child', 't_duplicate'],
          status: 'todo',
          tenant: 'tenant-a',
          title: 'Loop root',
          workspace_path: '/worktrees/t_root',
          latest_run: {
            id: 8,
            metadata: {
              changed_files: [{ path: 'src/root-only.ts', status: 'modified' }]
            },
            status: 'done'
          }
        },
        {
          id: 't_blocker',
          included_child_ids: ['t_child'],
          status: 'running',
          tenant: 'tenant-a',
          title: 'Nested blocker',
          workspace_path: '/worktrees/t_blocker',
          latest_run: {
            id: 10,
            metadata: {
              changed_files: [{ path: 'src/nested-blocker.ts', status: 'modified' }]
            },
            status: 'running'
          }
        },
        {
          id: 't_child',
          included_parent_ids: ['t_root', 't_blocker'],
          status: 'done',
          tenant: 'tenant-a',
          title: 'Loop child',
          workspace_path: '/worktrees/t_child',
          latest_run: {
            id: 9,
            metadata: {
              changed_files: [{ path: 'src/child-only.ts', status: 'added' }]
            },
            status: 'done'
          }
        },
        {
          id: 't_duplicate',
          included_parent_ids: ['t_root'],
          status: 'done',
          tenant: 'tenant-a',
          title: 'Review duplicate changed file',
          workspace_path: '/worktrees/t_child',
          latest_run: {
            id: 12,
            metadata: {
              changed_files: [{ path: 'src/child-only.ts', status: 'modified' }]
            },
            status: 'done'
          }
        },
        {
          id: 't_unrelated',
          included_parent_ids: [],
          status: 'done',
          tenant: 'tenant-a',
          title: 'Unrelated Loop row',
          workspace_path: '/worktrees/t_unrelated',
          latest_run: {
            id: 11,
            metadata: {
              changed_files: [{ path: 'src/unrelated.ts', status: 'modified' }]
            },
            status: 'done'
          }
        }
      ],
      tenant: 'tenant-a'
    })

    const { rerender } = render(
      <RightSidebarPane
        loopState={loopState}
        onActivateFile={onActivateFile}
        onActivateFolder={vi.fn()}
        onChangeCwd={vi.fn()}
      />
    )

    expect(screen.getByText('root-only.ts')).toBeTruthy()
    expect(screen.getAllByText('child-only.ts')).toHaveLength(2)
    expect(screen.getByText('nested-blocker.ts')).toBeTruthy()
    expect(screen.queryByText('unrelated.ts')).toBeNull()

    rerender(
      <RightSidebarPane
        loopFocusedTaskId="t_child"
        loopState={loopState}
        onActivateFile={onActivateFile}
        onActivateFolder={vi.fn()}
        onChangeCwd={vi.fn()}
      />
    )

    expect(screen.queryByText('root-only.ts')).toBeNull()
    expect(screen.getAllByText('child-only.ts')).toHaveLength(1)
    expect(screen.queryByText('nested-blocker.ts')).toBeNull()
    expect(screen.queryByText('unrelated.ts')).toBeNull()

    rerender(
      <RightSidebarPane
        loopFocusedTaskId="t_root"
        loopState={loopState}
        onActivateFile={onActivateFile}
        onActivateFolder={vi.fn()}
        onChangeCwd={vi.fn()}
      />
    )

    expect(screen.getByText('root-only.ts')).toBeTruthy()
    expect(screen.getAllByText('child-only.ts')).toHaveLength(2)
    expect(screen.getByText('nested-blocker.ts')).toBeTruthy()
    expect(screen.queryByText('unrelated.ts')).toBeNull()
  })
})
