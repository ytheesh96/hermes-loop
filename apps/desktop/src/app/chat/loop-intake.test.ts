import { describe, expect, it } from 'vitest'

import { buildLoopChatDraft } from './loop-intake'
import { deriveLoopPanelStateFromTenantSource, type TenantLoopSource } from './loop-state'

const titleOnlyIntakeSource: TenantLoopSource = {
  latest_event_id: 1,
  root_task_id: 't_intake',
  session_id: 'session-intake',
  tasks: [
    {
      body: null,
      created_by: 'loop:t_intake',
      id: 't_intake',
      status: 'scheduled',
      tenant: 'session-intake',
      title: 'Launch a Peacock workflow',
      loop_intake: {
        dispatchable: false,
        needed: true,
        source: 'slash_loop_draft',
        state: 'drafted'
      }
    }
  ]
}

describe('Loop intake foreground trigger', () => {
  it('derives durable intake state onto Loop rows', () => {
    const state = deriveLoopPanelStateFromTenantSource(titleOnlyIntakeSource)

    expect(state?.rows[0]?.loopIntake).toEqual({
      dispatchable: false,
      needed: true,
      source: 'slash_loop_draft',
      state: 'drafted'
    })
  })

  it('turns intake-needed rows into a graph-first planning prompt', () => {
    const row = deriveLoopPanelStateFromTenantSource(titleOnlyIntakeSource)!.rows[0]!
    const draft = buildLoopChatDraft(row)

    expect(draft).toContain('For Loop row t_intake (Launch a Peacock workflow)')
    expect(draft).toContain('start the graph-first Loop intake path')
    expect(draft).toContain('Treat this row as the real Loop/Kanban root')
    expect(draft).toContain('Use the Loop graph as the exploration surface')
    expect(draft).toContain('scheduled option tasks')
    expect(draft).toContain('The clarify choices must match those option tasks')
    expect(draft).toContain('delete/archive unchosen sibling option tasks')
    expect(draft).toContain('origin activation')
    expect(draft).not.toContain('Interview me relentlessly')
    expect(draft).not.toContain('Resolved decisions')
  })

  it('keeps ordinary Loop chat drafts for rows without durable intake state', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 1,
      root_task_id: 't_ready',
      session_id: 'session-ready',
      tasks: [
        {
          body: 'Already specified',
          created_by: 'loop:t_ready',
          id: 't_ready',
          status: 'scheduled',
          tenant: 'session-ready',
          title: 'Ready spec'
        }
      ]
    })

    expect(buildLoopChatDraft(state!.rows[0]!)).toBe('Help me with Loop task t_ready: Ready spec')
  })
})
