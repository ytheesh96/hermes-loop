import { describe, expect, it } from 'vitest'

import { activeTimelineIndex, deriveTimelineEntries, timelinePreview } from './timeline-data'

describe('timelinePreview', () => {
  it('collapses whitespace to a single line', () => {
    expect(timelinePreview('hello\n\n  world\tagain')).toBe('hello world again')
  })

  it('truncates with an ellipsis past the limit', () => {
    const out = timelinePreview('abcdefghij', 5)
    expect(out).toBe('abcd…')
    expect(out.length).toBe(5)
  })
})

describe('deriveTimelineEntries', () => {
  it('keeps non-empty user prompts in order', () => {
    expect(
      deriveTimelineEntries([
        { id: 'u1', role: 'user', text: 'first' },
        { id: 'a1', role: 'assistant', text: 'answer' },
        { id: 'u2', role: 'user', text: '  second  ' }
      ])
    ).toEqual([
      { id: 'u1', preview: 'first' },
      { id: 'u2', preview: 'second' }
    ])
  })

  it('drops blanks and injected process notifications', () => {
    expect(
      deriveTimelineEntries([
        { id: 'u1', role: 'user', text: '   ' },
        { id: 'u2', role: 'user', text: '[IMPORTANT: Background process 123 finished]' },
        {
          id: 'u3',
          role: 'user',
          text:
            '[IMPORTANT: A workflow produced a task-boundary batch. Handle this workflow in isolation for this foreground turn.]\n\n' +
            '[IMPORTANT: ✔ @worker Kanban t_1234 done — verify the result]'
        },
        {
          id: 'u4',
          role: 'user',
          text: '[IMPORTANT: ✔ @worker Kanban t_5678 done — legacy completion re-entry]'
        },
        { id: 'u5', role: 'user', text: 'real prompt' }
      ]).map(e => e.id)
    ).toEqual(['u5'])
  })

  it('keeps human prompts that mention completed Kanban work', () => {
    expect(
      deriveTimelineEntries([{ id: 'u1', role: 'user', text: 'Summarize the Kanban tasks that are done' }])
    ).toEqual([{ id: 'u1', preview: 'Summarize the Kanban tasks that are done' }])
  })
})

describe('activeTimelineIndex', () => {
  it('returns the last prompt scrolled to or above the top edge', () => {
    expect(activeTimelineIndex([-400, -10, 320])).toBe(1)
  })

  it('falls back to the first rendered entry', () => {
    expect(activeTimelineIndex([null, 120, 480])).toBe(1)
    expect(activeTimelineIndex([null, null])).toBe(0)
  })
})
