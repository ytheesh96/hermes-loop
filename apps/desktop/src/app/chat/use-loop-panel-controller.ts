import { useStore } from '@nanostores/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  addLoopTaskComment,
  createLoopDraftTask,
  decomposeLoopTask,
  getLoopCanvasPositions,
  getLoopSessionSource,
  getLoopTaskDetail,
  linkLoopTasks,
  type LoopCanvasPosition,
  loopSourceFromDraftResult,
  mergeLoopDraftSource,
  reviewLoopHandoffForTask,
  saveLoopCanvasPositions,
  unlinkLoopTasks,
  updateLoopTaskStatus
} from '@/hermes'
import { reconcileKanbanSessionSourceForComposer } from '@/store/composer-status'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { openSessionInNewWindow } from '@/store/windows'

import { requestComposerInsert } from './composer/focus'
import { buildLoopChatDraft } from './loop-intake'
import type { LoopTaskAction } from './loop-panel'
import { loopSessionSourceRefetchInterval } from './loop-refresh'
import {
  deriveLoopPanelStateFromTenantSource,
  type LoopPanelState,
  type LoopRow,
  type TenantLoopSource
} from './loop-state'

interface LoopPanelControllerOptions {
  activeSessionId: null | string
  ensureLoopSourceSessionId?: () => Promise<null | string>
  gatewayOpen: boolean
  loopSourceSessionId: string
  onAddContextRef: (refText: string, label?: string, detail?: string) => void
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

function shouldApproveLoopIntakeOnSubmit(row: LoopRow): boolean {
  const intake = row.loopIntake

  if (!intake || intake.needed !== true || intake.dispatchable === true) {
    return false
  }

  return true
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
  loopSourceSessionId,
  onAddContextRef
}: LoopPanelControllerOptions) {
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const queryClient = useQueryClient()

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
  const [loopFocusRequestKey, setLoopFocusRequestKey] = useState(0)
  const [loopPanelOpen, setLoopPanelOpen] = useState(false)
  const [loopPanelHidden, setLoopPanelHidden] = useState(false)
  const autoOpenedLoopPanelRef = useRef<string | null>(null)
  const pendingSelectedLoopTaskIdRef = useRef<string | null>(null)

  const loopPanelRootKey = loopPanelState?.rootTaskId || ''
  const loopCanvasScopeKey = loopSourceSessionId || activeSessionId || 'new'
  const loopSourceBoard = loopSourceQuery.data?.board || undefined

  const loopCanvasPositionsQuery = useQuery({
    queryKey: ['loop-canvas-positions', activeGatewayProfile, loopSourceBoard, loopPanelRootKey, loopSourceSessionId],
    queryFn: () => getLoopCanvasPositions(loopPanelRootKey, activeGatewayProfile, loopSourceBoard, loopSourceSessionId),
    enabled: gatewayOpen && Boolean(loopPanelRootKey),
    staleTime: 2_000
  })

  const selectedLoopTaskDetailQuery = useQuery({
    queryKey: [
      'loop-task-detail',
      activeGatewayProfile,
      loopSourceBoard,
      focusedLoopTaskId,
      loopPanelState?.revision || 0
    ],
    queryFn: () => getLoopTaskDetail(focusedLoopTaskId!, activeGatewayProfile, loopSourceBoard),
    enabled: gatewayOpen && loopPanelOpen && Boolean(focusedLoopTaskId) && Boolean(tenantLoopPanelState?.rows.length),
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
    mutationFn: ({ body, taskId }: { body: string; taskId: string }) =>
      addLoopTaskComment(taskId, body, activeGatewayProfile, 'desktop', loopSourceBoard),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskStatusMutation = useMutation({
    mutationFn: ({ status, taskId }: { status: string; taskId: string }) =>
      updateLoopTaskStatus(taskId, status, activeGatewayProfile, {
        blockReason: status === 'blocked' ? 'Blocked from Loop side panel' : undefined,
        board: loopSourceBoard
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopTaskDecomposeMutation = useMutation({
    mutationFn: ({ approveIntake, taskId }: { approveIntake?: boolean; taskId: string }) =>
      decomposeLoopTask(taskId, activeGatewayProfile, { approveIntake, board: loopSourceBoard }),
    onSuccess: async result => {
      if (!result.ok) {
        notify({
          kind: 'warning',
          title: 'Loop submit blocked',
          message: result.reason || `Could not submit ${result.task_id || 'Loop task'}`
        })
      }

      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    },
    onError: error => {
      notifyError(error, 'Loop submit failed')
    }
  })

  const loopTaskArchiveMutation = useMutation({
    mutationFn: async ({ taskIds }: { taskIds: string[] }) => {
      await Promise.all(
        taskIds.map(taskId =>
          updateLoopTaskStatus(taskId, 'archived', activeGatewayProfile, { board: loopSourceBoard })
        )
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
    }
  })

  const loopReviewDecisionMutation = useMutation({
    mutationFn: ({
      action,
      taskId
    }: {
      action: Extract<LoopTaskAction, 'accept-review' | 'escalate-review' | 'reject-review'>
      taskId: string
    }) => reviewLoopHandoffForTask(taskId, action, activeGatewayProfile, { board: loopSourceQuery.data?.board }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
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
  }, [loopSourceSessionId])

  useEffect(() => {
    const taskId = pendingSelectedLoopTaskIdRef.current

    if (!taskId || !loopPanelState?.rows.some(row => row.taskId === taskId)) {
      return
    }

    pendingSelectedLoopTaskIdRef.current = null
    setSelectedLoopTaskId(taskId)
    setFocusedLoopTaskId(taskId)
    setLoopFocusRequestKey(key => key + 1)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [loopPanelState])

  useEffect(() => {
    const autoOpen = loopPanelAutoOpenParams()

    if (!autoOpen.enabled || !loopPanelState?.rows.length) {
      return
    }

    if (autoOpen.taskId && !loopPanelState.rows.some(row => row.taskId === autoOpen.taskId)) {
      return
    }

    const targetTaskId = autoOpen.taskId
    const autoOpenKey = `${loopCanvasScopeKey}:${targetTaskId || 'canvas'}`

    if (autoOpenedLoopPanelRef.current === autoOpenKey) {
      return
    }

    autoOpenedLoopPanelRef.current = autoOpenKey

    setSelectedLoopTaskId(targetTaskId)
    setFocusedLoopTaskId(targetTaskId)
    setLoopFocusRequestKey(key => key + 1)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [loopCanvasScopeKey, loopPanelState])

  const handleSelectLoopTaskId = useCallback(
    (taskId: string) => {
      pendingSelectedLoopTaskIdRef.current = loopPanelState?.rows.some(row => row.taskId === taskId) ? null : taskId
      setSelectedLoopTaskId(taskId)
      setFocusedLoopTaskId(taskId)
      setLoopFocusRequestKey(key => key + 1)
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [loopPanelState]
  )

  const handleOpenLoopPanel = useCallback(
    (taskId?: string) => {
      if (taskId) {
        handleSelectLoopTaskId(taskId)

        return
      }

      pendingSelectedLoopTaskIdRef.current = null
      setSelectedLoopTaskId(null)
      setFocusedLoopTaskId(null)
      setLoopFocusRequestKey(key => key + 1)
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [handleSelectLoopTaskId]
  )

  const handleHideLoopPanel = useCallback(() => {
    setLoopPanelOpen(false)
    setLoopPanelHidden(true)
  }, [])

  const handleCreateLoopTask = useCallback(
    async (idea: string, assignee: string): Promise<null | string> => {
      const title = idea.trim()
      const sourceSessionId = loopSourceSessionId || (await ensureLoopSourceSessionId?.())?.trim()

      if (!title || !sourceSessionId) {
        return null
      }

      try {
        const result = await createLoopDraftTask({
          assignee,
          board: loopSourceBoard,
          idempotencyKey: `loop-draft:${sourceSessionId}:${crypto.randomUUID()}`,
          profile: activeGatewayProfile,
          sessionId: sourceSessionId,
          title
        })

        const source = loopSourceFromDraftResult(sourceSessionId, result)

        if (source && !loopPanelRootKey) {
          const queryKey = ['loop-session-source', activeGatewayProfile, sourceSessionId]

          const reconciledSource = mergeLoopDraftSource(queryClient.getQueryData<TenantLoopSource>(queryKey), source)

          queryClient.setQueryData(queryKey, reconciledSource)
          reconcileKanbanSessionSourceForComposer({ activeSessionId, source: reconciledSource, sourceSessionId })
        }

        void queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, sourceSessionId]
        })

        const taskId = result.task?.id

        if (!loopPanelRootKey) {
          handleOpenLoopPanel(taskId)
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
      loopPanelRootKey,
      loopSourceBoard,
      loopSourceSessionId,
      queryClient
    ]
  )

  const handleAddLoopTaskComment = useCallback(
    async (taskId: string, body: string) => {
      await loopTaskCommentMutation.mutateAsync({ body, taskId })
    },
    [loopTaskCommentMutation]
  )

  const handleSaveLoopCanvasPositions = useCallback(
    async (positions: LoopCanvasPosition[], rootTaskId?: string): Promise<boolean> => {
      const targetRootTaskId = rootTaskId?.trim() || loopPanelRootKey

      if (!targetRootTaskId) {
        return false
      }

      try {
        const saved = await saveLoopCanvasPositions(
          targetRootTaskId,
          positions,
          activeGatewayProfile,
          loopSourceBoard,
          loopSourceSessionId
        )

        queryClient.setQueryData(
          ['loop-canvas-positions', activeGatewayProfile, loopSourceBoard, targetRootTaskId, loopSourceSessionId],
          saved
        )

        return true
      } catch (error) {
        notifyError(error, 'Save Loop layout failed')

        return false
      }
    },
    [activeGatewayProfile, loopPanelRootKey, loopSourceBoard, loopSourceSessionId, queryClient]
  )

  const handleLinkLoopTasks = useCallback(
    async (parentId: string, childId: string): Promise<boolean> => {
      try {
        await linkLoopTasks(
          parentId,
          childId,
          activeGatewayProfile,
          loopSourceBoard,
          loopPanelRootKey,
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
    [activeGatewayProfile, loopPanelRootKey, loopSourceBoard, loopSourceSessionId, queryClient]
  )

  const handleUnlinkLoopTasks = useCallback(
    async (parentId: string, childId: string): Promise<boolean> => {
      try {
        const result = await unlinkLoopTasks(parentId, childId, activeGatewayProfile, loopSourceBoard)

        await queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
        })

        return result.ok
      } catch (error) {
        notifyError(error, 'Delete Loop dependency failed')

        return false
      }
    },
    [activeGatewayProfile, loopSourceBoard, loopSourceSessionId, queryClient]
  )

  const handleLoopTaskAction = useCallback(
    (action: LoopTaskAction, row: LoopRow) => {
      const workerSessionId = row.workerActivity?.worker_session_id || row.latestRun?.worker_session_id
      const workerProfile = row.workerActivity?.profile || row.latestRun?.profile || row.assignee || undefined

      if (action === 'worker-session' && workerSessionId) {
        void openSessionInNewWindow(
          workerSessionId,
          workerProfile ? { profile: workerProfile, watch: true } : { watch: true }
        )

        return
      }

      if (action === 'details' || action === 'kanban' || action === 'logs' || action === 'worker-run') {
        handleSelectLoopTaskId(row.taskId)

        return
      }

      if (action === 'ask-hermes') {
        onAddContextRef(`@task:${row.taskId}`, row.title || row.taskId, `Loop task ${row.taskId}`)

        requestComposerInsert(buildLoopChatDraft(row), { mode: 'block', target: 'main' })

        return
      }

      if (action === 'decompose') {
        loopTaskDecomposeMutation.mutate({
          approveIntake: shouldApproveLoopIntakeOnSubmit(row),
          taskId: row.taskId
        })

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
    [
      handleSelectLoopTaskId,
      loopPanelState,
      loopReviewDecisionMutation,
      loopTaskArchiveMutation,
      loopTaskDecomposeMutation,
      loopTaskStatusMutation,
      onAddContextRef
    ]
  )

  return {
    canvasScopeKey: loopCanvasScopeKey,
    focusedTaskId: focusedLoopTaskId,
    focusRequestKey: loopFocusRequestKey,
    hidden: loopPanelHidden,
    onAddTaskComment: handleAddLoopTaskComment,
    onCreateTask: handleCreateLoopTask,
    onFocusTaskId: setFocusedLoopTaskId,
    onHide: handleHideLoopPanel,
    onLinkTasks: handleLinkLoopTasks,
    onOpen: handleOpenLoopPanel,
    onSavePositions: handleSaveLoopCanvasPositions,
    onSelectTaskId: handleSelectLoopTaskId,
    onTaskAction: handleLoopTaskAction,
    onUnlinkTasks: handleUnlinkLoopTasks,
    open: loopPanelOpen,
    positions: loopCanvasPositionsQuery.data?.positions,
    rootTaskId: loopPanelRootKey || undefined,
    selectedTaskDetail: selectedLoopTaskDetailQuery.data,
    selectedTaskDetailError: selectedLoopTaskDetailError,
    selectedTaskId: selectedLoopTaskId,
    state: loopPanelState,
    tabKey: selectedLoopTaskId || focusedLoopTaskId || ''
  }
}

export type LoopPanelController = ReturnType<typeof useLoopPanelController>
