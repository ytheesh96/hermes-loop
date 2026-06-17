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
      status: 'triage',
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

  it('turns intake-needed rows into a grill-me assistant prompt', () => {
    const row = deriveLoopPanelStateFromTenantSource(titleOnlyIntakeSource)!.rows[0]!
    const draft = buildLoopChatDraft(row)

    expect(draft).toContain('For Loop row t_intake (Launch a Peacock workflow)')
    expect(draft).toContain('start the grill-me Loop intake path')
    expect(draft).toContain('ask exactly one unresolved decision')
    expect(draft).toContain('mark the recommended option inline')
    expect(draft).toContain('write each locked decision into the canonical task body')
    expect(draft).toContain('leave the row triage/non-dispatchable until I explicitly approve Decompose or activation')
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
          status: 'triage',
          tenant: 'session-ready',
          title: 'Ready spec'
        }
      ]
    })

    expect(buildLoopChatDraft(state!.rows[0]!)).toBe('Help me with Loop task t_ready: Ready spec')
  })
})
