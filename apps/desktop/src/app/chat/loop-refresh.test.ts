import { describe, expect, it } from 'vitest'

import {
  LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS,
  LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS,
  loopSessionSourceRefetchInterval
} from './loop-refresh'
import type { TenantLoopSource } from './loop-state'

describe('loopSessionSourceRefetchInterval', () => {
  it('polls active Loop session-source rows frequently so task status changes refresh automatically', () => {
    const source: TenantLoopSource = {
      session_id: 'session-1',
      latest_event_id: 10,
      tasks: [
        {
          id: 't_running',
          status: 'running',
          title: 'Worker is running'
        }
      ]
    }

    expect(loopSessionSourceRefetchInterval(source)).toBe(LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS)
  })

  it('keeps a slower idle poll for empty sources so external Loop rows can appear without manual refresh', () => {
    expect(loopSessionSourceRefetchInterval({ session_id: 'session-1', latest_event_id: 0, tasks: [] })).toBe(
      LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
    )
    expect(loopSessionSourceRefetchInterval(null)).toBe(LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS)
  })

  it('stops automatic polling once a non-empty Loop source is fully terminal', () => {
    const source: TenantLoopSource = {
      session_id: 'session-1',
      latest_event_id: 20,
      tasks: [
        {
          id: 't_done',
          status: 'done',
          title: 'Completed work'
        },
        {
          id: 't_cancelled',
          status: 'cancelled',
          title: 'Cancelled follow-up'
        }
      ]
    }

    expect(loopSessionSourceRefetchInterval(source)).toBe(false)
  })

  it('keeps polling a terminal task while a first-class handoff is open', () => {
    const source: TenantLoopSource = {
      session_id: 'session-1',
      latest_event_id: 30,
      tasks: [
        {
          id: 't_done_waiting',
          status: 'done',
          title: 'Completed work awaiting foreground approval',
          loop_handoffs: [
            {
              id: 55,
              intent: 'approve',
              target_actor: 'foreground',
              queue_state: 'open',
              state: 'queued',
              summary: 'Task -> Run -> Handoff demo'
            }
          ]
        }
      ]
    }

    expect(loopSessionSourceRefetchInterval(source)).toBe(LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS)
  })

  it('keeps polling a terminal task while a legacy cached handoff state is still active', () => {
    const source: TenantLoopSource = {
      session_id: 'session-1',
      latest_event_id: 31,
      tasks: [
        {
          id: 't_done_legacy_handoff',
          status: 'done',
          title: 'Completed work with cached handoff',
          loop_handoffs: [
            {
              id: 56,
              handoff_kind: 'worker_completed',
              state: 'queued',
              summary: 'Legacy queued handoff'
            }
          ]
        }
      ]
    }

    expect(loopSessionSourceRefetchInterval(source)).toBe(LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS)
  })
})
