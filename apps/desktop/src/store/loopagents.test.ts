import { beforeEach, describe, expect, it } from 'vitest'

import { $loopagentsBySession, loopagentSessionKeys, upsertLoopagent } from './loopagents'

describe('loopagent store', () => {
  beforeEach(() => {
    $loopagentsBySession.set({})
  })

  it('keys activity by explicit, current, logical, source, lineage, and worker sessions', () => {
    const payload = {
      current_session_id: 'runtime-tip',
      lineage_session_ids: ['compression-root', 'runtime-tip', 'ancestor'],
      logical_session_id: 'logical-root',
      source_session_id: 'source-root',
      worker_session_id: 'worker-session'
    }

    expect(loopagentSessionKeys(payload, 'event-session')).toEqual([
      'event-session',
      'runtime-tip',
      'logical-root',
      'source-root',
      'compression-root',
      'ancestor',
      'worker-session'
    ])
  })

  it('upserts the same Loop worker into every session key and ignores stale revisions', () => {
    const sessionKeys = ['runtime-tip', 'source-root']

    upsertLoopagent(
      sessionKeys,
      {
        current_tool: 'terminal',
        event: 'loopagent.worker.upsert',
        profile: 'peacock',
        revision: 2,
        run_id: 7,
        source_session_id: 'source-root',
        status: 'running',
        summary_preview: 'building the patch',
        task_id: 't_loop',
        task_title: 'Wire Loop activity',
        workflow_id: 'wf_loop',
        worker_session_id: 'worker-session-7'
      },
      'loopagent.worker.upsert'
    )

    upsertLoopagent(
      sessionKeys,
      {
        current_tool: 'apply_patch',
        event: 'loopagent.worker.upsert',
        revision: 1,
        run_id: 7,
        status: 'running',
        task_id: 't_loop',
        task_title: 'stale title'
      },
      'loopagent.worker.upsert'
    )

    expect($loopagentsBySession.get()['runtime-tip']).toEqual($loopagentsBySession.get()['source-root'])
    expect($loopagentsBySession.get()['runtime-tip']?.[0]).toMatchObject({
      currentTool: 'terminal',
      id: 'loopagent:worker:t_loop:7',
      kind: 'worker',
      profile: 'peacock',
      revision: 2,
      runId: 7,
      status: 'running',
      summaryPreview: 'building the patch',
      taskId: 't_loop',
      title: 'Wire Loop activity',
      workerSessionId: 'worker-session-7',
      workflowId: 'wf_loop'
    })
  })

  it('keeps identical task and run ids isolated by board while preserving legacy ids', () => {
    for (const board of ['alpha', 'beta']) {
      upsertLoopagent(
        ['session-one'],
        {
          board,
          event: 'loopagent.worker.upsert',
          revision: 1,
          run_id: 7,
          status: 'running',
          task_id: 'shared-task'
        },
        'loopagent.worker.upsert'
      )
    }

    upsertLoopagent(
      ['session-one'],
      {
        event: 'loopagent.worker.upsert',
        revision: 1,
        run_id: 7,
        status: 'running',
        task_id: 'legacy-task'
      },
      'loopagent.worker.upsert'
    )

    expect($loopagentsBySession.get()['session-one']?.map(activity => activity.id)).toEqual([
      'loopagent:worker:alpha:shared-task:7',
      'loopagent:worker:beta:shared-task:7',
      'loopagent:worker:legacy-task:7'
    ])
  })

  it('retains safe structured worker activity, real timing, tool count, and changed files', () => {
    const base = {
      created_at: '2026-07-19T00:00:00Z',
      profile: 'peacock',
      run_id: 7,
      run_status: 'running',
      source_session_id: 'source-root',
      task_id: 't_loop',
      task_title: 'Wire Loop activity',
      worker_session_id: 'worker-session-7'
    }

    upsertLoopagent(
      ['source-root'],
      {
        ...base,
        event: 'kanban.worker.tool_start',
        sequence: 1,
        tool_call_id: 'call-1',
        tool_context: 'example.txt',
        tool_name: 'read_file'
      },
      'kanban.worker.tool_start'
    )

    // The canonical mirror carries the same sequence. It updates no history
    // because the raw structured event was already accepted.
    upsertLoopagent(
      ['source-root'],
      {
        ...base,
        current_tool: 'read_file',
        event: 'loopagent.worker.upsert',
        sequence: 1,
        summary_preview: 'duplicate mirror'
      },
      'loopagent.worker.upsert'
    )

    upsertLoopagent(
      ['source-root'],
      {
        ...base,
        event: 'kanban.worker.tool_progress',
        progress_current: 12,
        progress_text: 'read 12 lines',
        progress_total: 12,
        sequence: 2,
        tool_name: 'read_file',
        unit: 'lines'
      },
      'kanban.worker.tool_progress'
    )

    upsertLoopagent(
      ['source-root'],
      {
        ...base,
        event: 'kanban.worker.thinking',
        redacted: false,
        sequence: 3,
        text: 'checking edge cases'
      },
      'kanban.worker.thinking'
    )

    upsertLoopagent(
      ['source-root'],
      {
        ...base,
        event: 'kanban.worker.tool_complete',
        sequence: 4,
        success: true,
        tool_name: 'terminal',
        tool_preview: 'terminal exited 0'
      },
      'kanban.worker.tool_complete'
    )

    upsertLoopagent(
      ['source-root'],
      {
        changed_files_preview: ['apps/desktop/src/store/loopagents.ts'],
        created_at: '2026-07-19T00:01:00Z',
        event: 'loopagent.worker.upsert',
        revision: 5,
        run_id: 7,
        run_status: 'completed',
        safe_summary: 'implemented structured activity',
        task_id: 't_loop'
      },
      'loopagent.worker.upsert'
    )

    const worker = $loopagentsBySession.get()['source-root']?.[0]

    expect(worker).toMatchObject({
      filesWritten: ['apps/desktop/src/store/loopagents.ts'],
      startedAt: Date.parse('2026-07-19T00:00:00Z'),
      status: 'completed',
      toolCount: 1
    })
    expect(worker?.stream?.map(entry => [entry.kind, entry.text, entry.isError])).toEqual([
      ['tool', 'Read File("example.txt")', undefined],
      ['progress', 'read 12 lines · 12/12 lines', undefined],
      ['thinking', 'checking edge cases', undefined],
      ['tool', 'Terminal("terminal exited 0")', false],
      ['summary', 'implemented structured activity', false]
    ])
    expect(worker?.summaryPreview).toBe('implemented structured activity')
  })

  it('allows newer revisions to move a previously terminal task back to active', () => {
    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.worker.upsert',
        revision: 3,
        run_id: 1,
        status: 'completed',
        task_id: 't_loop',
        task_title: 'Loop task'
      },
      'loopagent.worker.upsert'
    )

    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.worker.upsert',
        revision: 4,
        run_id: 1,
        status: 'running',
        task_id: 't_loop'
      },
      'loopagent.worker.upsert'
    )

    expect($loopagentsBySession.get().s1?.[0]?.status).toBe('running')
  })

  it('keeps task rows separate from worker rows and records their canonical workflow', () => {
    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.task.upsert',
        revision: 1,
        task_id: 't_loop',
        task_status: 'running',
        task_title: 'Loop task',
        workflow_id: 'wf_loop'
      },
      'loopagent.task.upsert'
    )

    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.worker.upsert',
        profile: 'peacock',
        revision: 2,
        run_id: 7,
        run_status: 'running',
        task_id: 't_loop',
        task_title: 'Loop task',
        workflow_id: 'wf_loop'
      },
      'loopagent.worker.upsert'
    )

    expect($loopagentsBySession.get().s1?.map(item => [item.id, item.kind])).toEqual([
      ['loopagent:task:t_loop', 'task'],
      ['loopagent:worker:t_loop:7', 'worker']
    ])
    expect($loopagentsBySession.get().s1?.map(item => item.workflowId)).toEqual(['wf_loop', 'wf_loop'])
    expect($loopagentsBySession.get().s1?.map(item => item.isRootTask)).toEqual([undefined, undefined])
  })

  it("keeps a worker's live run status separate from its blocked task", () => {
    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.worker.upsert',
        run_id: 7,
        run_status: 'running',
        task_id: 't_blocked',
        task_status: 'blocked',
        task_title: 'Blocked task with a live worker'
      },
      'loopagent.worker.upsert'
    )

    expect($loopagentsBySession.get().s1?.[0]).toMatchObject({
      kind: 'worker',
      status: 'running',
      taskId: 't_blocked',
      taskStatus: 'blocked'
    })
  })

  it('keeps is_root_task only as a legacy fallback when workflow_id is absent', () => {
    upsertLoopagent(
      ['s1'],
      {
        event: 'loopagent.task.upsert',
        is_root_task: false,
        parent_task_ids: ['t_parent'],
        task_id: 't_child',
        task_status: 'running'
      },
      'loopagent.task.upsert'
    )

    expect($loopagentsBySession.get().s1?.[0]).toMatchObject({
      isRootTask: false,
      taskId: 't_child',
      workflowId: undefined
    })
  })
})
