import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { findGroupOfPane, group, split } from '@/components/pane-shell/tree/model'
import { TreeGroup } from '@/components/pane-shell/tree/renderer/tree-group'
import { $activeTreeGroup, $layoutTree, closeTreePane } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { setRuntimeI18nLocale } from '@/i18n'

import { type LoopWorkflowRef, loopWorkflowRefKey } from '../chat/loop-state'
import type { LoopPanelController } from '../chat/use-loop-panel-controller'

const mocks = vi.hoisted(() => ({
  loopPanelProps: vi.fn(),
  requestComposerFocus: vi.fn()
}))

vi.mock('../chat/composer/focus', () => ({
  requestComposerFocus: mocks.requestComposerFocus
}))

vi.mock('../chat/loop-panel', () => ({
  LoopPanel: (props: Record<string, unknown>) => {
    mocks.loopPanelProps(props)

    return <div data-testid="workflow-canvas">{String(props.workflowId)}</div>
  },
  loopPanelStateForWorkflow: (
    state: { rows: { board?: string; workflowId?: string }[]; workflowId?: string; workflowIds: string[] } | null,
    workflow: LoopWorkflowRef
  ) => {
    if (!state) {
      return null
    }

    const workflowId = workflow.workflowId
    const board = workflow.board

    return {
      ...state,
      rows: state.rows.filter(
        row => (row.workflowId || state.workflowId) === workflowId && (!board || (row.board || 'default') === board)
      ),
      workflowId,
      workflowIds: [workflowId]
    }
  },
  loopWorkflowPaneTitle: (
    state: { rows: { board?: string; title: string; workflowId?: string }[] } | null,
    workflow: LoopWorkflowRef
  ) => {
    const workflowId = workflow.workflowId
    const board = workflow.board

    return (
      state?.rows.find(row => row.workflowId === workflowId && (!board || (row.board || 'default') === board))?.title ||
      workflowId
    )
  }
}))

import { $loopPanelController, loopNewWorkflowPaneId, loopWorkflowPaneId, watchLoopWorkflowPanes } from './panes'

function workflowRef(workflowId: string, board = 'default'): LoopWorkflowRef {
  return { board, workflowId }
}

function controller(workflowIds = ['wf-a', 'wf-b']): LoopPanelController {
  const workflowRefs = workflowIds.map(workflowId => workflowRef(workflowId))
  const activeWorkflowRef = workflowRefs[0] || null

  return {
    activeWorkflowRef,
    canvasScopeKey: 'session:one',
    focusedTaskId: null,
    focusRequestKey: 1,
    focusRequestKeysByWorkflow: Object.fromEntries(workflowRefs.map(ref => [loopWorkflowRefKey(ref), 1])),
    hidden: false,
    onActivateWorkflowId: vi.fn(),
    onAddTaskComment: vi.fn(),
    onCloseWorkflowId: vi.fn(),
    onCreateTask: vi.fn(),
    onFocusTaskId: vi.fn(),
    onHide: vi.fn(),
    onLinkTasks: vi.fn(),
    onOpen: vi.fn(),
    onSavePositions: vi.fn(),
    onSelectTaskId: vi.fn(),
    onSelectWorkflowId: vi.fn(),
    onTaskAction: vi.fn(),
    onUnlinkTasks: vi.fn(),
    open: true,
    positions: undefined,
    positionsByWorkflow: Object.fromEntries(workflowRefs.map(ref => [loopWorkflowRefKey(ref), []])),
    selectedTaskDetail: undefined,
    selectedTaskDetailError: null,
    selectedTaskId: null,
    state: {
      rows: [
        { taskId: 'a-root', title: 'Duplicate title', workflowId: 'wf-a' },
        { taskId: 'b-root', title: 'Duplicate title', workflowId: 'wf-b' }
      ],
      status: 'ready',
      workflowId: 'wf-a',
      workflowIds: ['wf-a', 'wf-b'],
      workflowRefs
    },
    tabKey: '',
    workflowId: workflowIds[0],
    workflowKey: activeWorkflowRef ? loopWorkflowRefKey(activeWorkflowRef) : '',
    workflowRef: activeWorkflowRef,
    workflowRefs,
    workflowPaneScopeKey: 'profile:session:one'
  } as unknown as LoopPanelController
}

function crossBoardController(): LoopPanelController {
  const alpha = { board: 'alpha', workflowId: 'wf-shared' }
  const beta = { board: 'beta', workflowId: 'wf-shared' }
  const loop = controller([])

  return {
    ...loop,
    activeWorkflowRef: alpha,
    focusRequestKeysByWorkflow: { 'alpha:wf-shared': 1, 'beta:wf-shared': 1 },
    positionsByWorkflow: { 'alpha:wf-shared': [], 'beta:wf-shared': [] },
    state: {
      ...loop.state!,
      rows: [
        { board: 'alpha', taskId: 'alpha-root', title: 'Duplicate title', workflowId: 'wf-shared' },
        { board: 'beta', taskId: 'beta-root', title: 'Duplicate title', workflowId: 'wf-shared' }
      ] as never,
      workflowId: '',
      workflowIds: ['wf-shared'],
      workflowRefs: [alpha, beta]
    },
    workflowKey: 'alpha:wf-shared',
    workflowRef: alpha,
    workflowId: alpha.workflowId,
    workflowRefs: [alpha, beta]
  } as LoopPanelController
}

beforeAll(() => {
  watchLoopWorkflowPanes()
})

afterEach(() => {
  cleanup()
  mocks.loopPanelProps.mockClear()
  mocks.requestComposerFocus.mockClear()
  act(() => $loopPanelController.set(null))
  $layoutTree.set(null)
  $activeTreeGroup.set(null)
  setRuntimeI18nLocale('en')
})

describe('native Loop workflow panes', () => {
  it('registers one keep-alive native pane per exact scoped workflow id', () => {
    act(() => $loopPanelController.set(controller()))

    const paneAId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-a'))
    const paneBId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-b'))
    const panes = registry.getArea('panes')
    const paneA = panes.find(pane => pane.id === paneAId)
    const paneB = panes.find(pane => pane.id === paneBId)

    expect(paneAId).not.toBe(paneBId)
    expect(paneA?.title).toBe('Duplicate title')
    expect(paneB?.title).toBe('Duplicate title')
    expect(paneA?.data).toEqual(
      expect.objectContaining({
        dock: { before: 'loop', pane: 'loop', pos: 'center' },
        keepAliveWhenInactive: true,
        placement: 'main'
      })
    )
  })

  it('keeps identical workflow ids on different boards as distinct native panes', () => {
    const loop = crossBoardController()
    act(() => $loopPanelController.set(loop))

    const alpha = { board: 'alpha', workflowId: 'wf-shared' }
    const beta = { board: 'beta', workflowId: 'wf-shared' }
    const alphaPaneId = loopWorkflowPaneId('profile:session:one', alpha)
    const betaPaneId = loopWorkflowPaneId('profile:session:one', beta)
    const panes = registry.getArea('panes')
    const alphaPane = panes.find(pane => pane.id === alphaPaneId)
    const betaPane = panes.find(pane => pane.id === betaPaneId)

    expect(alphaPaneId).not.toBe(betaPaneId)
    expect(alphaPane?.title).toBe('Duplicate title · alpha')
    expect(betaPane?.title).toBe('Duplicate title · beta')

    act(() => (betaPane?.data as { onActivate?: () => void } | undefined)?.onActivate?.())
    expect(loop.onActivateWorkflowId).toHaveBeenCalledWith(beta)

    render(<>{betaPane?.render?.()}</>)
    expect(mocks.loopPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ rows: [expect.objectContaining({ taskId: 'beta-root' })] }),
        workflowId: 'wf-shared'
      })
    )
  })

  it('renders and activates only the workflow owned by that native pane', () => {
    const loop = controller()
    act(() => $loopPanelController.set(loop))

    const paneBId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-b'))
    const paneB = registry.getArea('panes').find(pane => pane.id === paneBId)

    act(() => (paneB?.data as { onActivate?: () => void } | undefined)?.onActivate?.())
    render(<>{paneB?.render?.()}</>)

    expect(loop.onActivateWorkflowId).toHaveBeenCalledWith(workflowRef('wf-b'))
    expect(loop.onSelectWorkflowId).not.toHaveBeenCalled()
    expect(mocks.loopPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          rows: [expect.objectContaining({ taskId: 'b-root' })],
          workflowId: 'wf-b',
          workflowIds: ['wf-b']
        }),
        workflowCanvas: true,
        workflowId: 'wf-b'
      })
    )
  })

  it('keeps focused task detail with the workflow pane that owns the task', () => {
    const loop = controller()
    loop.activeWorkflowRef = workflowRef('wf-b')
    loop.focusedTaskId = 'b-root'
    loop.selectedTaskDetail = { task: { id: 'b-root', title: 'Workflow B detail' } } as never
    loop.selectedTaskDetailError = 'detail warning'
    loop.selectedTaskId = null
    act(() => $loopPanelController.set(loop))

    const paneBId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-b'))
    const paneB = registry.getArea('panes').find(pane => pane.id === paneBId)
    mocks.loopPanelProps.mockClear()
    render(<>{paneB?.render?.()}</>)

    expect(mocks.loopPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedTaskDetail: loop.selectedTaskDetail,
        selectedTaskDetailError: 'detail warning',
        selectedTaskId: null,
        workflowId: 'wf-b'
      })
    )
  })

  it('uses a closeable native placeholder while a new workflow is empty or hydrating', () => {
    const loop = controller([])
    setRuntimeI18nLocale('ja')
    act(() => $loopPanelController.set(loop))

    const placeholderId = loopNewWorkflowPaneId('profile:session:one')
    const placeholder = registry.getArea('panes').find(pane => pane.id === placeholderId)

    expect(placeholder?.title).toBe('新しいワークフロー')
    render(<>{placeholder?.render?.()}</>)
    expect(mocks.loopPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: null, workflowCanvas: true, workflowId: undefined })
    )

    closeTreePane(placeholderId)
    expect(loop.onHide).toHaveBeenCalledTimes(1)
    expect(loop.onCloseWorkflowId).not.toHaveBeenCalled()
    expect(mocks.requestComposerFocus).toHaveBeenCalledTimes(1)
  })

  it('routes native tab close to the exact workflow and returns focus after the last one', () => {
    const loop = controller()
    act(() => $loopPanelController.set(loop))

    closeTreePane(loopWorkflowPaneId('profile:session:one', workflowRef('wf-a')))
    expect(loop.onCloseWorkflowId).toHaveBeenCalledWith(workflowRef('wf-a'))
    expect(mocks.requestComposerFocus).not.toHaveBeenCalled()

    const last = controller(['wf-b'])
    vi.mocked(last.onCloseWorkflowId).mockReturnValue({
      closedLast: true,
      nextWorkflowId: null,
      nextWorkflowRef: null
    })
    act(() => $loopPanelController.set(last))

    closeTreePane(loopWorkflowPaneId('profile:session:one', workflowRef('wf-b')))
    expect(last.onCloseWorkflowId).toHaveBeenCalledWith(workflowRef('wf-b'))
    expect(mocks.requestComposerFocus).toHaveBeenCalledTimes(1)
  })

  it('moves focus to the surviving workflow when closing an inactive singleton split', () => {
    const loop = controller()
    loop.activeWorkflowRef = workflowRef('wf-a')
    vi.mocked(loop.onCloseWorkflowId).mockReturnValue({
      closedLast: false,
      nextWorkflowId: 'wf-a',
      nextWorkflowRef: { board: 'default', workflowId: 'wf-a' }
    })
    act(() => $loopPanelController.set(loop))

    const paneAId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-a'))
    const paneBId = loopWorkflowPaneId('profile:session:one', workflowRef('wf-b'))
    const groupA = group([paneAId], { id: 'test-workflow-split-a' })
    const groupB = group([paneBId], { id: 'test-workflow-split-b' })
    $layoutTree.set(split('row', [groupA, groupB], [1, 1], 'test-workflow-split-root'))

    const { rerender } = render(
      <>
        <TreeGroup node={groupA} parentAxis="row" />
        <TreeGroup node={groupB} parentAxis="row" />
      </>
    )

    globalThis.document.querySelector<HTMLElement>(`[data-tree-tab="${paneBId}"]`)!.focus()

    closeTreePane(paneBId)
    act(() => $loopPanelController.set(controller(['wf-a'])))
    const next = $layoutTree.get()!
    const nextGroup = findGroupOfPane(next, paneAId)!
    rerender(<TreeGroup node={nextGroup} parentAxis="row" />)

    expect(loop.onCloseWorkflowId).toHaveBeenCalledWith(workflowRef('wf-b'))
    expect($activeTreeGroup.get()).toBe(nextGroup.id)
    expect(globalThis.document.activeElement).toBe(globalThis.document.querySelector(`[data-tree-tab="${paneAId}"]`))
  })
})
