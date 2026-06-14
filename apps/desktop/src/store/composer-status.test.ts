import { beforeEach, describe, expect, it } from 'vitest'

import {
  $backgroundStatusBySession,
  $kanbanStatusBySession,
  dismissBackgroundProcess,
  groupStatusItems,
  reconcileBackgroundProcesses,
  reconcileKanbanSessionSourceForComposer,
  reconcileKanbanSessionSource
} from './composer-status'

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
  })

  it('shows only the root Kanban task in Tasks and only active/attention children in Subagents', () => {
    reconcileKanbanSessionSource(SID, {
      tasks: [
        { id: 't_root', status: 'running', title: 'Root Kanban task', included_parent_ids: [], included_child_ids: ['t_running', 't_queued', 't_review', 't_done'] },
        { id: 't_running', status: 'running', title: 'Running child', included_parent_ids: ['t_root'], included_child_ids: [] },
        { id: 't_queued', status: 'ready', title: 'Queued child', included_parent_ids: ['t_root'], included_child_ids: [] },
        { id: 't_review', status: 'blocked', title: 'Review child', latest_summary: 'review-required: needs eyes', included_parent_ids: ['t_root'], included_child_ids: [] },
        { id: 't_done', status: 'done', title: 'Completed child', included_parent_ids: ['t_root'], included_child_ids: [] }
      ],
      workers: [
        {
          run_id: 7,
          task_id: 't_running',
          task_title: 'Running child',
          profile: 'peacock',
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
          summary: 'review-required: needs eyes'
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
    expect(groups[0]!.items.map(item => [item.id, item.kanbanTaskId, item.todoStatus])).toEqual([
      ['kanban-task:t_root', 't_root', 'in_progress']
    ])
    expect(groups[1]!.items.map(item => [item.id, item.state, item.sessionId, item.output])).toEqual([
      ['kanban-agent:t_running:7', 'running', 'worker-session-7', 'worker log tail'],
      ['kanban-agent:t_review:8', 'failed', undefined, 'review-required: needs eyes']
    ])
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_queued')
    expect(items.map(item => item.kanbanTaskId)).not.toContain('t_done')
  })

  it('clears stale Kanban rows when session-source metadata disappears', () => {
    reconcileKanbanSessionSource(SID, { tasks: [{ id: 't_running', status: 'running', title: 'Running' }] })
    reconcileKanbanSessionSource(SID, null)

    expect($kanbanStatusBySession.get()).toEqual({})
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
    expect(bySession['runtime-tip']?.map(item => [item.id, item.kanbanTaskId, item.todoStatus])).toEqual([
      ['kanban-task:t_root', 't_root', 'completed']
    ])
  })
})
