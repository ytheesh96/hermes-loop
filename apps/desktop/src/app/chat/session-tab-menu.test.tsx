import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { exportSession } from '@/lib/session-export'
import { $sessions } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import { SessionTabMenu } from './session-tile'

vi.mock('@/lib/session-export', () => ({
  exportSession: vi.fn(async () => undefined)
}))

vi.mock('.', () => ({
  ChatView: () => null
}))

const storedSessionId = 'worker-session-9'
const workerProfile = 'reviewer-qa'

afterEach(() => {
  cleanup()
  vi.mocked(exportSession).mockClear()
  $sessions.set([])
  $sessionTiles.set([])
})

async function openTabMenu(title = 'Session') {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Worker tab' }), {
    clientX: 10,
    clientY: 10
  })

  return screen.findByRole('menu', { name: `Actions for ${title}` })
}

describe('SessionTabMenu', () => {
  it('keeps a cross-profile watch tab read-only and exports through the tile profile', async () => {
    $sessionTiles.set([
      {
        profile: workerProfile,
        runtimeId: 'runtime-worker',
        storedSessionId,
        watch: true
      }
    ])

    render(
      <SessionTabMenu onClose={vi.fn()} storedSessionId={storedSessionId} tabPaneId={`session-tile:${storedSessionId}`}>
        <button type="button">Worker tab</button>
      </SessionTabMenu>
    )

    await openTabMenu()

    expect(screen.getByRole('menuitem', { name: 'Copy ID' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'New window' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Branch' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }))

    expect(exportSession).toHaveBeenCalledWith(storedSessionId, {
      profile: workerProfile,
      title: 'Session'
    })
  })

  it('preserves the mutating verbs for an ordinary interactive tab', async () => {
    $sessionTiles.set([{ storedSessionId }])

    render(
      <SessionTabMenu onClose={vi.fn()} storedSessionId={storedSessionId} tabPaneId={`session-tile:${storedSessionId}`}>
        <button type="button">Worker tab</button>
      </SessionTabMenu>
    )

    await openTabMenu('New session')

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Branch' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })
})
