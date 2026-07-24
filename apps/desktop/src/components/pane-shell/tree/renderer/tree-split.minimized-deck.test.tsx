import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { $layoutEditMode } from '../../edit-mode'
import { group, split } from '../model'
import { $narrowViewport, setTreePaneHidden } from '../store'

import { TreeSplit } from './tree-split'

const disposers: (() => void)[] = []
const hiddenPaneIds = new Set<string>()

afterEach(() => {
  cleanup()
  $layoutEditMode.set(false)
  $narrowViewport.set(false)

  hiddenPaneIds.forEach(id => setTreePaneHidden(id, false))
  hiddenPaneIds.clear()
  disposers.splice(0).forEach(dispose => dispose())
})

const registerPane = (id: string, data: Record<string, unknown> = {}) => {
  disposers.push(
    registry.register({
      area: 'panes',
      data,
      id,
      render: () => null,
      title: id
    })
  )
}

const hidePane = (id: string) => {
  hiddenPaneIds.add(id)
  setTreePaneHidden(id, true)
}

const layout = (suffix: string, toolsMinimized = true) => {
  const ids = {
    files: `test-files-${suffix}`,
    logs: `test-logs-${suffix}`,
    terminal: `test-terminal-${suffix}`,
    workspace: `test-workspace-${suffix}`
  }

  registerPane(ids.workspace, { placement: 'main' })
  registerPane(ids.files, { collapsible: true, placement: 'right', width: '237px' })
  registerPane(ids.logs, { placement: 'bottom' })
  registerPane(ids.terminal, { placement: 'bottom' })

  const utility = split(
    'column',
    [
      group([ids.files], { id: `test-files-group-${suffix}` }),
      group([ids.logs, ids.terminal], {
        active: ids.terminal,
        id: `test-tools-group-${suffix}`,
        minimized: toolsMinimized
      })
    ],
    [1.6, 1],
    `test-utility-${suffix}`
  )

  return {
    ids,
    root: split(
      'row',
      [group([ids.workspace], { id: `test-main-group-${suffix}` }), utility],
      [3, 1],
      `test-root-${suffix}`
    ),
    utility
  }
}

describe('TreeSplit minimized utility deck', () => {
  it('keeps the minimized tool bar under a visible Files pane', () => {
    const { root, utility } = layout('visible')
    const { container } = render(<TreeSplit node={root} root rootRow />)
    const utilityElement = container.querySelector<HTMLElement>(`[data-tree-split="${utility.id}"]`)

    expect(utilityElement).not.toBeNull()
    expect(utilityElement?.parentElement?.style.display).not.toBe('none')
    expect(container.querySelector(`[data-tree-tab="test-logs-visible"]`)).not.toBeNull()
    expect(container.querySelector(`[data-tree-tab="test-terminal-visible"]`)).not.toBeNull()
  })

  it('removes the outer right track when only its minimized tool bar remains', () => {
    const { ids, root, utility } = layout('hidden')

    hidePane(ids.files)

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const utilityElement = container.querySelector<HTMLElement>(`[data-tree-split="${utility.id}"]`)

    expect(utilityElement).not.toBeNull()
    expect(utilityElement?.parentElement?.style.display).toBe('none')
  })

  it('keeps the right deck when a tool pane is expanded without Files', () => {
    const { ids, root, utility } = layout('expanded', false)

    hidePane(ids.files)

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const utilityElement = container.querySelector<HTMLElement>(`[data-tree-split="${utility.id}"]`)

    expect(utilityElement).not.toBeNull()
    expect(utilityElement?.parentElement?.style.display).not.toBe('none')
  })

  it('does not remove a direct minimized group used as a restore rail', () => {
    const suffix = 'direct'
    const workspace = `test-workspace-${suffix}`
    const terminal = `test-terminal-${suffix}`

    registerPane(workspace, { placement: 'main' })
    registerPane(terminal, { placement: 'bottom' })

    const terminalGroup = group([terminal], {
      id: `test-terminal-group-${suffix}`,
      minimized: true
    })

    const root = split(
      'row',
      [group([workspace], { id: `test-main-group-${suffix}` }), terminalGroup],
      [3, 1],
      `test-root-${suffix}`
    )

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const terminalElement = container.querySelector<HTMLElement>(`[data-tree-group="${terminalGroup.id}"]`)

    expect(terminalElement).not.toBeNull()
    expect(terminalElement?.parentElement?.style.display).not.toBe('none')
  })

  it('keeps same-axis nested minimized groups as restore rails', () => {
    const suffix = 'same-axis'
    const workspace = `test-workspace-${suffix}`
    const logs = `test-logs-${suffix}`
    const terminal = `test-terminal-${suffix}`

    registerPane(workspace, { placement: 'main' })
    registerPane(logs, { placement: 'bottom' })
    registerPane(terminal, { placement: 'bottom' })

    const tools = split(
      'row',
      [
        group([logs], { id: `test-logs-group-${suffix}`, minimized: true }),
        group([terminal], { id: `test-terminal-group-${suffix}`, minimized: true })
      ],
      [1, 1],
      `test-tools-${suffix}`
    )

    const root = split(
      'row',
      [group([workspace], { id: `test-main-group-${suffix}` }), tools],
      [3, 1],
      `test-root-${suffix}`
    )

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const toolsElement = container.querySelector<HTMLElement>(`[data-tree-split="${tools.id}"]`)

    expect(toolsElement).not.toBeNull()
    expect(toolsElement?.parentElement?.style.display).not.toBe('none')
  })

  it('keeps a minimized-only composite visible in layout edit mode', () => {
    const suffix = 'edit'
    const workspace = `test-workspace-${suffix}`
    const terminal = `test-terminal-${suffix}`

    registerPane(workspace, { placement: 'main' })
    registerPane(terminal, { placement: 'bottom' })

    const tools = split(
      'column',
      [group([terminal], { id: `test-terminal-group-${suffix}`, minimized: true })],
      [1],
      `test-tools-${suffix}`
    )

    const root = split(
      'row',
      [group([workspace], { id: `test-main-group-${suffix}` }), tools],
      [3, 1],
      `test-root-${suffix}`
    )

    $layoutEditMode.set(true)

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const toolsElement = container.querySelector<HTMLElement>(`[data-tree-split="${tools.id}"]`)

    expect(toolsElement).not.toBeNull()
    expect(toolsElement?.parentElement?.style.display).not.toBe('none')
  })

  it('never reserves a track for a structural layout anchor in edit mode', () => {
    const workspace = 'test-anchor-workspace'
    const anchor = 'test-anchor-only-pane'

    registerPane(workspace, { placement: 'main' })
    registerPane(anchor, { layoutAnchorOnly: true, placement: 'main' })
    const anchorGroup = group([anchor], { id: 'test-anchor-only-group' })

    const root = split(
      'row',
      [group([workspace], { id: 'test-anchor-workspace-group' }), anchorGroup],
      [3, 1],
      'test-anchor-root'
    )

    $layoutEditMode.set(true)

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const anchorElement = container.querySelector<HTMLElement>(`[data-tree-group="${anchorGroup.id}"]`)

    expect(anchorElement).not.toBeNull()
    expect(anchorElement?.parentElement?.style.display).toBe('none')
  })

  it('keeps the hidden narrow utility subtree mounted for persistent tools', () => {
    const { root, utility } = layout('narrow')

    $narrowViewport.set(true)

    const { container } = render(<TreeSplit node={root} root rootRow />)
    const utilityElement = container.querySelector<HTMLElement>(`[data-tree-split="${utility.id}"]`)

    expect(utilityElement).not.toBeNull()
    expect(utilityElement?.parentElement?.style.display).toBe('none')
  })
})
