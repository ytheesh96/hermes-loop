import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $backgroundStatusBySession,
  $kanbanStatusBySession,
  $statusItemsBySession,
  dismissBackgroundProcess,
  groupStatusItems,
  reconcileBackgroundProcesses,
  reconcileKanbanSessionSource,
  reconcileKanbanSessionSourceForComposer,
  reconcileKanbanSessionSources
} from './composer-status'
import { $loopagentsBySession, upsertLoopagent } from './loopagents'

const SID = 'sess-1'

const delegatedLoopTask = (id: string, createdAt: number, title: string) => ({
  created_at: createdAt,
  created_by: 'loop_delegation:planner',
  id,
  included_child_ids: [],
  included_parent_ids: [],
  status: 'done',
  title,
  workflow_id: id
})

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
    // Fake timers so the success self-clear (a real setTimeout) is deterministic
    // and never leaks a pending timer between tests.
    vi.useFakeTimers()
    $backgroundStatusBySession.set({})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
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

  // The self-clear path calls dismissBackgroundProcess, which records the id in
  // the module-level dismissed set; use a fresh session per test so that record
  // can't bleed into another test's reconcile.
  const itemsOf = (sid: string) => $backgroundStatusBySession.get()[sid] ?? []

  it('self-clears a finished success after a short linger', () => {
    reconcileBackgroundProcesses('sess-clear', [exited('a', 0)])
    expect(itemsOf('sess-clear').map(i => i.id)).toEqual(['a'])

    vi.advanceTimersByTime(5_000)

    expect(itemsOf('sess-clear')).toEqual([])
  })

  it('self-clears a failed task too, but only after a longer linger', () => {
    reconcileBackgroundProcesses('sess-fail', [exited('a', 1)])

    // Still visible after the success window — the failure gets a longer one so
    // its exit code stays readable.
    vi.advanceTimersByTime(5_000)
    expect(itemsOf('sess-fail').map(i => [i.id, i.state])).toEqual([['a', 'failed']])

    vi.advanceTimersByTime(10_000)
    expect(itemsOf('sess-fail')).toEqual([])
  })

  it('never self-clears a still-running task', () => {
    reconcileBackgroundProcesses('sess-run', [running('a')])

    vi.advanceTimersByTime(60_000)

    expect(itemsOf('sess-run').map(i => i.id)).toEqual(['a'])
  })

  it('arms the self-clear only once a task finishes', () => {
    reconcileBackgroundProcesses('sess-arm', [running('a')])
    vi.advanceTimersByTime(60_000)
    // Still running after a minute — nothing scheduled yet.
    expect(itemsOf('sess-arm').map(i => i.id)).toEqual(['a'])

    reconcileBackgroundProcesses('sess-arm', [exited('a', 0)])
    vi.advanceTimersByTime(5_000)

    expect(itemsOf('sess-arm')).toEqual([])
  })
})

describe('groupStatusItems', () => {
  it('folds legacy Loopagent rows into the Subagents group', () => {
    const groups = groupStatusItems([
      { id: 'subagent-1', state: 'running', title: 'Normal child', type: 'subagent' },
      { id: 'kanban-agent:t_loop:1', state: 'running', title: 'Loop child', type: 'kanban-agent' }
    ])

    expect(groups.map(group => [group.type, group.items.map(item => item.id)])).toEqual([
      ['subagent', ['subagent-1', 'kanban-agent:t_loop:1']]
    ])
  })
})

describe('reconcileKanbanSessionSource', () => {
  beforeEach(() => {
    $kanbanStatusBySession.set({})
    $loopagentsBySession.set({})
  })

  it('shows one workflow summary in Tasks and active/attention workers as Subagents', () => {
    reconcileKanbanSessionSource(SID, {
      workflow_id: 't_root',
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
          error_preview: 'review-required: needs eyes',
          log_tail: 'raw review worker transcript',
          summary: 'less useful summary',
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

    expect(groups.map(group => group.type)).toEqual(['todo', 'subagent'])
    expect(
      groups[0]!.items.map(item => [
        item.id,
        item.kanbanTaskId,
        item.todoStatus,
        item.currentTool,
        item.state,
        item.statusIndicator,
        item.taskProgress
      ])
    ).toEqual([
      [
        'kanban-task:t_root',
        't_root',
        'in_progress',
        'Loop',
        'failed',
        'attention',
        { blocked: 1, completed: 1, pending: 3, total: 5 }
      ]
    ])
    expect(
      groups[1]!.items.map(item => [item.id, item.state, item.sessionId, item.output, item.profile, item.currentTool])
    ).toEqual([
      ['kanban-agent:t_running:7', 'running', 'worker-session-7', undefined, 'peacock', 'Terminal'],
      ['kanban-agent:t_review:8', 'failed', undefined, 'review-required: needs eyes', 'reviewer-qa', 'Apply Patch']
    ])
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_queued')
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_done')
  })

  it('keeps an active Loop workflow in Tasks while showing its worker under Subagents', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      workflow_id: 't_root',
      tasks: [
        {
          id: 't_root',
          session_id: SID,
          status: 'running',
          title: 'Self-root smoke',
          included_parent_ids: [],
          included_child_ids: []
        }
      ],
      workers: [
        {
          current_tool: 'search_files',
          profile: 'default',
          run_id: 42,
          status: 'running',
          task_id: 't_root',
          task_status: 'running',
          task_title: 'Self-root smoke',
          worker_session_id: 'worker-session-root'
        }
      ]
    })

    const items = $kanbanStatusBySession.get()[SID] ?? []
    const groups = groupStatusItems(items)

    expect(groups.map(group => group.type)).toEqual(['todo', 'subagent'])
    expect(
      items.map(item => [item.id, item.type, item.kanbanTaskId, item.sessionId, item.profile, item.currentTool])
    ).toEqual([
      ['kanban-task:t_root', 'todo', 't_root', undefined, undefined, 'Loop'],
      ['kanban-agent:t_root:42', 'subagent', 't_root', 'worker-session-root', 'default', 'Search Files']
    ])
  })

  it('keeps a running worker active when its task is blocked', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      workflow_id: 't_root',
      tasks: [
        {
          id: 't_root',
          session_id: SID,
          status: 'blocked',
          title: 'Blocked task with a live worker',
          included_parent_ids: [],
          included_child_ids: []
        }
      ],
      workers: [
        {
          current_tool: 'terminal',
          profile: 'default',
          run_id: 44,
          summary_preview: 'review-required: stale prior summary',
          status: 'running',
          task_id: 't_root',
          task_status: 'blocked',
          task_title: 'Blocked task with a live worker',
          worker_session_id: 'worker-session-blocked-task'
        }
      ]
    })

    const worker = ($kanbanStatusBySession.get()[SID] ?? []).find(item => item.type === 'subagent')

    expect([worker?.state, worker?.statusIndicator]).toEqual(['running', 'active'])
  })

  it('keeps a subscribed workflow in Tasks when a member has an active worker and graph links', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      workflow_id: 't_root',
      tasks: [
        {
          created_by: 'loop_delegation:agent',
          id: 't_root',
          session_id: SID,
          status: 'running',
          title: 'Subscribed linked root',
          included_parent_ids: [],
          included_child_ids: ['t_child']
        },
        {
          id: 't_child',
          session_id: SID,
          status: 'ready',
          title: 'Root child',
          included_parent_ids: ['t_root'],
          included_child_ids: []
        }
      ],
      workers: [
        {
          current_tool: 'search_files',
          profile: 'default',
          run_id: 43,
          status: 'running',
          task_id: 't_root',
          task_status: 'running',
          task_title: 'Subscribed linked root',
          worker_session_id: 'worker-session-root'
        }
      ]
    })

    const items = $kanbanStatusBySession.get()[SID] ?? []
    const groups = groupStatusItems(items)

    expect(groups.map(group => group.type)).toEqual(['todo', 'subagent'])
    expect(groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.title, item.currentTool])).toEqual([
      ['kanban-task:t_root', 't_root', 'Subscribed linked root', 'Loop']
    ])
    expect(
      groups[1]!.items.map(item => [item.id, item.kanbanTaskId, item.sessionId, item.profile, item.currentTool])
    ).toEqual([['kanban-agent:t_root:43', 't_root', 'worker-session-root', 'default', 'Search Files']])
  })

  it('clears stale Kanban rows when session-source metadata disappears', () => {
    reconcileKanbanSessionSource(SID, { tasks: [{ id: 't_running', status: 'running', title: 'Running' }] })
    reconcileKanbanSessionSource(SID, null)

    expect($kanbanStatusBySession.get()).toEqual({})
  })

  it('uses the oldest member as the workflow summary for a decomposed workflow', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: 'tenant-a',
      workflow_id: 'wf_decomposed',
      tasks: [
        {
          created_at: 20,
          id: 't_child',
          status: 'ready',
          title: 'Implementation child',
          included_child_ids: ['t_root'],
          included_parent_ids: []
        },
        {
          created_at: 10,
          id: 't_root',
          session_id: SID,
          status: 'todo',
          title: 'Original Loop workflow',
          included_child_ids: [],
          included_parent_ids: ['t_child']
        }
      ]
    })

    expect(
      $kanbanStatusBySession
        .get()
        [SID]?.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 't_root', 'Original Loop workflow', 'pending', 'Loop']])
  })

  it('shows multiple Loop workflows from the same foreground session', () => {
    reconcileKanbanSessionSource(SID, {
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
          title: 'Harden foreground handoff',
          workflow_id: 'wf_old'
        },
        {
          id: 't_old_child',
          created_at: 11,
          created_by: 'foreground',
          included_child_ids: ['t_old_root'],
          included_parent_ids: [],
          status: 'running',
          title: 'Patch handoff child',
          workflow_id: 'wf_old'
        },
        {
          id: 't_new_root',
          created_at: 20,
          created_by: 'loop:t_new_root',
          included_child_ids: ['t_new_child'],
          included_parent_ids: ['t_new_child'],
          status: 'done',
          title: 'Create explainer atlas',
          workflow_id: 'wf_new'
        },
        {
          id: 't_new_child',
          created_at: 21,
          created_by: 'loop:t_new_root',
          included_child_ids: ['t_new_root'],
          included_parent_ids: [],
          status: 'done',
          title: 'Build atlas child',
          workflow_id: 'wf_new'
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

    expect(groups.map(group => group.type)).toEqual(['todo', 'subagent'])
    expect(
      groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([
      ['kanban-task:t_old_root', 't_old_root', 'Harden foreground handoff', 'in_progress', 'Loop'],
      ['kanban-task:t_new_root', 't_new_root', 'Create explainer atlas', 'completed', 'Loop']
    ])
    expect(groups[1]!.items.map(item => [item.id, item.kanbanTaskId])).toEqual([
      ['kanban-agent:t_old_root:1', 't_old_root'],
      ['kanban-agent:t_old_child:2', 't_old_child']
    ])
  })

  it('keeps the same workflow id distinct when it exists on two boards', () => {
    reconcileKanbanSessionSources(SID, [
      {
        board: 'alpha',
        session_id: SID,
        workflow_id: 'wf_shared',
        tasks: [
          {
            id: 't_root',
            included_child_ids: [],
            included_parent_ids: [],
            status: 'running',
            title: 'Alpha workflow'
          }
        ]
      },
      {
        board: 'beta',
        session_id: SID,
        workflow_id: 'wf_shared',
        tasks: [
          {
            id: 't_root',
            included_child_ids: [],
            included_parent_ids: [],
            status: 'running',
            title: 'Beta workflow'
          }
        ]
      }
    ])

    expect(
      $kanbanStatusBySession
        .get()
        [SID]?.map(item => [item.id, item.kanbanBoard, item.kanbanWorkflowId, item.kanbanTaskId, item.title])
    ).toEqual([
      ['kanban-task:alpha:t_root', 'alpha', 'wf_shared', 't_root', 'Alpha workflow'],
      ['kanban-task:beta:t_root', 'beta', 'wf_shared', 't_root', 'Beta workflow']
    ])
  })

  it('shows multiple delegate_task Loop workflows from the same foreground session', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: SID,
      tasks: [
        delegatedLoopTask('t_first_delegate', 10, 'First delegated Loop smoke'),
        delegatedLoopTask('t_second_delegate', 20, 'Second delegated Loop smoke')
      ]
    })

    const groups = groupStatusItems($kanbanStatusBySession.get()[SID] ?? [])

    expect(groups.map(group => group.type)).toEqual(['todo'])
    expect(
      groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([
      ['kanban-task:t_first_delegate', 't_first_delegate', 'First delegated Loop smoke', 'completed', 'Loop'],
      ['kanban-task:t_second_delegate', 't_second_delegate', 'Second delegated Loop smoke', 'completed', 'Loop']
    ])
  })

  it('rolls delegated tasks with the same workflow id into one summary', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: SID,
      tasks: [
        {
          ...delegatedLoopTask('t_child_delegate', 10, 'Delegated child'),
          included_parent_ids: ['t_root_delegate'],
          workflow_id: 'wf_delegate'
        },
        {
          ...delegatedLoopTask('t_root_delegate', 20, 'Delegated root'),
          included_child_ids: ['t_child_delegate'],
          workflow_id: 'wf_delegate'
        }
      ]
    })

    expect($kanbanStatusBySession.get()[SID]?.map(item => [item.id, item.kanbanTaskId, item.title])).toEqual([
      ['kanban-task:t_child_delegate', 't_child_delegate', 'Delegated child']
    ])
  })

  it('rolls nested tasks up under their explicit workflow id', () => {
    reconcileKanbanSessionSource(SID, {
      workflow_id: 'wf_outer',
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
          title: 'Outer Loop workflow'
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

    expect(
      $kanbanStatusBySession
        .get()
        [SID]?.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_outer_loop', 't_outer_loop', 'Outer Loop workflow', 'completed', 'Loop']])
  })

  it('uses the task matching workflow_id as the workflow summary when present', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: 'sess-current',
      lineage_session_ids: ['sess-root', 'sess-current'],
      workflow_id: 't_root',
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
          title: 'Original Loop workflow',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        }
      ]
    })

    expect(
      $kanbanStatusBySession
        .get()
        [SID]?.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 't_root', 'Original Loop workflow', 'pending', 'Loop']])
  })

  it('uses the oldest workflow member as its summary when no task id matches the workflow id', () => {
    reconcileKanbanSessionSource(SID, {
      session_id: SID,
      tenant: 'tenant-a',
      workflow_id: 'wf_lineage',
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
          title: 'Original Loop workflow',
          included_child_ids: ['t_child'],
          included_parent_ids: []
        }
      ]
    })

    expect(
      $kanbanStatusBySession
        .get()
        [SID]?.map(item => [item.id, item.kanbanTaskId, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 't_root', 'Original Loop workflow', 'pending', 'Loop']])
  })

  it('writes compressed lineage source under the active composer session key', () => {
    reconcileKanbanSessionSourceForComposer({
      activeSessionId: 'runtime-tip',
      source: {
        tasks: [
          { id: 't_root', status: 'done', title: 'Workflow task', included_parent_ids: [], included_child_ids: [] }
        ]
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
      $statusItemsBySession
        .get()
        ['runtime-tip']?.map(item => [item.id, item.type, item.state, item.sessionId, item.profile, item.currentTool])
    ).toEqual([['kanban-agent:t_running:7', 'subagent', 'running', 'worker-session-7', 'peacock', 'Terminal']])

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
      workflow_id: 'wf_loop',
      tasks: [
        { id: 't_root', status: 'ready', title: 'Snapshot title', included_parent_ids: [], included_child_ids: [] }
      ]
    })

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 3,
        task_id: 't_root',
        task_status: 'running',
        task_title: 'Live title',
        workflow_id: 'wf_loop'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.title, item.todoStatus, item.currentTool])
    ).toEqual([['kanban-task:t_root', 'Live title', 'in_progress', 'Loop']])
  })

  it('merges a live workflow task and worker over the snapshot row', () => {
    reconcileKanbanSessionSource('runtime-tip', {
      workflow_id: 'wf_loop',
      tasks: [
        {
          id: 't_root',
          status: 'running',
          title: 'Snapshot self-root',
          included_parent_ids: [],
          included_child_ids: []
        }
      ]
    })

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 3,
        task_id: 't_root',
        task_status: 'running',
        task_title: 'Live workflow',
        workflow_id: 'wf_loop'
      },
      'loopagent.task.upsert'
    )
    upsertLoopagent(
      ['runtime-tip'],
      {
        current_tool: 'read_file',
        event: 'loopagent.worker.upsert',
        profile: 'default',
        run_id: 42,
        run_status: 'running',
        task_id: 't_root',
        task_title: 'Live workflow',
        workflow_id: 'wf_loop',
        worker_session_id: 'worker-session-root'
      },
      'loopagent.worker.upsert'
    )

    expect(
      $statusItemsBySession
        .get()
        ['runtime-tip']?.map(item => [item.id, item.type, item.title, item.sessionId, item.profile, item.currentTool])
    ).toEqual([
      ['kanban-task:t_root', 'todo', 'Live workflow', undefined, undefined, 'Loop'],
      ['kanban-agent:t_root:42', 'subagent', 'Live workflow', 'worker-session-root', 'default', 'Read File']
    ])
  })

  it('aggregates ordinary live task activities by workflow and keeps workers underneath', () => {
    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 1,
        task_id: 't_build',
        task_status: 'running',
        task_title: 'Build implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )
    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 2,
        task_id: 't_review',
        task_status: 'blocked',
        task_title: 'Review implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )
    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.worker.upsert',
        profile: 'reviewer-qa',
        run_id: 9,
        run_status: 'running',
        task_id: 't_review',
        task_status: 'blocked',
        task_title: 'Review implementation',
        workflow_id: 'wf_dynamic',
        worker_session_id: 'worker-review'
      },
      'loopagent.worker.upsert'
    )

    expect(
      $statusItemsBySession
        .get()
        [
          'runtime-tip'
        ]?.map(item => [item.id, item.type, item.kanbanWorkflowId, item.kanbanTaskId, item.state, item.statusIndicator])
    ).toEqual([
      ['kanban-workflow:wf_dynamic', 'todo', 'wf_dynamic', 't_build', 'failed', 'attention'],
      ['kanban-agent:t_review:9', 'subagent', undefined, 't_review', 'running', 'active']
    ])
  })

  it('updates one live workflow summary with dynamic descendant progress', () => {
    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 1,
        task_id: 't_build',
        task_status: 'done',
        task_title: 'Build implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.kanbanWorkflowId, item.taskProgress])
    ).toEqual([['kanban-workflow:wf_dynamic', 'wf_dynamic', { blocked: 0, completed: 1, pending: 0, total: 1 }]])

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 2,
        task_id: 't_review',
        task_status: 'running',
        task_title: 'Review implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.kanbanWorkflowId, item.taskProgress])
    ).toEqual([['kanban-workflow:wf_dynamic', 'wf_dynamic', { blocked: 0, completed: 1, pending: 1, total: 2 }]])

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 3,
        task_id: 't_review',
        task_status: 'blocked',
        task_title: 'Review implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.kanbanWorkflowId, item.taskProgress])
    ).toEqual([['kanban-workflow:wf_dynamic', 'wf_dynamic', { blocked: 1, completed: 1, pending: 0, total: 2 }]])

    upsertLoopagent(
      ['runtime-tip'],
      {
        event: 'loopagent.task.upsert',
        revision: 4,
        task_id: 't_review',
        task_status: 'done',
        task_title: 'Review implementation',
        workflow_id: 'wf_dynamic'
      },
      'loopagent.task.upsert'
    )

    expect(
      $statusItemsBySession.get()['runtime-tip']?.map(item => [item.id, item.kanbanWorkflowId, item.taskProgress])
    ).toEqual([['kanban-workflow:wf_dynamic', 'wf_dynamic', { blocked: 0, completed: 2, pending: 0, total: 2 }]])
  })
})
