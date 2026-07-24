import { describe, expect, it, vi } from 'vitest'

import { requestComposerInsertRefs } from '@/app/chat/composer/focus'

import { attachLiveGraphNodeToComposer, liveGraphNodeContextRef } from './context'
import type { LiveGraphNode } from './model'

vi.mock('@/app/chat/composer/focus', () => ({
  requestComposerInsertRefs: vi.fn()
}))

const node = (kind: LiveGraphNode['kind'], overrides: Partial<LiveGraphNode> = {}): LiveGraphNode => ({
  entityId: `${kind}-id`,
  id: `${kind}:default:${kind}-id`,
  kind,
  label: `${kind} label`,
  ...overrides
})

describe('liveGraphNodeContextRef', () => {
  it('uses established context refs when the node has a resolvable target', () => {
    expect(liveGraphNodeContextRef(node('task'))).toEqual({
      kind: 'task',
      label: 'task label',
      value: 'task-id'
    })
    expect(liveGraphNodeContextRef(node('session'), 'work')).toEqual({
      kind: 'session',
      label: 'session label',
      value: 'work/session-id'
    })
    expect(liveGraphNodeContextRef(node('artifact', { path: 'src/result.md' }))).toEqual({
      kind: 'file',
      label: 'artifact label',
      value: 'src/result.md'
    })
    expect(liveGraphNodeContextRef(node('project', { path: 'apps/desktop' }))).toEqual({
      kind: 'folder',
      label: 'project label',
      value: 'apps/desktop'
    })
  })

  it('keeps graph-only nodes scoped and typed', () => {
    expect(liveGraphNodeContextRef(node('workflow', { board: 'delivery', workflowId: 'wf-7' }), 'work')).toEqual({
      kind: 'workflow',
      label: 'workflow label',
      value: 'work/delivery/wf-7'
    })
    expect(liveGraphNodeContextRef(node('agent', { board: 'delivery' }), 'work')).toEqual({
      kind: 'agent',
      label: 'agent label',
      value: 'work/delivery/agent-id'
    })
    expect(liveGraphNodeContextRef(node('artifact'), 'work')).toEqual({
      kind: 'artifact',
      label: 'artifact label',
      value: 'work/artifact-id'
    })
    expect(liveGraphNodeContextRef(node('project'), 'work')).toEqual({
      kind: 'project',
      label: 'project label',
      value: 'work/project-id'
    })
  })

  it('attaches to the main chat composer', () => {
    expect(attachLiveGraphNodeToComposer(node('task'))).toBe(true)
    expect(requestComposerInsertRefs).toHaveBeenCalledWith([{ kind: 'task', label: 'task label', value: 'task-id' }], {
      target: 'main'
    })
  })
})
