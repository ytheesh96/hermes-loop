import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
})
