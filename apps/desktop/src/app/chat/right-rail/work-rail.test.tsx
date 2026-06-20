import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearSessionPreviewRegistry, type PreviewTarget, setPreviewTarget } from '@/store/preview'

import { deriveLoopPanelStateFromTenantSource } from '../loop-state'
import type { LoopPanelController } from '../use-loop-panel-controller'

import { ChatWorkRail } from './work-rail'

vi.mock('./preview-pane', () => ({
  PreviewPane: ({ target }: { target: PreviewTarget }) => <div data-testid="preview-pane">{target.label}</div>
}))

afterEach(() => {
  cleanup()
  clearSessionPreviewRegistry()
})

function previewTarget(label = 'Preview artifact'): PreviewTarget {
  return {
    kind: 'url',
    label,
    source: 'http://localhost:5174',
    url: 'http://localhost:5174'
  }
}

function loopController(): LoopPanelController {
  const state = deriveLoopPanelStateFromTenantSource({
    root_task_id: 't_root',
    tasks: [
      {
        id: 't_root',
        included_child_ids: ['t_child'],
        included_parent_ids: [],
        status: 'triage',
        title: 'Loop root'
      },
      {
        id: 't_child',
        included_child_ids: [],
        included_parent_ids: ['t_root'],
        status: 'ready',
        title: 'Build child'
      }
    ]
  })

  return {
    focusedTaskId: 't_root',
    hidden: false,
    onAddTaskComment: vi.fn(),
    onFocusTaskId: vi.fn(),
    onHide: vi.fn(),
    onSelectTaskId: vi.fn(),
    onTaskAction: vi.fn(),
    open: true,
    selectedTaskDetail: undefined,
    selectedTaskDetailError: null,
    selectedTaskId: 't_root',
    state,
    tabKey: 't_root'
  } as LoopPanelController
}

describe('ChatWorkRail', () => {
  it('renders Loop and Preview as sibling rail tabs outside the chat surface', async () => {
    const target = previewTarget()
    setPreviewTarget(target)

    render(
      <ChatWorkRail
        loop={loopController()}
        previewKey={target.url}
        previewLabel={target.label}
        previewOpen
      />
    )

    expect(screen.getByTestId('work-rail-tab-loop')).toBeTruthy()
    expect(screen.getByTestId('work-rail-tab-preview')).toBeTruthy()
    expect(within(screen.getByTestId('work-rail-tab-loop')).getByRole('tab', { name: 'Loop' })).toBeTruthy()
    expect(within(screen.getByTestId('work-rail-tab-preview')).getByRole('tab', { name: 'Preview' })).toBeTruthy()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Loop', 'Preview'])
    expect((await screen.findByTestId('preview-pane')).textContent).toBe('Preview artifact')

    fireEvent.click(screen.getByRole('tab', { name: 'Loop' }))

    const loopPanel = screen.getByTestId('loop-panel')
    expect(loopPanel.getAttribute('data-layout')).toBe('tabbed')
    expect(loopPanel.style.width).toBe('')
    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByRole('separator', { name: /resize loop-panel/i })).toBeNull()
  })
})
