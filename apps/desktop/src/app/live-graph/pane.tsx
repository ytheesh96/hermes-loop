import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { paneMirror } from '@/app/chat/pane-mirror'
import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { getLoopSessionSources, getLoopSessionThreads } from '@/hermes'
import { translateNow } from '@/i18n'
import {
  $liveGraphPanes,
  closeLiveGraphPane,
  LIVE_GRAPH_PANE_PREFIX,
  type LiveGraphPaneDescriptor,
  liveGraphPaneIdForDescriptor
} from '@/store/live-graph-panes'
import { $loopagentsBySession, type LoopagentActivity } from '@/store/loopagents'
import { $projects, $projectTree, projectIdForCwd } from '@/store/projects'
import { $sessions, sessionMatchesStoredId } from '@/store/session'
import { $subagentsBySession } from '@/store/subagents'

import { mergeSessionThreadSources, normalizeSessionThreads } from './messages'
import { buildSessionLiveGraph, detectLiveGraphPulses, type LiveGraphPulse, type LiveGraphSnapshot } from './model'
import { ScopedTaskFeedPaneView } from './scoped-task-feed'
import { LiveGraphPaneView } from './view'

const ACTIVE_REFETCH_MS = 2_000

function entriesForSession<T extends { id: string }>(
  map: Record<string, T[]>,
  keys: ReadonlySet<string>,
  identity: (entry: T) => string = entry => entry.id
): T[] {
  const byId = new Map<string, T>()

  for (const key of keys) {
    for (const entry of map[key] ?? []) {
      byId.set(identity(entry), entry)
    }
  }

  return [...byId.values()]
}

const loopagentIdentity = (entry: LoopagentActivity): string =>
  `${entry.board?.trim().toLowerCase() || ''}\u0000${entry.id}`

function LiveGraphPane({ descriptor }: { descriptor: LiveGraphPaneDescriptor }) {
  const layoutTree = useStore($layoutTree)
  const loopagentsBySession = useStore($loopagentsBySession)
  const projects = useStore($projects)
  useStore($projectTree)
  const sessions = useStore($sessions)
  const subagentsBySession = useStore($subagentsBySession)
  const [messagesVisible, setMessagesVisible] = useState(true)

  const paneId = liveGraphPaneIdForDescriptor(descriptor)
  const group = layoutTree ? findGroupOfPane(layoutTree, paneId) : null
  const active = group?.active === paneId

  const storedSession = sessions.find(
    session =>
      sessionMatchesStoredId(session, descriptor.sessionRootId) ||
      sessionMatchesStoredId(session, descriptor.sourceSessionId)
  )

  const sessionKeys = new Set([
    descriptor.sessionRootId,
    descriptor.sourceSessionId,
    ...(storedSession?._lineage_ids ?? []),
    ...(storedSession ? [storedSession.id, storedSession._lineage_root_id || ''] : [])
  ])

  sessionKeys.delete('')

  const loopagents = entriesForSession(loopagentsBySession, sessionKeys, loopagentIdentity)
  const subagents = entriesForSession(subagentsBySession, sessionKeys)

  const projectId = descriptor.cwd ? projectIdForCwd(descriptor.cwd) : null

  const project = projectId ? projects.find(candidate => candidate.id === projectId) : undefined

  const sourceQuery = useQuery({
    // Share the chat controller's source snapshot instead of starting a second
    // all-board poll for the same session when the graph is opened.
    queryKey: ['loop-session-source', descriptor.sourceProfile, descriptor.sourceSessionId],
    queryFn: () => getLoopSessionSources(descriptor.sourceSessionId, descriptor.sourceProfile),
    enabled: active,
    refetchInterval: active ? ACTIVE_REFETCH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: ACTIVE_REFETCH_MS
  })

  const activeGraph = useMemo(
    () =>
      active && sourceQuery.data !== undefined
        ? buildSessionLiveGraph({
            loopagents,
            profile: descriptor.sourceProfile,
            project: project ? { boardSlug: project.board_slug, id: project.id, name: project.name } : undefined,
            session: {
              cwd: descriptor.cwd || null,
              id: descriptor.sessionRootId,
              title: descriptor.title
            },
            sources: sourceQuery.data ?? [],
            subagents
          })
        : null,
    [
      active,
      descriptor.cwd,
      descriptor.sourceProfile,
      descriptor.sessionRootId,
      descriptor.title,
      loopagents,
      project,
      sourceQuery.data,
      subagents
    ]
  )

  const sourceBoards = useMemo(
    () => Array.from(new Set((sourceQuery.data ?? []).map(source => source.board?.trim() || 'default'))),
    [sourceQuery.data]
  )

  const threadIdentity = `${descriptor.sourceProfile}\u0000${descriptor.sourceSessionId}\u0000${sourceBoards.join('\u0000')}`
  const threadIdentityRef = useRef(threadIdentity)
  const threadSourcesRef = useRef<Awaited<ReturnType<typeof getLoopSessionThreads>>>([])

  const commentsQuery = useQuery({
    queryKey: ['loop-session-threads', descriptor.sourceProfile, descriptor.sourceSessionId, sourceBoards],
    queryFn: async () => {
      if (threadIdentityRef.current !== threadIdentity) {
        threadIdentityRef.current = threadIdentity
        threadSourcesRef.current = []
      }

      const cursors = Object.fromEntries(
        threadSourcesRef.current.map(source => [source.board, source.latest_reply_id || 0])
      )

      const delta = await getLoopSessionThreads(
        descriptor.sourceSessionId,
        descriptor.sourceProfile,
        sourceBoards,
        cursors
      )

      threadSourcesRef.current = mergeSessionThreadSources(threadSourcesRef.current, delta)

      return threadSourcesRef.current
    },
    enabled: descriptor.mode === 'feed' && active && messagesVisible && sourceQuery.data !== undefined,
    refetchInterval: descriptor.mode === 'feed' && active && messagesVisible ? ACTIVE_REFETCH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: ACTIVE_REFETCH_MS
  })

  const messages = useMemo(
    () => normalizeSessionThreads(descriptor.sourceProfile, commentsQuery.data ?? []),
    [commentsQuery.data, descriptor.sourceProfile]
  )

  const previousGraphRef = useRef<LiveGraphSnapshot | null>(null)
  const lastRenderedGraphRef = useRef<LiveGraphSnapshot | null>(null)
  const lastRenderedPulsesRef = useRef<readonly LiveGraphPulse[]>([])

  const pulses = useMemo(
    () => (activeGraph ? detectLiveGraphPulses(previousGraphRef.current, activeGraph) : lastRenderedPulsesRef.current),
    [activeGraph]
  )

  const graph = activeGraph ?? lastRenderedGraphRef.current

  // eslint-disable-next-line no-restricted-syntax -- Refs retain prior rendered graph state for transition detection.
  useEffect(() => {
    if (!activeGraph) {
      return
    }

    previousGraphRef.current = activeGraph
    lastRenderedGraphRef.current = activeGraph
    lastRenderedPulsesRef.current = pulses
  }, [activeGraph, pulses])

  const messageThread = {
    error:
      commentsQuery.error instanceof Error
        ? commentsQuery.error.message
        : commentsQuery.error
          ? String(commentsQuery.error)
          : null,
    loading: commentsQuery.isLoading,
    messages,
    onRetry: () => void commentsQuery.refetch(),
    sourceProfile: descriptor.sourceProfile
  }

  if (descriptor.mode === 'feed') {
    return (
      <ScopedTaskFeedPaneView
        error={
          sourceQuery.data === undefined
            ? sourceQuery.error instanceof Error
              ? sourceQuery.error.message
              : sourceQuery.error
                ? String(sourceQuery.error)
                : null
            : null
        }
        graph={graph ?? { edges: [], nodes: [] }}
        loading={sourceQuery.isLoading}
        messageThread={messageThread}
        onMessagesVisibleChange={visible => setMessagesVisible(visible)}
        sourceProfile={descriptor.sourceProfile}
      />
    )
  }

  return (
    <LiveGraphPaneView
      descriptor={descriptor}
      error={
        sourceQuery.data !== undefined
          ? null
          : sourceQuery.error instanceof Error
            ? sourceQuery.error.message
            : sourceQuery.error
              ? String(sourceQuery.error)
              : null
      }
      graph={graph}
      loading={sourceQuery.isLoading}
      pulses={pulses}
    />
  )
}

function descriptorForKey(key: string): LiveGraphPaneDescriptor | undefined {
  return $liveGraphPanes.get().find(descriptor => descriptor.key === key)
}

/** Mirror every persisted session graph into a native, independently mounted tab. */
export const watchLiveGraphPanes = paneMirror<LiveGraphPaneDescriptor>({
  source: $liveGraphPanes,
  anchor: descriptor => descriptor.sourcePaneId,
  close: closeLiveGraphPane,
  dir: descriptor => descriptor.dock,
  keepAliveWhenInactive: true,
  key: descriptor => descriptor.key,
  minWidth: '22rem',
  prefix: LIVE_GRAPH_PANE_PREFIX,
  render: key => {
    const descriptor = descriptorForKey(key)

    return descriptor ? <LiveGraphPane descriptor={descriptor} /> : null
  },
  replacements: (previous, next) =>
    next.flatMap(descriptor =>
      descriptor.replacesKey && previous.some(candidate => candidate.key === descriptor.replacesKey)
        ? [{ from: descriptor.replacesKey, to: descriptor.key }]
        : []
    ),
  title: key => {
    const descriptor = descriptorForKey(key)

    const title = translateNow(descriptor?.mode === 'feed' ? 'liveGraph.messagesTab' : 'liveGraph.title')

    return descriptor ? `${title} · ${descriptor.title}` : title
  }
})
