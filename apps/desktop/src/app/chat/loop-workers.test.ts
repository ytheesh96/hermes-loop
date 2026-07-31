import { describe, expect, it } from 'vitest'

import { loopWorkerCounts, normalizeLoopWorkers, type TenantLoopSource } from './loop-state'

const source: TenantLoopSource = {
  now: 1_000,
  workers: [
    {
      run_id: 1,
      task_id: 't_running',
      task_title: 'Running task',
      profile: 'peacock',
      status: 'running',
      started_at: 100,
      last_heartbeat_at: 980,
      summary: 'halfway there',
      worker_session_id: 'worker-session-1',
      log_tail_available: true,
      log_tail: 'worker log line'
    },
    {
      run_id: 2,
      task_id: 't_stale',
      task_title: 'Stale task',
      profile: 'reviewer-qa',
      status: 'running',
      started_at: 100,
      last_heartbeat_at: 100
    },
    {
      run_id: 3,
      task_id: 't_failed',
      task_title: 'Failed task',
      profile: 'peacock',
      status: 'completed',
      outcome: 'failed',
      started_at: 200,
      ended_at: 900,
      error: 'boom'
    },
    {
      run_id: 4,
      task_id: 't_done',
      task_title: 'Done task',
      profile: 'peacock',
      status: 'completed',
      outcome: 'success',
      started_at: 100,
      ended_at: 800,
      summary: 'done'
    }
  ]
}

describe('normalizeLoopWorkers', () => {
  it('maps active and recent Loop worker runs separately from delegate subagent state', () => {
    const workers = normalizeLoopWorkers(source, { nowSeconds: 1_000, staleHeartbeatSeconds: 600 })

    expect(workers.map(worker => [worker.taskId, worker.state])).toEqual([
      ['t_running', 'running'],
      ['t_stale', 'stale'],
      ['t_failed', 'failed'],
      ['t_done', 'done']
    ])
    expect(workers[0]).toMatchObject({
      action: 'open-session',
      elapsedSeconds: 900,
      heartbeatAgeSeconds: 20,
      latestText: 'halfway there',
      logTail: 'worker log line',
      logTailAvailable: true,
      workerSessionId: 'worker-session-1'
    })
    expect(workers[1]).toMatchObject({ action: 'inspect-run', heartbeatAgeSeconds: 900 })
    expect(workers[2]).toMatchObject({ attention: true, latestText: 'boom' })
  })

  it('counts running and attention Loop workers for the statusbar', () => {
    const workers = normalizeLoopWorkers(source, { nowSeconds: 1_000, staleHeartbeatSeconds: 600 })

    expect(loopWorkerCounts(workers)).toEqual({ attention: 2, running: 1, total: 4 })
  })
})
