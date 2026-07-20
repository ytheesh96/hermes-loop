import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSessionMessages } from '@/hermes'
import { chatMessageText } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $sessionStates,
  $sessionTiles,
  publishSessionState,
  sessionTileDelegate,
  SessionTileResumeSupersededError
} from '@/store/session-states'
import type { SessionMessage, SessionResumeResponse } from '@/types/hermes'

import type { ClientSessionState } from '../../types'

import { useSessionTileDelegate } from './use-session-tile-delegate'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal()),
  getSessionMessages: vi.fn()
}))

const storedSessionId = 'worker-session-9'
const workerProfile = 'reviewer-qa'

function assistantMessage(content: string, id: number): SessionMessage {
  return { content, role: 'assistant', timestamp: id }
}

function toolMessage(content: string, id: number, name: string): SessionMessage {
  return {
    content,
    name,
    role: 'tool',
    timestamp: id,
    tool_call_id: `call-${id}`
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, reject, resolve }
}

function resumePayload(
  runtimeId = 'runtime-worker',
  messages: SessionMessage[] = [assistantMessage('Worker snapshot', 1)],
  running = true
): SessionResumeResponse {
  return {
    info: {
      fast: false,
      model: 'openai/gpt-5.6-sol',
      provider: 'openai-codex',
      reasoning_effort: 'xhigh',
      running: false
    },
    message_count: messages.length,
    messages,
    resumed: storedSessionId,
    running,
    session_id: runtimeId
  }
}

function renderDelegate(requestGateway = vi.fn(async () => resumePayload())) {
  const runtimeIdByStoredSessionIdRef = { current: new Map<string, string>() }
  const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }

  const updateSessionState = vi.fn(
    (runtimeId: string, updater: (state: ClientSessionState) => ClientSessionState, storedId?: string | null) => {
      const previous = sessionStateByRuntimeIdRef.current.get(runtimeId) ?? createClientSessionState(storedId ?? null)
      const next = updater(previous)

      sessionStateByRuntimeIdRef.current.set(runtimeId, next)

      if (storedId) {
        runtimeIdByStoredSessionIdRef.current.set(storedId, runtimeId)
      }

      publishSessionState(runtimeId, next)

      return next
    }
  )

  const hook = renderHook(() =>
    useSessionTileDelegate({
      archiveSession: vi.fn(async () => undefined),
      branchStoredSession: vi.fn(async () => undefined),
      executeSlashCommand: vi.fn(async () => undefined) as never,
      removeSession: vi.fn(async () => undefined),
      requestGateway: requestGateway as never,
      runtimeIdByStoredSessionIdRef,
      sessionStateByRuntimeIdRef,
      updateSessionState: updateSessionState as never
    })
  )

  return {
    hook,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    updateSessionState
  }
}

describe('useSessionTileDelegate', () => {
  beforeEach(() => {
    vi.mocked(getSessionMessages).mockReset()
    $sessionStates.set({})
    $sessionTiles.set([])
    vi.useRealTimers()
  })

  afterEach(() => {
    cleanup()
    $sessionStates.set({})
    $sessionTiles.set([])
    vi.useRealTimers()
  })

  it('resumes a cross-profile Loop worker tab lazily without constructing another agent', async () => {
    const requestGateway = vi.fn(async () =>
      resumePayload('runtime-worker', [assistantMessage('Worker snapshot', 1)], false)
    )

    const { sessionStateByRuntimeIdRef } = renderDelegate(requestGateway)

    let runtimeId = ''

    await act(async () => {
      runtimeId =
        (await sessionTileDelegate()?.resumeTile(storedSessionId, {
          profile: workerProfile,
          runningHint: true,
          watch: true
        })) ?? ''
    })

    expect(runtimeId).toBe('runtime-worker')
    expect(getSessionMessages).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      cols: 96,
      lazy: true,
      profile: workerProfile,
      session_id: storedSessionId,
      source: 'desktop'
    })
    expect(sessionStateByRuntimeIdRef.current.get('runtime-worker')).toMatchObject({
      awaitingResponse: true,
      busy: true,
      fast: false,
      model: 'openai/gpt-5.6-sol',
      provider: 'openai-codex',
      reasoningEffort: 'xhigh',
      storedSessionId
    })
  })

  it('refreshes a watch tab from the durable profile transcript without gateway events', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [assistantMessage('Durable progress', 2)],
      session_id: storedSessionId
    })
    const { sessionStateByRuntimeIdRef } = renderDelegate()
    let runtimeId = ''

    await act(async () => {
      runtimeId =
        (await sessionTileDelegate()?.resumeTile(storedSessionId, {
          profile: workerProfile,
          watch: true
        })) ?? ''
      $sessionTiles.set([{ profile: workerProfile, runtimeId, storedSessionId, watch: true }])
    })

    await waitFor(() => {
      const state = sessionStateByRuntimeIdRef.current.get(runtimeId)

      expect(getSessionMessages).toHaveBeenCalledWith(storedSessionId, workerProfile)
      expect(state?.messages.at(-1) && chatMessageText(state.messages.at(-1)!)).toBe('Durable progress')
      expect(state?.awaitingResponse).toBe(false)
      expect(state?.busy).toBe(false)
    })
  })

  it('settles a stale running hint from an unchanged final durable snapshot', async () => {
    const finalSnapshot = [assistantMessage('Already finished', 2)]

    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: finalSnapshot,
      session_id: storedSessionId
    })

    const { sessionStateByRuntimeIdRef } = renderDelegate(
      vi.fn(async () => resumePayload('runtime-worker', finalSnapshot, false))
    )

    await act(async () => {
      const runtimeId = await sessionTileDelegate()?.resumeTile(storedSessionId, {
        profile: workerProfile,
        runningHint: true,
        watch: true
      })

      $sessionTiles.set([{ profile: workerProfile, runtimeId, storedSessionId, watch: true }])
    })

    await waitFor(() => {
      expect(sessionStateByRuntimeIdRef.current.get('runtime-worker')).toMatchObject({
        awaitingResponse: false,
        busy: false
      })
    })
  })

  it('keeps polling an open watch tab without overlapping a pending refresh', async () => {
    vi.useFakeTimers()
    const first = deferred<{ messages: SessionMessage[]; session_id: string }>()

    vi.mocked(getSessionMessages)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        messages: [assistantMessage('Second durable update', 2)],
        session_id: storedSessionId
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage('Third durable update', 3)],
        session_id: storedSessionId
      })

    const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate()
    const initial = createClientSessionState(storedSessionId)

    runtimeIdByStoredSessionIdRef.current.set(storedSessionId, 'runtime-worker')
    sessionStateByRuntimeIdRef.current.set('runtime-worker', initial)
    publishSessionState('runtime-worker', initial)

    await act(async () => {
      $sessionTiles.set([{ profile: workerProfile, runtimeId: 'runtime-worker', storedSessionId, watch: true }])
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({
        messages: [assistantMessage('First durable update', 1)],
        session_id: storedSessionId
      })
      await first.promise
      await Promise.resolve()
    })

    expect(chatMessageText(sessionStateByRuntimeIdRef.current.get('runtime-worker')!.messages.at(-1)!)).toBe(
      'First durable update'
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(2)
    expect(chatMessageText(sessionStateByRuntimeIdRef.current.get('runtime-worker')!.messages.at(-1)!)).toBe(
      'Second durable update'
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(3)
    expect(chatMessageText(sessionStateByRuntimeIdRef.current.get('runtime-worker')!.messages.at(-1)!)).toBe(
      'Third durable update'
    )
  })

  it('stops polling after an explicit terminal tool result stays durably unchanged', async () => {
    vi.useFakeTimers()
    const terminalMessages = [toolMessage('Task completed', 1, 'kanban_complete')]

    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: terminalMessages,
      session_id: storedSessionId
    })

    const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate()

    const initial = {
      ...createClientSessionState(storedSessionId),
      awaitingResponse: true,
      busy: true
    }

    runtimeIdByStoredSessionIdRef.current.set(storedSessionId, 'runtime-worker')
    sessionStateByRuntimeIdRef.current.set('runtime-worker', initial)
    publishSessionState('runtime-worker', initial)

    await act(async () => {
      $sessionTiles.set([{ profile: workerProfile, runtimeId: 'runtime-worker', storedSessionId, watch: true }])
      await Promise.resolve()
    })

    expect(sessionStateByRuntimeIdRef.current.get('runtime-worker')).toMatchObject({
      awaitingResponse: false,
      busy: false
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    const callsAfterStableTerminal = vi.mocked(getSessionMessages).mock.calls.length

    expect(callsAfterStableTerminal).toBeGreaterThan(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(callsAfterStableTerminal)
  })

  it('rejects a stale durable response after the same watch tab closes and reopens', async () => {
    vi.useFakeTimers()
    const stale = deferred<{ messages: SessionMessage[]; session_id: string }>()

    vi.mocked(getSessionMessages)
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({
        messages: [assistantMessage('Fresh progress', 3)],
        session_id: storedSessionId
      })

    const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate()

    const initial = {
      ...createClientSessionState(storedSessionId),
      busy: true
    }

    runtimeIdByStoredSessionIdRef.current.set(storedSessionId, 'runtime-worker')
    sessionStateByRuntimeIdRef.current.set('runtime-worker', initial)
    publishSessionState('runtime-worker', initial)

    await act(async () => {
      $sessionTiles.set([{ profile: workerProfile, runtimeId: 'runtime-worker', storedSessionId, watch: true }])
    })
    expect(getSessionMessages).toHaveBeenCalledTimes(1)

    await act(async () => {
      $sessionTiles.set([])
      $sessionTiles.set([{ profile: workerProfile, runtimeId: 'runtime-worker', storedSessionId, watch: true }])
      await Promise.resolve()
    })

    expect(chatMessageText(sessionStateByRuntimeIdRef.current.get('runtime-worker')!.messages.at(-1)!)).toBe(
      'Fresh progress'
    )

    await act(async () => {
      stale.resolve({
        messages: [assistantMessage('Stale progress', 2)],
        session_id: storedSessionId
      })
      await stale.promise
      await Promise.resolve()
    })

    expect(chatMessageText(sessionStateByRuntimeIdRef.current.get('runtime-worker')!.messages.at(-1)!)).toBe(
      'Fresh progress'
    )

    $sessionTiles.set([])
    const callsAfterClose = vi.mocked(getSessionMessages).mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(3_000)
    })

    expect(getSessionMessages).toHaveBeenCalledTimes(callsAfterClose)
  })

  it('ignores a durable refresh that resolves after the watcher unmounts', async () => {
    const pending = deferred<{ messages: SessionMessage[]; session_id: string }>()

    vi.mocked(getSessionMessages).mockReturnValue(pending.promise)
    const { hook, runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate()
    const initial = createClientSessionState(storedSessionId)

    runtimeIdByStoredSessionIdRef.current.set(storedSessionId, 'runtime-worker')
    sessionStateByRuntimeIdRef.current.set('runtime-worker', initial)
    publishSessionState('runtime-worker', initial)

    await act(async () => {
      $sessionTiles.set([{ profile: workerProfile, runtimeId: 'runtime-worker', storedSessionId, watch: true }])
    })
    expect(getSessionMessages).toHaveBeenCalledTimes(1)

    hook.unmount()

    await act(async () => {
      pending.resolve({
        messages: [assistantMessage('Too late', 2)],
        session_id: storedSessionId
      })
      await pending.promise
      await Promise.resolve()
    })

    expect(sessionStateByRuntimeIdRef.current.get('runtime-worker')?.messages).toEqual([])
  })

  it('drops an incompatible cached runtime before a profile-aware watch resume', async () => {
    const requestGateway = vi.fn(async () => resumePayload('runtime-fresh'))
    const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate(requestGateway)
    const staleState = createClientSessionState(storedSessionId)

    runtimeIdByStoredSessionIdRef.current.set(storedSessionId, 'runtime-stale')
    sessionStateByRuntimeIdRef.current.set('runtime-stale', staleState)
    publishSessionState('runtime-stale', staleState)

    const runtimeId = await sessionTileDelegate()?.resumeTile(storedSessionId, {
      profile: workerProfile,
      watch: true
    })

    expect(runtimeId).toBe('runtime-fresh')
    expect(requestGateway).toHaveBeenCalledTimes(1)
    expect(sessionStateByRuntimeIdRef.current.has('runtime-stale')).toBe(false)
    expect($sessionStates.get()['runtime-stale']).toBeUndefined()
    expect(runtimeIdByStoredSessionIdRef.current.get(storedSessionId)).toBe('runtime-fresh')
  })

  it('does not reuse a lazy watch runtime for a later interactive tile', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [assistantMessage('Interactive snapshot', 2)],
      session_id: storedSessionId
    })

    const requestGateway = vi
      .fn()
      .mockResolvedValueOnce(resumePayload('runtime-watch'))
      .mockResolvedValueOnce(resumePayload('runtime-interactive', [assistantMessage('Interactive snapshot', 2)], false))

    renderDelegate(requestGateway)

    await sessionTileDelegate()?.resumeTile(storedSessionId, {
      profile: workerProfile,
      watch: true
    })

    const runtimeId = await sessionTileDelegate()?.resumeTile(storedSessionId)

    expect(runtimeId).toBe('runtime-interactive')
    expect(requestGateway).toHaveBeenCalledTimes(2)
    expect(requestGateway).toHaveBeenLastCalledWith('session.resume', {
      cols: 96,
      session_id: storedSessionId,
      source: 'desktop'
    })
  })

  it('does not apply a resume invalidated while its RPC is in flight', async () => {
    const pending = deferred<SessionResumeResponse>()

    const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = renderDelegate(vi.fn(() => pending.promise))

    const resume = sessionTileDelegate()!.resumeTile(storedSessionId, {
      profile: workerProfile,
      watch: true
    })

    const rejected = expect(resume).rejects.toBeInstanceOf(SessionTileResumeSupersededError)

    sessionTileDelegate()?.invalidateRuntime(storedSessionId)
    pending.resolve(resumePayload('runtime-stale'))

    await rejected
    expect(runtimeIdByStoredSessionIdRef.current.has(storedSessionId)).toBe(false)
    expect(sessionStateByRuntimeIdRef.current.has('runtime-stale')).toBe(false)
  })

  it('normalizes a rejected stale resume to the superseded retry signal', async () => {
    const pending = deferred<SessionResumeResponse>()

    renderDelegate(vi.fn(() => pending.promise))

    const resume = sessionTileDelegate()!.resumeTile(storedSessionId, {
      profile: workerProfile,
      watch: true
    })

    const rejected = expect(resume).rejects.toBeInstanceOf(SessionTileResumeSupersededError)

    sessionTileDelegate()?.invalidateRuntime(storedSessionId)
    pending.reject(new Error('session not found'))

    await rejected
  })
})
