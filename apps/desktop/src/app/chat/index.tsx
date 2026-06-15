import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessage
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type * as React from 'react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { Thread } from '@/components/assistant-ui/thread'
import { Backdrop } from '@/components/Backdrop'
import { PromptOverlays } from '@/components/prompt-overlays'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  decomposeLoopTask,
  getGlobalModelOptions,
  getLoopSessionSource,
  getLoopTaskDetail,
  type HermesGateway,
  reviewLoopHandoffForTask,
  updateLoopTaskStatus
} from '@/hermes'
import type { ChatMessage } from '@/lib/chat-messages'
import { quickModelOptions, sessionTitle, toRuntimeMessage } from '@/lib/chat-runtime'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { reconcileKanbanSessionSourceForComposer } from '@/store/composer-status'
import { $pinnedSessionIds } from '@/store/layout'
import { $activeGatewayProfile, $gatewaySwapTarget } from '@/store/profile'
import {
  $activeSessionId,
  $awaitingResponse,
  $busy,
  $contextSuggestions,
  $currentCwd,
  $currentModel,
  $currentProvider,
  $freshDraftReady,
  $gatewayState,
  $introPersonality,
  $introSeed,
  $lastVisibleMessageIsUser,
  $messages,
  $messagesEmpty,
  $selectedStoredSessionId,
  $sessions,
  sessionMatchesAnyId,
  sessionPinId
} from '@/store/session'
import { openSessionInNewWindow } from '@/store/windows'
import type { ModelOptionsResponse } from '@/types/hermes'

import { routeSessionId } from '../routes'
import { titlebarHeaderBaseClass, titlebarHeaderShadowClass, titlebarHeaderTitleClass } from '../shell/titlebar'

import { ChatDropOverlay } from './chat-drop-overlay'
import { ChatSwapOverlay } from './chat-swap-overlay'
import { ChatBar, ChatBarFallback } from './composer'
import { requestComposerInsert, requestComposerInsertRefs } from './composer/focus'
import { droppedFileInlineRefs, type SessionDragPayload, sessionInlineRef } from './composer/inline-refs'
import type { ChatBarState } from './composer/types'
import { type DroppedFile, partitionDroppedFiles } from './hooks/use-composer-actions'
import { useFileDropZone } from './hooks/use-file-drop-zone'
import { LoopPanel, type LoopTaskAction } from './loop-panel'
import { loopSessionSourceRefetchInterval } from './loop-refresh'
import { deriveLoopPanelStateFromTenantSource, type LoopPanelState, type LoopRow, type TenantLoopSource } from './loop-state'
import { ScrollToBottomButton } from './scroll-to-bottom-button'
import { SessionActionsMenu } from './sidebar/session-actions-menu'
import { threadLoadingState } from './thread-loading'

interface ChatViewProps extends Omit<React.ComponentProps<'div'>, 'onSubmit'> {
  gateway: HermesGateway | null
  onToggleSelectedPin: () => void
  onDeleteSelectedSession: () => void
  onCancel: () => Promise<void> | void
  onAddContextRef: (refText: string, label?: string, detail?: string) => void
  onAddUrl: (url: string) => void
  onBranchInNewChat: (messageId: string) => void
  maxVoiceRecordingSeconds?: number
  onAttachImageBlob: (blob: Blob) => Promise<boolean | void> | boolean | void
  onAttachDroppedItems: (candidates: DroppedFile[]) => Promise<boolean | void> | boolean | void
  onPasteClipboardImage: () => void
  onPickFiles: () => void
  onPickFolders: () => void
  onPickImages: () => void
  onRemoveAttachment: (id: string) => void
  onSteer: (text: string) => Promise<boolean> | boolean
  onSubmit: (
    text: string,
    options?: { attachments?: ComposerAttachment[]; fromQueue?: boolean }
  ) => Promise<boolean> | boolean
  onThreadMessagesChange: (messages: readonly ThreadMessage[]) => void
  onEdit: (message: AppendMessage) => Promise<void>
  onReload: (parentId: string | null) => Promise<void>
  onRestoreToMessage?: (messageId: string) => Promise<void>
  onTranscribeAudio?: (audio: Blob) => Promise<string>
}

interface ChatHeaderProps {
  activeSessionId: null | string
  isRoutedSessionView: boolean
  onDeleteSelectedSession: () => void
  onToggleSelectedPin: () => void
  routedSessionId: null | string
  selectedSessionId: null | string
}

function normalizeLoopStatus(status?: null | string): string {
  return (status || '').trim().toLowerCase().replaceAll('-', '_')
}

function archiveableLoopRows(state: LoopPanelState | null, fallback: LoopRow): LoopRow[] {
  const rows = state?.rows.length ? state.rows : [fallback]
  const seen = new Set<string>()

  return rows.filter(row => {
    if (seen.has(row.taskId) || normalizeLoopStatus(row.status) === 'archived') {
      return false
    }

    seen.add(row.taskId)

    return true
  })
}

function buildLoopTriageDraft(): string {
  return 'Help me triage this Loop spec in Kanban.'
}

function ChatHeader({
  activeSessionId,
  isRoutedSessionView,
  onDeleteSelectedSession,
  onToggleSelectedPin,
  routedSessionId,
  selectedSessionId
}: ChatHeaderProps) {
  const sessions = useStore($sessions)
  const pinnedSessionIds = useStore($pinnedSessionIds)

  const activeStoredSession =
    sessions.find(session => sessionMatchesAnyId(session, [selectedSessionId, routedSessionId, activeSessionId])) || null

  const title = activeStoredSession ? sessionTitle(activeStoredSession) : 'New session'

  // Pins live on the durable lineage-root id, but selectedSessionId is the live
  // (tip) id — resolve through the loaded row so the menu reflects the pin
  // state after auto-compression rotates the id.
  const selectedIsPinned = activeStoredSession
    ? pinnedSessionIds.includes(sessionPinId(activeStoredSession))
    : selectedSessionId
      ? pinnedSessionIds.includes(selectedSessionId)
      : false

  // A brand-new session has no session to pin/delete/rename, so the header is
  // just a dead "New session" label + chevron. Drop it (and its border)
  // entirely until there's a real session to act on.
  if (!selectedSessionId && !activeSessionId && !isRoutedSessionView) {
    return null
  }

  const actionSessionId = selectedSessionId || activeStoredSession?.id || routedSessionId || activeSessionId || ''

  return (
    <header className={cn(titlebarHeaderBaseClass, isRoutedSessionView && titlebarHeaderShadowClass)}>
      <div
        className={titlebarHeaderTitleClass}
        style={{
          maxWidth:
            'calc(100vw - var(--titlebar-content-inset,0px) - var(--titlebar-tools-right) - var(--titlebar-tools-width) - 1.5rem)'
        }}
      >
        <SessionActionsMenu
          align="start"
          onDelete={selectedSessionId ? onDeleteSelectedSession : undefined}
          onPin={selectedSessionId ? onToggleSelectedPin : undefined}
          pinned={selectedIsPinned}
          sessionId={actionSessionId}
          sideOffset={8}
          title={title}
        >
          <Button
            className="pointer-events-auto flex h-6 min-w-0 max-w-full gap-1 overflow-hidden border border-transparent bg-transparent px-2 py-0 text-(--ui-text-secondary) hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground data-[state=open]:border-(--ui-stroke-tertiary) data-[state=open]:bg-(--ui-control-active-background) [-webkit-app-region:no-drag]"
            type="button"
            variant="ghost"
          >
            <h2 className="min-w-0 flex-1 truncate text-[0.75rem] font-medium leading-none">{title}</h2>
            <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="chevron-down" size="0.8125rem" />
          </Button>
        </SessionActionsMenu>
      </div>
    </header>
  )
}

interface ChatRuntimeBoundaryProps {
  busy: boolean
  children: React.ReactNode
  onCancel: () => Promise<void> | void
  onEdit: (message: AppendMessage) => Promise<void>
  onReload: (parentId: string | null) => Promise<void>
  onThreadMessagesChange: (messages: readonly ThreadMessage[]) => void
  /** Route points at an unloaded session — render empty until resume swaps in
   *  the new transcript, so the previous session's messages don't linger. */
  suppressMessages: boolean
}

const NO_MESSAGES: ChatMessage[] = []

/**
 * Owns the $messages subscription and the assistant-ui external-store runtime.
 *
 * Isolated from ChatView so the per-token delta flush (which replaces the
 * $messages atom ~30×/s during streaming) only re-renders this component and
 * the runtime provider. The children (Thread, ChatBar) are created by
 * ChatView, whose render output is stable across flushes — so React bails out
 * of re-rendering them by element identity and the stream's render cost stays
 * confined to the streaming message's own subtree.
 */
function ChatRuntimeBoundary({
  busy,
  children,
  onCancel,
  onEdit,
  onReload,
  onThreadMessagesChange,
  suppressMessages
}: ChatRuntimeBoundaryProps) {
  const storeMessages = useStore($messages)
  const messages = suppressMessages ? NO_MESSAGES : storeMessages
  const runtimeMessageCacheRef = useRef(new WeakMap<ChatMessage, ThreadMessage>())

  const runtimeMessageRepository = useMemo(() => {
    const items: { message: ThreadMessage; parentId: string | null }[] = []
    const branchParentByGroup = new Map<string, string | null>()
    let visibleParentId: string | null = null
    let headId: string | null = null

    for (const message of messages) {
      let parentId = visibleParentId

      if (message.role === 'assistant' && message.branchGroupId) {
        if (!branchParentByGroup.has(message.branchGroupId)) {
          branchParentByGroup.set(message.branchGroupId, visibleParentId)
        }

        parentId = branchParentByGroup.get(message.branchGroupId) ?? null
      }

      const cachedMessage = runtimeMessageCacheRef.current.get(message)
      const runtimeMessage = cachedMessage ?? toRuntimeMessage(message)

      if (!cachedMessage) {
        runtimeMessageCacheRef.current.set(message, runtimeMessage)
      }

      items.push({ message: runtimeMessage, parentId })

      if (!message.hidden) {
        visibleParentId = message.id
        headId = message.id
      }
    }

    return ExportedMessageRepository.fromBranchableArray(items, { headId })
  }, [messages])

  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: runtimeMessageRepository,
    isRunning: busy,
    setMessages: onThreadMessagesChange,
    onNew: async () => {
      // Submission is handled explicitly by ChatBar.
      // Keeping this no-op avoids duplicate prompt.submit calls.
    },
    onEdit,
    onCancel: async () => onCancel(),
    onReload
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

export function ChatView({
  className,
  gateway,
  onToggleSelectedPin,
  onDeleteSelectedSession,
  onCancel,
  onAddContextRef,
  onAddUrl,
  onAttachImageBlob,
  onAttachDroppedItems,
  onBranchInNewChat,
  maxVoiceRecordingSeconds,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSteer,
  onSubmit,
  onThreadMessagesChange,
  onEdit,
  onReload,
  onRestoreToMessage,
  onTranscribeAudio
}: ChatViewProps) {
  const location = useLocation()
  const activeSessionId = useStore($activeSessionId)
  const awaitingResponse = useStore($awaitingResponse)
  const busy = useStore($busy)
  const contextSuggestions = useStore($contextSuggestions)
  const currentCwd = useStore($currentCwd)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const freshDraftReady = useStore($freshDraftReady)
  const gatewayState = useStore($gatewayState)
  const gatewaySwapTarget = useStore($gatewaySwapTarget)
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const queryClient = useQueryClient()
  const gatewayOpen = gatewayState === 'open'
  const introPersonality = useStore($introPersonality)
  const introSeed = useStore($introSeed)
  // PERF: ChatView must not subscribe to $messages — the atom is replaced on
  // every streaming delta flush (~30×/s) and a subscription here re-renders
  // the entire chat shell (header, chat bar, thread wrapper) per token. The
  // runtime that DOES need the messages lives in ChatRuntimeBoundary below;
  // this component only needs streaming-stable derivations.
  const messagesEmpty = useStore($messagesEmpty)
  const lastVisibleIsUser = useStore($lastVisibleMessageIsUser)
  const selectedSessionId = useStore($selectedStoredSessionId)
  const routedSessionId = routeSessionId(location.pathname)
  const isRoutedSessionView = Boolean(routedSessionId)

  // The URL points at a session the store hasn't loaded yet (sidebar / cmd-K /
  // direct nav). Derived in render so the swap reads instantly: the same frame
  // the id changes we drop the old transcript and show the loader, instead of
  // waiting for the resume effect (which paints a frame later) to clear them.
  const routeSessionMismatch = isRoutedSessionView && routedSessionId !== selectedSessionId

  const showIntro = freshDraftReady && !isRoutedSessionView && !selectedSessionId && !activeSessionId && messagesEmpty

  // Session is still loading if the route references a session we haven't
  // resumed yet. Once `activeSessionId` is set (runtime has resumed), the
  // session exists — even if it has zero messages (a brand-new routed
  // session). The flicker where `busy` flips true briefly during hydrate
  // is handled by `threadLoadingState`'s last-visible-user gate.
  const loadingSession = isRoutedSessionView && (routeSessionMismatch || (messagesEmpty && !activeSessionId))
  const threadLoading = threadLoadingState(loadingSession, busy, awaitingResponse, lastVisibleIsUser)
  const showChatBar = !loadingSession
  const threadKey = selectedSessionId || activeSessionId || (isRoutedSessionView ? location.pathname : 'new')

  const modelOptionsQuery = useQuery<ModelOptionsResponse>({
    queryKey: ['model-options', activeSessionId || 'global'],
    queryFn: () => {
      if (!activeSessionId) {
        return getGlobalModelOptions()
      }

      if (!gateway) {
        throw new Error('Hermes gateway unavailable')
      }

      return gateway.request<ModelOptionsResponse>('model.options', { session_id: activeSessionId })
    },
    enabled: gatewayOpen
  })

  const quickModels = useMemo(
    () => quickModelOptions(modelOptionsQuery.data, currentProvider, currentModel),
    [currentModel, currentProvider, modelOptionsQuery.data]
  )

  const chatBarState = useMemo<ChatBarState>(
    () => ({
      model: {
        model: currentModel,
        provider: currentProvider,
        canSwitch: gatewayOpen,
        loading: !gatewayOpen || (!currentModel && !currentProvider),
        quickModels
      },
      tools: {
        enabled: true,
        label: 'Add context',
        suggestions: contextSuggestions
      },
      voice: {
        enabled: true,
        active: false
      }
    }),
    [contextSuggestions, currentModel, currentProvider, gatewayOpen, quickModels]
  )

  const loopSourceSessionId = selectedSessionId || activeSessionId || routedSessionId || ''

  const loopSourceQuery = useQuery<TenantLoopSource>({
    queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId],
    queryFn: () => getLoopSessionSource(loopSourceSessionId, activeGatewayProfile),
    enabled: gatewayOpen && Boolean(loopSourceSessionId),
    refetchInterval: query => loopSessionSourceRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
    staleTime: 2_000
  })

  const tenantLoopPanelState = useMemo(
    () => deriveLoopPanelStateFromTenantSource(loopSourceQuery.data),
    [loopSourceQuery.data]
  )

  useEffect(() => {
    if (!loopSourceSessionId) {
      return
    }

    reconcileKanbanSessionSourceForComposer({
      activeSessionId,
      source: loopSourceQuery.data,
      sourceSessionId: loopSourceSessionId
    })
  }, [activeSessionId, loopSourceQuery.data, loopSourceSessionId])

  const loopPanelState = tenantLoopPanelState
  const [selectedLoopTaskId, setSelectedLoopTaskId] = useState<string | null>(null)
  const [focusedLoopTaskId, setFocusedLoopTaskId] = useState<string | null>(null)
  const [loopPanelOpen, setLoopPanelOpen] = useState(false)
  const [loopPanelHidden, setLoopPanelHidden] = useState(false)

  const loopPanelRootKey = loopPanelState?.rootTaskId || ''

  const selectedLoopTaskDetailQuery = useQuery({
    queryKey: ['loop-task-detail', activeGatewayProfile, focusedLoopTaskId, loopPanelState?.revision || 0],
    queryFn: () => getLoopTaskDetail(focusedLoopTaskId!, activeGatewayProfile),
    enabled: gatewayOpen && loopPanelOpen && Boolean(focusedLoopTaskId) && Boolean(tenantLoopPanelState?.rows.length),
    staleTime: 2_000
  })

  const loopTaskStatusMutation = useMutation({
    mutationFn: ({ status, taskId }: { status: string; taskId: string }) =>
      updateLoopTaskStatus(taskId, status, activeGatewayProfile, {
        blockReason: status === 'blocked' ? 'Blocked from Loop side panel' : undefined
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId] })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskDecomposeMutation = useMutation({
    mutationFn: ({ taskId }: { taskId: string }) => decomposeLoopTask(taskId, activeGatewayProfile),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId] })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskArchiveMutation = useMutation({
    mutationFn: async ({ taskIds }: { taskIds: string[] }) => {
      await Promise.all(taskIds.map(taskId => updateLoopTaskStatus(taskId, 'archived', activeGatewayProfile)))
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId] })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopReviewDecisionMutation = useMutation({
    mutationFn: ({ action, taskId }: { action: Extract<LoopTaskAction, 'accept-review' | 'escalate-review' | 'reject-review'>; taskId: string }) =>
      reviewLoopHandoffForTask(taskId, action, activeGatewayProfile, { board: loopSourceQuery.data?.board }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId] })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    },
    onError: error => {
      console.error('Loop review decision failed', error)
    }
  })

  useEffect(() => {
    setSelectedLoopTaskId(null)
    setFocusedLoopTaskId(null)
    setLoopPanelOpen(false)
    setLoopPanelHidden(false)
  }, [loopPanelRootKey])

  const handleSelectLoopTaskId = useCallback((taskId: string) => {
    setSelectedLoopTaskId(taskId)
    setFocusedLoopTaskId(taskId)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [])

  const handleHideLoopPanel = useCallback(() => {
    setLoopPanelOpen(false)
    setLoopPanelHidden(true)
  }, [])

  const handleLoopTaskAction = useCallback(
    (action: LoopTaskAction, row: LoopRow) => {
      if (action === 'worker-session' && row.workerActivity?.worker_session_id) {
        void openSessionInNewWindow(row.workerActivity.worker_session_id, { watch: true })

        return
      }

      if (action === 'details' || action === 'kanban' || action === 'logs' || action === 'worker-run') {
        handleSelectLoopTaskId(row.taskId)

        return
      }

      if (action === 'ask-hermes') {
        onAddContextRef(`@task:${row.taskId}`, row.title || row.taskId, `Loop task ${row.taskId}`)
        requestComposerInsert(buildLoopTriageDraft(), { mode: 'block', target: 'main' })

        return
      }

      if (action === 'decompose') {
        loopTaskDecomposeMutation.mutate({ taskId: row.taskId })

        return
      }

      if (action === 'archive-loop') {
        const taskIds = archiveableLoopRows(loopPanelState, row).map(task => task.taskId)

        if (taskIds.length) {
          loopTaskArchiveMutation.mutate({ taskIds })
        }

        return
      }

      if (action === 'accept-review' || action === 'escalate-review' || action === 'reject-review') {
        loopReviewDecisionMutation.mutate({ action, taskId: row.taskId })

        return
      }

      const nextStatusByAction: Partial<Record<LoopTaskAction, string>> = {
        archive: 'archived',
        block: 'blocked',
        park: 'scheduled',
        start: 'ready',
        unblock: 'ready'
      }

      const nextStatus = nextStatusByAction[action]

      if (!nextStatus) {
        return
      }

      loopTaskStatusMutation.mutate({ status: nextStatus, taskId: row.taskId })
    },
    [handleSelectLoopTaskId, loopPanelState, loopReviewDecisionMutation, loopTaskArchiveMutation, loopTaskDecomposeMutation, loopTaskStatusMutation, onAddContextRef]
  )

  // Drop files anywhere in the conversation area, not just on the composer
  // input. In-app drags (project tree / gutter) carry workspace-relative paths
  // the gateway resolves directly, so they stay inline `@file:` refs. OS/Finder
  // drops carry absolute local paths that don't exist on a remote gateway (and
  // images need byte upload for vision), so route them through the attachment
  // pipeline — otherwise the local path leaks into the prompt verbatim.
  const onDropFiles = useCallback(
    (candidates: DroppedFile[]) => {
      const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
      const refs = droppedFileInlineRefs(inAppRefs, currentCwd)

      if (refs.length) {
        requestComposerInsert(refs.join(' '), { mode: 'inline', target: 'main' })
      }

      if (osDrops.length) {
        void onAttachDroppedItems(osDrops)
      }
    },
    [currentCwd, onAttachDroppedItems]
  )

  // Dropping a sidebar session inserts an @session link the agent can resolve
  // via session_search (carries the source profile, so cross-profile works).
  const onDropSession = useCallback((session: SessionDragPayload) => {
    requestComposerInsertRefs([sessionInlineRef(session)], { target: 'main' })
  }, [])

  const { dragKind, dropHandlers } = useFileDropZone({ enabled: showChatBar, onDropFiles, onDropSession })

  return (
    <div
      className={cn(
        'relative isolate grid h-full min-w-0 grid-cols-[minmax(0,1fr)_auto] overflow-hidden bg-(--ui-chat-surface-background)',
        className
      )}
    >
      <Backdrop />
      <div className="row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ gridColumn: '1 / 2' }}>
        <ChatHeader
          activeSessionId={activeSessionId}
          isRoutedSessionView={isRoutedSessionView}
          onDeleteSelectedSession={onDeleteSelectedSession}
          onToggleSelectedPin={onToggleSelectedPin}
          routedSessionId={routedSessionId}
          selectedSessionId={selectedSessionId}
        />

        <PromptOverlays />

        <div className="relative flex min-h-0 max-w-full flex-1 overflow-hidden bg-(--ui-chat-surface-background) contain-[layout_paint]">
          <div
            className="relative min-w-0 flex-1 overflow-hidden"
            {...dropHandlers}
          >
            <ChatRuntimeBoundary
              busy={busy}
              onCancel={onCancel}
              onEdit={onEdit}
              onReload={onReload}
              onThreadMessagesChange={onThreadMessagesChange}
              suppressMessages={routeSessionMismatch}
            >
              <Thread
                clampToComposer={showChatBar}
                cwd={currentCwd}
                gateway={gateway}
                intro={showIntro ? { personality: introPersonality, seed: introSeed } : undefined}
                loading={threadLoading}
                onBranchInNewChat={onBranchInNewChat}
                onCancel={onCancel}
                onRestoreToMessage={onRestoreToMessage}
                sessionId={activeSessionId}
                sessionKey={threadKey}
              />
              {showChatBar && (
                <Suspense fallback={<ChatBarFallback />}>
                  <ChatBar
                    busy={busy}
                    cwd={currentCwd}
                    disabled={!gatewayOpen}
                    focusKey={activeSessionId}
                    gateway={gateway}
                    maxRecordingSeconds={maxVoiceRecordingSeconds}
                    onAddContextRef={onAddContextRef}
                    onAddUrl={onAddUrl}
                    onAttachDroppedItems={onAttachDroppedItems}
                    onAttachImageBlob={onAttachImageBlob}
                    onCancel={onCancel}
                    onOpenKanbanTask={handleSelectLoopTaskId}
                    onPasteClipboardImage={onPasteClipboardImage}
                    onPickFiles={onPickFiles}
                    onPickFolders={onPickFolders}
                    onPickImages={onPickImages}
                    onRemoveAttachment={onRemoveAttachment}
                    onSteer={onSteer}
                    onSubmit={onSubmit}
                    onTranscribeAudio={onTranscribeAudio}
                    queueSessionKey={selectedSessionId || activeSessionId}
                    sessionId={activeSessionId}
                    state={chatBarState}
                    statusStackLead={null}
                  />
                </Suspense>
              )}
            </ChatRuntimeBoundary>
            {showChatBar && <ScrollToBottomButton />}
            <ChatDropOverlay kind={dragKind} />
            <ChatSwapOverlay profile={gatewaySwapTarget} />
          </div>
        </div>
      </div>
      <LoopPanel
        artifactSourceBaseDir={currentCwd}
        hidden={loopPanelHidden}
        onFocusTaskId={setFocusedLoopTaskId}
        onHide={handleHideLoopPanel}
        onRefresh={() => void loopSourceQuery.refetch()}
        onSelectTaskId={handleSelectLoopTaskId}
        onTaskAction={handleLoopTaskAction}
        open={loopPanelOpen}
        selectedTaskDetail={selectedLoopTaskDetailQuery.data}
        selectedTaskId={selectedLoopTaskId}
        state={loopPanelState}
      />
    </div>
  )
}
