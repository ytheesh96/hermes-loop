import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canOpenNewWindow,
  canOpenSessionWindow,
  openNewSessionInNewWindow,
  openNewWindow,
  openSessionInNewWindow,
  sessionWindowProfile
} from './windows'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop

const notifyError = vi.fn()

vi.mock('./notifications', () => ({
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

function installBridge(
  openSessionWindow?: Window['hermesDesktop']['openSessionWindow'],
  openNewSessionWindow?: Window['hermesDesktop']['openNewSessionWindow'],
  openWindow?: Window['hermesDesktop']['openWindow']
) {
  desktopWindow.hermesDesktop = {
    ...(openSessionWindow ? { openSessionWindow } : {}),
    ...(openNewSessionWindow ? { openNewSessionWindow } : {}),
    ...(openWindow ? { openWindow } : {})
  } as unknown as Window['hermesDesktop']
}

beforeEach(() => {
  notifyError.mockClear()
})

afterEach(() => {
  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }

  history.replaceState(null, '', '/')
})

describe('canOpenSessionWindow', () => {
  it('is false when the desktop bridge is absent', () => {
    delete desktopWindow.hermesDesktop
    expect(canOpenSessionWindow()).toBe(false)
  })

  it('is false when the bridge lacks openSessionWindow', () => {
    installBridge(undefined)
    expect(canOpenSessionWindow()).toBe(false)
  })

  it('is true when the bridge exposes openSessionWindow', () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenSessionWindow()).toBe(true)
  })
})

describe('openSessionInNewWindow', () => {
  it('no-ops without a session id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('')

    expect(open).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('no-ops gracefully when the bridge is absent (web fallback)', async () => {
    delete desktopWindow.hermesDesktop

    await openSessionInNewWindow('s1')

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge with the session id', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('s1')

    expect(open).toHaveBeenCalledWith('s1', undefined)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('forwards the watch flag for spectator (subagent) windows', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('s1', { watch: true })

    expect(open).toHaveBeenCalledWith('s1', { watch: true })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('forwards the owning profile for cross-profile session windows', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    installBridge(open)

    await openSessionInNewWindow('s1', { profile: 'bme' })

    expect(open).toHaveBeenCalledWith('s1', { profile: 'bme' })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('notifies on an ok:false result', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: false, error: 'invalid-session-id' }))

    await openSessionInNewWindow('s1')

    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  it('notifies when the bridge throws', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('boom')))

    await openSessionInNewWindow('s1')

    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})

describe('sessionWindowProfile', () => {
  it('reads the profile query parameter', () => {
    history.replaceState(null, '', '/?win=secondary&profile=bme#/s1')

    expect(sessionWindowProfile()).toBe('bme')
  })

  it('returns null when no profile is present', () => {
    history.replaceState(null, '', '/?win=secondary#/s1')

    expect(sessionWindowProfile()).toBeNull()
  })
})

describe('openNewSessionInNewWindow', () => {
  it('no-ops gracefully when the bridge is absent (web fallback)', async () => {
    delete desktopWindow.hermesDesktop

    await openNewSessionInNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('no-ops when openNewSessionWindow is missing', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))

    await openNewSessionInNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge', async () => {
    const openNew = vi.fn().mockResolvedValue({ ok: true })
    installBridge(vi.fn().mockResolvedValue({ ok: true }), openNew)

    await openNewSessionInNewWindow()

    expect(openNew).toHaveBeenCalledTimes(1)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('notifies on an ok:false result', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }), vi.fn().mockResolvedValue({ ok: false, error: 'nope' }))

    await openNewSessionInNewWindow()

    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})

describe('canOpenNewWindow', () => {
  it('is false when the desktop bridge is absent', () => {
    delete desktopWindow.hermesDesktop
    expect(canOpenNewWindow()).toBe(false)
  })

  it('is false when the bridge lacks openWindow', () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenNewWindow()).toBe(false)
  })

  it('is true when the bridge exposes openWindow', () => {
    installBridge(undefined, undefined, vi.fn().mockResolvedValue({ ok: true }))
    expect(canOpenNewWindow()).toBe(true)
  })
})

describe('openNewWindow', () => {
  it('no-ops gracefully when the bridge is absent (web fallback)', async () => {
    delete desktopWindow.hermesDesktop

    await openNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('no-ops when openWindow is missing', async () => {
    installBridge(vi.fn().mockResolvedValue({ ok: true }))

    await openNewWindow()

    expect(notifyError).not.toHaveBeenCalled()
  })

  it('invokes the bridge', async () => {
    const openWindow = vi.fn().mockResolvedValue({ ok: true })
    installBridge(undefined, undefined, openWindow)

    await openNewWindow()

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('notifies on an ok:false result', async () => {
    installBridge(undefined, undefined, vi.fn().mockResolvedValue({ ok: false, error: 'nope' }))

    await openNewWindow()

    expect(notifyError).toHaveBeenCalledTimes(1)
  })
})
