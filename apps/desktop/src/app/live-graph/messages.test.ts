import { describe, expect, it } from 'vitest'

import type { LoopSessionCommentsSource } from '@/app/chat/loop-state'

import { normalizeSessionMessages } from './messages'
import type { LiveGraphNode } from './model'

const taskNode = (board: string, entityId: string): LiveGraphNode => ({
  board,
  entityId,
  id: `task:${board}:${entityId}`,
  kind: 'task',
  label: entityId
})

describe('normalizeSessionMessages', () => {
  it('keeps board-local id collisions, deduplicates repeated rows, and orders stable ties', () => {
    const sources: LoopSessionCommentsSource[] = [
      {
        board: ' Beta ',
        comments: [
          {
            author: '  Builder ',
            body: 'Beta message',
            created_at: 10,
            id: 1,
            task_id: 'task-b',
            task_status: 'in progress',
            task_title: 'Beta task'
          },
          {
            author: 'Builder',
            body: 'Beta message duplicate',
            created_at: 10,
            id: 1,
            task_id: 'task-b',
            task_status: 'running',
            task_title: 'Beta task'
          }
        ]
      },
      {
        board: 'alpha',
        comments: [
          {
            author: 'Reviewer',
            body: 'Alpha message',
            created_at: 10,
            id: 1,
            task_id: 'task-a',
            task_status: 'done',
            task_title: 'Alpha task'
          }
        ]
      }
    ]

    expect(
      normalizeSessionMessages('session-profile', sources, [taskNode('alpha', 'task-a'), taskNode('beta', 'task-b')])
    ).toEqual([
      {
        author: 'Reviewer',
        board: 'alpha',
        body: 'Alpha message',
        createdAt: 10,
        id: 'session-profile\u0000alpha\u00001',
        status: 'completed',
        taskId: 'task-a',
        taskTitle: 'Alpha task',
        workflowId: null
      },
      {
        author: 'Builder',
        board: 'beta',
        body: 'Beta message',
        createdAt: 10,
        id: 'session-profile\u0000beta\u00001',
        status: 'running',
        taskId: 'task-b',
        taskTitle: 'Beta task',
        workflowId: null
      }
    ])
  })

  it('filters outside-graph and invalid comments while preserving body line breaks', () => {
    const sources: LoopSessionCommentsSource[] = [
      {
        board: 'default',
        comments: [
          { body: 'First line\n\nSecond line', created_at: 12, id: 3, task_id: 'shown' },
          { body: 'outside', created_at: 13, id: 4, task_id: 'hidden' },
          { body: '   ', created_at: 14, id: 5, task_id: 'shown' },
          { body: 'invalid id', created_at: 15, id: 1.5, task_id: 'shown' }
        ]
      }
    ]

    expect(normalizeSessionMessages('profile', sources, [taskNode('default', 'shown')])).toEqual([
      {
        author: '',
        board: 'default',
        body: 'First line\n\nSecond line',
        createdAt: 12,
        id: 'profile\u0000default\u00003',
        status: 'unknown',
        taskId: 'shown',
        taskTitle: 'shown',
        workflowId: null
      }
    ])
  })
})
