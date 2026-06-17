import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { invalidateLoopSourceFromEvent, isLoopSourceInvalidationEvent } from './loop-source-events'

describe('loop source live invalidation', () => {
  it('treats every Kanban worker event with a payload as Loop source invalidating', () => {
    expect(isLoopSourceInvalidationEvent('kanban.worker.spawned', { task_id: 't1' })).toBe(true)
    expect(isLoopSourceInvalidationEvent('kanban.worker.heartbeat', { task_id: 't1' })).toBe(true)
    expect(isLoopSourceInvalidationEvent('kanban.worker.complete', { task_id: 't1' })).toBe(true)
    expect(isLoopSourceInvalidationEvent('kanban.worker.complete', null)).toBe(false)
    expect(isLoopSourceInvalidationEvent('subagent.progress', { task_id: 't1' })).toBe(false)
  })

  it('invalidates active lineage source and selected task detail only for newer source changes', async () => {
    const queryClient = new QueryClient()
    const staleKey = ['loop-session-source', 'peacock', 'session-root'] as const
    const selectedTaskKey = ['loop-task-detail', 'peacock', 'developer', 't_selected', 12] as const
    const unrelatedTaskKey = ['loop-task-detail', 'peacock', 'developer', 't_other', 12] as const

    queryClient.setQueryData(staleKey, { latest_event_id: 10, rows: [] })
    queryClient.setQueryData(selectedTaskKey, { task: { id: 't_selected', title: 'Old title' } })
    queryClient.setQueryData(unrelatedTaskKey, { task: { id: 't_other', title: 'Stable' } })

    await invalidateLoopSourceFromEvent(queryClient, {
      activeProfile: 'peacock',
      activeSessionIds: ['session-root', 'session-tip'],
      event: {
        source_session_id: 'session-root',
        affected_task_ids: ['t_selected'],
        latest_task_event_id: 11
      },
      selectedTaskId: 't_selected'
    })

    expect(queryClient.getQueryState(staleKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(selectedTaskKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(unrelatedTaskKey)?.isInvalidated).toBe(false)
  })

  it('does not invalidate active source queries for unrelated lineages', async () => {
    const queryClient = new QueryClient()
    const activeKey = ['loop-session-source', 'peacock', 'session-active'] as const
    const relatedKey = ['loop-session-source', 'peacock', 'session-other'] as const
    const otherProfileKey = ['loop-session-source', 'default', 'session-other'] as const

    queryClient.setQueryData(activeKey, { latest_event_id: 1 })
    queryClient.setQueryData(relatedKey, { latest_event_id: 1 })
    queryClient.setQueryData(otherProfileKey, { latest_event_id: 1 })

    await invalidateLoopSourceFromEvent(queryClient, {
      activeProfile: 'peacock',
      activeSessionIds: ['session-active'],
      event: {
        source_session_id: 'session-other',
        affected_task_ids: [],
        latest_task_event_id: 2
      }
    })

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(relatedKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(otherProfileKey)?.isInvalidated).toBe(false)
  })
})
