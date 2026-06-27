import { QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { $loopagentsBySession } from '@/store/loopagents'
import { $todosBySession, setSessionTodos } from '@/store/todos'
import type { RpcEvent } from '@/types/hermes'

import type { ClientSessionState } from '../../types'

import { useMessageStream } from './use-message-stream'

describe('useMessageStream loopagent events', () => {
  beforeEach(() => {
    $loopagentsBySession.set({})
    $todosBySession.set({})
  })

  it('routes loopagent gateway events into the event-fed Loop activity store', () => {
    const queryClient = new QueryClient()
    const activeSessionIdRef = { current: 'runtime-tip' }
    const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }

    const { result } = renderHook(() =>
      useMessageStream({
        activeSessionIdRef,
        hydrateFromStoredSession: vi.fn(async () => undefined),
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions: vi.fn(async () => undefined),
        sessionStateByRuntimeIdRef,
        updateSessionState: vi.fn()
      })
    )

    act(() => {
      result.current.handleGatewayEvent({
        payload: {
          current_session_id: 'runtime-tip',
          logical_session_id: 'logical-root',
          source_session_id: 'source-root',
          task_id: 't_loop',
          task_title: 'Wire Loop activity',
          run_id: 7,
          event: 'loopagent.worker.upsert',
          run_status: 'running',
          current_tool: 'terminal'
        },
        type: 'loopagent.worker.upsert'
      } as RpcEvent)
    })

    expect($loopagentsBySession.get()['runtime-tip']?.[0]).toMatchObject({
      currentTool: 'terminal',
      id: 'loopagent:worker:t_loop:7',
      kind: 'worker',
      status: 'running',
      taskId: 't_loop',
      title: 'Wire Loop activity'
    })
    expect($loopagentsBySession.get()['logical-root']?.[0]?.id).toBe('loopagent:worker:t_loop:7')
    expect($loopagentsBySession.get()['source-root']?.[0]?.id).toBe('loopagent:worker:t_loop:7')
  })

  it('refreshes Loop session-source snapshots when a live task row changes', () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
    const activeSessionIdRef = { current: 'runtime-tip' }
    const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }

    const { result } = renderHook(() =>
      useMessageStream({
        activeSessionIdRef,
        hydrateFromStoredSession: vi.fn(async () => undefined),
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions: vi.fn(async () => undefined),
        sessionStateByRuntimeIdRef,
        updateSessionState: vi.fn()
      })
    )

    act(() => {
      result.current.handleGatewayEvent({
        payload: {
          current_session_id: 'runtime-tip',
          task_id: 't_loop',
          task_title: 'New Loop row',
          event: 'loopagent.task.upsert',
          task_status: 'ready'
        },
        type: 'loopagent.task.upsert'
      } as RpcEvent)
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['loop-session-source'] })
  })

  it('hydrates the active stored session when an external message append event arrives', () => {
    const queryClient = new QueryClient()
    const activeSessionIdRef = { current: 'runtime-active' }
    const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }
    const hydrateFromStoredSession = vi.fn(async () => undefined)
    const refreshSessions = vi.fn(async () => undefined)

    sessionStateByRuntimeIdRef.current.set('runtime-active', createClientSessionState('stored-active'))

    const { result } = renderHook(() =>
      useMessageStream({
        activeSessionIdRef,
        hydrateFromStoredSession,
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions,
        sessionStateByRuntimeIdRef,
        updateSessionState: vi.fn()
      })
    )

    act(() => {
      result.current.handleGatewayEvent({
        session_id: 'stored-active',
        payload: {
          stored_session_id: 'stored-active',
          message_id: 123,
          role: 'user',
          observed: true
        },
        type: 'session.message.appended'
      } as RpcEvent)
    })

    expect(hydrateFromStoredSession).toHaveBeenCalledWith(3, 'stored-active', 'runtime-active')
    expect(refreshSessions).toHaveBeenCalled()
  })

  it('does not hydrate the active runtime for a background external message append', () => {
    const queryClient = new QueryClient()
    const activeSessionIdRef = { current: 'runtime-active' }
    const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }
    const hydrateFromStoredSession = vi.fn(async () => undefined)

    sessionStateByRuntimeIdRef.current.set('runtime-active', createClientSessionState('stored-active'))

    const { result } = renderHook(() =>
      useMessageStream({
        activeSessionIdRef,
        hydrateFromStoredSession,
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions: vi.fn(async () => undefined),
        sessionStateByRuntimeIdRef,
        updateSessionState: vi.fn()
      })
    )

    act(() => {
      result.current.handleGatewayEvent({
        session_id: 'stored-background',
        payload: { stored_session_id: 'stored-background', message_id: 456 },
        type: 'session.message.appended'
      } as RpcEvent)
    })

    expect(hydrateFromStoredSession).not.toHaveBeenCalled()
  })

  it('settles stale local todo rows when a turn completes', () => {
    const queryClient = new QueryClient()
    const activeSessionIdRef = { current: 'runtime-tip' }
    const initialState = createClientSessionState('stored-tip')
    const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>([['runtime-tip', initialState]]) }

    const updateSessionState = vi.fn(
      (sessionId: string, updater: (state: ClientSessionState) => ClientSessionState) => {
        const previous = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState(sessionId)
        const next = updater(previous)

        sessionStateByRuntimeIdRef.current.set(sessionId, next)

        return next
      }
    )

    setSessionTodos('runtime-tip', [
      { content: 'Finished durable task', id: 'done', status: 'completed' },
      { content: 'Stale local spinner', id: 'running', status: 'in_progress' }
    ])

    const { result } = renderHook(() =>
      useMessageStream({
        activeSessionIdRef,
        hydrateFromStoredSession: vi.fn(async () => undefined),
        queryClient,
        refreshHermesConfig: vi.fn(async () => undefined),
        refreshSessions: vi.fn(async () => undefined),
        sessionStateByRuntimeIdRef,
        updateSessionState
      })
    )

    act(() => {
      result.current.handleGatewayEvent({
        session_id: 'runtime-tip',
        payload: { text: 'Done.' },
        type: 'message.complete'
      } as RpcEvent)
    })

    expect($todosBySession.get()['runtime-tip']?.map(item => [item.id, item.status])).toEqual([
      ['done', 'completed'],
      ['running', 'completed']
    ])
  })
})
