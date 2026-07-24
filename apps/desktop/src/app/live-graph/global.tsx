import { useStore } from '@nanostores/react'
import { replaceEqualDeep, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import type { TenantLoopSource } from '@/app/chat/loop-state'
import { sessionRoute } from '@/app/routes'
import { getWorkflowOverview, type WorkflowOverviewBoard, type WorkflowOverviewResponse } from '@/hermes'
import { useI18n } from '@/i18n'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $projects, $projectTree, projectIdForCwd } from '@/store/projects'

import {
  buildGlobalLiveGraph,
  detectLiveGraphPulses,
  liveGraphEdgeId,
  liveGraphNodeId,
  type LiveGraphPulse,
  type LiveGraphSnapshot,
  type SessionLiveGraphInput
} from './model'
import { DEFAULT_LIVE_GRAPH_VIEW_STATE, LiveGraphPaneView } from './view'

const GLOBAL_REFETCH_MS = 5_000

export function mergeWorkflowOverviewBoards(
  previous: readonly WorkflowOverviewBoard[],
  response: Pick<WorkflowOverviewResponse, 'boards' | 'errors'>
): WorkflowOverviewBoard[] {
  const next = new Map(response.boards.map(board => [board.slug, board]))
  const failed = new Set(response.errors.map(error => error.board))

  for (const board of previous) {
    if (failed.has(board.slug) && !next.has(board.slug)) {
      next.set(board.slug, board)
    }
  }

  return [...next.values()].sort((left, right) => left.slug.localeCompare(right.slug))
}

export function mergeWorkflowOverview(
  previous: WorkflowOverviewResponse | null,
  response: WorkflowOverviewResponse
): WorkflowOverviewResponse {
  const boards = mergeWorkflowOverviewBoards(previous?.boards ?? [], response)
  let merged: WorkflowOverviewResponse = { ...response, boards }

  if (response.errors.length && previous) {
    const sessions = new Map(previous.sessions.map(session => [session.id, session]))

    for (const session of response.sessions) {
      sessions.set(session.id, session)
    }

    merged = {
      ...merged,
      sessions: [...sessions.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
  }

  return previous ? replaceEqualDeep(previous, merged) : merged
}

export function buildGlobalOverviewSnapshot(
  boards: readonly WorkflowOverviewBoard[],
  response: WorkflowOverviewResponse,
  profile: string,
  projects: ReturnType<typeof $projects.get>
): LiveGraphSnapshot {
  const sessionByIdentity = new Map<string, WorkflowOverviewResponse['sessions'][number]>()

  for (const session of response.sessions) {
    for (const id of new Set([session.id, session.current_session_id, ...session.lineage_session_ids])) {
      sessionByIdentity.set(id, session)
    }
  }

  const inputs: SessionLiveGraphInput[] = []
  const projectById = new Map(projects.map(project => [project.id, project]))
  const syntheticSessionNodeIds = new Set<string>()

  for (const board of boards) {
    const tasksByWorkflow = new Map<string, typeof board.tasks>()

    for (const task of board.tasks) {
      const workflowId = task.workflow_id?.trim()

      if (workflowId) {
        const tasks = tasksByWorkflow.get(workflowId) ?? []
        tasks.push(task)
        tasksByWorkflow.set(workflowId, tasks)
      }
    }

    const groups = new Map<
      string,
      {
        links: typeof board.links
        projectIds: Set<string>
        tasks: typeof board.tasks
        workers: typeof board.workers
        workflowIds: string[]
        workflows: typeof board.workflows
      }
    >()

    const ownerByWorkflow = new Map<string, string>()

    for (const workflow of board.workflows) {
      const tasks = tasksByWorkflow.get(workflow.id) ?? []

      const rawOwner =
        workflow.origin_session_id?.trim() || tasks.find(task => task.session_id?.trim())?.session_id || ''

      const session = rawOwner ? sessionByIdentity.get(rawOwner) : undefined
      const owner = session?.id || rawOwner || `unattached:${board.slug}`

      if (!session && owner.startsWith('unattached:')) {
        syntheticSessionNodeIds.add(liveGraphNodeId('session', profile, owner))
      }

      const group = groups.get(owner) ?? {
        links: [],
        projectIds: new Set<string>(),
        tasks: [],
        workers: [],
        workflowIds: [],
        workflows: []
      }

      group.workflowIds.push(workflow.id)
      group.workflows.push(workflow)
      groups.set(owner, group)
      ownerByWorkflow.set(workflow.id, owner)
    }

    const ownerByTask = new Map<string, string>()

    for (const task of board.tasks) {
      const workflowId = task.workflow_id?.trim() || ''
      const owner = ownerByWorkflow.get(workflowId)

      if (!owner) {
        continue
      }

      const group = groups.get(owner)

      if (!group) {
        continue
      }

      group.tasks.push(task)
      ownerByTask.set(task.id, owner)

      const projectId = task.project_id?.trim()

      if (projectId) {
        group.projectIds.add(projectId)
      }
    }

    for (const link of board.links) {
      const owner = ownerByTask.get(link.child_id)

      if (owner && owner === ownerByTask.get(link.parent_id)) {
        groups.get(owner)?.links.push(link)
      }
    }

    for (const worker of board.workers) {
      const owner = ownerByTask.get(worker.task_id)

      if (owner) {
        groups.get(owner)?.workers.push(worker)
      }
    }

    for (const [owner, group] of groups) {
      const session = sessionByIdentity.get(owner)
      const cwd = session?.cwd?.trim() || ''
      const projectId = group.projectIds.size === 1 ? [...group.projectIds][0] : cwd ? projectIdForCwd(cwd) : null
      const project = projectId ? projectById.get(projectId) : undefined

      const source: TenantLoopSource = {
        board: board.slug,
        latest_event_id: board.source_revision,
        links: group.links,
        session_id: session?.current_session_id || owner,
        source_revision: board.source_revision,
        tasks: group.tasks,
        workflow_id: group.workflowIds.length === 1 ? group.workflowIds[0] : null,
        workflow_ids: group.workflowIds,
        workflows: group.workflows,
        workers: group.workers
      }

      inputs.push({
        loopagents: [],
        profile,
        project: project ? { boardSlug: project.board_slug, id: project.id, name: project.name } : undefined,
        session: {
          cwd: session?.cwd || null,
          id: session?.id || owner,
          openable: Boolean(session),
          title: session?.title?.trim() || owner
        },
        sources: [source],
        subagents: []
      })
    }
  }

  inputs.sort((left, right) => left.session.title.localeCompare(right.session.title))
  const graph = buildGlobalLiveGraph(inputs)
  const nodes = graph.nodes.filter(node => !syntheticSessionNodeIds.has(node.id))
  const visibleNodeIds = new Set(nodes.map(node => node.id))
  const nodesById = new Map(nodes.map(node => [node.id, node]))

  const edges = new Map(
    graph.edges
      .filter(edge => visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId))
      .map(edge => [edge.id, edge])
  )

  for (const board of boards) {
    for (const link of board.links) {
      const sourceId = liveGraphNodeId('task', profile, board.slug, link.child_id)
      const targetId = liveGraphNodeId('task', profile, board.slug, link.parent_id)
      const source = nodesById.get(sourceId)
      const target = nodesById.get(targetId)

      if (source && target && (!source.workflowId || source.workflowId !== target.workflowId)) {
        const id = liveGraphEdgeId('depends_on', sourceId, targetId)
        edges.set(id, { id, kind: 'depends_on', sourceId, targetId })
      }
    }
  }

  return {
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    nodes,
    ...(graph.rootId && visibleNodeIds.has(graph.rootId) ? { rootId: graph.rootId } : {})
  }
}

function GlobalLiveGraphProfileView({ profile }: { profile: string }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const projects = useStore($projects)
  useStore($projectTree)
  const previousGraphRef = useRef<LiveGraphSnapshot | null>(null)
  const lastGraphRef = useRef<LiveGraphSnapshot | null>(null)
  const lastPulsesRef = useRef<readonly LiveGraphPulse[]>([])

  const overview = useQuery({
    queryKey: ['loop-workflow-overview', profile],
    queryFn: () => getWorkflowOverview(profile),
    refetchInterval: GLOBAL_REFETCH_MS,
    refetchOnWindowFocus: true,
    staleTime: GLOBAL_REFETCH_MS,
    structuralSharing: (previous, response) =>
      mergeWorkflowOverview(
        (previous as WorkflowOverviewResponse | undefined) ?? null,
        response as WorkflowOverviewResponse
      )
  })

  const currentOverview = overview.data ?? null

  const activeGraph = useMemo(
    () =>
      currentOverview ? buildGlobalOverviewSnapshot(currentOverview.boards, currentOverview, profile, projects) : null,
    [currentOverview, profile, projects]
  )

  const pulses = useMemo(
    () => (activeGraph ? detectLiveGraphPulses(previousGraphRef.current, activeGraph) : lastPulsesRef.current),
    [activeGraph]
  )

  useEffect(() => {
    if (!activeGraph) {
      return
    }

    previousGraphRef.current = activeGraph
    lastGraphRef.current = activeGraph
    lastPulsesRef.current = pulses
  }, [activeGraph, pulses])

  const graph = activeGraph ?? lastGraphRef.current

  const error =
    currentOverview === null && overview.error
      ? overview.error instanceof Error
        ? overview.error.message
        : String(overview.error)
      : null

  return (
    <LiveGraphPaneView
      defaultViewState={{ ...DEFAULT_LIVE_GRAPH_VIEW_STATE, focusDepth: 'all' }}
      descriptor={{ key: 'global', profile, title: t.liveGraph.globalTitle }}
      error={error}
      graph={graph}
      loading={currentOverview === null && overview.isLoading}
      onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
      pulses={pulses}
      scope="global"
    />
  )
}

export function GlobalLiveGraphView() {
  const activeProfile = useStore($activeGatewayProfile)
  const profile = normalizeProfileKey(activeProfile)

  return <GlobalLiveGraphProfileView key={profile} profile={profile} />
}
