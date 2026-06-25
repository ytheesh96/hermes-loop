import { useStore } from '@nanostores/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  addLoopTaskComment,
  decomposeLoopTask,
  getLoopSessionSource,
  getLoopTaskDetail,
  reviewLoopHandoffForTask,
  updateLoopTaskStatus
} from '@/hermes'
import { reconcileKanbanSessionSourceForComposer } from '@/store/composer-status'
import { PREVIEW_PANE_ID } from '@/store/layout'
import { notify, notifyError } from '@/store/notifications'
import { setPaneOpen } from '@/store/panes'
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

export function useLoopPanelController({
  activeSessionId,
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

  const loopPanelRootKey = loopPanelState?.rootTaskId || ''
  const loopSourceBoard = loopSourceQuery.data?.board || undefined

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
    mutationFn: ({ approveIntake, loopSafe, taskId }: { approveIntake?: boolean; loopSafe?: boolean; taskId: string }) =>
      decomposeLoopTask(taskId, activeGatewayProfile, { approveIntake, board: loopSourceBoard, loopSafe }),
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
        taskIds.map(taskId => updateLoopTaskStatus(taskId, 'archived', activeGatewayProfile, { board: loopSourceBoard }))
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
  }, [loopPanelRootKey])

  const handleSelectLoopTaskId = useCallback((taskId: string) => {
    setPaneOpen(PREVIEW_PANE_ID, true)
    setSelectedLoopTaskId(taskId)
    setFocusedLoopTaskId(taskId)
    setLoopFocusRequestKey(key => key + 1)
    setLoopPanelOpen(true)
    setLoopPanelHidden(false)
  }, [])

  const handleHideLoopPanel = useCallback(() => {
    setLoopPanelOpen(false)
    setLoopPanelHidden(true)
  }, [])

  const handleAddLoopTaskComment = useCallback(
    async (taskId: string, body: string) => {
      await loopTaskCommentMutation.mutateAsync({ body, taskId })
    },
    [loopTaskCommentMutation]
  )

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
        requestComposerInsert(buildLoopChatDraft(row), { mode: 'block', target: 'main' })

        return
      }

      if (action === 'decompose') {
        loopTaskDecomposeMutation.mutate({
          approveIntake: shouldApproveLoopIntakeOnSubmit(row),
          loopSafe: true,
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
    focusedTaskId: focusedLoopTaskId,
    focusRequestKey: loopFocusRequestKey,
    hidden: loopPanelHidden,
    onAddTaskComment: handleAddLoopTaskComment,
    onFocusTaskId: setFocusedLoopTaskId,
    onHide: handleHideLoopPanel,
    onSelectTaskId: handleSelectLoopTaskId,
    onTaskAction: handleLoopTaskAction,
    open: loopPanelOpen,
    selectedTaskDetail: selectedLoopTaskDetailQuery.data,
    selectedTaskDetailError: selectedLoopTaskDetailError,
    selectedTaskId: selectedLoopTaskId,
    state: loopPanelState,
    tabKey: selectedLoopTaskId || focusedLoopTaskId || loopPanelRootKey
  }
}

export type LoopPanelController = ReturnType<typeof useLoopPanelController>
