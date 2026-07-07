import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addLoopTaskComment,
  createLoopDraftTask,
  decomposeLoopTask,
  getCronJobs,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getHermesConfig,
  getHermesConfigDefaults,
  getLoopSessionSource,
  getLoopTaskDetail,
  getProfiles,
  getSessionMessages,
  getStatus,
  listAllProfileSessions,
  listSessions,
  reviewLoopHandoffForTask,
  updateLoopTaskStatus
} from './hermes'
import { refreshActiveProfile } from './store/profile'

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

  it('uses a longer timeout for profile listing during desktop startup', async () => {
    api.mockResolvedValue({ profiles: [] })

    await getProfiles()

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/profiles?detail=summary',
        timeoutMs: 60_000
      })
    )
  })

  it('uses a longer timeout for active profile refresh during desktop startup', async () => {
    api.mockResolvedValueOnce({ current: 'default' }).mockResolvedValueOnce({ profiles: [] })

    await refreshActiveProfile()

    expect(api).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: '/api/profiles/active',
        timeoutMs: 60_000
      })
    )
    expect(api).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: '/api/profiles?detail=summary',
        timeoutMs: 60_000
      })
    )
  })

  it('gives the whole startup data burst the long timeout, not just profiles', async () => {
    api.mockResolvedValue({})

    const bootCalls: [() => Promise<unknown>, string][] = [
      [getHermesConfig, '/api/config'],
      [getHermesConfigDefaults, '/api/config/defaults'],
      [getGlobalModelInfo, '/api/model/info'],
      [() => getGlobalModelOptions(), '/api/model/options?explicit_only=1'],
      [getCronJobs, '/api/cron/jobs']
    ]

    for (const [call, path] of bootCalls) {
      api.mockClear()
      await call()
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ path, timeoutMs: 60_000 }))
    }
  })

  it('keeps the liveness poll on the short default so a dead backend fails fast', async () => {
    api.mockResolvedValue({})
    api.mockClear()

    await getStatus()

    // /api/status must NOT carry the long startup timeout — it is the runtime
    // liveness probe and has to fail quickly when the backend drops.
    const call = api.mock.calls[0]?.[0] as { path: string; timeoutMs?: number }
    expect(call.path).toBe('/api/status')
    expect(call.timeoutMs).toBeUndefined()
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
    await getLoopTaskDetail('t_child', 'peacock', 'developer')

    expect(api).toHaveBeenNthCalledWith(1, {
      path: '/api/plugins/kanban/session-source?session_id=session-1',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      path: '/api/plugins/kanban/tasks/t_child?board=developer',
      profile: 'peacock'
    })
  })

  it('creates a draft Loop task through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ task: { id: 't_loop', title: 'Draft Loop root' } })

    await createLoopDraftTask({ board: 'developer', profile: 'peacock', sessionId: 'session-1', title: 'Draft Loop root' })

    expect(api).toHaveBeenCalledWith({
      body: {
        assignee: 'orchestrator',
        body: undefined,
        session_id: 'session-1',
        title: 'Draft Loop root'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-drafts?board=developer',
      profile: 'peacock'
    })
  })

  it('passes explicit Loop draft tenant metadata when provided', async () => {
    api.mockResolvedValue({ task: { id: 't_loop', title: 'Draft Loop root' } })

    await createLoopDraftTask({
      profile: 'peacock',
      sessionId: 'session-1',
      tenant: 'custom-origin-metadata',
      title: 'Draft Loop root'
    })

    expect(api).toHaveBeenCalledWith({
      body: {
        assignee: 'orchestrator',
        body: undefined,
        session_id: 'session-1',
        tenant: 'custom-origin-metadata',
        title: 'Draft Loop root'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-drafts',
      profile: 'peacock'
    })
  })

  it('posts Loop task comments through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ ok: true })

    await addLoopTaskComment('t_child', 'Looks good — please merge after tests.', 'peacock', 'desktop', 'developer')

    expect(api).toHaveBeenCalledWith({
      body: {
        author: 'desktop',
        body: 'Looks good — please merge after tests.'
      },
      method: 'POST',
      path: '/api/plugins/kanban/tasks/t_child/comments?board=developer',
      profile: 'peacock'
    })
  })

  it('patches Loop task status actions through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ task: null })

    await updateLoopTaskStatus('t_blocked', 'blocked', 'peacock', {
      blockReason: 'Blocked from Loop side panel',
      board: 'developer'
    })

    expect(api).toHaveBeenCalledWith({
      body: {
        block_reason: 'Blocked from Loop side panel',
        status: 'blocked'
      },
      method: 'PATCH',
      path: '/api/plugins/kanban/tasks/t_blocked?board=developer',
      profile: 'peacock'
    })
  })

  it('decomposes Loop root tasks through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ child_ids: [], fanout: false, ok: true, task_id: 't_root' })

    await decomposeLoopTask('t_root', 'peacock', { board: 'developer' })

    expect(api).toHaveBeenCalledWith({
      body: {},
      method: 'POST',
      path: '/api/plugins/kanban/tasks/t_root/decompose?board=developer',
      profile: 'peacock',
      timeoutMs: 600_000
    })
  })

  it('marks Loop intake approval when Submit decomposes a clarified draft', async () => {
    api.mockResolvedValue({ child_ids: [], fanout: false, ok: true, task_id: 't_root' })

    await decomposeLoopTask('t_root', 'peacock', { approveIntake: true, board: 'developer' })

    expect(api).toHaveBeenCalledWith({
      body: { approve_intake: true },
      method: 'POST',
      path: '/api/plugins/kanban/tasks/t_root/decompose?board=developer',
      profile: 'peacock',
      timeoutMs: 600_000
    })
  })

  it('can request Loop-safe decomposition without making planning rows dispatchable', async () => {
    api.mockResolvedValue({ child_ids: [], fanout: false, ok: true, task_id: 't_root' })

    await decomposeLoopTask('t_root', 'peacock', { approveIntake: true, board: 'developer', loopSafe: true })

    expect(api).toHaveBeenCalledWith({
      body: { approve_intake: true, loop_safe: true },
      method: 'POST',
      path: '/api/plugins/kanban/tasks/t_root/decompose?board=developer',
      profile: 'peacock',
      timeoutMs: 600_000
    })
  })

  it('submits Loop handoff accept decisions through the profile-scoped kanban API', async () => {
    api
      .mockResolvedValueOnce({
        handoffs: [
          { id: 42, state: 'closed', task_id: 't_review', updated_at: 1 },
          { id: 43, state: 'reviewing', task_id: 't_review', updated_at: 2 }
        ],
        ok: true
      })
      .mockResolvedValueOnce({ ok: true, outcome: 'approved' })

    await reviewLoopHandoffForTask('t_review', 'accept-review', 'peacock', { board: 'developer' })

    expect(api).toHaveBeenNthCalledWith(1, {
      path: '/api/plugins/kanban/loop-handoffs?task_id=t_review&board=developer',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      body: {
        action: 'approve_release',
        actor: 'desktop-loop-panel',
        evidence_passed: true,
        reason: 'Accepted from the Loop side panel after reviewing the foreground handoff.'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-handoffs/43/auto-action?board=developer',
      profile: 'peacock'
    })
  })

  it('submits Loop handoff escalation decisions with a safe escalation flag', async () => {
    api
      .mockResolvedValueOnce({
        handoffs: [{ id: 44, state: 'assigned', task_id: 't_review', updated_at: 3 }],
        ok: true
      })
      .mockResolvedValueOnce({ ok: true, outcome: 'escalated' })

    await reviewLoopHandoffForTask('t_review', 'escalate-review', 'peacock')

    expect(api).toHaveBeenNthCalledWith(2, {
      body: {
        action: 'approve_release',
        actor: 'desktop-loop-panel',
        evidence_passed: true,
        prohibited_flags: ['product_decision'],
        reason: 'Escalated from the Loop side panel because this needs a user decision.'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-handoffs/44/auto-action',
      profile: 'peacock'
    })
  })

  it('defaults model options to configured providers only', async () => {
    await getGlobalModelOptions()

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/model/options?explicit_only=1'
      })
    )
  })

  it('can opt into unconfigured providers for onboarding flows', async () => {
    await getGlobalModelOptions({ includeUnconfigured: true, refresh: true, explicitOnly: false })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/model/options?refresh=1&include_unconfigured=1'
      })
    )
  })
})
