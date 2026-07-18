import { describe, expect, it } from 'vitest'

import { buildLoopChatDraft, buildLoopTriageDraft } from './loop-intake'
import { deriveLoopPanelStateFromTenantSource, type TenantLoopSource } from './loop-state'

const titleOnlyIntakeSource: TenantLoopSource = {
  latest_event_id: 1,
  workflow_id: 't_intake',
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

  it('turns intake-needed rows into the foreground triage skill command', () => {
    const row = deriveLoopPanelStateFromTenantSource(titleOnlyIntakeSource)!.rows[0]!
    const draft = buildLoopTriageDraft(row, 'developer')

    expect(draft).toBe(
      '/loop-triage Triage Loop workflow task t_intake on Kanban board developer: Launch a Peacock workflow'
    )
  })

  it('ignores legacy planning projections', () => {
    const source = {
      ...titleOnlyIntakeSource,
      planning_links: [{ parent_id: 't_intake', child_id: 'plan:option-a' }],
      planning_nodes: [{ id: 'plan:option-a', status: 'scheduled', title: 'Option A' }]
    } as TenantLoopSource

    expect(deriveLoopPanelStateFromTenantSource(source)?.rows.map(row => row.taskId)).toEqual(['t_intake'])
  })

  it('keeps ordinary Loop chat drafts for rows without durable intake state', () => {
    const state = deriveLoopPanelStateFromTenantSource({
      latest_event_id: 1,
      workflow_id: 't_ready',
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

  it('keeps Ask in chat generic even when the task still needs triage', () => {
    const row = deriveLoopPanelStateFromTenantSource(titleOnlyIntakeSource)!.rows[0]!

    expect(buildLoopChatDraft(row)).toBe('Help me with Loop task t_intake: Launch a Peacock workflow')
  })
})
