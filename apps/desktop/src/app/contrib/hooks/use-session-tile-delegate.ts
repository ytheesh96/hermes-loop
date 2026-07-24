import { useEffect, useRef } from 'react'

import { getSessionMessages, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import { toChatMessages } from '@/lib/chat-messages'
import { sessionMessagesSignature } from '@/lib/session-signatures'
import {
  $sessionTiles,
  dropSessionState,
  publishSessionState,
  SessionTileResumeSupersededError,
  setSessionTileDelegate
} from '@/store/session-states'
import type { SessionMessage, SessionResumeResponse } from '@/types/hermes'

import { sessionInfoStatePatch } from '../../session/hooks/use-message-stream/utils'
import type { usePromptActions } from '../../session/hooks/use-prompt-actions'
import { resolveSessionProfile } from '../../session/hooks/use-session-actions/utils'
import type { useSessionStateCache } from '../../session/hooks/use-session-state-cache'
import type { GatewayRequester } from '../types'

type SessionStateCache = ReturnType<typeof useSessionStateCache>
const WATCH_TILE_REFRESH_MS = 1_000
const WATCH_TILE_TERMINAL_STABLE_POLLS = 5
const KANBAN_TERMINAL_TOOLS = new Set(['kanban_block', 'kanban_complete'])

function hasPersistedKanbanTerminal(messages: readonly SessionMessage[]): boolean {
  let lastTerminal = -1
  let lastUser = -1

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      lastUser = index
    } else if (message.role === 'tool' && KANBAN_TERMINAL_TOOLS.has(message.name ?? message.tool_name ?? '')) {
      lastTerminal = index
    }
  })

  return lastTerminal > lastUser
}

interface SessionTileDelegateParams {
  archiveSession: (storedSessionId: string) => Promise<unknown>
  branchStoredSession: (storedSessionId: string) => Promise<unknown>
  executeSlashCommand: ReturnType<typeof usePromptActions>['executeSlashCommand']
  removeSession: (storedSessionId: string) => Promise<unknown>
  requestGateway: GatewayRequester
  runtimeIdByStoredSessionIdRef: SessionStateCache['runtimeIdByStoredSessionIdRef']
  sessionStateByRuntimeIdRef: SessionStateCache['sessionStateByRuntimeIdRef']
  updateSessionState: SessionStateCache['updateSessionState']
}

/**
 * Publishes the session-tile delegate: resume / submit / interrupt / slash for
 * tiled sessions WITHOUT touching the primary view ($activeSessionId /
 * $messages stay the main thread's). Resume reuses a live runtime binding when
 * one exists (incl. the main thread's own session); a cold tile binds +
 * hydrates the cache, which publishSessionState mirrors to the tile.
 */
export function useSessionTileDelegate({
  archiveSession,
  branchStoredSession,
  executeSlashCommand,
  removeSession,
  requestGateway,
  runtimeIdByStoredSessionIdRef,
  sessionStateByRuntimeIdRef,
  updateSessionState
}: SessionTileDelegateParams): void {
  const resumeGenerationsRef = useRef(new Map<string, number>())
  const runtimeBindingByStoredSessionIdRef = useRef(new Map<string, string>())
  const watchTranscriptSignaturesRef = useRef(new Map<string, string>())

  // Loop workers run in standalone processes and their best-effort live event
  // publisher is not guaranteed to feed Desktop's gateway socket. Watch the
  // durable transcript instead: the agent flushes assistant tool calls before
  // execution and tool results immediately after, so SessionDB advances
  // throughout the run. One in-flight read per tab prevents stale responses
  // from landing out of order; closing/rebinding the tab cancels future polls
  // and rejects any response already in flight.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let disposed = false
    let nextGeneration = 0
    const descriptors = new Map<string, string>()
    const generations = new Map<string, number>()
    const inFlight = new Set<string>()
    const terminalStablePolls = new Map<string, number>()
    const timers = new Map<string, number>()

    const refresh = async (
      tile: {
        profile?: string
        runtimeId: string
        storedSessionId: string
      },
      generation: number
    ) => {
      const requestKey = `${tile.runtimeId}\u0000${generation}`

      if (inFlight.has(requestKey)) {
        return
      }

      inFlight.add(requestKey)

      try {
        const latest = await getSessionMessages(tile.storedSessionId, tile.profile)

        if (disposed || generations.get(tile.runtimeId) !== generation) {
          return
        }

        const stillOpen = $sessionTiles
          .get()
          .some(
            current =>
              current.watch &&
              current.runtimeId === tile.runtimeId &&
              current.storedSessionId === tile.storedSessionId &&
              current.profile === tile.profile
          )

        if (!stillOpen || runtimeIdByStoredSessionIdRef.current.get(tile.storedSessionId) !== tile.runtimeId) {
          return
        }

        const signature = sessionMessagesSignature(latest.messages)
        const tail = latest.messages.at(-1)
        const hasToolCalls = Array.isArray(tail?.tool_calls) ? tail.tool_calls.length > 0 : tail?.tool_calls != null
        const terminalPersisted = hasPersistedKanbanTerminal(latest.messages)
        const settled = terminalPersisted || (tail?.role === 'assistant' && !hasToolCalls)

        if (watchTranscriptSignaturesRef.current.get(tile.runtimeId) === signature) {
          if (terminalPersisted) {
            const stablePolls = (terminalStablePolls.get(tile.runtimeId) ?? 0) + 1

            terminalStablePolls.set(tile.runtimeId, stablePolls)

            if (stablePolls >= WATCH_TILE_TERMINAL_STABLE_POLLS) {
              const timer = timers.get(tile.runtimeId)

              if (timer !== undefined) {
                window.clearInterval(timer)
              }
            }
          } else {
            terminalStablePolls.delete(tile.runtimeId)
          }

          // The Loop row can still say "running" for the brief interval after
          // the worker has already committed its final assistant message. Even
          // an unchanged first poll must be allowed to settle that opening hint.
          const current = sessionStateByRuntimeIdRef.current.get(tile.runtimeId)

          if (settled && (current?.busy || current?.awaitingResponse || current?.needsInput || current?.streamId)) {
            updateSessionState(
              tile.runtimeId,
              state => ({
                ...state,
                awaitingResponse: false,
                busy: false,
                needsInput: false,
                streamId: null
              }),
              tile.storedSessionId
            )
          }

          return
        }

        watchTranscriptSignaturesRef.current.set(tile.runtimeId, signature)

        if (terminalPersisted) {
          terminalStablePolls.set(tile.runtimeId, 0)
        } else {
          terminalStablePolls.delete(tile.runtimeId)
        }

        const messages = toChatMessages(latest.messages)

        updateSessionState(
          tile.runtimeId,
          state => ({
            ...state,
            messages,
            ...(settled
              ? {
                  awaitingResponse: false,
                  busy: false,
                  needsInput: false,
                  streamId: null
                }
              : {})
          }),
          tile.storedSessionId
        )
      } catch {
        // Best effort. The next bounded poll retries without disturbing the tab.
      } finally {
        inFlight.delete(requestKey)
      }
    }

    const sync = () => {
      const watchedRuntimeIds = new Set<string>()

      for (const tile of $sessionTiles.get()) {
        if (!tile.watch || !tile.runtimeId) {
          continue
        }

        watchedRuntimeIds.add(tile.runtimeId)
        const descriptor = `${tile.storedSessionId}\u0000${tile.profile ?? ''}`

        if (timers.has(tile.runtimeId) && descriptors.get(tile.runtimeId) === descriptor) {
          continue
        }

        const priorTimer = timers.get(tile.runtimeId)

        if (priorTimer !== undefined) {
          window.clearInterval(priorTimer)
        }

        terminalStablePolls.delete(tile.runtimeId)
        const generation = ++nextGeneration

        const watchedTile = {
          profile: tile.profile,
          runtimeId: tile.runtimeId,
          storedSessionId: tile.storedSessionId
        }

        descriptors.set(tile.runtimeId, descriptor)
        generations.set(tile.runtimeId, generation)
        void refresh(watchedTile, generation)
        timers.set(
          tile.runtimeId,
          window.setInterval(() => void refresh(watchedTile, generation), WATCH_TILE_REFRESH_MS)
        )
      }

      for (const [runtimeId, timer] of timers) {
        if (watchedRuntimeIds.has(runtimeId)) {
          continue
        }

        window.clearInterval(timer)
        timers.delete(runtimeId)
        descriptors.delete(runtimeId)
        generations.delete(runtimeId)
        terminalStablePolls.delete(runtimeId)
        watchTranscriptSignaturesRef.current.delete(runtimeId)
      }
    }

    const unsubscribe = $sessionTiles.subscribe(sync)

    return () => {
      disposed = true
      unsubscribe()

      for (const timer of timers.values()) {
        window.clearInterval(timer)
      }

      descriptors.clear()
      generations.clear()
      terminalStablePolls.clear()
      timers.clear()
      inFlight.clear()
    }
  }, [runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef, updateSessionState])

  useEffect(() => {
    setSessionTileDelegate({
      archiveSession: async storedSessionId => {
        await archiveSession(storedSessionId)
      },
      branchSession: async storedSessionId => {
        await branchStoredSession(storedSessionId)
      },
      deleteSession: async storedSessionId => {
        await removeSession(storedSessionId)
      },
      executeSlash: async (rawCommand, sessionId) => {
        await executeSlashCommand(rawCommand, { sessionId })
      },
      interruptSession: async runtimeId => {
        await requestGateway('session.interrupt', { session_id: runtimeId })
      },
      invalidateRuntime: storedSessionId => {
        const runtimeId =
          runtimeIdByStoredSessionIdRef.current.get(storedSessionId) ??
          $sessionTiles.get().find(tile => tile.storedSessionId === storedSessionId)?.runtimeId

        runtimeIdByStoredSessionIdRef.current.delete(storedSessionId)
        resumeGenerationsRef.current.set(storedSessionId, (resumeGenerationsRef.current.get(storedSessionId) ?? 0) + 1)
        runtimeBindingByStoredSessionIdRef.current.delete(storedSessionId)

        if (runtimeId) {
          sessionStateByRuntimeIdRef.current.delete(runtimeId)
          watchTranscriptSignaturesRef.current.delete(runtimeId)
          dropSessionState(runtimeId)
        }
      },
      resumeTile: async (storedSessionId, options = {}) => {
        const existing = runtimeIdByStoredSessionIdRef.current.get(storedSessionId)
        const cached = existing ? sessionStateByRuntimeIdRef.current.get(existing) : undefined
        const generation = (resumeGenerationsRef.current.get(storedSessionId) ?? 0) + 1
        resumeGenerationsRef.current.set(storedSessionId, generation)

        // Resolve the owning profile before binding a runtime. Explicit tile
        // metadata remains the fallback for a row that has not loaded yet.
        const profile = options.profile ?? (await resolveSessionProfile(storedSessionId))

        if (resumeGenerationsRef.current.get(storedSessionId) !== generation) {
          throw new SessionTileResumeSupersededError()
        }

        const requestedBinding = `${profile ?? ''}\u0000${options.watch ? 'watch' : 'interactive'}`
        const cachedBinding = runtimeBindingByStoredSessionIdRef.current.get(storedSessionId)

        const bindingCompatible = cachedBinding
          ? cachedBinding === requestedBinding
          : !options.profile && !options.watch

        if (existing && cached?.storedSessionId === storedSessionId && bindingCompatible) {
          publishSessionState(existing, cached)

          return existing
        }

        if (existing && (!bindingCompatible || cached?.storedSessionId !== storedSessionId)) {
          runtimeIdByStoredSessionIdRef.current.delete(storedSessionId)
          runtimeBindingByStoredSessionIdRef.current.delete(storedSessionId)
          sessionStateByRuntimeIdRef.current.delete(existing)
          watchTranscriptSignaturesRef.current.delete(existing)
          dropSessionState(existing)
        }

        const [prefetch, resumed] = await Promise.all([
          options.watch ? Promise.resolve(null) : getSessionMessages(storedSessionId, profile).catch(() => null),
          requestGateway<SessionResumeResponse>('session.resume', {
            session_id: storedSessionId,
            cols: 96,
            source: 'desktop',
            ...(options.watch ? { lazy: true } : {}),
            ...(profile ? { profile } : {})
          })
        ]).catch((error: unknown) => {
          if (resumeGenerationsRef.current.get(storedSessionId) !== generation) {
            throw new SessionTileResumeSupersededError()
          }

          throw error
        })

        if (resumeGenerationsRef.current.get(storedSessionId) !== generation) {
          throw new SessionTileResumeSupersededError()
        }

        const runtimeId = resumed?.session_id

        if (!runtimeId) {
          throw new Error('resume returned no session id')
        }

        const snapshot = prefetch?.messages ?? resumed?.messages ?? []

        if (options.watch) {
          watchTranscriptSignaturesRef.current.set(runtimeId, sessionMessagesSignature(snapshot))
        }

        const runtimeInfo = sessionInfoStatePatch(resumed?.info)
        const running = Boolean(options.runningHint || resumed?.running || resumed?.info?.running)

        runtimeBindingByStoredSessionIdRef.current.set(storedSessionId, requestedBinding)
        updateSessionState(
          runtimeId,
          state => ({
            ...state,
            ...runtimeInfo,
            busy: running,
            awaitingResponse: running,
            messages: options.watch || state.messages.length === 0 ? toChatMessages(snapshot) : state.messages
          }),
          storedSessionId
        )

        return runtimeId
      },
      submitToSession: async (runtimeId, text) => {
        await requestGateway('prompt.submit', { session_id: runtimeId, text }, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)
      },
      updateSession: (runtimeId, updater) => updateSessionState(runtimeId, updater)
    })
  }, [
    archiveSession,
    branchStoredSession,
    executeSlashCommand,
    removeSession,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    updateSessionState
  ])
}
