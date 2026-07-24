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
    workflow_id: 't_root',
    tasks: [
      {
        id: 't_root',
        included_child_ids: ['t_child'],
        included_parent_ids: [],
        status: 'triage',
        title: 'Loop workflow'
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
    activeWorkflowRef: { board: 'default', workflowId: 't_root' },
    canvasScopeKey: 'session-1',
    focusedTaskId: 't_root',
    focusRequestKey: 0,
    focusRequestKeysByWorkflow: { 'default:t_root': 0 },
    hidden: false,
    onActivateWorkflowId: vi.fn(),
    onAddTaskComment: vi.fn(),
    onCloseWorkflowId: vi.fn(),
    onCreateTask: vi.fn(async () => null),
    onFocusTaskId: vi.fn(),
    onHide: vi.fn(),
    onLinkTasks: vi.fn(async () => true),
    onUnlinkTasks: vi.fn(async () => true),
    onOpen: vi.fn(),
    onSavePositions: vi.fn(async () => true),
    onSelectTaskId: vi.fn(),
    onSelectWorkflowId: vi.fn(),
    onTaskAction: vi.fn(),
    open: true,
    positions: [],
    positionsByWorkflow: { 'default:t_root': [] },
    workflowKey: 'default:t_root',
    workflowId: 't_root',
    workflowRef: { board: 'default', workflowId: 't_root' },
    workflowRefs: [{ board: 'default', workflowId: 't_root' }],
    workflowPaneScopeKey: 'default:session-1',
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

    render(<ChatWorkRail loop={loopController()} previewKey={target.url} previewLabel={target.label} previewOpen />)

    expect(screen.getByTestId('work-rail-tab-loop')).toBeTruthy()
    expect(screen.getByTestId('work-rail-tab-preview')).toBeTruthy()
    expect(within(screen.getByTestId('work-rail-tab-loop')).getByRole('tab', { name: 'Loop' })).toBeTruthy()
    expect(within(screen.getByTestId('work-rail-tab-preview')).getByRole('tab', { name: 'Preview' })).toBeTruthy()
    expect(
      within(screen.getByTestId('work-rail-tabbar'))
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Loop', 'Preview'])
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Loop', 'Preview'])
    expect((await screen.findByTestId('preview-pane')).textContent).toBe('Preview artifact')

    fireEvent.click(screen.getByRole('tab', { name: 'Loop' }))

    const loopPanel = screen.getByTestId('loop-panel')
    expect(loopPanel.getAttribute('data-layout')).toBe('tabbed')
    expect(loopPanel.style.width).toBe('')
    expect(screen.queryByTestId('loop-panel-tabbar')).toBeNull()
    expect(screen.queryByRole('separator', { name: /resize loop-panel/i })).toBeNull()
  })

  it('opens the Loop rail immediately for a selected task while the graph source is still loading', () => {
    const loop = {
      ...loopController(),
      focusedTaskId: 't_pending',
      selectedTaskId: 't_pending',
      state: null,
      tabKey: 't_pending'
    } as LoopPanelController

    render(<ChatWorkRail loop={loop} previewOpen={false} />)

    expect(screen.getByTestId('work-rail-tab-loop')).toBeTruthy()
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
    expect(screen.getByTestId('loop-panel-loading').textContent).toContain('t_pending')
  })

  it('opens an empty Loop canvas without a selected task', () => {
    const onCreateLoopTask = vi.fn(async () => 't_created')

    const loop = {
      ...loopController(),
      focusedTaskId: null,
      selectedTaskId: null,
      state: null,
      tabKey: ''
    } as LoopPanelController

    render(<ChatWorkRail loop={loop} onCreateLoopTask={onCreateLoopTask} previewOpen={false} />)

    expect(screen.getByTestId('work-rail-tab-loop')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Add a Loop task' })).toBeTruthy()
    expect(screen.queryByTestId('loop-panel-loading')).toBeNull()

    const idea = screen.getByRole('textbox', { name: 'Rough idea' })
    fireEvent.change(idea, { target: { value: 'Fix flaky auth test' } })
    fireEvent.keyDown(idea, { key: 'Enter' })
    expect(onCreateLoopTask).toHaveBeenCalledWith('Fix flaky auth test', {
      workflowId: 't_root',
      workflowRef: { board: 'default', workflowId: 't_root' }
    })
  })

  it('reactivates the Loop tab when the same root row is explicitly opened again', async () => {
    const target = previewTarget()
    setPreviewTarget(target)

    const loop = loopController()

    const { rerender } = render(
      <ChatWorkRail
        loop={{ ...loop, focusRequestKey: 0 }}
        previewKey={target.url}
        previewLabel={target.label}
        previewOpen
      />
    )

    expect((await screen.findByTestId('preview-pane')).textContent).toBe('Preview artifact')
    expect(
      within(screen.getByTestId('work-rail-tabbar')).getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')
    ).toBe('true')

    rerender(
      <ChatWorkRail
        loop={{ ...loop, focusRequestKey: 1 }}
        previewKey={target.url}
        previewLabel={target.label}
        previewOpen
      />
    )

    expect(
      within(screen.getByTestId('work-rail-tabbar')).getByRole('tab', { name: 'Loop' }).getAttribute('aria-selected')
    ).toBe('true')
    expect(screen.getByTestId('loop-panel')).toBeTruthy()
  })
})
