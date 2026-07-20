import { useStore } from '@nanostores/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  addLoopTaskComment,
  archiveLoopNodes,
  createLoopDraftTask,
  getKanbanCapabilities,
  getLoopCanvasPositions,
  getLoopSessionSource,
  getLoopTaskDetail,
  linkLoopTasks,
  type LoopCanvasPosition,
  loopSourceFromDraftResult,
  mergeLoopDraftSource,
  saveLoopCanvasPositions,
  unlinkLoopTasks,
  updateLoopTaskStatus
} from '@/hermes'
import {
  reconcileKanbanSessionSourceForComposer,
  selectLoopWorkflowForSession
} from '@/store/composer-status'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { openSessionInNewWindow } from '@/store/windows'

import { requestComposerInsertRefs, requestComposerSubmit } from './composer/focus'
import { buildLoopTriageDraft } from './loop-intake'
import type { LoopTaskAction, LoopTaskCreateOptions } from './loop-panel'
import { loopSessionSourceRefetchInterval } from './loop-refresh'
import {
  deriveLoopPanelStateFromTenantSource,
  type LoopPanelState,
  type LoopRow,
  loopTaskAllowsDependencyEdits,
  loopTaskAllowsDependencySource,
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

  const loopPanelWorkflowKey = loopPanelState?.workflowId || ''
  const loopCanvasScopeKey = loopSourceSessionId || activeSessionId || 'new'
  const loopSourceBoard = loopSourceQuery.data?.board || undefined

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

  const loopTaskArchiveMutation = useMutation({
    mutationFn: ({ taskIds, workflowId }: { taskIds: string[]; workflowId: string }) =>
      archiveLoopNodes(workflowId, taskIds, activeGatewayProfile, loopSourceBoard, loopSourceSessionId),
    onError: error => notifyError(error, 'Archive Loop task failed'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
      })
      await queryClient.invalidateQueries({ queryKey: ['loop-task-detail', activeGatewayProfile] })
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
      const workflowId = loopPanelState?.rows.find(row => row.taskId === taskId)?.workflowId

      if (activeSessionId && workflowId) {
        selectLoopWorkflowForSession(activeSessionId, workflowId)
      }

      pendingSelectedLoopTaskIdRef.current = loopPanelState?.rows.some(row => row.taskId === taskId) ? null : taskId
      setSelectedLoopTaskId(taskId)
      setFocusedLoopTaskId(taskId)
      setLoopFocusRequestKey(key => key + 1)
      setLoopPanelOpen(true)
      setLoopPanelHidden(false)
    },
    [activeSessionId, loopPanelState]
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
    async (idea: string, options: LoopTaskCreateOptions = {}): Promise<null | string> => {
      const title = idea.trim()
      const sourceSessionId = loopSourceSessionId || (await ensureLoopSourceSessionId?.())?.trim()
      const targetWorkflowId = options.workflowId || loopPanelWorkflowKey || undefined
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
          board: loopSourceBoard,
          childIds: options.childId ? [options.childId] : undefined,
          idempotencyKey: `loop-draft:${sourceSessionId}:${crypto.randomUUID()}`,
          parents: options.parentId ? [options.parentId] : undefined,
          profile: activeGatewayProfile,
          sessionId: sourceSessionId,
          title,
          workflowId: targetWorkflowId
        })

        const source = loopSourceFromDraftResult(sourceSessionId, result)

        if (source && !loopPanelWorkflowKey) {
          const queryKey = ['loop-session-source', activeGatewayProfile, sourceSessionId]

          const reconciledSource = mergeLoopDraftSource(queryClient.getQueryData<TenantLoopSource>(queryKey), source)

          queryClient.setQueryData(queryKey, reconciledSource)
          reconcileKanbanSessionSourceForComposer({ activeSessionId, source: reconciledSource, sourceSessionId })
        }

        void queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, sourceSessionId]
        })

        const taskId = result.task?.id

        if (!loopPanelWorkflowKey) {
          handleOpenLoopPanel(taskId)
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
      loopPanelWorkflowKey,
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
    async (positions: LoopCanvasPosition[], workflowId?: string): Promise<boolean> => {
      const targetWorkflowId = workflowId?.trim() || loopPanelWorkflowKey

      if (!targetWorkflowId) {
        return false
      }

      try {
        const saved = await saveLoopCanvasPositions(
          targetWorkflowId,
          positions,
          activeGatewayProfile,
          loopSourceBoard,
          loopSourceSessionId
        )

        queryClient.setQueryData(
          ['loop-canvas-positions', activeGatewayProfile, loopSourceBoard, targetWorkflowId, loopSourceSessionId],
          saved
        )

        return true
      } catch (error) {
        notifyError(error, 'Save Loop layout failed')

        return false
      }
    },
    [activeGatewayProfile, loopPanelWorkflowKey, loopSourceBoard, loopSourceSessionId, queryClient]
  )

  const handleLinkLoopTasks = useCallback(
    async (parentId: string, childId: string): Promise<boolean> => {
      if (!loopDependencySourceIsEditable(loopPanelState, parentId)) {
        notify({ kind: 'warning', message: 'This task is immutable while its generated work is active.' })

        return false
      }

      if (!loopDependencyTargetIsEditable(loopPanelState, childId)) {
        notify({ kind: 'warning', message: 'Dependencies can only be changed while the child task is pending.' })

        return false
      }

      try {
        const workflowId = loopRelationWorkflowId(loopPanelState, parentId, childId)

        if (!workflowId) {
          throw new Error('Select tasks from one workflow before editing dependencies.')
        }

        await linkLoopTasks(parentId, childId, activeGatewayProfile, loopSourceBoard, workflowId, loopSourceSessionId)
        await queryClient.invalidateQueries({
          queryKey: ['loop-session-source', activeGatewayProfile, loopSourceSessionId]
        })

        return true
      } catch (error) {
        notifyError(error, 'Connect Loop tasks failed')

        return false
      }
    },
    [activeGatewayProfile, loopPanelState, loopSourceBoard, loopSourceSessionId, queryClient]
  )

  const handleUnlinkLoopTasks = useCallback(
    async (parentId: string, childId: string): Promise<boolean> => {
      if (!loopDependencySourceIsEditable(loopPanelState, parentId)) {
        notify({ kind: 'warning', message: 'This task is immutable while its generated work is active.' })

        return false
      }

      if (!loopDependencyTargetIsEditable(loopPanelState, childId)) {
        notify({ kind: 'warning', message: 'Dependencies can only be changed while the child task is pending.' })

        return false
      }

      try {
        const workflowId = loopRelationWorkflowId(loopPanelState, parentId, childId)

        if (!workflowId) {
          throw new Error('Select tasks from one workflow before editing dependencies.')
        }

        const result = await unlinkLoopTasks(
          parentId,
          childId,
          activeGatewayProfile,
          loopSourceBoard,
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
    [activeGatewayProfile, loopPanelState, loopSourceBoard, loopSourceSessionId, queryClient]
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
        requestComposerInsertRefs([{ kind: 'task', label: row.title || row.taskId, value: row.taskId }], {
          target: 'main'
        })

        return
      }

      if (action === 'archive-loop') {
        const taskIds = archiveableLoopRows(loopPanelState, row).map(task => task.taskId)
        const workflowId = row.workflowId?.trim() || loopPanelState?.workflowId || ''

        if (taskIds.length && workflowId) {
          loopTaskArchiveMutation.mutate({ taskIds, workflowId })
        }

        return
      }

      if (action === 'archive' && !loopTaskAllowsDependencyEdits(row)) {
        notify({ kind: 'warning', message: 'Only pending tasks can be archived from the Loop graph.' })

        return
      }

      if (action === 'archive') {
        const workflowId = row.workflowId?.trim() || loopPanelState?.workflowId || ''

        if (workflowId) {
          loopTaskArchiveMutation.mutate({ taskIds: [row.taskId], workflowId })
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

      loopTaskStatusMutation.mutate({ status: nextStatus, taskId: row.taskId })
    },
    [handleSelectLoopTaskId, loopPanelState, loopTaskArchiveMutation, loopTaskStatusMutation]
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
    workflowId: loopPanelWorkflowKey || undefined,
    selectedTaskDetail: selectedLoopTaskDetailQuery.data,
    selectedTaskDetailError: selectedLoopTaskDetailError,
    selectedTaskId: selectedLoopTaskId,
    state: loopPanelState,
    tabKey: selectedLoopTaskId || focusedLoopTaskId || ''
  }
}

export type LoopPanelController = ReturnType<typeof useLoopPanelController>
