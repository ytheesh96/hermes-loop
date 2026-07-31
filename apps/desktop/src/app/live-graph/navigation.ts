export type LiveGraphNavigationTarget =
  | { board?: string; entityId: string; kind: 'task' }
  | { entityId: string; kind: 'session' }

export interface LiveGraphNavigationState {
  liveGraphTarget: LiveGraphNavigationTarget
}

export function liveGraphNavigationState(target: LiveGraphNavigationTarget): LiveGraphNavigationState {
  return { liveGraphTarget: target }
}

export function readLiveGraphNavigationTarget(state: unknown): LiveGraphNavigationTarget | null {
  if (!state || typeof state !== 'object') {
    return null
  }

  const target = (state as Partial<LiveGraphNavigationState>).liveGraphTarget

  if (!target || typeof target !== 'object') {
    return null
  }

  if ((target.kind === 'session' || target.kind === 'task') && target.entityId.trim()) {
    return target.kind === 'task'
      ? {
          ...(target.board?.trim() ? { board: target.board.trim() } : {}),
          entityId: target.entityId.trim(),
          kind: 'task'
        }
      : { entityId: target.entityId.trim(), kind: 'session' }
  }

  return null
}
