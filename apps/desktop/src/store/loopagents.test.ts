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
