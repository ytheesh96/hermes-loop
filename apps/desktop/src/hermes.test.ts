import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateLoopTask,
  addLoopTaskComment,
  createLoopDraftTask,
  getCronJobs,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getHermesConfig,
  getHermesConfigDefaults,
  getLoopAssignees,
  getLoopCanvasPositions,
  getLoopSessionSource,
  getLoopTaskDetail,
  getProfiles,
  getSessionMessages,
  getStatus,
  linkLoopTasks,
  listAllProfileSessions,
  listSessions,
  loopSourceFromDraftResult,
  mergeLoopDraftSource,
  reviewLoopHandoffForTask,
  saveLoopCanvasPositions,
  unlinkLoopTasks,
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

    await createLoopDraftTask({
      assignee: 'peacock',
      board: 'developer',
      profile: 'peacock',
      sessionId: 'session-1',
      title: 'Draft Loop root'
    })

    expect(api).toHaveBeenCalledWith({
      body: {
        assignee: 'peacock',
        body: undefined,
        session_id: 'session-1',
        title: 'Draft Loop root'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-drafts?board=developer',
      profile: 'peacock'
    })
  })

  it('lists available Loop assignees from the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ assignees: [{ name: 'peacock', on_disk: true }] })

    await getLoopAssignees('peacock', 'developer')

    expect(api).toHaveBeenCalledWith({
      path: '/api/plugins/kanban/assignees?board=developer',
      profile: 'peacock'
    })
  })

  it('reads and saves Loop canvas positions through the profile-scoped kanban API', async () => {
    api
      .mockResolvedValueOnce({
        positions: [{ task_id: 't_child', updated_at: 42, x: 12.5, y: -8 }],
        root_task_id: 't/root'
      })
      .mockResolvedValueOnce({
        ok: true,
        positions: [{ task_id: 't_child', updated_at: 43, x: 50, y: 75 }],
        root_task_id: 't/root'
      })

    await expect(getLoopCanvasPositions('t/root', 'peacock', 'developer', 'session/one')).resolves.toEqual({
      positions: [{ taskId: 't_child', updatedAt: 42, x: 12.5, y: -8 }],
      rootTaskId: 't/root'
    })
    await expect(
      saveLoopCanvasPositions('t/root', [{ taskId: 't_child', x: 50, y: 75 }], 'peacock', 'developer', 'session/one')
    ).resolves.toEqual({
      positions: [{ taskId: 't_child', updatedAt: 43, x: 50, y: 75 }],
      rootTaskId: 't/root'
    })

    expect(api).toHaveBeenNthCalledWith(1, {
      path: '/api/plugins/kanban/loop-canvas/t%2Froot/positions?board=developer&session_id=session%2Fone',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      body: { positions: [{ task_id: 't_child', x: 50, y: 75 }] },
      method: 'PUT',
      path: '/api/plugins/kanban/loop-canvas/t%2Froot/positions?board=developer&session_id=session%2Fone',
      profile: 'peacock'
    })
  })

  it('mutates Loop dependency links through the canonical kanban endpoint', async () => {
    api.mockResolvedValue({ ok: true })

    await linkLoopTasks('t_parent', 't_child', 'peacock', 'developer')
    await linkLoopTasks('t_parent', 't_child', 'peacock', 'developer', 't_root', 'session/one')
    await unlinkLoopTasks('t_parent', 't_child', 'peacock', 'developer')

    expect(api).toHaveBeenNthCalledWith(1, {
      body: { child_id: 't_child', parent_id: 't_parent' },
      method: 'POST',
      path: '/api/plugins/kanban/links?board=developer',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      body: {
        child_id: 't_child',
        parent_id: 't_parent',
        root_task_id: 't_root',
        session_id: 'session/one'
      },
      method: 'POST',
      path: '/api/plugins/kanban/links?board=developer',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(3, {
      method: 'DELETE',
      path: '/api/plugins/kanban/links?child_id=t_child&parent_id=t_parent&board=developer',
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

  it('passes a caller-stable idempotency key for a deliberate Loop task add', async () => {
    api.mockResolvedValue({ task: { id: 't_loop', title: 'Draft Loop root' } })

    await createLoopDraftTask({
      idempotencyKey: 'loop-draft:session-1:add-1',
      profile: 'peacock',
      sessionId: 'session-1',
      title: 'Draft Loop root'
    })

    expect(api).toHaveBeenCalledWith({
      body: {
        assignee: 'orchestrator',
        body: undefined,
        idempotency_key: 'loop-draft:session-1:add-1',
        session_id: 'session-1',
        title: 'Draft Loop root'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-drafts',
      profile: 'peacock'
    })
  })

  it('merges a newly created Loop row without dropping the existing graph', () => {
    const incoming = loopSourceFromDraftResult('session-1', {
      task: { id: 't_second', status: 'scheduled', title: 'Second task' }
    })!

    const merged = mergeLoopDraftSource(
      {
        links: [{ child_id: 't_child', parent_id: 't_root' }],
        root_task_id: 't_root',
        session_id: 'session-1',
        tasks: [
          { id: 't_root', status: 'scheduled', title: 'Root task' },
          { id: 't_child', status: 'scheduled', title: 'Child task' }
        ]
      },
      incoming
    )

    expect(merged.root_task_id).toBe('t_root')
    expect(merged.tasks?.map(task => task.id)).toEqual(['t_root', 't_child', 't_second'])
    expect(merged.links).toEqual([{ child_id: 't_child', parent_id: 't_root' }])
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

  it('activates an existing Loop plan through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ activated_ids: ['t_root'], ok: true, task_id: 't_root' })

    await activateLoopTask('t_root', 'peacock', { board: 'developer' })

    expect(api).toHaveBeenCalledWith({
      body: {},
      method: 'POST',
      path: '/api/plugins/kanban/tasks/t_root/activate?board=developer',
      profile: 'peacock'
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
