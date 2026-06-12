import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLoopSessionSource, getLoopTaskDetail, getSessionMessages, listAllProfileSessions, listSessions, updateLoopTaskStatus } from './hermes'

const emptySessionsResponse = {
  limit: 0,
  offset: 0,
  sessions: [],
  total: 0
}

describe('Hermes REST session helpers', () => {
  let api: ReturnType<typeof vi.fn>

  beforeEach(() => {
    api = vi.fn().mockResolvedValue(emptySessionsResponse)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { api }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('uses a longer timeout for the single-profile session list', async () => {
    await listSessions(50, 1)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/sessions?limit=50&offset=0&min_messages=1&archived=exclude&order=recent',
        timeoutMs: 60_000
      })
    )
  })

  it('uses a longer timeout for the all-profile session list', async () => {
    await listAllProfileSessions(50, 1)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/profiles/sessions?limit=50&offset=0&min_messages=1&archived=exclude&order=recent&profile=all',
        timeoutMs: 60_000
      })
    )
  })

  it('tags cross-profile message reads for Electron routing and backend lookup', async () => {
    api.mockResolvedValue({ messages: [], session_id: 'session-1' })

    await getSessionMessages('session-1', 'xiaoxuxu')

    expect(api).toHaveBeenCalledWith({
      path: '/api/sessions/session-1/messages?profile=xiaoxuxu',
      profile: 'xiaoxuxu'
    })
  })

  it('reads Loop panel source and focused task details through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ tasks: [] })

    await getLoopSessionSource('session-1', 'peacock')
    await getLoopTaskDetail('t_child', 'peacock')

    expect(api).toHaveBeenNthCalledWith(1, {
      path: '/api/plugins/kanban/session-source?session_id=session-1',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      path: '/api/plugins/kanban/tasks/t_child',
      profile: 'peacock'
    })
  })

  it('patches Loop task status actions through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ task: null })

    await updateLoopTaskStatus('t_blocked', 'blocked', 'peacock', { blockReason: 'Blocked from Loop side panel' })

    expect(api).toHaveBeenCalledWith({
      body: {
        block_reason: 'Blocked from Loop side panel',
        status: 'blocked'
      },
      method: 'PATCH',
      path: '/api/plugins/kanban/tasks/t_blocked',
      profile: 'peacock'
    })
  })
})
