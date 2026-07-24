import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadFreshTreeModules() {
  return {
    model: await import('@/components/pane-shell/tree/model'),
    registry: (await import('@/contrib/registry')).registry,
    tree: await import('@/components/pane-shell/tree/store')
  }
}

describe('native Loop workflow tab keyboard navigation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  async function setup() {
    const { model, registry, tree } = await loadFreshTreeModules()
    const paneA = 'loop-workflow:scope:wf-a'
    const paneB = 'loop-workflow:scope:wf-b'
    const activateA = vi.fn()
    const activateB = vi.fn()

    registry.registerMany([
      { area: 'panes', data: { uncloseable: true }, id: 'loop', render: () => null, title: 'Loop' },
      { area: 'panes', data: { onActivate: activateA }, id: paneA, render: () => null, title: 'A' },
      { area: 'panes', data: { onActivate: activateB }, id: paneB, render: () => null, title: 'B' }
    ])
    tree.declareDefaultTree(model.group(['loop', paneA, paneB], { active: paneA, id: 'grp-loop' }))
    tree.setTreePaneHidden('loop', true)
    tree.noteActiveTreeGroup('grp-loop')

    return { activateA, activateB, paneA, paneB, tree }
  }

  it('skips the hidden layout anchor for number slots and tab cycling', async () => {
    const { activateA, activateB, paneA, paneB, tree } = await setup()

    expect(tree.activateTreeTabSlot(2)).toBe(true)
    expect(tree.activeTreePaneId()).toBe(paneB)
    expect(activateB).toHaveBeenCalledTimes(1)

    expect(tree.cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(tree.activeTreePaneId()).toBe(paneA)
    expect(activateA).toHaveBeenCalledTimes(1)

    expect(tree.activateTreeTabSlot(3)).toBe(false)
    expect(tree.activeTreePaneId()).toBe(paneA)
  })

  it('notifies the workflow made active by a native drag move', async () => {
    const { model, registry, tree } = await loadFreshTreeModules()
    const paneA = 'loop-workflow:move:wf-a'
    const paneB = 'loop-workflow:move:wf-b'
    const activateB = vi.fn()

    registry.registerMany([
      { area: 'panes', data: { uncloseable: true }, id: 'workspace', render: () => null, title: 'Workspace' },
      { area: 'panes', id: paneA, render: () => null, title: 'A' },
      { area: 'panes', data: { onActivate: activateB }, id: paneB, render: () => null, title: 'B' }
    ])
    tree.declareDefaultTree(
      model.split(
        'row',
        [
          model.group(['workspace'], { id: 'grp-workspace' }),
          model.group([paneA, paneB], { active: paneA, id: 'grp-workflows' })
        ],
        [1, 1],
        'root-move'
      )
    )

    tree.moveTreePane(paneB, { groupId: 'grp-workspace', pos: 'center' })

    expect(tree.activeTreePaneId()).toBeNull()
    expect(activateB).toHaveBeenCalledTimes(1)
    expect(model.findGroupOfPane(tree.$layoutTree.get()!, paneB)?.active).toBe(paneB)
  })

  it('notifies the workflow moved into a native split', async () => {
    const { model, registry, tree } = await loadFreshTreeModules()
    const paneA = 'loop-workflow:split:wf-a'
    const paneB = 'loop-workflow:split:wf-b'
    const activateB = vi.fn()

    registry.registerMany([
      { area: 'panes', id: paneA, render: () => null, title: 'A' },
      { area: 'panes', data: { onActivate: activateB }, id: paneB, render: () => null, title: 'B' }
    ])
    tree.declareDefaultTree(model.group([paneA, paneB], { active: paneA, id: 'grp-split' }))

    tree.splitTreeZone('grp-split', 'right', paneB)

    expect(activateB).toHaveBeenCalledTimes(1)
    expect(model.findGroupOfPane(tree.$layoutTree.get()!, paneB)?.active).toBe(paneB)
  })

  it('replaces a pending pane id without changing its native placement', async () => {
    const { model, registry, tree } = await loadFreshTreeModules()
    const pending = 'loop-workflow:replace:'
    const hydrated = 'loop-workflow:replace:wf-a'

    registry.registerMany([
      { area: 'panes', id: pending, render: () => null, title: 'New workflow' },
      { area: 'panes', id: hydrated, render: () => null, title: 'Workflow A' }
    ])
    tree.declareDefaultTree(model.group([pending], { active: pending, id: 'grp-moved-pending' }))

    tree.replaceTreePaneId(pending, hydrated)

    const group = model.findGroupOfPane(tree.$layoutTree.get()!, hydrated)
    expect(group?.id).toBe('grp-moved-pending')
    expect(group?.active).toBe(hydrated)
    expect(model.allPaneIds(tree.$layoutTree.get()!)).not.toContain(pending)
  })

  it('normalizes a reset anchor to the controller-preferred workflow', async () => {
    const { model, registry, tree } = await loadFreshTreeModules()
    const paneA = 'loop-workflow:reset:wf-a'
    const paneB = 'loop-workflow:reset:wf-b'
    const activateB = vi.fn()

    registry.registerMany([
      {
        area: 'panes',
        data: { layoutAnchorOnly: true, placement: 'main', uncloseable: true },
        id: 'loop',
        render: () => null,
        title: 'Loop'
      },
      {
        area: 'panes',
        data: { placement: 'main', preferredActive: () => false },
        id: paneA,
        render: () => null,
        title: 'A'
      },
      {
        area: 'panes',
        data: { onActivate: activateB, placement: 'main', preferredActive: () => true },
        id: paneB,
        render: () => null,
        title: 'B'
      }
    ])
    tree.declareDefaultTree(model.group(['loop'], { active: 'loop', id: 'grp-reset-loop' }))
    tree.setTreePaneHidden('loop', true)
    tree.watchContributedPanes()

    const group = model.findGroupOfPane(tree.$layoutTree.get()!, paneB)
    expect(group?.active).toBe(paneB)
    expect(activateB).toHaveBeenCalledTimes(1)
  })
})
