import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addLoopTaskComment,
  archiveLoopNodes,
  createLoopDraftTask,
  getCronJobs,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getHermesConfig,
  getHermesConfigDefaults,
  getKanbanCapabilities,
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
  listSidebarSessions,
  loopSourceFromDraftResult,
  mergeLoopDraftSource,
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

  it('batches the sidebar slices into a single request with per-slice limits + excludes', async () => {
    api.mockResolvedValue({ recents: { sessions: [] }, cron: { sessions: [] }, messaging: { sessions: [] } })

    await listSidebarSessions({
      recentsProfile: 'work',
      recentsLimit: 30,
      recentsExclude: ['cron', 'tool'],
      cronLimit: 50,
      messagingLimit: 100,
      messagingExclude: ['cron', 'desktop']
    })

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path:
          '/api/profiles/sessions/sidebar?recents_profile=work&recents_limit=30&cron_limit=50' +
          '&messaging_limit=100&recents_exclude=cron%2Ctool&messaging_exclude=cron%2Cdesktop',
        timeoutMs: 60_000
      })
    )
  })

  it('defaults missing sidebar slices to empty session arrays', async () => {
    api.mockResolvedValue({})

    const result = await listSidebarSessions({
      recentsProfile: 'all',
      recentsLimit: 20,
      recentsExclude: [],
      cronLimit: 50,
      messagingLimit: 100,
      messagingExclude: []
    })

    expect(result.recents.sessions).toEqual([])
    expect(result.cron.sessions).toEqual([])
    expect(result.messaging.sessions).toEqual([])
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

  it('probes live Loop graph support through the profile-scoped kanban API', async () => {
    api.mockResolvedValue({ live_loop_graph: true })

    await expect(getKanbanCapabilities('peacock')).resolves.toEqual({ live_loop_graph: true })

    expect(api).toHaveBeenCalledWith({
      path: '/api/plugins/kanban/capabilities',
      profile: 'peacock'
    })
  })

  it('reads and saves Loop canvas positions through the profile-scoped kanban API', async () => {
    api
      .mockResolvedValueOnce({
        positions: [{ task_id: 't_child', updated_at: 42, x: 12.5, y: -8 }],
        workflow_id: 'wf/root'
      })
      .mockResolvedValueOnce({
        ok: true,
        positions: [{ task_id: 't_child', updated_at: 43, x: 50, y: 75 }],
        root_task_id: 'wf/root'
      })

    await expect(getLoopCanvasPositions('wf/root', 'peacock', 'developer', 'session/one')).resolves.toEqual({
      positions: [{ taskId: 't_child', updatedAt: 42, x: 12.5, y: -8 }],
      workflowId: 'wf/root'
    })
    await expect(
      saveLoopCanvasPositions('wf/root', [{ taskId: 't_child', x: 50, y: 75 }], 'peacock', 'developer', 'session/one')
    ).resolves.toEqual({
      positions: [{ taskId: 't_child', updatedAt: 43, x: 50, y: 75 }],
      workflowId: 'wf/root'
    })

    expect(api).toHaveBeenNthCalledWith(1, {
      path: '/api/plugins/kanban/loop-canvas/wf%2Froot/positions?board=developer&session_id=session%2Fone',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(2, {
      body: { positions: [{ task_id: 't_child', x: 50, y: 75 }] },
      method: 'PUT',
      path: '/api/plugins/kanban/loop-canvas/wf%2Froot/positions?board=developer&session_id=session%2Fone',
      profile: 'peacock'
    })
  })

  it('archives Loop nodes atomically through the workflow-scoped canvas endpoint', async () => {
    api.mockResolvedValue({ archived: ['t_one', 't_two'], ok: true })

    await archiveLoopNodes('wf/root', [' t_one ', 't_two', 't_one'], 'peacock', 'developer', 'session/one')

    expect(api).toHaveBeenCalledWith({
      body: { session_id: 'session/one', task_ids: ['t_one', 't_two'] },
      method: 'POST',
      path: '/api/plugins/kanban/loop-canvas/wf%2Froot/archive-nodes?board=developer',
      profile: 'peacock'
    })
  })

  it('mutates Loop dependency links through the canonical kanban endpoint', async () => {
    api.mockResolvedValue({ ok: true })

    await linkLoopTasks('t_parent', 't_child', 'peacock', 'developer')
    await linkLoopTasks('t_parent', 't_child', 'peacock', 'developer', 'wf_loop', 'session/one')
    await unlinkLoopTasks('t_parent', 't_child', 'peacock', 'developer', 'wf_loop', 'session/one')

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
        workflow_id: 'wf_loop',
        session_id: 'session/one'
      },
      method: 'POST',
      path: '/api/plugins/kanban/links?board=developer',
      profile: 'peacock'
    })
    expect(api).toHaveBeenNthCalledWith(3, {
      method: 'DELETE',
      path: '/api/plugins/kanban/links?child_id=t_child&parent_id=t_parent&board=developer&workflow_id=wf_loop&session_id=session%2Fone',
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

  it('creates a live workflow task with its initial dependency edges in one request', async () => {
    api.mockResolvedValue({ task: { id: 't_loop', title: 'Draft Loop root' } })

    await createLoopDraftTask({
      childIds: [' t_after ', 't_after'],
      idempotencyKey: 'loop-draft:session-1:add-1',
      parents: [' t_before ', 't_before'],
      profile: 'peacock',
      workflowId: ' wf_loop ',
      sessionId: 'session-1',
      title: 'Draft Loop root'
    })

    expect(api).toHaveBeenCalledWith({
      body: {
        assignee: 'orchestrator',
        body: undefined,
        child_ids: ['t_after'],
        idempotency_key: 'loop-draft:session-1:add-1',
        parents: ['t_before'],
        session_id: 'session-1',
        title: 'Draft Loop root',
        workflow_id: 'wf_loop'
      },
      method: 'POST',
      path: '/api/plugins/kanban/loop-drafts',
      profile: 'peacock'
    })
  })

  it('preserves an explicit null Loop assignee for a foreground-owned task', async () => {
    api.mockResolvedValue({ task: { id: 't_root', title: 'Foreground root' } })

    await createLoopDraftTask({
      assignee: null,
      profile: 'peacock',
      sessionId: 'session-1',
      title: 'Foreground root'
    })

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ assignee: null }) }))
  })

  it('merges a newly created Loop row without dropping the existing graph', () => {
    const incoming = loopSourceFromDraftResult('session-1', {
      task: { id: 't_second', status: 'scheduled', title: 'Second task' }
    })!

    const merged = mergeLoopDraftSource(
      {
        links: [{ child_id: 't_child', parent_id: 't_root' }],
        workflow_id: 'wf_loop',
        session_id: 'session-1',
        tasks: [
          { id: 't_root', status: 'scheduled', title: 'Root task' },
          { id: 't_child', status: 'scheduled', title: 'Child task' }
        ]
      },
      incoming
    )

    expect(merged.workflow_id).toBe('wf_loop')
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
