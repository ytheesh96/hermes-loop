import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hermes.desktop.layoutTree.v2'
const USER_PLACED_KEY = 'hermes.desktop.userPlacedPanes.v1'
const DISMISSED_KEY = 'hermes.desktop.dismissedPanes.v1'
const MIGRATION_KEY = 'hermes.desktop.layoutMigration.loopWorkspaceSplit.v1'
const ACTIVE_PRESET_KEY = 'hermes.desktop.layoutPreset.active'

async function registerLoopPanes() {
  const { registry } = await import('@/contrib/registry')

  registry.registerMany([
    {
      id: 'workspace',
      area: 'panes',
      title: 'Workspace',
      data: { placement: 'main', uncloseable: true },
      render: () => null
    },
    {
      id: 'loop',
      area: 'panes',
      title: 'Loop',
      data: { placement: 'main', dock: { pane: 'workspace', pos: 'right' } },
      render: () => null
    }
  ])
}

async function defaultTree() {
  const { group, split } = await import('./model')

  return split(
    'row',
    [
      group(['sessions'], { id: 'grp-sessions' }),
      split(
        'row',
        [group(['workspace'], { id: 'grp-main' }), group(['loop'], { id: 'grp-loop' })],
        [2, 3],
        'spl-main-loop'
      )
    ],
    [1, 4],
    'spl-root'
  )
}

async function legacyRightLoopTree() {
  const { group, split } = await import('./model')

  return split(
    'row',
    [
      group(['workspace'], { id: 'grp-main' }),
      split(
        'column',
        [
          split(
            'row',
            [group(['loop'], { id: 'grp-loop' }), group(['files'], { id: 'grp-files' })],
            [1, 1],
            'spl-rail'
          ),
          group(['terminal'], { id: 'grp-terminal' })
        ],
        [1.6, 1],
        'spl-right'
      )
    ],
    [3, 1.6],
    'spl-root'
  )
}

describe('Loop workspace-split layout migration', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('moves old automatic right-rail placement into a native split beside the workspace', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(await legacyRightLoopTree()))
    vi.resetModules()

    const { $layoutTree } = await import('./store')
    const { allPaneIds, findGroupOfPane } = await import('./model')
    const tree = $layoutTree.get()

    expect(tree).not.toBeNull()

    const workspace = tree ? findGroupOfPane(tree, 'workspace') : null
    const loop = tree ? findGroupOfPane(tree, 'loop') : null

    expect(loop?.id).not.toBe(workspace?.id)
    expect(allPaneIds(tree!)).toEqual(['workspace', 'loop', 'files', 'terminal'])
    expect(workspace?.active).toBe('workspace')
    expect(workspace?.headerHidden).toBeUndefined()
    expect(tree?.type).toBe('split')
    expect(tree?.type === 'split' ? tree.orientation : null).toBe('row')
    expect(tree?.type === 'split' ? tree.children.map(allPaneIds) : []).toEqual([
      ['workspace'],
      ['loop'],
      ['files', 'terminal']
    ])
    expect(tree?.type === 'split' ? tree.children[2]?.type : null).toBe('split')
    expect(tree?.type === 'split' && tree.children[2]?.type === 'split' ? tree.children[2].orientation : null).toBe(
      'column'
    )

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')

    expect(allPaneIds(persisted)).toEqual(['workspace', 'loop', 'files', 'terminal'])
    expect(window.localStorage.getItem(MIGRATION_KEY)).toBe('done')
  })

  it('preserves an explicitly user-placed Loop pane', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(await legacyRightLoopTree()))
    window.localStorage.setItem(USER_PLACED_KEY, JSON.stringify(['loop']))
    vi.resetModules()

    const { $layoutTree } = await import('./store')
    const { allPaneIds } = await import('./model')
    const tree = $layoutTree.get()

    expect(tree).not.toBeNull()
    expect(tree?.type).toBe('split')
    expect(tree?.type === 'split' ? allPaneIds(tree.children[1]) : []).toEqual(['loop', 'files', 'terminal'])
    expect(window.localStorage.getItem(MIGRATION_KEY)).toBe('done')
  })

  it('adds Loop beside an older workspace-only layout without forcing a chat header', async () => {
    const { group } = await import('./model')

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(group(['workspace'], { id: 'grp-main' })))
    vi.resetModules()

    const { $layoutTree } = await import('./store')
    const { allPaneIds, findGroupOfPane: findPaneGroup } = await import('./model')

    const tree = $layoutTree.get()
    const workspace = tree ? findPaneGroup(tree, 'workspace') : null

    expect(tree && findPaneGroup(tree, 'loop')?.id).not.toBe(workspace?.id)
    expect(tree && allPaneIds(tree)).toEqual(['workspace', 'loop'])
    expect(workspace?.active).toBe('workspace')
    expect(workspace?.headerHidden).toBeUndefined()
    expect(window.localStorage.getItem(MIGRATION_KEY)).toBe('done')
  })

  it('never reapplies the migration after the one-time marker is written', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(await legacyRightLoopTree()))
    window.localStorage.setItem(MIGRATION_KEY, 'done')
    vi.resetModules()

    const { $layoutTree } = await import('./store')
    const { allPaneIds } = await import('./model')
    const tree = $layoutTree.get()

    expect(tree).not.toBeNull()
    expect(tree?.type).toBe('split')
    expect(tree?.type === 'split' ? allPaneIds(tree.children[1]) : []).toEqual(['loop', 'files', 'terminal'])
  })

  it('keeps a dismissed Loop absent until reveal restores the workspace split', async () => {
    const { group, split } = await import('./model')

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        split(
          'row',
          [group(['sessions'], { id: 'grp-sessions' }), group(['workspace'], { id: 'grp-main' })],
          [1, 4],
          'spl-root'
        )
      )
    )
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(['loop']))
    vi.resetModules()

    await registerLoopPanes()
    const { $layoutTree, declareDefaultTree, revealTreePane } = await import('./store')
    const { allPaneIds, findGroupOfPane } = await import('./model')

    declareDefaultTree(await defaultTree())
    expect(allPaneIds($layoutTree.get()!)).toEqual(['sessions', 'workspace'])

    revealTreePane('loop')

    const tree = $layoutTree.get()
    const workspace = tree ? findGroupOfPane(tree, 'workspace') : null
    const loop = tree ? findGroupOfPane(tree, 'loop') : null

    expect(allPaneIds(tree!)).toEqual(['sessions', 'workspace', 'loop'])
    expect(loop?.id).not.toBe(workspace?.id)
    expect(loop?.id).not.toBe(findGroupOfPane(tree!, 'sessions')?.id)
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull()
  })

  it('adopts Loop beside workspace in an older named-preset layout', async () => {
    const { group, split } = await import('./model')

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        split(
          'row',
          [group(['sessions'], { id: 'grp-sessions' }), group(['workspace'], { id: 'grp-main' })],
          [1, 4],
          'spl-root'
        )
      )
    )
    window.localStorage.setItem(ACTIVE_PRESET_KEY, 'focus')
    vi.resetModules()

    await registerLoopPanes()
    const { $layoutTree, declareDefaultTree } = await import('./store')
    const { allPaneIds, findGroupOfPane } = await import('./model')

    declareDefaultTree(await defaultTree())

    const tree = $layoutTree.get()
    const workspace = tree ? findGroupOfPane(tree, 'workspace') : null
    const loop = tree ? findGroupOfPane(tree, 'loop') : null

    expect(allPaneIds(tree!)).toEqual(['sessions', 'workspace', 'loop'])
    expect(loop?.id).not.toBe(workspace?.id)
    expect(loop?.id).not.toBe(findGroupOfPane(tree!, 'sessions')?.id)
    expect(workspace?.active).toBe('workspace')
  })
})
