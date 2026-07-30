import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { paneMirror } from '@/app/chat/pane-mirror'
import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { getLoopSessionComments, getLoopSessionSources } from '@/hermes'
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

import { normalizeSessionMessages } from './messages'
import { buildSessionLiveGraph, detectLiveGraphPulses, type LiveGraphPulse, type LiveGraphSnapshot } from './model'
import { LiveGraphPaneView, type LiveGraphSidebarView } from './view'

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
  const [sidebarView, setSidebarView] = useState<LiveGraphSidebarView>('tasks')
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

  const commentsQuery = useQuery({
    queryKey: ['loop-session-comments', descriptor.sourceProfile, descriptor.sourceSessionId],
    queryFn: () => getLoopSessionComments(descriptor.sourceSessionId, descriptor.sourceProfile, sourceBoards),
    enabled: active && sidebarView === 'messages' && sourceQuery.data !== undefined,
    placeholderData: previous => previous,
    refetchInterval: active && sidebarView === 'messages' ? ACTIVE_REFETCH_MS : false,
    refetchOnWindowFocus: true,
    staleTime: ACTIVE_REFETCH_MS
  })

  const messages = useMemo(
    () => normalizeSessionMessages(descriptor.sourceProfile, commentsQuery.data ?? [], activeGraph?.nodes ?? []),
    [activeGraph?.nodes, commentsQuery.data, descriptor.sourceProfile]
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
      messageThread={{
        error:
          commentsQuery.error instanceof Error
            ? commentsQuery.error.message
            : commentsQuery.error
              ? String(commentsQuery.error)
              : null,
        loading: commentsQuery.isLoading,
        messages,
        onRetry: () => void commentsQuery.refetch()
      }}
      onMessageViewChange={setSidebarView}
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

    const title = translateNow('liveGraph.title')

    return descriptor ? `${title} · ${descriptor.title}` : title
  }
})
