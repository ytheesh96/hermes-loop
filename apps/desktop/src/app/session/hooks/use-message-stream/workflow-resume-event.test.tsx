import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { chatMessageText } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const SID = 'session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null
let sessionStates = new Map<string, ClientSessionState>()

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(sessionStates)
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

function emit(type: string, payload: Record<string, unknown> = {}) {
  act(() => handleEvent!({ payload, session_id: SID, type }))
}

describe('useMessageStream workflow foreground-resume boundary', () => {
  beforeEach(() => {
    handleEvent = null
    sessionStates = new Map()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('persists one structured boundary before the automatic assistant turn without parsing wake prose', async () => {
    await mountStream()

    emit('status.update', {
      kind: 'kanban',
      text: '[IMPORTANT: Workflow wf-opaque produced a task-boundary batch.]'
    })
    expect(sessionStates.get(SID)?.messages ?? []).toEqual([])

    const boundary = {
      event_id: 42,
      kind: 'workflow',
      status: 'foreground_resumed',
      text: 'Review dynamic handoff completed · foreground resumed',
      workflow_id: 'wf-opaque'
    }

    emit('status.update', boundary)
    emit('status.update', boundary)
    emit('message.start')
    emit('message.complete', { text: 'I reviewed the completed handoff.' })

    const messages = sessionStates.get(SID)?.messages ?? []

    expect(messages.map(message => [message.role, chatMessageText(message)])).toEqual([
      ['system', 'Review dynamic handoff completed · foreground resumed'],
      ['assistant', 'I reviewed the completed handoff.']
    ])
    expect(messages[0]?.id).toBe('workflow-resume-wf-opaque-42')
  })
})
