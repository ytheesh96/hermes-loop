import { requestComposerInsertRefs } from '@/app/chat/composer/focus'

import type { InlineRefInput } from '../chat/composer/inline-refs'

import type { LiveGraphNode } from './model'

const clean = (value: null | string | undefined): string => value?.trim() || ''

const scopedValue = (...parts: Array<null | string | undefined>): string => parts.map(clean).filter(Boolean).join('/')

export function liveGraphNodeContextRef(node: LiveGraphNode, profile = 'default'): InlineRefInput | null {
  const entityId = clean(node.entityId) || clean(node.id)

  if (!entityId) {
    return null
  }

  const label = clean(node.label) || entityId
  const normalizedProfile = clean(profile) || 'default'

  switch (node.kind) {
    case 'artifact':
      return node.path
        ? { kind: 'file', label, value: node.path }
        : { kind: 'artifact', label, value: scopedValue(normalizedProfile, entityId) }

    case 'project':
      return node.path
        ? { kind: 'folder', label, value: node.path }
        : { kind: 'project', label, value: scopedValue(normalizedProfile, entityId) }

    case 'session':
      return { kind: 'session', label, value: scopedValue(normalizedProfile, entityId) }

    case 'task':
      return { kind: 'task', label, value: entityId }

    case 'agent':
      return {
        kind: 'agent',
        label,
        value: scopedValue(normalizedProfile, node.board, entityId)
      }

    case 'workflow':
      return {
        kind: 'workflow',
        label,
        value: scopedValue(normalizedProfile, node.board, node.workflowId || entityId)
      }
  }
}

export function attachLiveGraphNodeToComposer(node: LiveGraphNode, profile?: string): boolean {
  const ref = liveGraphNodeContextRef(node, profile)

  if (!ref) {
    return false
  }

  requestComposerInsertRefs([ref], { target: 'main' })

  return true
}
