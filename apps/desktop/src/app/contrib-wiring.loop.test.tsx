import { useStore } from '@nanostores/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  interface MockLoopController {
    focusedTaskId: null | string
    focusRequestKey: number
    hidden: boolean
    onAddTaskComment: ReturnType<typeof vi.fn>
    onCreateTask: ReturnType<typeof vi.fn>
    onFocusTaskId: ReturnType<typeof vi.fn>
    onHide: ReturnType<typeof vi.fn>
    onOpen: ReturnType<typeof vi.fn>
    onSelectTaskId: ReturnType<typeof vi.fn>
    onTaskAction: ReturnType<typeof vi.fn>
    open: boolean
    selectedTaskDetail: null
    selectedTaskDetailError: null
    selectedTaskId: null | string
    state: null | {
      message: string
      rawJson: string
      revision: number
      workflowId: string
      rows: unknown[]
      status: string
    }
    tabKey: string
  }

  const selectLoopTask = vi.fn()
  const openLoop = vi.fn()
  const createLoopTask = vi.fn(async () => 't_created')
  const submitText = vi.fn(async () => true)

  const defaultLoopController = (): MockLoopController => ({
    focusedTaskId: null,
    focusRequestKey: 0,
    hidden: false,
    onAddTaskComment: vi.fn(),
    onCreateTask: createLoopTask,
    onFocusTaskId: vi.fn(),
    onHide: vi.fn(),
    onOpen: openLoop,
    onSelectTaskId: selectLoopTask,
    onTaskAction: vi.fn(),
    open: true,
    selectedTaskDetail: null,
    selectedTaskDetailError: null,
    selectedTaskId: 't_delegated_loop',
    state: { message: '', rawJson: '{}', revision: 1, workflowId: 't_delegated_loop', rows: [], status: 'ready' },
    tabKey: 't_delegated_loop'
  })

  const useLoopPanelController = vi.fn(defaultLoopController)

  return { createLoopTask, defaultLoopController, openLoop, selectLoopTask, submitText, useLoopPanelController }
})

vi.mock('@/components/pane-shell', () => ({
  Pane: ({ children }: { children?: React.ReactNode }) => <div data-testid="pane">{children}</div>,
  PaneMain: ({ children }: { children?: React.ReactNode }) => <main>{children}</main>
}))

vi.mock('@/components/boot-failure-overlay', () => ({ BootFailureOverlay: () => null }))
vi.mock('@/components/desktop-install-overlay', () => ({ DesktopInstallOverlay: () => null }))
vi.mock('@/components/desktop-onboarding-overlay', () => ({ DesktopOnboardingOverlay: () => null }))
vi.mock('@/components/gateway-connecting-overlay', () => ({ GatewayConnectingOverlay: () => null }))
vi.mock('@/components/remote-display-banner', () => ({ RemoteDisplayBanner: () => null }))
vi.mock('@/hooks/use-media-query', () => ({ matchesQuery: () => false, useMediaQuery: () => false }))
vi.mock('@/themes/use-skin-command', () => ({ useSkinCommand: () => vi.fn() }))

vi.mock('../hermes', () => ({
  checkHermesUpdate: vi.fn(async () => null),
  getCronJobs: vi.fn(async () => []),
  getActionStatus: vi.fn(async () => null),
  getProfiles: vi.fn(async () => []),
  getSessionMessages: vi.fn(async () => ({ messages: [] })),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  listSidebarSessions: vi.fn(async () => ({
    cron: { sessions: [], total: 0 },
    messaging: { sessions: [], total: 0 },
    recents: { profile_totals: {}, sessions: [], total: 0 }
  })),
  restartGateway: vi.fn(async () => undefined),
  setApiRequestProfile: vi.fn(),
  updateHermes: vi.fn(async () => undefined),
  triggerCronJob: vi.fn(async () => undefined)
}))

vi.mock('../store/windows', () => ({ isSecondaryWindow: () => false }))

vi.mock('./chat', () => ({
  ChatView: ({
    onOpenKanbanTask,
    onOpenLoop
  }: {
    onOpenKanbanTask?: (taskId: string) => void
    onOpenLoop?: () => void
  }) => (
    <>
      <button onClick={() => onOpenKanbanTask?.('t_delegated_loop')} type="button">
        Open delegated Loop row
      </button>
      <button onClick={onOpenLoop} type="button">
        Open Loop canvas
      </button>
    </>
  )
}))

vi.mock('./chat/composer/focus', () => ({
  requestComposerFocus: vi.fn(),
  requestComposerInsert: vi.fn()
}))

vi.mock('./chat/hooks/use-composer-actions', () => ({
  useComposerActions: () => ({
    addContextRefAttachment: vi.fn(),
    attachDroppedItems: vi.fn(),
    attachImageBlob: vi.fn(),
    insertContextPathInlineRef: vi.fn(),
    pasteClipboardImage: vi.fn(),
    pickContextPaths: vi.fn(),
    pickImages: vi.fn(),
    removeAttachment: vi.fn()
  })
}))

vi.mock('./chat/right-rail', () => ({
  ChatPreviewRail: () => <div data-testid="chat-preview-rail" />,
  ChatWorkRail: ({
    loop,
    onCreateLoopTask,
    previewOpen
  }: {
    loop: ReturnType<typeof mocks.defaultLoopController>
    onCreateLoopTask?: (idea: string, assignee: string) => Promise<null | string>
    previewOpen: boolean
  }) =>
    previewOpen || (loop.open && !loop.hidden) ? (
      <div data-testid="chat-work-rail">
        <button onClick={() => void onCreateLoopTask?.('Fix flaky auth test', 'peacock')} type="button">
          Add test Loop task
        </button>
      </div>
    ) : null,
  PREVIEW_RAIL_MAX_WIDTH: '38rem',
  PREVIEW_RAIL_MIN_WIDTH: '18rem',
  PREVIEW_RAIL_PANE_WIDTH: '32rem',
  WORK_RAIL_MAX_WIDTH: '42rem',
  WORK_RAIL_MIN_WIDTH: '24rem',
  WORK_RAIL_PANE_WIDTH: '34rem'
}))

vi.mock('./chat/sidebar', () => ({ ChatSidebar: () => null }))
vi.mock('./chat/use-loop-panel-controller', () => ({ useLoopPanelController: mocks.useLoopPanelController }))
vi.mock('./command-palette', () => ({ CommandPalette: () => null }))
vi.mock('./gateway/hooks/use-gateway-boot', () => ({ useGatewayBoot: vi.fn() }))
vi.mock('./gateway/hooks/use-gateway-request', () => ({
  useGatewayRequest: () => ({
    connectionRef: { current: null },
    gatewayRef: { current: null },
    requestGateway: vi.fn()
  })
}))
vi.mock('./hooks/use-keybinds', () => ({ useKeybinds: vi.fn() }))
vi.mock('./model-picker-overlay', () => ({ ModelPickerOverlay: () => null }))
vi.mock('./model-visibility-overlay', () => ({ ModelVisibilityOverlay: () => null }))
vi.mock('./pet-generate/pet-generate-overlay', () => ({ PetGenerateOverlay: () => null }))
vi.mock('./right-sidebar', () => ({ RightSidebarPane: () => null }))
vi.mock('./right-sidebar/file-actions', () => ({ FileActionDialogs: () => null }))
vi.mock('./right-sidebar/review', () => ({ ReviewPane: () => null }))
vi.mock('./right-sidebar/store', () => ({
  $terminalTakeover: { get: () => false, listen: () => () => {}, subscribe: () => () => {} }
}))
vi.mock('./right-sidebar/terminal/persistent', () => ({ PersistentTerminal: () => null, TerminalSlot: () => null }))
vi.mock('./session/hooks/use-context-suggestions', () => ({ useContextSuggestions: vi.fn() }))
vi.mock('./session/hooks/use-cwd-actions', () => ({ useCwdActions: () => ({ refreshProjectBranch: vi.fn() }) }))
vi.mock('./session/hooks/use-hermes-config', () => ({
  useHermesConfig: () => ({ refreshHermesConfig: vi.fn(), sttEnabled: false, voiceMaxRecordingSeconds: undefined })
}))
vi.mock('./session/hooks/use-message-stream', () => ({ useMessageStream: () => ({ handleGatewayEvent: vi.fn() }) }))
vi.mock('./session/hooks/use-model-controls', () => ({
  useModelControls: () => ({ refreshCurrentModel: vi.fn(), selectModel: vi.fn(), updateModelOptionsCache: vi.fn() })
}))
vi.mock('./session/hooks/use-preview-routing', () => ({
  usePreviewRouting: () => ({ handleDesktopGatewayEvent: vi.fn(), restartPreviewServer: vi.fn() })
}))
vi.mock('./session/hooks/use-prompt-actions', () => ({
  usePromptActions: () => ({
    cancelRun: vi.fn(),
    editMessage: vi.fn(),
    handleThreadMessagesChange: vi.fn(),
    reloadFromMessage: vi.fn(),
    restoreToMessage: vi.fn(),
    steerPrompt: vi.fn(),
    submitText: mocks.submitText,
    transcribeVoiceAudio: vi.fn()
  })
}))
vi.mock('./session/hooks/use-route-resume', () => ({ useRouteResume: vi.fn() }))
vi.mock('./session/hooks/use-session-actions', () => ({
  useSessionActions: () => ({
    archiveSession: vi.fn(),
    branchCurrentSession: vi.fn(async () => null),
    branchStoredSession: vi.fn(),
    createBackendSessionForSend: vi.fn(),
    openSettings: vi.fn(),
    removeSession: vi.fn(),
    resumeSession: vi.fn(),
    selectSidebarItem: vi.fn(),
    startFreshSessionDraft: vi.fn()
  })
}))
vi.mock('./session/hooks/use-session-state-cache', () => ({
  useSessionStateCache: () => ({
    activeSessionIdRef: { current: 'runtime-tip' },
    ensureSessionState: vi.fn(),
    runtimeIdByStoredSessionIdRef: { current: new Map([['logical-origin', 'runtime-tip']]) },
    selectedStoredSessionIdRef: { current: 'logical-origin' },
    sessionStateByRuntimeIdRef: { current: new Map() },
    syncSessionStateToView: vi.fn(),
    updateSessionState: vi.fn()
  })
}))
vi.mock('./shell/app-shell', () => ({
  AppShell: ({ children }: { children?: React.ReactNode }) => <div data-testid="app-shell">{children}</div>
}))
vi.mock('./shell/hooks/use-overlay-routing', () => ({
  useOverlayRouting: () => ({
    agentsOpen: false,
    chatOpen: true,
    closeOverlayToPreviousRoute: vi.fn(),
    commandCenterInitialSection: null,
    commandCenterOpen: false,
    cronOpen: false,
    currentView: 'chat',
    openAgents: vi.fn(),
    openCommandCenterSection: vi.fn(),
    profilesOpen: false,
    settingsOpen: false,
    toggleCommandCenter: vi.fn()
  })
}))
vi.mock('./shell/hooks/use-status-snapshot', () => ({
  useStatusSnapshot: () => ({ gatewayLogLines: [], inferenceStatus: null, statusSnapshot: null })
}))
vi.mock('./shell/hooks/use-statusbar-items', () => ({
  useStatusbarItems: () => ({ leftStatusbarItems: [], statusbarItems: [] })
}))
vi.mock('./shell/model-menu-panel', () => ({ ModelMenuPanel: () => null }))
vi.mock('./shell/use-group-registry', () => ({
  useGroupRegistry: () => ({ flat: { left: [], right: [] }, set: vi.fn() })
}))
vi.mock('./updates-overlay', () => ({ UpdatesOverlay: () => null }))

import './contrib/controller'

import { $collapsedTreeSides, $hiddenTreePanes } from '../components/pane-shell/tree/store'
import { $fileBrowserOpen, setFileBrowserOpen } from '../store/layout'
import {
  $activeSessionId,
  $currentCwd,
  $freshDraftReady,
  $gatewayState,
  $selectedStoredSessionId
} from '../store/session'

import { WiredPane } from './contrib/context'
import { $loopPanelController } from './contrib/panes'
import { ContribWiring } from './contrib/wiring'

function LoopWiringProbe() {
  const loop = useStore($loopPanelController)

  return (
    <div>
      <WiredPane part="chatRoutes" />
      <button onClick={() => void loop?.onCreateTask('Fix flaky auth test')} type="button">
        Add test Loop task
      </button>
      <output data-testid="loop-controller-open">{String(loop?.open ?? false)}</output>
    </div>
  )
}

function renderController() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/logical-origin']}>
        <ContribWiring>
          <LoopWiringProbe />
        </ContribWiring>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('ContribWiring Loop session-source wiring', () => {
  beforeEach(() => {
    $activeSessionId.set('runtime-tip')
    $selectedStoredSessionId.set('logical-origin')
    $gatewayState.set('open')
    $freshDraftReady.set(false)
    $currentCwd.set('/tmp/hermes-loop-project')
    setFileBrowserOpen(true)
    mocks.selectLoopTask.mockClear()
    mocks.openLoop.mockClear()
    mocks.createLoopTask.mockClear()
    mocks.submitText.mockClear()
    mocks.useLoopPanelController.mockReset()
    mocks.useLoopPanelController.mockImplementation(mocks.defaultLoopController)
  })

  afterEach(() => {
    cleanup()
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    $gatewayState.set('closed')
    $freshDraftReady.set(true)
    $currentCwd.set('')
    setFileBrowserOpen(false)
  })

  it('uses the logical session key for Loop source while a runtime session is active', () => {
    renderController()

    expect(mocks.useLoopPanelController).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: 'runtime-tip',
        gatewayOpen: true,
        loopSourceSessionId: 'logical-origin'
      })
    )
    expect(screen.getByTestId('loop-controller-open').textContent).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /open delegated loop row/i }))

    expect(mocks.selectLoopTask).toHaveBeenCalledWith('t_delegated_loop')

    fireEvent.click(screen.getByRole('button', { name: 'Open Loop canvas' }))

    expect(mocks.openLoop).toHaveBeenCalledTimes(1)
  })

  it('does not render a visible Loop rail placeholder when the mounted session-source controller is empty', () => {
    mocks.useLoopPanelController.mockReturnValue({
      ...mocks.defaultLoopController(),
      focusedTaskId: null,
      hidden: false,
      open: false,
      selectedTaskId: null,
      state: null,
      tabKey: ''
    })

    renderController()

    expect(mocks.useLoopPanelController).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSessionId: 'runtime-tip',
        gatewayOpen: true,
        loopSourceSessionId: 'logical-origin'
      })
    )
    expect(screen.getByTestId('loop-controller-open').textContent).toBe('false')
  })

  it('renders an explicitly opened Loop canvas before session-source data exists', () => {
    mocks.useLoopPanelController.mockReturnValue({
      ...mocks.defaultLoopController(),
      focusedTaskId: null,
      hidden: false,
      open: true,
      selectedTaskId: null,
      state: null,
      tabKey: ''
    })

    renderController()

    expect(screen.getByTestId('loop-controller-open').textContent).toBe('true')
  })

  it('routes empty-canvas creation directly through the Loop controller', () => {
    renderController()

    fireEvent.click(screen.getByRole('button', { name: 'Add test Loop task' }))

    expect(mocks.createLoopTask).toHaveBeenCalledWith('Fix flaky auth test')
    expect(mocks.submitText).not.toHaveBeenCalled()
  })

  it('keeps Files and Loop visibility independent in both directions', () => {
    renderController()

    expect($hiddenTreePanes.get().has('files')).toBe(false)
    expect($hiddenTreePanes.get().has('loop')).toBe(false)

    act(() => setFileBrowserOpen(false))

    expect($fileBrowserOpen.get()).toBe(false)
    expect($hiddenTreePanes.get().has('files')).toBe(true)
    expect($hiddenTreePanes.get().has('loop')).toBe(false)
    expect($collapsedTreeSides.get().has('right')).toBe(false)

    act(() => {
      setFileBrowserOpen(true)
      const loop = $loopPanelController.get()

      if (!loop) {
        throw new Error('expected mounted Loop controller')
      }

      $loopPanelController.set({ ...loop, hidden: true })
    })

    expect($fileBrowserOpen.get()).toBe(true)
    expect($hiddenTreePanes.get().has('files')).toBe(false)
    expect($hiddenTreePanes.get().has('loop')).toBe(true)
    expect($collapsedTreeSides.get().has('right')).toBe(false)
  })
})
