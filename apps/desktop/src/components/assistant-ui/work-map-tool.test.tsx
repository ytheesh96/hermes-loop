import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkMapItem } from '@/lib/work-map'

import { HoistedWorkMapPanel, workMapFromMessageContent } from './work-map-tool'

describe('workMapFromMessageContent', () => {
  it('returns the latest work_map tool-call and parses JSON or object payloads', () => {
    const content: Array<Record<string, unknown>> = [
      {
        type: 'tool-call',
        toolName: 'todo',
        result: JSON.stringify({ todos: [{ id: 'ignore', content: 'ignore', status: 'pending' }] }),
        args: {}
      },
      {
        type: 'tool-call',
        toolName: 'work_map',
        result: JSON.stringify({
          work_map: [{ id: 'old', content: 'Old loop', status: 'pending' }]
        }),
        args: {}
      },
      {
        type: 'tool-call',
        toolName: 'work_map',
        result: null,
        args: {
          work_map: [
            {
              id: 'new',
              content: 'New loop',
              status: 'blocked',
              kind: 'verification',
              attention: 'needs-orchestrator',
              verification_state: 'needs-orchestrator'
            }
          ]
        }
      }
    ]

    expect(workMapFromMessageContent(content)).toEqual<WorkMapItem[]>([
      {
        id: 'new',
        content: 'New loop',
        status: 'blocked',
        kind: 'verification',
        attention: 'needs-orchestrator',
        verification_state: 'needs-orchestrator'
      }
    ])
  })
})

describe('HoistedWorkMapPanel', () => {
  it('renders the locked Loop Work Map copy and the loop label', () => {
    const html = renderToStaticMarkup(
      <HoistedWorkMapPanel
        workMap={[
          {
            id: 'alpha',
            content: 'Finalize review',
            status: 'in_progress',
            kind: 'worker-task',
            attention: 'needs-orchestrator',
            verification_state: 'needs-orchestrator'
          },
          {
            id: 'beta',
            content: 'Ship follow-up',
            status: 'blocked',
            kind: 'verification'
          }
        ]}
      />
    )

    expect(html).toContain('Loop Work Map')
    expect(html).toContain('Hermes Loop')
    expect(html).toContain('Finalize review')
    expect(html).toContain('Ship follow-up')
  })
})
