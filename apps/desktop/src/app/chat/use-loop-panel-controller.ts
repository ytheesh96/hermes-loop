import { useStore } from '@nanostores/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  addLoopTaskComment,
  archiveLoopNodes,
  createLoopDraftTask,
  getKanbanCapabilities,
  getLoopCanvasPositions,
  getLoopSessionSources,
  getLoopTaskDetail,
  linkLoopTasks,
  type LoopCanvasPosition,
  loopSourceFromDraftResult,
  mergeLoopDraftSources,
  saveLoopCanvasPositions,
  unlinkLoopTasks,
  updateLoopTaskStatus
} from '@/hermes'
import { reconcileKanbanSessionSourcesForComposer, selectLoopWorkflowForSession } from '@/store/composer-status'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { openSessionTab } from '@/store/session-states'

import { requestComposerInsertRefs, requestComposerSubmit } from './composer/focus'
import { buildLoopTriageDraft } from './loop-intake'
import { loopPanelStateForWorkflow, type LoopTaskAction, type LoopTaskCreateOptions } from './loop-panel'
import {
  LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS,
  LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS,
  loopSessionSourceRefetchInterval
} from './loop-refresh'
import {
  deriveLoopPanelStateFromTenantSources,
  type LoopPanelState,
  type LoopRow,
  loopTaskAllowsDependencyEdits,
  loopTaskAllowsDependencySource,
  type LoopWorkflowRef,
  loopWorkflowRefKey,
  normalizeLoopBoard,
  type TenantLoopSource
} from './loop-state'

interface LoopPanelControllerOptions {
  activeSessionId: null | string
  ensureLoopSourceSessionId?: () => Promise<null | string>
  gatewayOpen: boolean
  loopSourceSessionId: string
}

const LIVE_LOOP_GRAPH_BACKEND_REQUIRED =
  'Backend update required: this Hermes backend does not support live Loop graph editing.'

function archiveableLoopRows(state: LoopPanelState | null, fallback: LoopRow): LoopRow[] {
  const rows = state?.rows.length ? state.rows : [fallback]
  const seen = new Set<string>()

  return rows.filter(row => {
    if (
      normalizeLoopBoard(row.board) !== normalizeLoopBoard(fallback.board) ||
      (fallback.workflowId && row.workflowId !== fallback.workflowId) ||
      seen.has(row.taskId) ||
      !loopTaskAllowsDependencyEdits(row)
    ) {
      return false
    }

    seen.add(row.taskId)

    return true
  })
}

function loopRelationWorkflowId(state: LoopPanelState | null, ...taskIds: string[]): string {
  const workflowIds = new Set(
    taskIds
      .map(taskId => state?.rows.find(row => row.taskId === taskId)?.workflowId?.trim())
      .filter((workflowId): workflowId is string => Boolean(workflowId))
  )

  if (workflowIds.size === 1) {
    return [...workflowIds][0]!
  }

  return workflowIds.size > 1 ? '' : state?.workflowId || ''
}

function loopDependencyTargetIsEditable(state: LoopPanelState | null, childId: string): boolean {
  const child = state?.rows.find(row => row.taskId === childId)

  return Boolean(child && loopTaskAllowsDependencyEdits(child))
}

function loopDependencySourceIsEditable(state: LoopPanelState | null, parentId: string): boolean {
  const parent = state?.rows.find(row => row.taskId === parentId)

  return Boolean(parent && loopTaskAllowsDependencySource(parent))
}

function loopWorkflowRefForTask(
  state: LoopPanelState | null,
  taskId: string,
  preferred?: null | LoopWorkflowRef
): LoopWorkflowRef | null {
  const rows = state?.rows.filter(row => row.taskId === taskId) || []

  const row = preferred
    ? rows.find(
        candidate =>
          normalizeLoopBoard(candidate.board) === normalizeLoopBoard(preferred.board) &&
          (candidate.workflowId || state?.workflowId) === preferred.workflowId
      ) || rows[0]
    : rows[0]

  const workflowId = row?.workflowId?.trim() || state?.workflowId || ''

  return workflowId ? { board: normalizeLoopBoard(row?.board || preferred?.board || state?.board), workflowId } : null
}

function loopPanelAutoOpenParams(): { enabled: boolean; taskId: null | string } {
  if (typeof window === 'undefined') {
    return { enabled: false, taskId: null }
  }

  try {
    const params = new URLSearchParams(window.location.search)
    const mode = (params.get('loop') || params.get('openLoop') || '').trim().toLowerCase()
    const taskId = (params.get('loopTask') || params.get('loop_task') || '').trim()

    return {
      enabled: mode === '1' || mode === 'true' || mode === 'open',
      taskId: taskId || null
    }
  } catch {
    return { enabled: false, taskId: null }
  }
}

export function useLoopPanelController({
  activeSessionId,
  ensureLoopSourceSessionId,
  gatewayOpen,
  loopSourceSessionId
}: LoopPanelControllerOptions) {
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const queryClient = useQueryClient()

  const loopSourceQuery = useQuery<TenantLoopSource[] | TenantLoopSource>({
    queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId],
    queryFn: () => getLoopSessionSources(loopSourceSessionId, activeGatewayProfile),
    enabled: gatewayOpen && Boolean(loopSourceSessionId),
    refetchInterval: query => {
      const data = query.state.data
      const sources = Array.isArray(data) ? data : data ? [data] : []

      return sources?.some(
        source => loopSessionSourceRefetchInterval(source) === LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS
      )
        ? LOOP_SOURCE_ACTIVE_REFETCH_INTERVAL_MS
        : LOOP_SOURCE_IDLE_REFETCH_INTERVAL_MS
    },
    refetchOnWindowFocus: true,
    staleTime: 2_000
  })

  const loopSources = useMemo(() => {
    const data = loopSourceQuery.data

    return Array.isArray(data) ? data : data ? [data] : []
  }, [loopSourceQuery.data])

  const tenantLoopPanelState = useMemo(() => deriveLoopPanelStateFromTenantSources(loopSources), [loopSources])

  useEffect(() => {
    if (!loopSourceSessionId) {
      return
    }

    reconcileKanbanSessionSourcesForComposer({
      activeSessionId,
      sources: loopSources,
      sourceSessionId: loopSourceSessionId
    })
  }, [activeSessionId, loopSourceSessionId, loopSources])

  const loopPanelState = tenantLoopPanelState
  const loopCanvasScopeKey = loopSourceSessionId || activeSessionId || 'new'
  const workflowPaneScopeKey = `${activeGatewayProfile}:${loopCanvasScopeKey}`
  const [selectedLoopTaskId, setSelectedLoopTaskId] = useState<string | null>(null)
  const [focusedLoopTaskId, setFocusedLoopTaskId] = useState<string | null>(null)

  const [openLoopWorkflows, setOpenLoopWorkflows] = useState<{
    activeKey: null | string
    refs: LoopWorkflowRef[]
    scopeKey: string
  }>(() => ({ activeKey: null, refs: [], scopeKey: workflowPaneScopeKey }))

  const openLoopWorkflowsRef = useRef(openLoopWorkflows)

  const updateOpenLoopWorkflows = useCallback(
    (
      update: (current: { activeKey: null | string; refs: LoopWorkflowRef[]; scopeKey: string }) => {
        activeKey: null | string
        refs: LoopWorkflowRef[]
        scopeKey: string
      }
    ) => {
      const next = update(openLoopWorkflowsRef.current)
      openLoopWorkflowsRef.current = next
      setOpenLoopWorkflows(next)

      return next
    },
    []
  )

  const openLoopWorkflowRefs = useMemo(
    () => (openLoopWorkflows.scopeKey === workflowPaneScopeKey ? openLoopWorkflows.refs : []),
    [openLoopWorkflows, workflowPaneScopeKey]
  )

  const workflowPaneScopeReady = openLoopWorkflows.scopeKey === workflowPaneScopeKey

  const activeLoopWorkflowRef = useMemo(
    () =>
      workflowPaneScopeReady
        ? openLoopWorkflowRefs.find(ref => loopWorkflowRefKey(ref) === openLoopWorkflows.activeKey) || null
        : null,
    [openLoopWorkflowRefs, openLoopWorkflows.activeKey, workflowPaneScopeReady]
  )

  const activeLoopWorkflowKey = activeLoopWorkflowRef ? loopWorkflowRefKey(activeLoopWorkflowRef) : ''

  const [loopCanvasPositionsByWorkflow, setLoopCanvasPositionsByWorkflow] = useState<
    Record<string, LoopCanvasPosition[]>
  >({})

  const [loopFocusRequestKey, setLoopFocusRequestKey] = useState(0)
  const [loopFocusRequestKeysByWorkflow, setLoopFocusRequestKeysByWorkflow] = useState<Record<string, number>>({})
  const [loopPanelOpen, setLoopPanelOpen] = useState(false)
  const [loopPanelHidden, setLoopPanelHidden] = useState(false)
  const autoOpenedLoopPanelRef = useRef<string | null>(null)
  const pendingSelectedLoopTaskIdRef = useRef<string | null>(null)

  const fallbackWorkflowRef = loopPanelState?.workflowRefs?.length === 1 ? loopPanelState.workflowRefs[0]! : null
  const loopPanelWorkflowRef = activeLoopWorkflowRef || fallbackWorkflowRef
  const loopPanelWorkflowKey = loopPanelWorkflowRef?.workflowId || ''
  const loopSourceBoard = loopPanelWorkflowRef?.board

  const activeLoopPanelState = loopPanelWorkflowRef
    ? loopPanelStateForWorkflow(loopPanelState, loopPanelWorkflowRef)
    : loopPanelState

  const loopCanvasPositionsQuery = useQuery({
    queryKey: [
      'loop-canvas-positions',
      activeGatewayProfile,
      loopSourceBoard,
      loopPanelWorkflowKey,
      loopSourceSessionId
    ],
    queryFn: () =>
      getLoopCanvasPositions(loopPanelWorkflowKey, activeGatewayProfile, loopSourceBoard, loopSourceSessionId),
    enabled: gatewayOpen && Boolean(loopPanelWorkflowKey),
    staleTime: 2_000
  })

  useEffect(() => {
    const loadedPositions = loopCanvasPositionsQuery.data?.positions

    if (!activeLoopWorkflowKey || !loadedPositions) {
      return
    }

    setLoopCanvasPositionsByWorkflow(current => ({
      ...current,
      [activeLoopWorkflowKey]: loadedPositions
    }))
  }, [activeLoopWorkflowKey, loopCanvasPositionsQuery.data?.positions])

  const selectedLoopTaskDetailQuery = useQuery({
    queryKey: [
      'loop-task-detail',
      activeGatewayProfile,
      loopSourceBoard,
      focusedLoopTaskId,
      activeLoopPanelState?.revision || 0
    ],
    queryFn: () => getLoopTaskDetail(focusedLoopTaskId!, activeGatewayProfile, loopSourceBoard),
    enabled: gatewayOpen && loopPanelOpen && Boolean(focusedLoopTaskId) && Boolean(activeLoopPanelState?.rows.length),
    refetchInterval: query =>
      loopSessionSourceRefetchInterval({
        session_id: loopSourceSessionId,
        tasks: query.state.data?.task ? [query.state.data.task] : []
      }),
    staleTime: 2_000
  })

  const selectedLoopTaskDetailError = selectedLoopTaskDetailQuery.error
    ? selectedLoopTaskDetailQuery.error instanceof Error
      ? selectedLoopTaskDetailQuery.error.message
      : String(selectedLoopTaskDetailQuery.error)
    : null

  const loopTaskCommentMutation = useMutation({
    mutationFn: ({ board, body, taskId }: { board: string; body: string; taskId: string }) =>
      addLoopTaskComment(taskId, body, activeGatewayProfile, 'desktop', board),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskStatusMutation = useMutation({
    mutationFn: ({ board, status, taskId }: { board: string; status: string; taskId: string }) =>
      updateLoopTaskStatus(taskId, status, activeGatewayProfile, {
        blockReason: status === 'blocked' ? 'Blocked from Loop side panel' : undefined,
        board
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskArchiveMutation = useMutation({
    mutationFn: ({ board, taskIds, workflowId }: { board: string; taskIds: string[]; workflowId: string }) =>
      archiveLoopNodes(workflowId, taskIds, activeGatewayProfile, board, loopSourceSessionId),
    onError: error => notifyError(error, 'Archive Loop task failed'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const requestLoopFocus = useCallback((workflow?: null | LoopWorkflowRef) => {
    setLoopFocusRequestKey(key => key + 1)

    if (workflow) {
      const workflowKey = loopWorkflowRefKey(workflow)
      setLoopFocusRequestKeysByWorkflow(keys => ({
        ...keys,
        [workflowKey]: (keys[workflowKey] || 0) + 1
      }))
    }
  }, [])

  const rememberLoopWorkflow = useCallback(
    (workflow: LoopWorkflowRef) => {
      const ref = { board: normalizeLoopBoard(workflow.board), workflowId: workflow.workflowId.trim() }

      if (!ref.workflowId) {
        return
      }

      const workflowKey = loopWorkflowRefKey(ref)

      updateOpenLoopWorkflows(current => {
        const workflowRefs = current.scopeKey === workflowPaneScopeKey ? current.refs : []

        return {
          activeKey: workflowKey,
          refs: workflowRefs.some(candidate => loopWorkflowRefKey(candidate) === workflowKey)
            ? workflowRefs
            : [...workflowRefs, ref],
          scopeKey: workflowPaneScopeKey
        }
      })

      if (activeSessionId) {
        selectLoopWorkflowForSession(activeSessionId, ref)
      }
    },
    [activeSessionId, updateOpenLoopWorkflows, workflowPaneScopeKey]
  )

  const handleSelectLoopWorkflowId = useCallback(
    (workflow: LoopWorkflowRef) => {
      const ref = { board: normalizeLoopBoard(workflow.board), workflowId: workflow.workflowId.trim() }

      if (!ref.workflowId) {
        return
      }

      pendingSelectedLoopTaskIdRef.current = null
      rememberLoopWorkflow(ref)
      setSelectedLoopTaskId(null)
      setFocusedLoopTaskId(null)
      requestLoopFocus(ref)
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [rememberLoopWorkflow, requestLoopFocus]
  )

  const handleActivateLoopWorkflowId = useCallback(
    (workflow: LoopWorkflowRef) => {
      if (openLoopWorkflowRefs.some(candidate => loopWorkflowRefKey(candidate) === loopWorkflowRefKey(workflow))) {
        rememberLoopWorkflow(workflow)
      }
    },
    [openLoopWorkflowRefs, rememberLoopWorkflow]
  )

  const handleFocusLoopTaskId = useCallback(
    (taskId: null | string, preferredWorkflow?: LoopWorkflowRef) => {
      if (taskId) {
        const workflow = loopWorkflowRefForTask(loopPanelState, taskId, preferredWorkflow || activeLoopWorkflowRef)

        if (workflow) {
          rememberLoopWorkflow(workflow)
        }
      }

      setFocusedLoopTaskId(taskId)
    },
    [activeLoopWorkflowRef, loopPanelState, rememberLoopWorkflow]
  )

  // A bare /loop can open before its source query resolves. Keep the
  // closeable "New workflow" native pane during that gap, then promote it to
  // the source's first real workflow once hydration makes one available.
  useEffect(() => {
    if (
      !loopPanelOpen ||
      loopPanelHidden ||
      openLoopWorkflowRefs.length > 0 ||
      selectedLoopTaskId ||
      focusedLoopTaskId ||
      pendingSelectedLoopTaskIdRef.current
    ) {
      return
    }

    const workflow =
      loopPanelState?.workflowRefs?.[0] ||
      (loopPanelState?.rows[0] ? loopWorkflowRefForTask(loopPanelState, loopPanelState.rows[0].taskId) : null)

    if (workflow) {
      handleSelectLoopWorkflowId(workflow)
    }
  }, [
    focusedLoopTaskId,
    handleSelectLoopWorkflowId,
    loopPanelHidden,
    loopPanelOpen,
    loopPanelState,
    openLoopWorkflowRefs.length,
    selectedLoopTaskId
  ])

  useEffect(() => {
    setSelectedLoopTaskId(null)
    setFocusedLoopTaskId(null)
    updateOpenLoopWorkflows(() => ({ activeKey: null, refs: [], scopeKey: workflowPaneScopeKey }))
    setLoopCanvasPositionsByWorkflow({})
    setLoopFocusRequestKeysByWorkflow({})
    setLoopPanelOpen(false)
    setLoopPanelHidden(false)
    pendingSelectedLoopTaskIdRef.current = null
  }, [updateOpenLoopWorkflows, workflowPaneScopeKey])

  useEffect(() => {
    const taskId = pendingSelectedLoopTaskIdRef.current

    if (!taskId || !loopPanelState?.rows.some(row => row.taskId === taskId)) {
      return
    }

    pendingSelectedLoopTaskIdRef.current = null
    const workflow = loopWorkflowRefForTask(loopPanelState, taskId)

    if (workflow) {
      rememberLoopWorkflow(workflow)
    }

    setSelectedLoopTaskId(taskId)
    setFocusedLoopTaskId(taskId)
    requestLoopFocus(workflow)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [loopPanelState, rememberLoopWorkflow, requestLoopFocus])

  useEffect(() => {
    const autoOpen = loopPanelAutoOpenParams()

    if (!autoOpen.enabled || !loopPanelState?.rows.length) {
      return
    }

    if (autoOpen.taskId && !loopPanelState.rows.some(row => row.taskId === autoOpen.taskId)) {
      return
    }

    const targetWorkflow =
      (autoOpen.taskId ? loopWorkflowRefForTask(loopPanelState, autoOpen.taskId) : null) ||
      loopPanelState.workflowRefs?.[0] ||
      loopWorkflowRefForTask(loopPanelState, loopPanelState.rows[0]!.taskId)

    const targetTaskId = autoOpen.taskId
    const autoOpenKey = `${activeGatewayProfile}:${loopCanvasScopeKey}:${targetWorkflow ? loopWorkflowRefKey(targetWorkflow) : targetTaskId || 'canvas'}`

    if (autoOpenedLoopPanelRef.current === autoOpenKey) {
      return
    }

    autoOpenedLoopPanelRef.current = autoOpenKey

    if (targetWorkflow) {
      rememberLoopWorkflow(targetWorkflow)
    }

    setSelectedLoopTaskId(targetTaskId)
    setFocusedLoopTaskId(targetTaskId)
    requestLoopFocus(targetWorkflow)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [activeGatewayProfile, loopCanvasScopeKey, loopPanelState, rememberLoopWorkflow, requestLoopFocus])

  const handleSelectLoopTaskId = useCallback(
    (taskId: string, preferredWorkflow?: LoopWorkflowRef) => {
      const workflow = loopWorkflowRefForTask(loopPanelState, taskId, preferredWorkflow || activeLoopWorkflowRef)

      if (workflow) {
        rememberLoopWorkflow(workflow)
      }

      pendingSelectedLoopTaskIdRef.current = loopPanelState?.rows.some(
        row =>
          row.taskId === taskId && (!workflow || normalizeLoopBoard(row.board) === normalizeLoopBoard(workflow.board))
      )
        ? null
        : taskId
      setSelectedLoopTaskId(taskId)
      setFocusedLoopTaskId(taskId)
      requestLoopFocus(workflow)
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [activeLoopWorkflowRef, loopPanelState, rememberLoopWorkflow, requestLoopFocus]
  )

  const handleOpenLoopPanel = useCallback(
    (taskId?: string, preferredWorkflow?: LoopWorkflowRef) => {
      if (taskId) {
        handleSelectLoopTaskId(taskId, preferredWorkflow)

        return
      }

      const workflow =
        preferredWorkflow ||
        activeLoopWorkflowRef ||
        loopPanelState?.workflowRefs?.[0] ||
        (loopPanelState?.rows[0] ? loopWorkflowRefForTask(loopPanelState, loopPanelState.rows[0].taskId) : null)

      if (workflow) {
        handleSelectLoopWorkflowId(workflow)

        return
      }

      pendingSelectedLoopTaskIdRef.current = null
      setSelectedLoopTaskId(null)
      setFocusedLoopTaskId(null)
      requestLoopFocus()
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [activeLoopWorkflowRef, handleSelectLoopTaskId, handleSelectLoopWorkflowId, loopPanelState, requestLoopFocus]
  )

  const handleCloseLoopWorkflowId = useCallback(
    (workflow: LoopWorkflowRef) => {
      const current = openLoopWorkflowsRef.current
      const currentWorkflowRefs = current.scopeKey === workflowPaneScopeKey ? current.refs : []
      const workflowKey = loopWorkflowRefKey(workflow)
      const currentActiveWorkflowKey = current.scopeKey === workflowPaneScopeKey ? current.activeKey : null
      const closingIndex = currentWorkflowRefs.findIndex(candidate => loopWorkflowRefKey(candidate) === workflowKey)

      if (closingIndex < 0) {
        return null
      }

      const remainingWorkflowRefs = currentWorkflowRefs.filter(
        candidate => loopWorkflowRefKey(candidate) !== workflowKey
      )

      const nextWorkflowRef = remainingWorkflowRefs[closingIndex - 1] || remainingWorkflowRefs[closingIndex]
      const nextWorkflowKey = nextWorkflowRef ? loopWorkflowRefKey(nextWorkflowRef) : null

      const nextActiveWorkflowKey =
        currentActiveWorkflowKey === workflowKey
          ? nextWorkflowKey
          : currentActiveWorkflowKey &&
              remainingWorkflowRefs.some(candidate => loopWorkflowRefKey(candidate) === currentActiveWorkflowKey)
            ? currentActiveWorkflowKey
            : nextWorkflowKey || (remainingWorkflowRefs[0] ? loopWorkflowRefKey(remainingWorkflowRefs[0]) : null)

      updateOpenLoopWorkflows(() => ({
        activeKey: nextActiveWorkflowKey,
        refs: remainingWorkflowRefs,
        scopeKey: workflowPaneScopeKey
      }))

      if (remainingWorkflowRefs.length === 0) {
        setSelectedLoopTaskId(null)
        setFocusedLoopTaskId(null)
        requestLoopFocus()
        setLoopPanelOpen(false)
        setLoopPanelHidden(true)

        return { closedLast: true, nextWorkflowId: null, nextWorkflowRef: null }
      }

      if (currentActiveWorkflowKey === workflowKey && nextWorkflowRef) {
        if (activeSessionId) {
          selectLoopWorkflowForSession(activeSessionId, nextWorkflowRef)
        }
      }

      return {
        closedLast: false,
        nextWorkflowId: nextWorkflowRef?.workflowId || null,
        nextWorkflowRef: nextWorkflowRef || null
      }
    },
    [activeSessionId, requestLoopFocus, updateOpenLoopWorkflows, workflowPaneScopeKey]
  )

  const handleHideLoopPanel = useCallback(() => {
    setLoopPanelOpen(false)
    setLoopPanelHidden(true)
  }, [])

  const handleCreateLoopTask = useCallback(
    async (idea: string, options: LoopTaskCreateOptions = {}): Promise<null | string> => {
      const title = idea.trim()
      const sourceSessionId = loopSourceSessionId || (await ensureLoopSourceSessionId?.())?.trim()
      const targetWorkflowRef = options.workflowRef || loopPanelWorkflowRef || undefined
      const targetWorkflowId = options.workflowId || targetWorkflowRef?.workflowId || undefined
      const targetBoard = normalizeLoopBoard(targetWorkflowRef?.board || loopSourceBoard)
      const creatingWorkflow = !targetWorkflowId

      if (!title || !sourceSessionId) {
        return null
      }

      try {
        if (!creatingWorkflow) {
          let liveLoopGraph = false

          try {
            const capabilities = await queryClient.fetchQuery({
              queryFn: () => getKanbanCapabilities(activeGatewayProfile),
              queryKey: ['kanban-capabilities', activeGatewayProfile],
              staleTime: Infinity
            })

            liveLoopGraph = capabilities.live_loop_graph === true
          } catch {
            // Older managed backends do not expose this route. Do not let them
            // silently create an orphan when they ignore graph metadata.
          }

          if (!liveLoopGraph) {
            throw new Error(LIVE_LOOP_GRAPH_BACKEND_REQUIRED)
          }
        }

        const result = await createLoopDraftTask({
          assignee: creatingWorkflow ? null : undefined,
          board: targetBoard,
          childIds: options.childId ? [options.childId] : undefined,
          idempotencyKey: `loop-draft:${sourceSessionId}:${crypto.randomUUID()}`,
          parents: options.parentId ? [options.parentId] : undefined,
          profile: activeGatewayProfile,
          sessionId: sourceSessionId,
          title,
          workflowId: targetWorkflowId
        })

        const source = loopSourceFromDraftResult(sourceSessionId, result)

        if (source && creatingWorkflow) {
          const queryKey = ['loop-session-source', activeGatewayProfile, sourceSessionId]
          const cached = queryClient.getQueryData<TenantLoopSource[] | TenantLoopSource>(queryKey)
          const reconciledSources = mergeLoopDraftSources(cached, source)

          queryClient.setQueryData(queryKey, reconciledSources)
          reconcileKanbanSessionSourcesForComposer({
            activeSessionId,
            sources: reconciledSources,
            sourceSessionId
          })
        }

        void queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, sourceSessionId]
        })

        const taskId = result.task?.id

        if (creatingWorkflow) {
          handleOpenLoopPanel(taskId, {
            board: normalizeLoopBoard(result.source?.board || result.board || targetBoard),
            workflowId: result.task?.workflow_id || result.workflow_id || taskId || ''
          })
        }

        if (creatingWorkflow && taskId) {
          const createdBoard = result.source?.board || result.board || loopSourceBoard

          requestComposerSubmit(buildLoopTriageDraft({ taskId, title: result.task?.title || title }, createdBoard), {
            target: 'main'
          })
        }

        notify({ kind: 'success', message: `Task added · ${result.task?.title || title}` })

        return taskId || null
      } catch (error) {
        notifyError(error, 'Create Loop task failed')

        return null
      }
    },
    [
      activeGatewayProfile,
      activeSessionId,
      ensureLoopSourceSessionId,
      handleOpenLoopPanel,
      loopPanelWorkflowRef,
      loopSourceBoard,
      loopSourceSessionId,
      queryClient
    ]
  )

  const handleAddLoopTaskComment = useCallback(
    async (taskId: string, body: string, preferredWorkflow?: LoopWorkflowRef) => {
      await loopTaskCommentMutation.mutateAsync({
        board: normalizeLoopBoard(preferredWorkflow?.board || loopSourceBoard),
        body,
        taskId
      })
    },
    [loopSourceBoard, loopTaskCommentMutation]
  )

  const handleSaveLoopCanvasPositions = useCallback(
    async (positions: LoopCanvasPosition[], workflow?: LoopWorkflowRef): Promise<boolean> => {
      const targetWorkflowRef = workflow || loopPanelWorkflowRef
      const targetWorkflowId = targetWorkflowRef?.workflowId.trim() || ''
      const targetBoard = normalizeLoopBoard(targetWorkflowRef?.board)

      if (!targetWorkflowId) {
        return false
      }

      try {
        const saved = await saveLoopCanvasPositions(
          targetWorkflowId,
          positions,
          activeGatewayProfile,
          targetBoard,
          loopSourceSessionId
        )

        queryClient.setQueryData(
          ['loop-canvas-positions', activeGatewayProfile, targetBoard, targetWorkflowId, loopSourceSessionId],
          saved
        )
        setLoopCanvasPositionsByWorkflow(current => ({
          ...current,
          [loopWorkflowRefKey({ board: targetBoard, workflowId: targetWorkflowId })]: saved.positions
        }))

        return true
      } catch (error) {
        notifyError(error, 'Save Loop layout failed')

        return false
      }
    },
    [activeGatewayProfile, loopPanelWorkflowRef, loopSourceSessionId, queryClient]
  )

  const handleLinkLoopTasks = useCallback(
    async (parentId: string, childId: string, preferredWorkflow?: LoopWorkflowRef): Promise<boolean> => {
      const targetWorkflow = preferredWorkflow || loopPanelWorkflowRef

      const targetState = targetWorkflow
        ? loopPanelStateForWorkflow(loopPanelState, targetWorkflow)
        : activeLoopPanelState

      if (!loopDependencySourceIsEditable(targetState, parentId)) {
        notify({ kind: 'warning', message: 'This task is immutable while its generated work is active.' })

        return false
      }

      if (!loopDependencyTargetIsEditable(targetState, childId)) {
        notify({ kind: 'warning', message: 'Dependencies can only be changed while the child task is pending.' })

        return false
      }

      try {
        const workflowId = loopRelationWorkflowId(targetState, parentId, childId)

        if (!workflowId) {
          throw new Error('Select tasks from one workflow before editing dependencies.')
        }

        await linkLoopTasks(
          parentId,
          childId,
          activeGatewayProfile,
          normalizeLoopBoard(targetWorkflow?.board || loopSourceBoard),
          workflowId,
          loopSourceSessionId
        )
        await queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
        })

        return true
      } catch (error) {
        notifyError(error, 'Connect Loop tasks failed')

        return false
      }
    },
    [
      activeGatewayProfile,
      activeLoopPanelState,
      loopPanelState,
      loopPanelWorkflowRef,
      loopSourceBoard,
      loopSourceSessionId,
      queryClient
    ]
  )

  const handleUnlinkLoopTasks = useCallback(
    async (parentId: string, childId: string, preferredWorkflow?: LoopWorkflowRef): Promise<boolean> => {
      const targetWorkflow = preferredWorkflow || loopPanelWorkflowRef

      const targetState = targetWorkflow
        ? loopPanelStateForWorkflow(loopPanelState, targetWorkflow)
        : activeLoopPanelState

      if (!loopDependencySourceIsEditable(targetState, parentId)) {
        notify({ kind: 'warning', message: 'This task is immutable while its generated work is active.' })

        return false
      }

      if (!loopDependencyTargetIsEditable(targetState, childId)) {
        notify({ kind: 'warning', message: 'Dependencies can only be changed while the child task is pending.' })

        return false
      }

      try {
        const workflowId = loopRelationWorkflowId(targetState, parentId, childId)

        if (!workflowId) {
          throw new Error('Select tasks from one workflow before editing dependencies.')
        }

        const result = await unlinkLoopTasks(
          parentId,
          childId,
          activeGatewayProfile,
          normalizeLoopBoard(targetWorkflow?.board || loopSourceBoard),
          workflowId,
          loopSourceSessionId
        )

        await queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
        })

        return result.ok
      } catch (error) {
        notifyError(error, 'Delete Loop dependency failed')

        return false
      }
    },
    [
      activeGatewayProfile,
      activeLoopPanelState,
      loopPanelState,
      loopPanelWorkflowRef,
      loopSourceBoard,
      loopSourceSessionId,
      queryClient
    ]
  )

  const handleLoopTaskAction = useCallback(
    (action: LoopTaskAction, row: LoopRow) => {
      const workerSessionId = row.workerActivity?.worker_session_id || row.latestRun?.worker_session_id
      const workerProfile = row.workerActivity?.profile || row.latestRun?.profile || row.assignee || undefined

      if (action === 'worker-session' && workerSessionId) {
        openSessionTab(
          workerSessionId,
          workerProfile
            ? { profile: workerProfile, runningHint: row.active, watch: true }
            : { runningHint: row.active, watch: true }
        )

        return
      }

      if (action === 'details' || action === 'kanban' || action === 'logs' || action === 'worker-run') {
        handleSelectLoopTaskId(row.taskId, {
          board: normalizeLoopBoard(row.board),
          workflowId: row.workflowId?.trim() || loopPanelWorkflowKey
        })

        return
      }

      if (action === 'ask-hermes') {
        requestComposerInsertRefs([{ kind: 'task', label: row.title || row.taskId, value: row.taskId }], {
          target: 'main'
        })

        return
      }

      if (action === 'archive-loop') {
        const rowWorkflowRef = {
          board: normalizeLoopBoard(row.board),
          workflowId: row.workflowId?.trim() || loopPanelWorkflowKey
        }

        const rowState = loopPanelStateForWorkflow(loopPanelState, rowWorkflowRef)
        const taskIds = archiveableLoopRows(rowState, row).map(task => task.taskId)
        const workflowId = rowWorkflowRef.workflowId

        if (taskIds.length && workflowId) {
          loopTaskArchiveMutation.mutate({ board: rowWorkflowRef.board, taskIds, workflowId })
        }

        return
      }

      if (action === 'archive' && !loopTaskAllowsDependencyEdits(row)) {
        notify({ kind: 'warning', message: 'Only pending tasks can be archived from the Loop graph.' })

        return
      }

      if (action === 'archive') {
        const workflowId = row.workflowId?.trim() || loopPanelWorkflowKey

        if (workflowId) {
          loopTaskArchiveMutation.mutate({
            board: normalizeLoopBoard(row.board),
            taskIds: [row.taskId],
            workflowId
          })
        }

        return
      }

      const nextStatusByAction: Partial<Record<LoopTaskAction, string>> = {
        block: 'blocked',
        park: 'scheduled',
        start: 'ready',
        unblock: 'ready'
      }

      const nextStatus = nextStatusByAction[action]

      if (!nextStatus) {
        return
      }

      loopTaskStatusMutation.mutate({
        board: normalizeLoopBoard(row.board),
        status: nextStatus,
        taskId: row.taskId
      })
    },
    [handleSelectLoopTaskId, loopPanelState, loopPanelWorkflowKey, loopTaskArchiveMutation, loopTaskStatusMutation]
  )

  return {
    activeWorkflowRef: activeLoopWorkflowRef,
    canvasScopeKey: loopCanvasScopeKey,
    focusedTaskId: workflowPaneScopeReady ? focusedLoopTaskId : null,
    focusRequestKey: workflowPaneScopeReady ? loopFocusRequestKey : 0,
    focusRequestKeysByWorkflow: workflowPaneScopeReady ? loopFocusRequestKeysByWorkflow : {},
    hidden: workflowPaneScopeReady ? loopPanelHidden : true,
    onAddTaskComment: handleAddLoopTaskComment,
    onActivateWorkflowId: handleActivateLoopWorkflowId,
    onCreateTask: handleCreateLoopTask,
    onCloseWorkflowId: handleCloseLoopWorkflowId,
    onFocusTaskId: handleFocusLoopTaskId,
    onHide: handleHideLoopPanel,
    onLinkTasks: handleLinkLoopTasks,
    onOpen: handleOpenLoopPanel,
    onSavePositions: handleSaveLoopCanvasPositions,
    onSelectTaskId: handleSelectLoopTaskId,
    onSelectWorkflowId: handleSelectLoopWorkflowId,
    onTaskAction: handleLoopTaskAction,
    onUnlinkTasks: handleUnlinkLoopTasks,
    open: workflowPaneScopeReady && loopPanelOpen,
    positions: loopCanvasPositionsQuery.data?.positions,
    positionsByWorkflow: loopCanvasPositionsByWorkflow,
    workflowKey: activeLoopWorkflowKey,
    workflowRef: loopPanelWorkflowRef,
    workflowId: loopPanelWorkflowKey || undefined,
    workflowRefs: openLoopWorkflowRefs,
    workflowPaneScopeKey,
    selectedTaskDetail: workflowPaneScopeReady ? selectedLoopTaskDetailQuery.data : undefined,
    selectedTaskDetailError: workflowPaneScopeReady ? selectedLoopTaskDetailError : null,
    selectedTaskId: workflowPaneScopeReady ? selectedLoopTaskId : null,
    state: loopPanelState,
    tabKey: selectedLoopTaskId || focusedLoopTaskId || ''
  }
}

export type LoopPanelController = ReturnType<typeof useLoopPanelController>
