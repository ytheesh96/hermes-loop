import { beforeEach, describe, expect, it } from 'vitest'

import {
  $backgroundStatusBySession,
  $kanbanStatusBySession,
  $statusItemsBySession,
  dismissBackgroundProcess,
  groupStatusItems,
  reconcileBackgroundProcesses,
  reconcileKanbanSessionSource,
  reconcileKanbanSessionSourceForComposer
} from './composer-status'
import { $loopagentsBySession, upsertLoopagent } from './loopagents'

const SID = 'sess-1'

const running = (id: string, command = `cmd ${id}`) => ({ command, session_id: id, status: 'running' })

const exited = (id: string, exit_code = 0, command = `cmd ${id}`) => ({
  command,
  exit_code,
  session_id: id,
  status: 'exited'
})

const items = () => $backgroundStatusBySession.get()[SID] ?? []

describe('reconcileBackgroundProcesses', () => {
  beforeEach(() => {
    $backgroundStatusBySession.set({})
  })

  it('maps registry entries to status items', () => {
    reconcileBackgroundProcesses(SID, [running('a'), exited('b', 0), exited('c', 1)])

    expect(items().map(i => [i.id, i.state])).toEqual([
      ['a', 'running'],
      ['b', 'done'],
      ['c', 'failed']
    ])
    expect(items()[2]!.exitCode).toBe(1)
  })

  it('keeps row order stable when a process flips state or the snapshot reorders', () => {
    reconcileBackgroundProcesses(SID, [running('a'), running('b')])
    // Snapshot arrives reordered AND `a` has exited — rows must not move.
    reconcileBackgroundProcesses(SID, [running('b'), exited('a', 0)])

    expect(items().map(i => [i.id, i.state])).toEqual([
      ['a', 'done'],
      ['b', 'running']
    ])
  })

  it('appends new processes after existing rows', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    reconcileBackgroundProcesses(SID, [running('b'), running('a')])

    expect(items().map(i => i.id)).toEqual(['a', 'b'])
  })

  it('preserves object identity for unchanged rows (memo stability)', () => {
    reconcileBackgroundProcesses(SID, [running('a'), running('b')])
    const [a1] = items()

    reconcileBackgroundProcesses(SID, [running('a'), exited('b', 0)])
    const [a2, b2] = items()

    expect(a2).toBe(a1)
    expect(b2!.state).toBe('done')
  })

  it('is a no-op store write when nothing changed', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    const before = $backgroundStatusBySession.get()

    reconcileBackgroundProcesses(SID, [running('a')])

    expect($backgroundStatusBySession.get()).toBe(before)
  })

  it('never resurrects a dismissed process while the registry still reports it', () => {
    reconcileBackgroundProcesses(SID, [exited('a', 0), running('b')])
    dismissBackgroundProcess(SID, 'a')

    reconcileBackgroundProcesses(SID, [exited('a', 0), running('b')])

    expect(items().map(i => i.id)).toEqual(['b'])
  })

  it('forgets a dismissal once the registry prunes the process', () => {
    reconcileBackgroundProcesses(SID, [exited('a', 0)])
    dismissBackgroundProcess(SID, 'a')

    // Registry pruned it…
    reconcileBackgroundProcesses(SID, [])
    // …so a future process reusing the id (new spawn) shows again.
    reconcileBackgroundProcesses(SID, [running('a')])

    expect(items().map(i => i.id)).toEqual(['a'])
  })

  it('drops the session key entirely when the last row goes away', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    reconcileBackgroundProcesses(SID, [])

    expect($backgroundStatusBySession.get()).toEqual({})
  })
})

describe('reconcileKanbanSessionSource', () => {
  beforeEach(() => {
    $kanbanStatusBySession.set({})
    $loopagentsBySession.set({})
  })

  it('shows only the root Kanban task in Tasks and only active/attention children in Subagents', () => {
    reconcileKanbanSessionSource(SID, {
      tasks: [
        {
          id: 't_root',
          status: 'running',
          title: 'Root Kanban task',
          included_parent_ids: [],
          included_child_ids: ['t_running', 't_queued', 't_review', 't_done']
        },
        {
          id: 't_running',
          status: 'running',
          title: 'Running child',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_queued',
          status: 'ready',
          title: 'Queued child',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_review',
          status: 'blocked',
          title: 'Review child',
          latest_summary: 'review-required: needs eyes',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        },
        {
          id: 't_done',
          status: 'done',
          title: 'Completed child',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        }
      ],
      workers: [
        {
          run_id: 7,
          task_id: 't_running',
          task_title: 'Running child',
          profile: 'peacock',
          current_tool: 'terminal',
          status: 'running',
          task_status: 'running',
          worker_session_id: 'worker-session-7',
          log_tail: 'worker log tail'
        },
        {
          run_id: 8,
          task_id: 't_review',
          task_title: 'Review child',
          profile: 'reviewer-qa',
          status: 'done',
          task_status: 'blocked',
          summary: 'review-required: needs eyes',
          recent_task_events: [{ kind: 'heartbeat', payload: { tool_name: 'apply_patch' } }]
        },
        {
          run_id: 9,
          task_id: 't_done',
          task_title: 'Completed child',
          profile: 'reviewer-qa',
          status: 'done',
          task_status: 'done',
          summary: 'accepted'
        }
      ]
    })

    const items = $kanbanStatusBySession.get()[SID] ?? []
    const groups = groupStatusItems(items)

    expect(groups.map(group => group.type)).toEqual(['todo', 'kanban-agent'])
    expect(groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.todoStatus, item.currentTool])).toEqual([
      ['kanban-task:t_root', 't_root', 'in_progress', 'Loop']
    ])
    expect(groups[1]!.items.map(item => [item.id, item.state, item.sessionId, item.output, item.currentTool])).toEqual([
      ['kanban-agent:t_running:7', 'running', 'worker-session-7', 'worker log tail', 'peacock · Terminal'],
      ['kanban-agent:t_review:8', 'failed', undefined, 'review-required: needs eyes', 'reviewer-qa · Apply Patch']
    ])
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_queued')
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_done')
  })

  it('clears stale Kanban rows when session-source metadata disappears', () => {
    reconcileKanbanSessionSource(SID, { tasks: [{ id: 't_running', status: 'running', title: 'Running' }] })
    reconcileKanbanSessionSource(SID, null)

    expect($kanbanStatusBySession.get()).toEqual({})
  })

  it('uses the session-anchored root instead of a parentless child for decomposed Loop roots', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_child',
          status: 'ready',
          title: 'Implementation child',
          included_child_ids: ['t_root'],
          included_parent_ids: []
        },
        {
          id: 't_root',
          session_id: SID,
          status: 'todo',
          title: 'Original Loop root',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    expect($kanbanStatusBySession.get()[SID]?.map(item => [item.id, item.kanbanTaskId, item.title])).toEqual([
      ['kanban-task:t_root', 't_root', 'Original Loop root']
    ])
  })

  it('shows multiple self-anchored Loop roots from the same foreground session', () => {
    reconcileKanbanSessionSource(SID, {
      root_task_id: 't_new_root',
      session_id: SID,
      tenant: SID,
      tasks: [
        {
          id: 't_old_root',
          created_at: 10,
          created_by: 'loop:t_old_root',
          included_child_ids: ['t_old_child'],
          included_parent_ids: ['t_old_child'],
          status: 'blocked',
          title: 'Harden foreground handoff'
        },
        {
          id: 't_old_child',
          created_at: 11,
          created_by: 'foreground',
          included_child_ids: ['t_old_root'],
          included_parent_ids: [],
          status: 'running',
          title: 'Patch handoff child'
        },
        {
          id: 't_new_root',
          created_at: 20,
          created_by: 'loop:t_new_root',
          included_child_ids: ['t_new_child'],
          included_parent_ids: ['t_new_child'],
          status: 'done',
          title: 'Create explainer atlas'
        },
        {
          id: 't_new_child',
          created_at: 21,
          created_by: 'loop:t_new_root',
          included_child_ids: ['t_new_root'],
          included_parent_ids: [],
          status: 'done',
          title: 'Build atlas child'
        }
      ],
      workers: [
        {
          run_id: 1,
          status: 'running',
          task_id: 't_old_root',
          task_status: 'running',
          task_title: 'Harden foreground handoff'
        },
        {
          run_id: 2,
          status: 'running',
          task_id: 't_old_child',
          task_status: 'running',
          task_title: 'Patch handoff child'
        }
      ]
    })

    const items = $kanbanStatusBySession.get()[SID] ?? []
    const groups = groupStatusItems(items)

    expect(groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus])).toEqual([
      ['kanban-task:t_old_root', 't_old_root', 'Harden foreground handoff', 'in_progress'],
      ['kanban-task:t_new_root', 't_new_root', 'Create explainer atlas', 'completed']
    ])
    expect(groups[1]!.items.map(item => [item.id, item.kanbanTaskId])).toEqual([
      ['kanban-agent:t_old_child:2', 't_old_child']
    ])
    expect(items.map(item => item.id)).not.toContain('kanban-agent:t_old_root:1')
  })

  it('keeps a nested non-self sub-loop out of top-level composer rows', () => {
    reconcileKanbanSessionSource(SID, {
      root_task_id: 't_nested_loop',
      session_id: SID,
      tenant: SID,
      tasks: [
        {
          id: 't_outer_loop',
          created_at: 10,
          created_by: 'loop:t_outer_loop',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: ['t_outer_child'],
          status: 'done',
          title: 'Outer Loop root'
        },
        {
          id: 't_outer_child',
          created_at: 11,
          created_by: 'loop:t_outer_loop',
          included_child_ids: ['t_outer_loop'],
          included_parent_ids: [],
          status: 'done',
          title: 'Outer child'
        },
        {
          id: 't_nested_loop',
          created_at: 20,
          created_by: 'loop:t_outer_loop',
          included_child_ids: ['t_nested_child'],
          included_parent_ids: ['t_outer_loop'],
          status: 'done',
          title: 'Nested sub-loop'
        },
        {
          id: 't_nested_child',
          created_at: 21,
          created_by: 'loop:t_outer_loop',
          included_child_ids: ['t_nested_loop'],
          included_parent_ids: [],
          status: 'done',
          title: 'Nested child'
        }
      ]
    })

    expect($kanbanStatusBySession.get()[SID]?.map(item => [item.id, item.kanbanTaskId, item.title])).toEqual([
      ['kanban-task:t_outer_loop', 't_outer_loop', 'Outer Loop root']
    ])
  })

  it('keeps explicit root_task_id as the composer root when a newer child has a lineage session', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: 'sess-current',
      lineage_session_ids: ['sess-root', 'sess-current'],
      root_task_id: 't_root',
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_child',
          session_id: 'sess-current',
          created_at: 30,
          status: 'ready',
          title: 'Newer prerequisite child',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_root',
          session_id: 'sess-root',
          created_at: 10,
          status: 'todo',
          title: 'Original Loop root',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        }
      ]
    })

    expect($kanbanStatusBySession.get()[SID]?.map(item => [item.id, item.kanbanTaskId, item.title])).toEqual([
      ['kanban-task:t_root', 't_root', 'Original Loop root']
    ])
  })

  it('falls back to the oldest lineage row instead of the newest child for composer roots', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: 'tenant-a',
      tasks: [
        {
          id: 't_child',
          session_id: SID,
          created_at: 30,
          status: 'ready',
          title: 'Newer prerequisite child',
          included_child_ids: [],
          included_parent_ids: ['t_root']
        },
        {
          id: 't_root',
          session_id: SID,
          created_at: 10,
          status: 'todo',
          title: 'Original Loop root',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        }
      ]
    })

    expect($kanbanStatusBySession.get()[SID]?.map(item => [item.id, item.kanbanTaskId, item.title])).toEqual([
      ['kanban-task:t_root', 't_root', 'Original Loop root']
    ])
  })

  it('writes compressed lineage source under the active composer session key', () => {
    reconcileKanbanSessionSourceForComposer({
      activeSessionId: 'runtime-tip',
      source: {
        tasks: [{ id: 't_root', status: 'done', title: 'Root task', included_parent_ids: [], included_child_ids: [] }]
      },
      sourceSessionId: 'compression-root'
    })

    const bySession = $kanbanStatusBySession.get()
    expect(bySession['compression-root']).toBeUndefined()
    expect(
      bySession['runtime-tip']?.map(item => [item.id, item.kanbanTaskId, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 't_root', 'completed', 'Loop']])
  })

  it('projects loopagent events into composer status and dedupes against session-source workers', () => {
    upsertLoopagent(
      ['runtime-tip'],
      {
        current_tool: 'terminal',
        event: 'loopagent.worker.upsert',
        profile: 'peacock',
        run_id: 7,
        run_status: 'running',
        summary_preview: 'patch in progress',
        task_id: 't_running',
        task_title: 'Running child',
        worker_session_id: 'worker-session-7'
      },
      'loopagent.worker.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.state, item.sessionId, item.currentTool])
    ).toEqual([['kanban-agent:t_running:7', 'running', 'worker-session-7', 'peacock · Terminal']])

    reconcileKanbanSessionSource('runtime-tip', {
      workers: [
        {
          current_tool: 'terminal',
          profile: 'peacock',
          run_id: 7,
          status: 'running',
          task_id: 't_running',
          task_status: 'running',
          task_title: 'Running child',
          worker_session_id: 'worker-session-7'
        }
      ]
    })

    expect(
      $statusItemsBySession.get()['runtime-tip']?.filter(item => item.id === 'kanban-agent:t_running:7')
    ).toHaveLength(1)
  })

  it('lets a live loopagent task row override a stale session-source task row', () => {
    reconcileKanbanSessionSource('runtime-tip', {
      tasks: [{ id: 't_root', status: 'ready', title: 'Snapshot title', included_parent_ids: [], included_child_ids: [] }]
    })

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        is_root_task: true,
        revision: 3,
        task_id: 't_root',
        task_status: 'running',
        task_title: 'Live title'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 'Live title', 'in_progress', 'Loop']])
  })
})
