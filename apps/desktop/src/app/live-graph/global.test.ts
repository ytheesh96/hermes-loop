import { describe, expect, it } from 'vitest'

import type { WorkflowOverviewBoard, WorkflowOverviewResponse } from '@/hermes'

import { buildGlobalOverviewSnapshot, mergeWorkflowOverview, mergeWorkflowOverviewBoards } from './global'
import { liveGraphNodeId } from './model'

const board = (slug: string, sourceRevision: number): WorkflowOverviewBoard => ({
  links: [],
  slug,
  source_revision: sourceRevision,
  tasks: [],
  workers: [],
  workflows: []
})

describe('mergeWorkflowOverviewBoards', () => {
  it('preserves response identity when a poll repeats the same snapshot', () => {
    const previous: WorkflowOverviewResponse = {
      boards: [board('alpha', 1)],
      errors: [],
      schema_version: 1,
      sessions: []
    }

    const next = mergeWorkflowOverview(previous, { ...previous })

    expect(next).toBe(previous)
  })

  it('updates healthy shards and retains only temporarily failed shards', () => {
    expect(
      mergeWorkflowOverviewBoards([board('alpha', 1), board('beta', 1), board('removed', 1)], {
        boards: [board('alpha', 2)],
        errors: [{ board: 'beta', error: 'busy' }]
      })
    ).toEqual([board('alpha', 2), board('beta', 1)])
  })

  it('retains session identity while a board shard is temporarily unavailable', () => {
    const previous: WorkflowOverviewResponse = {
      boards: [board('beta', 1)],
      errors: [],
      schema_version: 1,
      sessions: [
        {
          current_session_id: 'tip',
          cwd: '/repo',
          id: 'root',
          lineage_session_ids: ['root', 'tip'],
          title: 'Retained session'
        }
      ]
    }

    expect(
      mergeWorkflowOverview(previous, {
        boards: [],
        errors: [{ board: 'beta', error: 'busy' }],
        schema_version: 1,
        sessions: []
      })
    ).toMatchObject({ boards: [board('beta', 1)], sessions: previous.sessions })
  })
})

describe('buildGlobalOverviewSnapshot', () => {
  it('keeps immediate same-workflow DAG links and preserves cross-workflow dependencies', () => {
    const workflowBoard: WorkflowOverviewBoard = {
      links: [
        { child_id: 'task-b', parent_id: 'task-a' },
        { child_id: 'task-c', parent_id: 'task-b' },
        { child_id: 'task-c', parent_id: 'task-a' },
        { child_id: 'task-x', parent_id: 'task-a' }
      ],
      slug: 'alpha',
      source_revision: 1,
      tasks: [
        {
          id: 'task-a',
          session_id: 'session-1',
          status: 'queued',
          title: 'Task A',
          workflow_id: 'workflow-1'
        },
        {
          id: 'task-b',
          session_id: 'session-1',
          status: 'queued',
          title: 'Task B',
          workflow_id: 'workflow-1'
        },
        {
          id: 'task-c',
          session_id: 'session-1',
          status: 'queued',
          title: 'Task C',
          workflow_id: 'workflow-1'
        },
        {
          id: 'task-x',
          session_id: 'session-1',
          status: 'queued',
          title: 'Task X',
          workflow_id: 'workflow-2'
        }
      ],
      workers: [],
      workflows: [
        { id: 'workflow-1', origin_session_id: 'session-1', status: 'open', title: 'Workflow 1' },
        { id: 'workflow-2', origin_session_id: 'session-1', status: 'open', title: 'Workflow 2' }
      ]
    }

    const response: WorkflowOverviewResponse = {
      boards: [workflowBoard],
      errors: [],
      schema_version: 1,
      sessions: [
        {
          current_session_id: 'session-1',
          cwd: null,
          id: 'session-1',
          lineage_session_ids: ['session-1'],
          title: 'Session'
        }
      ]
    }

    const graph = buildGlobalOverviewSnapshot(response.boards, response, 'work', [])
    const taskAId = liveGraphNodeId('task', 'work', 'alpha', 'task-a')
    const taskBId = liveGraphNodeId('task', 'work', 'alpha', 'task-b')
    const taskCId = liveGraphNodeId('task', 'work', 'alpha', 'task-c')
    const taskXId = liveGraphNodeId('task', 'work', 'alpha', 'task-x')

    expect(graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'depends_on', sourceId: taskBId, targetId: taskAId })
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'depends_on', sourceId: taskCId, targetId: taskBId })
    )
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({ kind: 'depends_on', sourceId: taskCId, targetId: taskAId })
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'depends_on', sourceId: taskXId, targetId: taskAId })
    )
  })

  it('keeps unattached workflow clouds without creating a synthetic session hub', () => {
    const unattachedBoard: WorkflowOverviewBoard = {
      links: [],
      slug: 'default',
      source_revision: 1,
      tasks: [
        {
          id: 'task-root',
          session_id: null,
          status: 'queued',
          title: 'Root task',
          workflow_id: 'workflow-unattached'
        }
      ],
      workers: [],
      workflows: [
        {
          id: 'workflow-unattached',
          origin_session_id: null,
          status: 'open',
          title: 'Unattached workflow'
        }
      ]
    }

    const response: WorkflowOverviewResponse = {
      boards: [unattachedBoard],
      errors: [],
      schema_version: 1,
      sessions: []
    }

    const graph = buildGlobalOverviewSnapshot(response.boards, response, 'work', [])
    const syntheticSessionId = liveGraphNodeId('session', 'work', 'unattached:default')
    const workflowId = liveGraphNodeId('workflow', 'work', 'default', 'workflow-unattached')
    const taskId = liveGraphNodeId('task', 'work', 'default', 'task-root')

    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: workflowId, kind: 'workflow' }))
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: taskId, kind: 'task' }))
    expect(graph.nodes).not.toContainEqual(expect.objectContaining({ kind: 'session' }))
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'contains', sourceId: workflowId, targetId: taskId })
    )
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ sourceId: syntheticSessionId }))
    expect(graph.rootId).toBeUndefined()
  })

  it('keeps bounded overview card details and worker tools on task nodes', () => {
    const detailsBoard: WorkflowOverviewBoard = {
      links: [],
      slug: 'alpha',
      source_revision: 3,
      tasks: [
        {
          assignee: 'reviewer-qa',
          body: 'Inspect the supplied evidence.',
          id: 'task-details',
          latest_summary: 'The review is waiting on one artifact.',
          priority: 2,
          result: 'Prior checks passed.',
          session_id: 'session-1',
          status: 'blocked',
          title: 'Review the workflow',
          workflow_id: 'workflow-1'
        }
      ],
      workers: [{ current_tool: 'kanban_block', run_id: 9, task_id: 'task-details' }],
      workflows: [{ id: 'workflow-1', origin_session_id: 'session-1', status: 'open', title: 'Workflow 1' }]
    }

    const response: WorkflowOverviewResponse = {
      boards: [detailsBoard],
      errors: [],
      schema_version: 1,
      sessions: [
        {
          current_session_id: 'session-1',
          cwd: null,
          id: 'session-1',
          lineage_session_ids: ['session-1'],
          title: 'Session'
        }
      ]
    }

    const graph = buildGlobalOverviewSnapshot(response.boards, response, 'work', [])

    expect(graph.nodes.find(node => node.entityId === 'task-details')).toMatchObject({
      assignee: 'reviewer-qa',
      currentTool: 'Kanban Block',
      detail: 'Inspect the supplied evidence.',
      priority: 2,
      result: 'Prior checks passed.',
      summary: 'The review is waiting on one artifact.'
    })
  })
})
