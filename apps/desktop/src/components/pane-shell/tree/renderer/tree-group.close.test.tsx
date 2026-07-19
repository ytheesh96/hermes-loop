import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

import { group } from '../model'
import { registerPaneCloser, setTreePaneHidden } from '../store'

import { TreeGroup } from './tree-group'

afterEach(cleanup)

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
