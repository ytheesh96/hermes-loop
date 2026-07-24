import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

import { $layoutEditMode } from '../../edit-mode'
import { findGroupOfPane, group, split } from '../model'
import {
  $activeTreeGroup,
  $layoutTree,
  $treeTabFocusRequest,
  clearTreeTabFocusRequest,
  prepareTreePaneRemovalFocus,
  registerPaneCloser,
  removeTreePane,
  setTreePaneHidden
} from '../store'

import { TreeGroup } from './tree-group'

afterEach(() => {
  cleanup()
  $layoutEditMode.set(false)
  $layoutTree.set(null)
  $activeTreeGroup.set(null)

  const tabFocusRequest = $treeTabFocusRequest.get()

  if (tabFocusRequest) {
    clearTreeTabFocusRequest(tabFocusRequest.key)
  }
})

function StatefulPane({
  id,
  onMount,
  onUnmount
}: {
  id: string
  onMount: (id: string) => void
  onUnmount: (id: string) => void
}) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    onMount(id)

    return () => onUnmount(id)
  }, [id, onMount, onUnmount])

  return (
    <button data-testid={`stateful-pane-${id}`} onClick={() => setCount(value => value + 1)} type="button">
      {id}: {count}
    </button>
  )
}

describe('TreeGroup close action', () => {
  it('shows a visible close button for a lone closeable main pane', () => {
    const paneId = 'test-loop-close-pane'
    const onClose = vi.fn()

    registry.register({
      area: 'panes',
      data: { placement: 'main' },
      id: paneId,
      render: () => null,
      title: 'Loop'
    })
    registerPaneCloser(paneId, onClose)
    setTreePaneHidden(paneId, false)

    render(<TreeGroup node={group([paneId])} parentAxis="row" />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Loop' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('TreeGroup inactive pane keep-alive', () => {
  it('keeps an inactive flagged body inert and aria-hidden, then activates it without remounting', () => {
    const paneA = 'test-keep-alive-pane-a'
    const paneB = 'test-keep-alive-pane-b'
    const onMount = vi.fn()
    const onUnmount = vi.fn()

    registry.registerMany([
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneA,
        render: () => <StatefulPane id="a" onMount={onMount} onUnmount={onUnmount} />,
        title: 'Canvas A'
      },
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneB,
        render: () => <StatefulPane id="b" onMount={onMount} onUnmount={onUnmount} />,
        title: 'Canvas B'
      }
    ])

    const { rerender } = render(
      <TreeGroup node={group([paneA, paneB], { active: paneA, id: 'test-keep-alive-group' })} parentAxis="row" />
    )

    const bodyA = screen.getByTestId('stateful-pane-a')
    const bodyB = screen.getByTestId('stateful-pane-b')
    const wrapperA = bodyA.parentElement!
    const wrapperB = bodyB.parentElement!

    expect(onMount.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1)
    expect(onMount.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1)
    expect(onUnmount).not.toHaveBeenCalled()
    expect(wrapperA.hasAttribute('aria-hidden')).toBe(false)
    expect(wrapperA.hasAttribute('inert')).toBe(false)
    expect(wrapperB.getAttribute('aria-hidden')).toBe('true')
    expect(wrapperB.hasAttribute('inert')).toBe(true)
    expect(wrapperB.className).toContain('invisible')
    expect(wrapperB.className).toContain('pointer-events-none')
    expect(wrapperA.dataset.treePaneBody).toBe(paneA)
    expect(wrapperB.dataset.treePaneBody).toBe(paneB)

    fireEvent.click(bodyA)
    expect(bodyA.textContent).toBe('a: 1')
    bodyA.focus()
    expect(globalThis.document.activeElement).toBe(bodyA)

    rerender(
      <TreeGroup node={group([paneA, paneB], { active: paneB, id: 'test-keep-alive-group' })} parentAxis="row" />
    )

    expect(screen.getByTestId('stateful-pane-a')).toBe(bodyA)
    expect(screen.getByTestId('stateful-pane-b')).toBe(bodyB)
    expect(onMount.mock.calls.filter(([id]) => id === 'a')).toHaveLength(1)
    expect(onMount.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1)
    expect(onUnmount).not.toHaveBeenCalled()
    expect(wrapperA.getAttribute('aria-hidden')).toBe('true')
    expect(wrapperA.hasAttribute('inert')).toBe(true)
    expect(wrapperA.className).toContain('invisible')
    expect(wrapperA.className).toContain('pointer-events-none')
    expect(wrapperB.hasAttribute('aria-hidden')).toBe(false)
    expect(wrapperB.hasAttribute('inert')).toBe(false)
    expect(wrapperB.className).not.toContain('invisible')
    expect(wrapperB.className).not.toContain('pointer-events-none')
    expect(bodyA.textContent).toBe('a: 1')
    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneB}"]`))

    rerender(
      <TreeGroup node={group([paneA, paneB], { active: paneA, id: 'test-keep-alive-group' })} parentAxis="row" />
    )

    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneA}"]`))
  })
})

describe('TreeGroup native tab keyboard and close focus', () => {
  it('activates and focuses peer tabs with standard tablist keys', () => {
    const paneA = 'test-keyboard-pane-a'
    const paneB = 'test-keyboard-pane-b'
    const activateA = vi.fn()
    const activateB = vi.fn()
    const node = group([paneA, paneB], { active: paneA, id: 'test-keyboard-group' })

    registry.registerMany([
      { area: 'panes', data: { onActivate: activateA }, id: paneA, render: () => null, title: 'Canvas A' },
      { area: 'panes', data: { onActivate: activateB }, id: paneB, render: () => null, title: 'Canvas B' }
    ])
    $layoutTree.set(node)
    render(<TreeGroup node={node} parentAxis="row" />)

    const tabA = globalThis.document.querySelector<HTMLElement>(`[data-tree-tab="${paneA}"]`)!
    const tabB = globalThis.document.querySelector<HTMLElement>(`[data-tree-tab="${paneB}"]`)!

    tabA.focus()
    fireEvent.keyDown(tabA, { key: 'ArrowRight' })
    expect(findGroupOfPane($layoutTree.get()!, paneB)?.active).toBe(paneB)
    expect(activateB).toHaveBeenCalledTimes(1)
    expect(globalThis.document.activeElement).toBe(tabB)

    fireEvent.keyDown(tabB, { key: 'Home' })
    expect(findGroupOfPane($layoutTree.get()!, paneA)?.active).toBe(paneA)
    expect(activateA).toHaveBeenCalledTimes(1)
    expect(globalThis.document.activeElement).toBe(tabA)
  })

  it('moves focus to the actual native neighbor before removing a focused canvas', () => {
    const paneA = 'test-remove-focus-pane-a'
    const paneB = 'test-remove-focus-pane-b'
    const node = group([paneA, paneB], { active: paneA, id: 'test-remove-focus-group' })

    registry.registerMany([
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneA,
        render: () => <button data-testid="remove-focus-body-a">Canvas A body</button>,
        title: 'Canvas A'
      },
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneB,
        render: () => null,
        title: 'Canvas B'
      }
    ])
    $layoutTree.set(node)
    const { rerender } = render(<TreeGroup node={node} parentAxis="row" />)
    screen.getByTestId('remove-focus-body-a').focus()

    act(() => removeTreePane(paneA))
    const next = $layoutTree.get()!
    rerender(<TreeGroup node={next.type === 'group' ? next : group([paneB])} parentAxis="row" />)

    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneB}"]`))
  })

  it('moves focus between tabs in a minimized vertical rail after close', () => {
    const paneA = 'test-minimized-remove-focus-pane-a'
    const paneB = 'test-minimized-remove-focus-pane-b'

    const node = group([paneA, paneB], {
      active: paneA,
      id: 'test-minimized-remove-focus-group',
      minimized: true
    })

    registry.registerMany([
      { area: 'panes', data: { placement: 'main' }, id: paneA, render: () => null, title: 'Canvas A' },
      { area: 'panes', data: { placement: 'main' }, id: paneB, render: () => null, title: 'Canvas B' }
    ])
    $layoutTree.set(node)
    const { rerender } = render(<TreeGroup node={node} parentAxis="row" />)
    const tabA = globalThis.document.querySelector<HTMLElement>(`[data-tree-tab="${paneA}"]`)!

    tabA.focus()
    act(() => removeTreePane(paneA))
    const next = $layoutTree.get()!
    rerender(<TreeGroup node={next.type === 'group' ? next : group([paneB])} parentAxis="row" />)

    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneB}"]`))
  })

  it('focuses the surviving workflow tab when its focused peer owned a singleton split', () => {
    const paneA = 'test-split-remove-focus-pane-a'
    const paneB = 'test-split-remove-focus-pane-b'
    const groupA = group([paneA], { id: 'test-split-remove-group-a' })
    const groupB = group([paneB], { id: 'test-split-remove-group-b' })
    const root = split('row', [groupA, groupB], [1, 1], 'test-split-remove-root')

    registry.registerMany([
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneA,
        render: () => <button data-testid="split-remove-focus-body-a">Canvas A body</button>,
        title: 'Canvas A'
      },
      {
        area: 'panes',
        data: { keepAliveWhenInactive: true, placement: 'main' },
        id: paneB,
        render: () => null,
        title: 'Canvas B'
      }
    ])
    $layoutTree.set(root)

    const { rerender } = render(
      <>
        <TreeGroup node={groupA} parentAxis="row" />
        <TreeGroup node={groupB} parentAxis="row" />
      </>
    )

    screen.getByTestId('split-remove-focus-body-a').focus()
    prepareTreePaneRemovalFocus(paneA, paneB)

    act(() => removeTreePane(paneA))
    const next = $layoutTree.get()!
    rerender(<TreeGroup node={next.type === 'group' ? next : groupB} parentAxis="row" />)

    expect($activeTreeGroup.get()).toBe(groupB.id)
    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneB}"]`))
  })
})

describe('TreeGroup layout anchors', () => {
  it('never exposes a structural anchor as a native tab, including in layout edit mode', () => {
    const anchor = 'test-loop-layout-anchor'
    const paneA = 'test-loop-workflow-a'
    const paneB = 'test-loop-workflow-b'

    registry.registerMany([
      {
        area: 'panes',
        data: { layoutAnchorOnly: true, placement: 'main', uncloseable: true },
        id: anchor,
        render: () => null,
        title: 'Loop'
      },
      { area: 'panes', data: { placement: 'main' }, id: paneA, render: () => null, title: 'Workflow A' },
      { area: 'panes', data: { placement: 'main' }, id: paneB, render: () => null, title: 'Workflow B' }
    ])
    setTreePaneHidden(anchor, true)
    $layoutEditMode.set(true)

    const { container } = render(
      <TreeGroup
        node={group([paneA, paneB, anchor], { active: paneA, id: 'test-loop-anchor-group' })}
        parentAxis="row"
      />
    )

    expect(container.querySelector(`[data-tree-tab="${anchor}"]`)).toBeNull()
    expect(container.querySelector(`[data-tree-tab="${paneA}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-tree-tab="${paneB}"]`)).not.toBeNull()
  })
})
