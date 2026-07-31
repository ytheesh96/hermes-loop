import { describe, expect, it } from 'vitest'

import type { LoopSessionThreadsSource } from '@/app/chat/loop-state'

import { groupSessionMessageThreads, mergeSessionThreadSources, normalizeSessionThreads } from './messages'

const source = (overrides: Partial<LoopSessionThreadsSource> = {}): LoopSessionThreadsSource => ({
  board: 'default',
  latest_reply_id: 12,
  replies: [
    {
      author: 'decomposer',
      body: 'Decomposed into child-a',
      created_at: 20,
      id: 10,
      root_task_id: 'root-a',
      task_id: 'root-a'
    },
    {
      author: 'builder',
      body: 'Child complete',
      created_at: 30,
      id: 12,
      root_task_id: 'root-a',
      task_id: 'child-a'
    }
  ],
  threads: [
    {
      created_at: 10,
      description: 'Original foreground request',
      latest_reply_id: 12,
      legacy_root: false,
      origin_session_id: 'session-a',
      root_task_id: 'root-a',
      tenant: 'tenant-a',
      title: 'Submitted task',
      workflow_id: 'workflow-a'
    }
  ],
  ...overrides
})

describe('session task threads', () => {
  it('renders the immutable root first and replies in authoritative chronological order', () => {
    const messages = normalizeSessionThreads('profile-a', [
      source({
        replies: [
          {
            author: 'builder',
            body: 'Inserted first but later timestamp',
            created_at: 30,
            id: 11,
            root_task_id: 'root-a',
            task_id: 'child-a'
          },
          {
            author: 'decomposer',
            body: 'Decomposition',
            created_at: 20,
            id: 12,
            root_task_id: 'root-a',
            task_id: 'root-a'
          }
        ]
      })
    ])

    expect(messages.map(message => [message.kind, message.body])).toEqual([
      ['root', 'Original foreground request'],
      ['reply', 'Decomposition'],
      ['reply', 'Inserted first but later timestamp']
    ])
    expect(groupSessionMessageThreads('profile-a', messages)[0]?.messages).toEqual(messages)
  })

  it('merges polling deltas without duplicate roots or replies and uses timestamp then id ordering', () => {
    const initial = source({
      latest_reply_id: 2,
      replies: [
        {
          author: 'decomposer',
          body: 'first',
          created_at: 30,
          id: 2,
          root_task_id: 'root-a',
          task_id: 'root-a'
        }
      ]
    })
    const delta = source({
      latest_reply_id: 10,
      replies: [
        initial.replies[0]!,
        {
          author: 'builder-a',
          body: 'same second, higher id',
          created_at: 30,
          id: 10,
          root_task_id: 'root-a',
          task_id: 'child-a'
        }
      ]
    })

    const merged = mergeSessionThreadSources([initial], [delta])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.threads).toHaveLength(1)
    expect(merged[0]?.replies.map(reply => reply.id)).toEqual([2, 10])
    expect(merged[0]?.latest_reply_id).toBe(10)
  })

  it('keeps board-local reply identities isolated', () => {
    const merged = mergeSessionThreadSources(
      [source({ board: 'alpha' })],
      [source({ board: 'beta' })]
    )
    expect(merged.map(item => item.board)).toEqual(['alpha', 'beta'])
    expect(normalizeSessionThreads('profile-a', merged).filter(message => message.kind === 'root')).toHaveLength(2)
  })
})
