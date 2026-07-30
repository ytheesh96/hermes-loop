import { beforeEach, describe, expect, it, vi } from 'vitest'

async function setup() {
  const model = await import('./model')
  const { registry } = await import('@/contrib/registry')
  const tree = await import('./store')
  const paneId = 'live-graph:default:session-one'

  registry.registerMany([
    {
      area: 'panes',
      data: { placement: 'main', uncloseable: true },
      id: 'workspace',
      render: () => null,
      title: 'Workspace'
    },
    { area: 'panes', id: paneId, render: () => null, title: 'Graph View' },
    { area: 'panes', id: 'files', render: () => null, title: 'Files' }
  ])
  tree.declareDefaultTree(
    model.split(
      'row',
      [
        model.group(['workspace'], { id: 'grp-workspace' }),
        model.group([paneId], { id: 'grp-graph' }),
        model.group(['files'], { id: 'grp-files' })
      ],
      [2, 1, 1],
      'root'
    )
  )

  return { model, paneId, tree }
}

describe('automatic pane placement', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('stacks an auto-placed pane with its anchor', async () => {
    const { model, paneId, tree } = await setup()

    tree.stackPaneWith(paneId, 'workspace')

    const layout = tree.$layoutTree.get()!
    expect(model.findGroupOfPane(layout, paneId)?.id).toBe(model.findGroupOfPane(layout, 'workspace')?.id)
    expect(model.findGroupOfPane(layout, paneId)?.active).toBe(paneId)
  })

  it('preserves user placement for beside and stacked auto-placement requests', async () => {
    const { model, paneId, tree } = await setup()

    tree.moveTreePane(paneId, { groupId: 'grp-files', pos: 'center' })
    const userGroupId = model.findGroupOfPane(tree.$layoutTree.get()!, paneId)?.id

    tree.dockPaneBeside(paneId, 'workspace')
    tree.stackPaneWith(paneId, 'workspace')

    expect(model.findGroupOfPane(tree.$layoutTree.get()!, paneId)?.id).toBe(userGroupId)
    expect(model.findGroupOfPane(tree.$layoutTree.get()!, 'workspace')?.id).not.toBe(userGroupId)
  })
})
