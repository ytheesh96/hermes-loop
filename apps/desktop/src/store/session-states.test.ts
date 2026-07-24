import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { group, split } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree } from '@/components/pane-shell/tree/store'

import { $selectedStoredSessionId } from './session'
import {
  $sessionTiles,
  closeSessionTile,
  openSessionTab,
  openSessionTile,
  orderTilesByTree,
  patchSessionTile,
  resetTileRuntimeBindings,
  selectionHomesToWorkspace,
  type SessionTile,
  type SessionTileDelegate,
  setSessionTileDelegate
} from './session-states'

const tile = (storedSessionId: string): SessionTile => ({ storedSessionId })
const tilePane = (id: string) => `session-tile:${id}`

describe('orderTilesByTree', () => {
  it('no-ops (null) without a tree or below two tiles', () => {
    expect(orderTilesByTree(null, [tile('a'), tile('b')])).toBeNull()
    expect(orderTilesByTree(group([tilePane('a')]), [tile('a')])).toBeNull()
  })

  it('reorders tiles to layout-tree encounter order across a split', () => {
    const tree = split('row', [group(['workspace', tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('a'), tile('b')])).toEqual([tile('b'), tile('a')])
  })

  it('returns null when the array already matches strip order (skip persist)', () => {
    const tree = split('row', [group([tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('b'), tile('a')])).toBeNull()
  })

  it('sorts not-yet-adopted tiles after placed ones, stably', () => {
    const tree = group(['workspace', tilePane('b')])

    expect(orderTilesByTree(tree, [tile('a'), tile('b'), tile('c')])).toEqual([tile('b'), tile('a'), tile('c')])
  })
})

describe('selectionHomesToWorkspace', () => {
  const tiles = [tile('a'), tile('b')]

  it('homes for a null selection or a non-tile session', () => {
    expect(selectionHomesToWorkspace(null, tiles)).toBe(true)
    expect(selectionHomesToWorkspace('c', tiles)).toBe(true)
  })

  it('skips homing when the selected id is already an open tile', () => {
    expect(selectionHomesToWorkspace('a', tiles)).toBe(false)
  })
})

describe('Loop worker session tabs', () => {
  const invalidateRuntime = vi.fn()

  const delegate: SessionTileDelegate = {
    archiveSession: vi.fn(async () => undefined),
    branchSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    executeSlash: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => undefined),
    invalidateRuntime,
    resumeTile: vi.fn(async () => 'runtime'),
    submitToSession: vi.fn(async () => undefined),
    updateSession: vi.fn(state => state) as never
  }

  beforeEach(() => {
    for (const tile of $sessionTiles.get()) {
      closeSessionTile(tile.storedSessionId)
    }

    $selectedStoredSessionId.set(null)
    $activeTreeGroup.set(null)
    $layoutTree.set(group(['workspace'], { id: 'grp-main' }))
    invalidateRuntime.mockClear()
    setSessionTileDelegate(delegate)
  })

  afterEach(() => {
    for (const tile of $sessionTiles.get()) {
      closeSessionTile(tile.storedSessionId)
    }

    $selectedStoredSessionId.set(null)
    $activeTreeGroup.set(null)
  })

  it('keeps profile and watch metadata when runtime bindings reset', () => {
    openSessionTile('worker-session-9', 'center', 'workspace', 'session-tile:other', {
      profile: 'reviewer-qa',
      watch: true
    })

    expect($sessionTiles.get()).toEqual([
      {
        anchor: 'workspace',
        before: 'session-tile:other',
        dir: 'center',
        profile: 'reviewer-qa',
        storedSessionId: 'worker-session-9',
        watch: true
      }
    ])

    patchSessionTile('worker-session-9', { runtimeId: 'runtime-worker' })
    invalidateRuntime.mockClear()
    resetTileRuntimeBindings()

    expect(invalidateRuntime).toHaveBeenCalledWith('worker-session-9')
    expect($sessionTiles.get()[0]).toMatchObject({
      anchor: 'workspace',
      before: 'session-tile:other',
      profile: 'reviewer-qa',
      storedSessionId: 'worker-session-9',
      watch: true
    })
    expect($sessionTiles.get()[0]?.runtimeId).toBeUndefined()
  })

  it('opens and focuses the worker tab in the main group', () => {
    $layoutTree.set(
      group(['workspace', 'session-tile:worker-session-9'], {
        active: 'workspace',
        id: 'grp-main'
      })
    )

    openSessionTab('worker-session-9', { profile: 'reviewer-qa', watch: true })

    expect($layoutTree.get()).toMatchObject({
      active: 'session-tile:worker-session-9',
      id: 'grp-main'
    })
    expect($activeTreeGroup.get()).toBe('grp-main')
  })

  it('keeps a Loop running hint across an in-memory rebind without persisting it', () => {
    openSessionTab('worker-session-9', {
      profile: 'reviewer-qa',
      runningHint: true,
      watch: true
    })

    expect($sessionTiles.get()[0]).toMatchObject({
      runningHint: true,
      storedSessionId: 'worker-session-9',
      watch: true
    })

    patchSessionTile('worker-session-9', { runtimeId: 'runtime-worker' })
    resetTileRuntimeBindings()

    expect($sessionTiles.get()[0]).toMatchObject({
      runningHint: true,
      storedSessionId: 'worker-session-9',
      watch: true
    })
    expect($sessionTiles.get()[0]?.runtimeId).toBeUndefined()
    expect(window.localStorage.getItem('hermes.desktop.sessionTiles.v2') ?? '').not.toContain('runningHint')
  })

  it.each([
    ['profile', { profile: 'research-worker', watch: true }],
    ['watch mode', { profile: 'reviewer-qa', watch: undefined }]
  ])('invalidates the cached runtime when %s changes', (_label, options) => {
    openSessionTab('worker-session-9', { profile: 'reviewer-qa', watch: true })
    patchSessionTile('worker-session-9', { runtimeId: 'runtime-worker' })
    invalidateRuntime.mockClear()

    openSessionTab('worker-session-9', options)

    expect(invalidateRuntime).toHaveBeenCalledWith('worker-session-9')
    expect($sessionTiles.get()[0]?.runtimeId).toBeUndefined()
  })
})
