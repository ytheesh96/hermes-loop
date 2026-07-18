import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { StatusIndicator, type StatusIndicatorKind } from '@/components/chat/status-indicator'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { cn } from '@/lib/utils'

import type { LoopTaskAction, LoopTaskCreateOptions } from './loop-panel'
import {
  isDoneLoopRow,
  isGraphActiveLoopRow,
  LOOP_FAILED_STATUSES,
  LOOP_TERMINAL_STATUSES,
  loopAttentionText,
  loopTextValue,
  loopWorkerCurrentTool,
  normalizedLoopValue
} from './loop-selectors'
import {
  type LoopRow,
  loopTaskAllowsDependencyEdits,
  loopTaskAllowsDependencySource,
  loopTaskPhaseLabel
} from './loop-state'

function loopGraphTargetAllowsDependency(row: LoopRow): boolean {
  return loopTaskAllowsDependencyEdits(row)
}

function loopRowStatusIndicator(row: LoopRow): StatusIndicatorKind {
  const status = normalizedLoopValue(row.status)
  const runStatus = normalizedLoopValue(row.latestRun?.status)
  const runOutcome = normalizedLoopValue(row.latestRun?.outcome)

  if (row.specificationFailure) {
    return row.specificationFailure.backing_off ? 'attention' : 'failed'
  }

  const failed =
    LOOP_FAILED_STATUSES.has(status) ||
    LOOP_FAILED_STATUSES.has(runStatus) ||
    LOOP_FAILED_STATUSES.has(runOutcome)

  if (failed) {
    return 'failed'
  }

  const attentionText = loopAttentionText(row)

  if (attentionText.includes('review-required') || attentionText.includes('review required')) {
    return 'attention'
  }

  if (isGraphActiveLoopRow(row)) {
    return 'active'
  }

  if (isDoneLoopRow(row)) {
    return 'done'
  }

  if (status === 'triage') {
    return 'triage'
  }

  if (status === 'todo' || status === 'ready' || status === 'scheduled') {
    return 'pending'
  }

  return 'unknown'
}

function LoopStatusIndicator({ row }: { row: LoopRow }) {
  return (
    <StatusIndicator
      ariaLabel={`Status: ${loopTaskPhaseLabel(row) || row.status}`}
      kind={loopRowStatusIndicator(row)}
    />
  )
}

interface LoopTaskGraphEdge {
  from: string
  secondary?: boolean
  to: string
}

interface LoopTaskGraphPoint {
  x: number
  y: number
}

export interface LoopTaskGraphPosition extends LoopTaskGraphPoint {
  taskId: string
}

interface LoopTaskGraphCreateDraft extends LoopTaskGraphPoint {
  childId?: string
  parentId?: string
}

type LoopTaskGraphConnectionSide = 'input' | 'output'

interface LoopTaskGraphConnectionDrag {
  clientX: number
  clientY: number
  moved: boolean
  pointerId: number
  side: LoopTaskGraphConnectionSide
  startClientX: number
  startClientY: number
  startWorldX: number
  startWorldY: number
  taskId: string
  worldX: number
  worldY: number
}

interface LoopTaskGraphArmedConnection {
  side: LoopTaskGraphConnectionSide
  taskId: string
}

interface LoopTaskGraphNodeDrag {
  currentX: number
  currentY: number
  moved: boolean
  pointerId: number
  startPositions: Map<string, LoopTaskGraphPoint>
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  taskId: string
}

interface LoopTaskGraphConnectedEdge {
  edge: LoopTaskGraphEdge
  from: LoopTaskGraphNodeLayout
  key: string
  to: LoopTaskGraphNodeLayout
}

interface LoopTaskGraphPreparedEdge extends LoopTaskGraphConnectedEdge {
  endX: number
  startX: number
}

interface LoopTaskGraphRenderedEdge {
  actionX: number
  actionY: number
  d: string
  edge: LoopTaskGraphEdge
  railX?: number
}

interface LoopTaskGraphNodeLayout {
  depth: number
  index: number
  row: LoopRow
  x: number
  y: number
}

interface LoopTaskGraphLayout {
  edges: LoopTaskGraphEdge[]
  height: number
  nodes: LoopTaskGraphNodeLayout[]
  width: number
}

interface LoopTaskGraphBounds {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

interface LoopTaskGraphFocusState {
  edgeKeys: Set<string>
  nodeIds: Set<string>
  taskId: null | string
}

const LOOP_GRAPH_NODE_WIDTH = 188
const LOOP_GRAPH_NODE_HEIGHT = 76

const LOOP_GRAPH_NODE_CLASS =
  'absolute z-20 flex flex-col gap-1 overflow-hidden rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) py-2 pl-3 pr-2 text-left shadow-none transition-colors hover:border-(--ui-stroke-primary) hover:bg-(--ui-row-hover-background) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

const LOOP_GRAPH_ACTION_TRAY_CLASS =
  'absolute z-30 flex items-center gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-1 shadow-nous'

const LOOP_GRAPH_COLUMN_GAP = 18
const LOOP_GRAPH_COMPONENT_GAP = 72
const LOOP_GRAPH_ROW_GAP = 34
const LOOP_GRAPH_PADDING = 32
const LOOP_GRAPH_CANVAS_PADDING = 32
const LOOP_GRAPH_MIN_ZOOM = 0.3
const LOOP_GRAPH_MAX_ZOOM = 2
const LOOP_GRAPH_ZOOM_SENSITIVITY = 0.0015
const LOOP_GRAPH_KEYBOARD_PAN_STEP = 48
const LOOP_GRAPH_MINIMAP_HEIGHT = 112
const LOOP_GRAPH_MINIMAP_PADDING = 6
const LOOP_GRAPH_MINIMAP_WIDTH = 264
const LOOP_GRAPH_EDGE_PORT_PADDING = 24
const LOOP_GRAPH_EDGE_ROUTE_RADIUS = 6
const LOOP_GRAPH_EDGE_RAIL_INSET = 4
const LOOP_GRAPH_EDGE_RAIL_GAP = 6
const LOOP_GRAPH_EDGE_RAIL_BALANCE_COST = 96

interface LoopGraphViewportSize {
  height: number
  width: number
}

interface LoopGraphView {
  scale: number
  x: number
  y: number
}

const EMPTY_LOOP_GRAPH_VIEWPORT: LoopGraphViewportSize = { height: 0, width: 0 }
const INITIAL_LOOP_GRAPH_VIEW: LoopGraphView = { scale: 1, x: 0, y: 0 }

function clampLoopGraphZoom(zoom: number): number {
  return Math.min(LOOP_GRAPH_MAX_ZOOM, Math.max(LOOP_GRAPH_MIN_ZOOM, zoom))
}

function loopTaskGraphBounds(
  layout: LoopTaskGraphLayout,
  createDraft?: LoopTaskGraphCreateDraft | null
): LoopTaskGraphBounds {
  const points = layout.nodes.map(node => ({ x: node.x, y: node.y }))

  if (createDraft) {
    points.push(createDraft)
  }

  if (points.length === 0) {
    return { bottom: layout.height, height: layout.height, left: 0, right: layout.width, top: 0, width: layout.width }
  }

  const left = Math.min(...points.map(point => point.x - LOOP_GRAPH_PADDING))
  const top = Math.min(...points.map(point => point.y - LOOP_GRAPH_PADDING))
  const right = Math.max(...points.map(point => point.x + LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_PADDING))
  const bottom = Math.max(...points.map(point => point.y + LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_PADDING))

  return { bottom, height: bottom - top, left, right, top, width: right - left }
}

function frameLoopGraphView(bounds: LoopTaskGraphBounds, viewport: LoopGraphViewportSize): LoopGraphView {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return INITIAL_LOOP_GRAPH_VIEW
  }

  const availableWidth = Math.max(1, viewport.width - LOOP_GRAPH_CANVAS_PADDING * 2)
  const availableHeight = Math.max(1, viewport.height - LOOP_GRAPH_CANVAS_PADDING * 2)
  const scale = clampLoopGraphZoom(Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height))

  return {
    scale,
    x: Math.round((viewport.width - bounds.width * scale) / 2 - bounds.left * scale),
    y: Math.round((viewport.height - bounds.height * scale) / 2 - bounds.top * scale)
  }
}

function roundedLoopGraphView(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function loopTaskGraphPositionList(positions: ReadonlyMap<string, LoopTaskGraphPoint>): LoopTaskGraphPosition[] {
  return Array.from(positions, ([taskId, point]) => ({ taskId, x: point.x, y: point.y })).sort((a, b) =>
    a.taskId.localeCompare(b.taskId)
  )
}

function loopGraphTargetIsInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-loop-task-graph-interaction]'))
}

type LoopTaskGraphNodeKind = 'blocker' | 'review' | 'task' | 'worker'

function loopTaskGraphNodeKind(row: LoopRow): LoopTaskGraphNodeKind {
  if (normalizedLoopValue(row.status) === 'blocked') {
    return 'blocker'
  }

  if (row.reviewKind || normalizedLoopValue(row.status) === 'review') {
    return 'review'
  }

  if (row.workerActivity || isGraphActiveLoopRow(row)) {
    return 'worker'
  }

  return 'task'
}

function loopTaskGraphDependencyCount(row: LoopRow): number {
  return new Set([...row.parents, ...row.children]).size
}

function loopTaskGraphEdges(rows: LoopRow[]): LoopTaskGraphEdge[] {
  const rowById = new Map(rows.map(row => [row.taskId, row]))
  const edgeKeys = new Set<string>()
  const edges: LoopTaskGraphEdge[] = []

  const addEdge = (from: string, to: string) => {
    if (from === to || !rowById.has(from) || !rowById.has(to)) {
      return
    }

    const key = `${from}:${to}`

    if (edgeKeys.has(key)) {
      return
    }

    edgeKeys.add(key)
    edges.push({
      from,
      to
    })
  }

  for (const row of rows) {
    // Loop subtasks carry their parent task IDs; render those parents as owning this row in the graph.
    for (const parentId of row.parents) {
      addEdge(parentId, row.taskId)
    }

    for (const childId of row.children) {
      addEdge(row.taskId, childId)
    }
  }

  return edges
}

function breakCyclesForLayout(edges: LoopTaskGraphEdge[]): {
  dagEdges: LoopTaskGraphEdge[]
  backEdges: LoopTaskGraphEdge[]
} {
  const adj = new Map<string, string[]>()
  const taskIds = new Set<string>()

  for (const edge of edges) {
    adj.set(edge.from, [...(adj.get(edge.from) || []), edge.to])
    taskIds.add(edge.from)
    taskIds.add(edge.to)
  }

  for (const neighbors of adj.values()) {
    neighbors.sort()
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const backEdgesSet = new Set<string>()

  const dfs = (node: string) => {
    visiting.add(node)

    for (const neighbor of adj.get(node) || []) {
      if (visiting.has(neighbor)) {
        backEdgesSet.add(`${node}:${neighbor}`)
      } else if (!visited.has(neighbor)) {
        dfs(neighbor)
      }
    }

    visiting.delete(node)
    visited.add(node)
  }

  for (const taskId of Array.from(taskIds).sort()) {
    if (!visited.has(taskId)) {
      dfs(taskId)
    }
  }

  const dagEdges: LoopTaskGraphEdge[] = []
  const backEdges: LoopTaskGraphEdge[] = []

  for (const edge of edges) {
    if (backEdgesSet.has(`${edge.from}:${edge.to}`)) {
      backEdges.push(edge)
    } else {
      dagEdges.push(edge)
    }
  }

  return { dagEdges, backEdges }
}

function reduceLoopTaskGraphEdges(edges: LoopTaskGraphEdge[]): LoopTaskGraphEdge[] {
  const outgoing = new Map<string, LoopTaskGraphEdge[]>()

  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge])
  }

  const hasAlternatePath = (excluded: LoopTaskGraphEdge) => {
    const pending = (outgoing.get(excluded.from) || []).filter(edge => edge !== excluded).map(edge => edge.to)
    const visited = new Set<string>()

    while (pending.length > 0) {
      const taskId = pending.pop()!

      if (taskId === excluded.to) {
        return true
      }

      if (visited.has(taskId)) {
        continue
      }

      visited.add(taskId)

      for (const edge of outgoing.get(taskId) || []) {
        pending.push(edge.to)
      }
    }

    return false
  }

  return edges.filter(edge => !hasAlternatePath(edge))
}

function orderLoopTaskGraphLayers(
  rowsByDepth: Map<number, LoopRow[]>,
  sortedDepths: number[],
  dagEdges: LoopTaskGraphEdge[],
  rowIndexById: Map<string, number>
) {
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()

  for (const edge of dagEdges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from])
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to])
  }

  const positions = () => {
    const byTaskId = new Map<string, number>()

    for (const depth of sortedDepths) {
      const layer = rowsByDepth.get(depth) || []

      layer.forEach((row, index) => byTaskId.set(row.taskId, (index + 1) / (layer.length + 1)))
    }

    return byTaskId
  }

  const sortLayer = (depth: number, neighborsByTaskId: Map<string, string[]>) => {
    const layer = rowsByDepth.get(depth)

    if (!layer || layer.length < 2) {
      return
    }

    const positionByTaskId = positions()
    const currentIndexByTaskId = new Map(layer.map((row, index) => [row.taskId, index]))

    const score = (row: LoopRow) => {
      const neighborPositions = (neighborsByTaskId.get(row.taskId) || [])
        .map(taskId => positionByTaskId.get(taskId))
        .filter((position): position is number => position !== undefined)

      return neighborPositions.length > 0
        ? neighborPositions.reduce((total, position) => total + position, 0) / neighborPositions.length
        : ((currentIndexByTaskId.get(row.taskId) || 0) + 1) / (layer.length + 1)
    }

    layer.sort(
      (a, b) =>
        score(a) - score(b) ||
        (currentIndexByTaskId.get(a.taskId) || 0) - (currentIndexByTaskId.get(b.taskId) || 0) ||
        (rowIndexById.get(a.taskId) || 0) - (rowIndexById.get(b.taskId) || 0)
    )
  }

  // ponytail: four barycentric sweeps remove common crossings; add a layout engine only if larger graphs prove this ceiling.
  for (let pass = 0; pass < 4; pass += 1) {
    for (let index = 1; index < sortedDepths.length; index += 1) {
      sortLayer(sortedDepths[index]!, incoming)
    }

    for (let index = sortedDepths.length - 2; index >= 0; index -= 1) {
      sortLayer(sortedDepths[index]!, outgoing)
    }
  }
}

function loopTaskGraphLayout(rows: LoopRow[]): LoopTaskGraphLayout {
  const graphRows = rows
  const rowIndexById = new Map(graphRows.map((row, index) => [row.taskId, index]))
  const edges = loopTaskGraphEdges(graphRows)
  const { backEdges, dagEdges } = breakCyclesForLayout(edges)
  const reducedDagEdges = reduceLoopTaskGraphEdges(dagEdges)
  const primaryEdgeKeys = new Set([...reducedDagEdges, ...backEdges].map(edge => `${edge.from}:${edge.to}`))
  const outgoing = new Map<string, string[]>()
  const indegreeById = new Map(graphRows.map(row => [row.taskId, 0]))
  const depthById = new Map(graphRows.map(row => [row.taskId, 0]))
  const topologicalOrder: string[] = []

  for (const edge of reducedDagEdges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to])
    indegreeById.set(edge.to, (indegreeById.get(edge.to) || 0) + 1)
  }

  for (const children of outgoing.values()) {
    children.sort()
  }

  const queue = graphRows
    .map(row => row.taskId)
    .filter(taskId => (indegreeById.get(taskId) || 0) === 0)
    .sort()

  while (queue.length > 0) {
    const taskId = queue.shift()!
    const currentDepth = depthById.get(taskId) || 0

    topologicalOrder.push(taskId)

    for (const childId of outgoing.get(taskId) || []) {
      depthById.set(childId, Math.max(depthById.get(childId) || 0, currentDepth + 1))
      const nextIndegree = (indegreeById.get(childId) || 0) - 1

      indegreeById.set(childId, nextIndegree)

      if (nextIndegree === 0) {
        queue.push(childId)
        queue.sort()
      }
    }
  }

  // Pull prerequisites down next to their earliest dependent so Tidy emphasizes direct links.
  for (let index = topologicalOrder.length - 1; index >= 0; index -= 1) {
    const taskId = topologicalOrder[index]!
    const children = outgoing.get(taskId) || []

    if (children.length > 0) {
      depthById.set(taskId, Math.min(...children.map(childId => (depthById.get(childId) ?? 0) - 1)))
    }
  }

  const neighborsByTaskId = new Map(graphRows.map(row => [row.taskId, [] as string[]]))

  for (const edge of edges) {
    neighborsByTaskId.get(edge.from)?.push(edge.to)
    neighborsByTaskId.get(edge.to)?.push(edge.from)
  }

  const remainingTaskIds = new Set(graphRows.map(row => row.taskId))
  const components: LoopRow[][] = []

  for (const row of graphRows) {
    if (!remainingTaskIds.delete(row.taskId)) {
      continue
    }

    const componentTaskIds = new Set([row.taskId])
    const queue = [row.taskId]

    while (queue.length > 0) {
      const taskId = queue.shift()!

      for (const neighborId of neighborsByTaskId.get(taskId) || []) {
        if (remainingTaskIds.delete(neighborId)) {
          componentTaskIds.add(neighborId)
          queue.push(neighborId)
        }
      }
    }

    components.push(graphRows.filter(candidate => componentTaskIds.has(candidate.taskId)))
  }

  const componentLayouts = components.map(componentRows => {
    const rowsByDepth = new Map<number, LoopRow[]>()

    for (const row of componentRows) {
      const depth = depthById.get(row.taskId) || 0
      const depthRows = rowsByDepth.get(depth) || []

      depthRows.push(row)
      rowsByDepth.set(depth, depthRows)
    }

    for (const depthRows of rowsByDepth.values()) {
      depthRows.sort((a, b) => (rowIndexById.get(a.taskId) || 0) - (rowIndexById.get(b.taskId) || 0))
    }

    const sortedDepths = Array.from(rowsByDepth.keys()).sort((a, b) => a - b)

    orderLoopTaskGraphLayers(rowsByDepth, sortedDepths, reducedDagEdges, rowIndexById)

    const maxRowColumns = Math.max(1, ...Array.from(rowsByDepth.values()).map(depthRows => depthRows.length))

    const width = maxRowColumns * LOOP_GRAPH_NODE_WIDTH + Math.max(0, maxRowColumns - 1) * LOOP_GRAPH_COLUMN_GAP

    return { rowsByDepth, sortedDepths, width }
  })

  const graphRowCount = Math.max(1, ...componentLayouts.map(component => component.sortedDepths.length))

  const graphBodyWidth =
    componentLayouts.reduce((total, component) => total + component.width, 0) +
    Math.max(0, componentLayouts.length - 1) * LOOP_GRAPH_COMPONENT_GAP

  const width = LOOP_GRAPH_PADDING * 2 + Math.max(LOOP_GRAPH_NODE_WIDTH, graphBodyWidth)

  const height = Math.max(
    LOOP_GRAPH_PADDING * 2 + LOOP_GRAPH_NODE_HEIGHT,
    LOOP_GRAPH_PADDING * 2 +
      graphRowCount * LOOP_GRAPH_NODE_HEIGHT +
      Math.max(0, graphRowCount - 1) * LOOP_GRAPH_ROW_GAP
  )

  const nodes: LoopTaskGraphNodeLayout[] = []
  let componentX = LOOP_GRAPH_PADDING

  componentLayouts.forEach(component => {
    component.sortedDepths.forEach((depth, depthIndex) => {
      const depthRows = component.rowsByDepth.get(depth) || []

      const rowWidth =
        depthRows.length * LOOP_GRAPH_NODE_WIDTH + Math.max(0, depthRows.length - 1) * LOOP_GRAPH_COLUMN_GAP

      const rowX = componentX + Math.max(0, (component.width - rowWidth) / 2)
      const rowY = LOOP_GRAPH_PADDING + depthIndex * (LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP)

      depthRows.forEach((row, index) => {
        nodes.push({
          depth,
          index,
          row,
          x: rowX + index * (LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_COLUMN_GAP),
          y: rowY
        })
      })
    })

    componentX += component.width + LOOP_GRAPH_COMPONENT_GAP
  })

  nodes.sort((a, b) => a.depth - b.depth || a.index - b.index)

  return {
    edges: edges.map(edge => ({ ...edge, secondary: !primaryEdgeKeys.has(`${edge.from}:${edge.to}`) })),
    height,
    nodes,
    width
  }
}

function loopTaskGraphWithPositions(
  layout: LoopTaskGraphLayout,
  positions: ReadonlyMap<string, LoopTaskGraphPoint>
): LoopTaskGraphLayout {
  if (positions.size === 0) {
    return layout
  }

  const nodes = layout.nodes.map(node => {
    const position = positions.get(node.row.taskId)

    return position ? { ...node, x: position.x, y: position.y } : node
  })

  return {
    ...layout,
    height: Math.max(layout.height, ...nodes.map(node => node.y + LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_PADDING)),
    nodes,
    width: Math.max(layout.width, ...nodes.map(node => node.x + LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_PADDING))
  }
}

function loopTaskGraphRoundedPath(points: LoopTaskGraphPoint[]): string {
  const route = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y
  )

  if (route.length < 2) {
    return ''
  }

  let path = `M ${route[0]!.x} ${route[0]!.y}`

  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1]!
    const corner = route[index]!
    const next = route[index + 1]!
    const incomingDistance = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outgoingDistance = Math.hypot(next.x - corner.x, next.y - corner.y)
    const radius = Math.min(LOOP_GRAPH_EDGE_ROUTE_RADIUS, incomingDistance / 2, outgoingDistance / 2)

    const before = {
      x: corner.x + ((previous.x - corner.x) / incomingDistance) * radius,
      y: corner.y + ((previous.y - corner.y) / incomingDistance) * radius
    }

    const after = {
      x: corner.x + ((next.x - corner.x) / outgoingDistance) * radius,
      y: corner.y + ((next.y - corner.y) / outgoingDistance) * radius
    }

    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`
  }

  const last = route.at(-1)!

  return `${path} L ${last.x} ${last.y}`
}

function loopTaskGraphFocusState(layout: LoopTaskGraphLayout, taskId?: null | string): LoopTaskGraphFocusState {
  const selectedTaskId = taskId?.trim() || null
  const rowIds = new Set(layout.nodes.map(node => node.row.taskId))

  if (!selectedTaskId || !rowIds.has(selectedTaskId)) {
    return { edgeKeys: new Set(), nodeIds: new Set(), taskId: null }
  }

  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  for (const edge of layout.edges) {
    if (!rowIds.has(edge.from) || !rowIds.has(edge.to)) {
      continue
    }

    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to])
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from])
  }

  const nodeIds = new Set<string>([selectedTaskId])

  const visit = (startId: string, map: Map<string, string[]>) => {
    const queue = [startId]

    while (queue.length > 0) {
      const currentId = queue.shift()!

      for (const nextId of map.get(currentId) || []) {
        if (nodeIds.has(nextId)) {
          continue
        }

        nodeIds.add(nextId)
        queue.push(nextId)
      }
    }
  }

  visit(selectedTaskId, incoming)
  visit(selectedTaskId, outgoing)

  const edgeKeys = new Set(
    layout.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map(edge => `${edge.from}:${edge.to}`)
  )

  return { edgeKeys, nodeIds, taskId: selectedTaskId }
}

function loopGraphRelatedTargetBelongsToInteraction(interactionId: string, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }

  return (
    target.closest('[data-loop-task-graph-interaction]')?.getAttribute('data-loop-task-graph-interaction') ===
    interactionId
  )
}

function LoopTaskGraphActionTray({
  layout,
  onActionEnd,
  onActionStart,
  onTaskAction
}: {
  layout: LoopTaskGraphNodeLayout
  onActionEnd: (taskId: string, relatedTarget: EventTarget | null) => void
  onActionStart: (taskId: string) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
}) {
  const { row, x, y } = layout
  const status = normalizedLoopValue(row.status)
  const blocked = normalizedLoopValue(row.status) === 'blocked'
  const terminal = LOOP_TERMINAL_STATUSES.has(status)

  const statusAction: LoopTaskAction = blocked ? 'unblock' : 'block'
  const statusLabel = blocked ? 'Unblock' : 'Block'

  return (
    <div
      className={LOOP_GRAPH_ACTION_TRAY_CLASS}
      data-loop-task-graph-interaction={row.taskId}
      data-testid={`loop-task-graph-action-tray-${row.taskId}`}
      onBlur={event => onActionEnd(row.taskId, event.relatedTarget)}
      onFocus={() => onActionStart(row.taskId)}
      onMouseEnter={() => onActionStart(row.taskId)}
      onMouseLeave={event => onActionEnd(row.taskId, event.relatedTarget)}
      style={{ left: x, top: y + LOOP_GRAPH_NODE_HEIGHT - 1 }}
    >
      {!terminal && (
        <Button
          aria-label={`${statusLabel} ${row.taskId}`}
          className="h-6 gap-1 px-1.5 text-[0.68rem]"
          disabled={!onTaskAction}
          onClick={event => {
            event.stopPropagation()
            onTaskAction?.(statusAction, row)
          }}
          type="button"
          variant="outline"
        >
          <Codicon name={blocked ? 'unlock' : 'lock'} size="0.72rem" />
          <span>{statusLabel}</span>
        </Button>
      )}
      {loopTaskAllowsDependencyEdits(row) ? (
        <Button
          aria-label={`Archive ${row.taskId}`}
          className="h-6 px-1.5 text-[0.68rem]"
          disabled={!onTaskAction}
          onClick={event => {
            event.stopPropagation()
            onTaskAction?.('archive', row)
          }}
          type="button"
          variant="outline"
        >
          <Codicon name="archive" size="0.72rem" />
        </Button>
      ) : null}
    </div>
  )
}

function LoopTaskGraphNode({
  armedSide,
  connectionTarget,
  dimmed,
  layout,
  onActionEnd,
  onActionStart,
  onActivate,
  onConnectionActivate,
  onConnectionStart,
  onDragStart,
  inputEnabled,
  onNudge,
  outputEnabled = true,
  pathConnected,
  selected
}: {
  armedSide?: LoopTaskGraphConnectionSide
  connectionTarget?: boolean
  dimmed?: boolean
  layout: LoopTaskGraphNodeLayout
  onActionEnd?: (taskId: string, relatedTarget: EventTarget | null) => void
  onActionStart?: (taskId: string) => void
  onActivate?: (row: LoopRow, event: ReactMouseEvent<HTMLButtonElement>) => void
  onConnectionActivate?: (taskId: string, side: LoopTaskGraphConnectionSide) => void
  onConnectionStart?: (
    taskId: string,
    side: LoopTaskGraphConnectionSide,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => void
  onDragStart?: (layout: LoopTaskGraphNodeLayout, event: ReactPointerEvent<HTMLButtonElement>) => void
  inputEnabled?: boolean
  onNudge?: (layout: LoopTaskGraphNodeLayout, deltaX: number, deltaY: number) => void
  outputEnabled?: boolean
  pathConnected?: boolean
  selected?: boolean
}) {
  const { row, x, y } = layout
  const currentTool = isGraphActiveLoopRow(row) ? loopWorkerCurrentTool(row) : undefined
  const assignee = loopTextValue(row.assignee)
  const nodeKind = loopTaskGraphNodeKind(row)
  const dependencyCount = loopTaskGraphDependencyCount(row)
  const phaseLabel = loopTaskPhaseLabel(row)
  const dependenciesEditable = inputEnabled ?? loopTaskAllowsDependencyEdits(row)

  return (
    <div
      className="group absolute z-20"
      data-loop-task-graph-interaction={row.taskId}
      onBlur={event => onActionEnd?.(row.taskId, event.relatedTarget)}
      onFocus={() => onActionStart?.(row.taskId)}
      onMouseEnter={() => onActionStart?.(row.taskId)}
      onMouseLeave={event => onActionEnd?.(row.taskId, event.relatedTarget)}
      style={{
        height: LOOP_GRAPH_NODE_HEIGHT,
        left: x,
        top: y,
        width: LOOP_GRAPH_NODE_WIDTH
      }}
    >
      <button
        aria-label={`${selected ? 'Selected' : 'Select'} ${row.title} (${row.taskId})`}
        aria-pressed={selected}
        className={cn(
          'relative flex h-full w-full flex-col gap-1 overflow-hidden rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) py-2 pl-3 pr-2 text-left shadow-none transition-colors hover:border-(--ui-stroke-primary) hover:bg-(--ui-row-hover-background) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          onActivate ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
          isDoneLoopRow(row) && 'bg-(--ui-bg-secondary)/45',
          pathConnected && !selected && 'border-(--ui-stroke-secondary) bg-(--ui-fill-quaternary)/45',
          selected &&
            'border-(--ui-stroke-primary) bg-(--ui-row-hover-background) shadow-nous ring-1 ring-(--ui-stroke-primary)/30',
          connectionTarget && 'ring-2 ring-emerald-500/70',
          dimmed && 'opacity-55'
        )}
        data-dimmed={dimmed ? 'true' : 'false'}
        data-path-connected={pathConnected ? 'true' : 'false'}
        data-selected={selected ? 'true' : 'false'}
        data-task-kind={nodeKind}
        data-testid={`loop-task-graph-node-${row.taskId}`}
        onClick={event => onActivate?.(row, event)}
        onKeyDown={event => {
          if (!event.altKey || !event.key.startsWith('Arrow')) {
            return
          }

          event.preventDefault()
          event.stopPropagation()
          onNudge?.(
            layout,
            event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0,
            event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
          )
        }}
        onPointerDown={event => onDragStart?.(layout, event)}
        type="button"
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-0 w-1',
            nodeKind === 'worker' && 'bg-sky-500/70',
            nodeKind === 'review' && 'bg-amber-500/75',
            nodeKind === 'blocker' && 'bg-red-500/70',
            nodeKind === 'task' && 'bg-(--ui-stroke-tertiary)'
          )}
        />
        <div className="flex min-w-0 items-start gap-2">
          <LoopStatusIndicator row={row} />
          <span className="min-w-0 flex-1 truncate text-[0.7rem] font-medium leading-4 text-(--ui-text-primary)">
            {row.title}
          </span>
        </div>
        {phaseLabel || assignee || currentTool ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {phaseLabel ? (
              <span
                className="min-w-0 truncate rounded-[0.2rem] bg-(--ui-fill-quaternary) px-1.5 py-0.5 text-[0.58rem] font-medium text-(--ui-text-tertiary)"
                data-testid={`loop-task-graph-phase-${row.taskId}`}
              >
                {phaseLabel}
              </span>
            ) : null}
            {assignee ? (
              <span className="min-w-0 max-w-full truncate rounded-[0.2rem] bg-(--ui-bg-secondary) px-1.5 py-0.5 text-[0.58rem] font-medium text-(--ui-text-tertiary)">
                {assignee}
              </span>
            ) : null}
            {currentTool ? (
              <span className="min-w-0 truncate text-[0.62rem] text-(--ui-text-tertiary) leading-none">
                {currentTool}
              </span>
            ) : null}
          </div>
        ) : null}
        {(dependencyCount > 0 || row.commentCount > 0) && (
          <div className="flex min-w-0 items-center gap-2 text-[0.58rem] text-(--ui-text-quaternary)">
            {dependencyCount > 0 ? (
              <span
                aria-label={loopGraphCountLabel(dependencyCount, 'dependency', 'dependencies')}
                className="inline-flex items-center gap-1"
              >
                <Codicon aria-hidden name="git-merge" size="0.62rem" />
                {dependencyCount}
              </span>
            ) : null}
            {row.commentCount > 0 ? (
              <span
                aria-label={loopGraphCountLabel(row.commentCount, 'comment')}
                className="inline-flex items-center gap-1"
              >
                <Codicon aria-hidden name="comment" size="0.62rem" />
                {row.commentCount}
              </span>
            ) : null}
          </div>
        )}
      </button>
      {dependenciesEditable ? (
        <button
          aria-label={`Connect a prerequisite into ${row.title}`}
          aria-pressed={armedSide === 'input'}
          className="absolute left-1/2 top-0 z-30 h-3 w-5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border border-(--ui-stroke-secondary) bg-(--ui-surface-background) opacity-0 shadow-sm transition-opacity hover:border-(--ui-stroke-primary) focus:opacity-100 group-hover:opacity-100"
          data-loop-connection-input={row.taskId}
          onClick={() => onConnectionActivate?.(row.taskId, 'input')}
          onPointerDown={event => onConnectionStart?.(row.taskId, 'input', event)}
          title={`Drop a preceding task here · drag outward to create a prerequisite for ${row.title}`}
          type="button"
        />
      ) : null}
      {outputEnabled ? (
        <button
          aria-label={`Connect a follow-up from ${row.title}`}
          aria-pressed={armedSide === 'output'}
          className="absolute bottom-0 left-1/2 z-30 h-3 w-5 -translate-x-1/2 translate-y-1/2 cursor-crosshair rounded-full border border-(--ui-stroke-secondary) bg-(--ui-surface-background) opacity-0 shadow-sm transition-opacity hover:border-(--ui-stroke-primary) focus:opacity-100 group-hover:opacity-100"
          data-loop-connection-output={row.taskId}
          onClick={() => onConnectionActivate?.(row.taskId, 'output')}
          onPointerDown={event => onConnectionStart?.(row.taskId, 'output', event)}
          title={`Drag to another task or empty space to add a follow-up for ${row.title}`}
          type="button"
        />
      ) : null}
    </div>
  )
}

function loopGraphCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function loopGraphSummaryItems(rows: LoopRow[]): { key: string; label: string }[] {
  const active = rows.filter(row => row.active || isGraphActiveLoopRow(row)).length

  const blockers = rows.filter(row => normalizedLoopValue(row.status) === 'blocked').length

  const reviews = rows.filter(row => {
    const status = normalizedLoopValue(row.status)
    const text = loopAttentionText(row)

    return (
      Boolean(row.reviewKind) ||
      status === 'review' ||
      text.includes('review-required') ||
      text.includes('review required')
    )
  }).length

  return [
    active > 0 ? { key: 'active', label: loopGraphCountLabel(active, 'active', 'active') } : null,
    blockers > 0 ? { key: 'blocker', label: loopGraphCountLabel(blockers, 'blocker') } : null,
    reviews > 0 ? { key: 'review', label: loopGraphCountLabel(reviews, 'review') } : null
  ].filter((item): item is { key: string; label: string } => Boolean(item))
}

function LoopGraphSummary({ rows }: { rows: LoopRow[] }) {
  const items = loopGraphSummaryItems(rows)

  if (items.length === 0) {
    return null
  }

  return (
    <div className="mb-2 flex flex-wrap gap-1" data-testid="loop-graph-summary">
      {items.map(item => (
        <span
          className="rounded border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) px-1.5 py-0.5 text-[0.62rem] text-(--ui-text-tertiary)"
          key={item.key}
        >
          {item.label}
        </span>
      ))}
    </div>
  )
}

function LoopTaskGraphCreateNode({
  draft,
  onCancel,
  onCreated,
  onCreateTask,
  scopeKey,
  workflowId
}: {
  draft: LoopTaskGraphCreateDraft
  onCancel: () => void
  onCreated: (taskId: string, draft: LoopTaskGraphCreateDraft, scopeKey: string) => void
  onCreateTask?: (idea: string, options?: LoopTaskCreateOptions) => Promise<null | string>
  scopeKey: string
  workflowId?: string
}) {
  const [actionsVisible, setActionsVisible] = useState(false)
  const [creating, setCreating] = useState(false)
  const [idea, setIdea] = useState('')

  const createTask = useCallback(async () => {
    const taskIdea = idea.trim()

    if (!taskIdea || !onCreateTask || creating) {
      return
    }

    setCreating(true)

    try {
      const options: LoopTaskCreateOptions = {
        ...(draft.childId ? { childId: draft.childId } : {}),
        ...(draft.parentId ? { parentId: draft.parentId } : {}),
        ...(workflowId ? { workflowId } : {})
      }

      const taskId = Object.keys(options).length ? await onCreateTask(taskIdea, options) : await onCreateTask(taskIdea)

      if (taskId) {
        setIdea('')
        onCreated(taskId, draft, scopeKey)
      }
    } finally {
      setCreating(false)
    }
  }, [creating, draft, idea, onCreateTask, onCreated, scopeKey, workflowId])

  const hideActions = (relatedTarget: EventTarget | null) => {
    if (!loopGraphRelatedTargetBelongsToInteraction('create-task', relatedTarget)) {
      setActionsVisible(false)
    }
  }

  return (
    <form
      data-loop-task-graph-interaction="create-task"
      onBlur={event => hideActions(event.relatedTarget)}
      onFocus={() => setActionsVisible(true)}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={event => hideActions(event.relatedTarget)}
      onSubmit={event => {
        event.preventDefault()
        void createTask()
      }}
    >
      <section
        aria-busy={creating}
        aria-label="Add a Loop task"
        className={cn(LOOP_GRAPH_NODE_CLASS, 'cursor-default')}
        data-loop-task-graph-interaction="create-task"
        data-task-kind="task"
        data-testid="loop-task-create-card"
        role="region"
        style={{
          height: LOOP_GRAPH_NODE_HEIGHT,
          left: draft.x,
          top: draft.y,
          width: LOOP_GRAPH_NODE_WIDTH
        }}
      >
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-(--ui-stroke-tertiary)" />
        <div className="flex min-w-0 items-start gap-2">
          <StatusIndicator ariaLabel="New Loop task" kind="triage" />
          <label className="min-w-0 flex-1">
            <span className="sr-only">Rough idea</span>
            <input
              autoFocus
              className="h-6 w-full rounded-[0.2rem] border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) px-1.5 text-[0.62rem] text-(--ui-text-primary) outline-none placeholder:text-(--ui-text-quaternary) focus:border-(--ui-stroke-primary) disabled:cursor-not-allowed disabled:opacity-60"
              disabled={creating}
              onChange={event => setIdea(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createTask()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  onCancel()
                }
              }}
              placeholder="Rough idea…"
              title="Create a title-only task in the live Loop graph."
              value={idea}
            />
          </label>
        </div>
        <span className="text-[0.58rem] text-(--ui-text-tertiary)">Routing is assigned automatically</span>
      </section>
      {actionsVisible ? (
        <div
          className={LOOP_GRAPH_ACTION_TRAY_CLASS}
          data-loop-task-graph-interaction="create-task"
          data-testid="loop-task-graph-create-action-tray"
          style={{
            left: draft.x,
            top: draft.y + LOOP_GRAPH_NODE_HEIGHT
          }}
        >
          <Button
            aria-label="Add task"
            className="h-6 w-6 shrink-0 p-0"
            disabled={!onCreateTask || creating || !idea.trim()}
            type="submit"
            variant="default"
          >
            <Codicon name={creating ? 'loading' : 'add'} size="0.7rem" />
          </Button>
          <Button
            aria-label="Cancel new task"
            className="h-6 w-6 shrink-0 p-0"
            disabled={creating}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            <Codicon name="close" size="0.7rem" />
          </Button>
        </div>
      ) : null}
    </form>
  )
}

export function LoopTaskGraph({
  fullPanel = false,
  onCreateTask,
  onLinkTasks,
  onUnlinkTasks,
  onOpenTaskTab,
  onSavePositions,
  onSelectTask,
  onTaskAction,
  positions,
  scopeKey,
  rows,
  selectedTaskId,
  workflowId
}: {
  fullPanel?: boolean
  onCreateTask?: (idea: string, options?: LoopTaskCreateOptions) => Promise<null | string>
  onLinkTasks?: (parentId: string, childId: string) => Promise<boolean>
  onUnlinkTasks?: (parentId: string, childId: string) => Promise<boolean>
  onOpenTaskTab?: (row: LoopRow) => void
  onSavePositions?: (positions: LoopTaskGraphPosition[], workflowId?: string) => Promise<boolean>
  onSelectTask?: (row: LoopRow) => void
  onTaskAction?: (action: LoopTaskAction, row: LoopRow) => void
  positions?: LoopTaskGraphPosition[]
  scopeKey?: string
  rows: LoopRow[]
  selectedTaskId?: null | string
  workflowId?: string
}) {
  const [view, setView] = useState<LoopGraphView>(INITIAL_LOOP_GRAPH_VIEW)
  const [hoveredTaskId, setHoveredTaskId] = useState<null | string>(null)
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<null | string>(null)
  const [removingEdgeKey, setRemovingEdgeKey] = useState<null | string>(null)
  const [minimapOpen, setMinimapOpen] = useState(true)

  const [createDraft, setCreateDraft] = useState<LoopTaskGraphCreateDraft | null>(() =>
    rows.length === 0 ? { x: LOOP_GRAPH_PADDING, y: LOOP_GRAPH_PADDING } : null
  )

  const [awaitingCreatedTaskId, setAwaitingCreatedTaskId] = useState<null | string>(null)

  const [positionOverrides, setPositionOverrides] = useState<Map<string, LoopTaskGraphPoint>>(
    () => new Map(positions?.map(position => [position.taskId, { x: position.x, y: position.y }]))
  )

  const [undoPositions, setUndoPositions] = useState<Map<string, LoopTaskGraphPoint> | null>(null)
  const [connectionDrag, setConnectionDrag] = useState<LoopTaskGraphConnectionDrag | null>(null)
  const [connectionTargetTaskId, setConnectionTargetTaskId] = useState<null | string>(null)
  const [armedConnection, setArmedConnection] = useState<LoopTaskGraphArmedConnection | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<null | { pointerId: number; startView: LoopGraphView; startX: number; startY: number }>(null)
  const nodeDragRef = useRef<LoopTaskGraphNodeDrag | null>(null)
  const connectionDragRef = useRef<LoopTaskGraphConnectionDrag | null>(null)
  const suppressNodeClickRef = useRef<null | string>(null)
  const suppressConnectionClickRef = useRef(false)
  const graphScopeKey = scopeKey || workflowId || rows[0]?.taskId || 'empty'
  const graphScopeRef = useRef(graphScopeKey)
  const positionSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingPositionSavesRef = useRef(0)
  const lastAutoFrameKeyRef = useRef<null | string>(null)
  const minimapDragRef = useRef<null | number>(null)
  const [canvasViewport, setCanvasViewport] = useState<LoopGraphViewportSize>(EMPTY_LOOP_GRAPH_VIEWPORT)

  const measureCanvasViewport = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      if (!fullPanel) {
        return
      }

      const entry = entries.find(candidate => candidate.target === canvasRef.current) || entries[0]
      const rect = entry?.contentRect
      let width = rect?.width || 0
      let height = rect?.height || 0

      if ((!width || !height) && canvasRef.current) {
        const bounds = canvasRef.current.getBoundingClientRect()
        width = bounds.width
        height = bounds.height
      }

      if (width <= 0 || height <= 0) {
        return
      }

      setCanvasViewport(current =>
        Math.round(current.width) === Math.round(width) && Math.round(current.height) === Math.round(height)
          ? current
          : { height, width }
      )
    },
    [fullPanel]
  )

  useResizeObserver(measureCanvasViewport, canvasRef)

  useEffect(() => {
    if (!positions || pendingPositionSavesRef.current > 0) {
      return
    }

    setPositionOverrides(new Map(positions.map(position => [position.taskId, { x: position.x, y: position.y }])))
  }, [positions])

  useEffect(() => {
    const nextScope = graphScopeKey

    if (graphScopeRef.current === nextScope) {
      return
    }

    graphScopeRef.current = nextScope

    nodeDragRef.current = null
    connectionDragRef.current = null
    dragRef.current = null
    minimapDragRef.current = null
    suppressNodeClickRef.current = null
    suppressConnectionClickRef.current = false
    setConnectionDrag(null)
    setConnectionTargetTaskId(null)
    setArmedConnection(null)
    setHoveredEdgeKey(null)
    setHoveredTaskId(null)
    setRemovingEdgeKey(null)
    setView(INITIAL_LOOP_GRAPH_VIEW)

    if (awaitingCreatedTaskId === nextScope) {
      return
    }

    setPositionOverrides(new Map(positions?.map(position => [position.taskId, { x: position.x, y: position.y }])))
    setUndoPositions(null)
    setAwaitingCreatedTaskId(null)
    setCreateDraft(rows.length === 0 ? { x: LOOP_GRAPH_PADDING, y: LOOP_GRAPH_PADDING } : null)
  }, [awaitingCreatedTaskId, graphScopeKey, positions, rows])

  useEffect(() => {
    if (awaitingCreatedTaskId && rows.some(row => row.taskId === awaitingCreatedTaskId)) {
      setAwaitingCreatedTaskId(null)
    }
  }, [awaitingCreatedTaskId, rows])

  const baseLayout = useMemo(() => loopTaskGraphLayout(rows), [rows])

  const layout = useMemo(() => {
    const positioned = loopTaskGraphWithPositions(baseLayout, positionOverrides)

    if (!createDraft) {
      return positioned
    }

    return {
      ...positioned,
      height: Math.max(positioned.height, createDraft.y + LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_PADDING),
      width: Math.max(positioned.width, createDraft.x + LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_PADDING)
    }
  }, [baseLayout, createDraft, positionOverrides])

  const graphBounds = useMemo(() => loopTaskGraphBounds(layout, createDraft), [createDraft, layout])

  const graphFrameKey = `${graphScopeKey}:${positions === undefined ? 'loading' : 'ready'}`

  useEffect(() => {
    if (!fullPanel) {
      return
    }

    const frameKey = `${graphFrameKey}:${Math.round(canvasViewport.width)}x${Math.round(canvasViewport.height)}`

    if (lastAutoFrameKeyRef.current === frameKey) {
      return
    }

    lastAutoFrameKeyRef.current = frameKey
    setView(frameLoopGraphView(graphBounds, canvasViewport))
  }, [canvasViewport, fullPanel, graphBounds, graphFrameKey])

  const nodeById = useMemo(() => new Map(layout.nodes.map(node => [node.row.taskId, node])), [layout.nodes])
  const visibleEdges = useMemo(() => layout.edges.filter(edge => !edge.secondary), [layout.edges])

  const persistPositions = useCallback(
    (next: Map<string, LoopTaskGraphPoint>, workflowOverride?: string, createdTaskId?: string) => {
      if (!onSavePositions) {
        return Promise.resolve(true)
      }

      const requestScope = graphScopeRef.current
      const targetWorkflowId = workflowOverride || workflowId
      pendingPositionSavesRef.current += 1

      const save = async () => {
        if (graphScopeRef.current !== requestScope) {
          return true
        }

        let saved = false

        try {
          saved = await onSavePositions(
            loopTaskGraphPositionList(next).filter(
              position => nodeById.has(position.taskId) || position.taskId === createdTaskId
            ),
            targetWorkflowId
          )
        } catch {
          saved = false
        }

        return graphScopeRef.current === requestScope ? saved : true
      }

      const result = positionSaveQueueRef.current.then(save, save)

      positionSaveQueueRef.current = result.then(
        () => {
          pendingPositionSavesRef.current = Math.max(0, pendingPositionSavesRef.current - 1)
        },
        () => {
          pendingPositionSavesRef.current = Math.max(0, pendingPositionSavesRef.current - 1)
        }
      )

      return result
    },
    [nodeById, onSavePositions, workflowId]
  )

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): LoopTaskGraphPoint => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const screenX = clientX - (rect?.left || 0)
      const screenY = clientY - (rect?.top || 0)

      return {
        x: (screenX - view.x) / view.scale,
        y: (screenY - view.y) / view.scale
      }
    },
    [view]
  )

  const openCreateAt = useCallback((point: LoopTaskGraphPoint, relation?: { childId?: string; parentId?: string }) => {
    setCreateDraft({
      ...relation,
      x: Math.round(point.x - LOOP_GRAPH_NODE_WIDTH / 2),
      y: Math.round(point.y - LOOP_GRAPH_NODE_HEIGHT / 2)
    })
  }, [])

  const handleCreatedTask = useCallback(
    (taskId: string, draft: LoopTaskGraphCreateDraft, createdScope: string) => {
      if (graphScopeRef.current !== createdScope) {
        return
      }

      const nextPositions = new Map(positionOverrides)
      const requestScope = graphScopeRef.current

      nextPositions.set(taskId, { x: draft.x, y: draft.y })
      setPositionOverrides(nextPositions)
      setUndoPositions(null)
      setAwaitingCreatedTaskId(taskId)
      setCreateDraft(null)

      void (async () => {
        const positioned = await persistPositions(nextPositions, workflowId, taskId)

        if (!positioned) {
          setPositionOverrides(positionOverrides)
        }

        if (graphScopeRef.current !== requestScope) {
          return
        }
      })()
    },
    [persistPositions, positionOverrides, workflowId]
  )

  const edgesWithPaths = useMemo(() => {
    const connectedEdges = visibleEdges
      .map(edge => {
        const from = nodeById.get(edge.from)
        const to = nodeById.get(edge.to)

        return from && to ? { edge, from, key: `${edge.from}:${edge.to}`, to } : null
      })
      .filter((connected): connected is LoopTaskGraphConnectedEdge => connected !== null)

    const outgoingByTaskId = new Map<string, LoopTaskGraphConnectedEdge[]>()
    const incomingByTaskId = new Map<string, LoopTaskGraphConnectedEdge[]>()

    for (const connected of connectedEdges) {
      outgoingByTaskId.set(connected.edge.from, [...(outgoingByTaskId.get(connected.edge.from) || []), connected])
      incomingByTaskId.set(connected.edge.to, [...(incomingByTaskId.get(connected.edge.to) || []), connected])
    }

    for (const outgoing of outgoingByTaskId.values()) {
      outgoing.sort((a, b) => a.to.x - b.to.x || a.to.y - b.to.y || a.key.localeCompare(b.key))
    }

    for (const incoming of incomingByTaskId.values()) {
      incoming.sort((a, b) => a.from.x - b.from.x || a.from.y - b.from.y || a.key.localeCompare(b.key))
    }

    const portX = (node: LoopTaskGraphNodeLayout, edges: LoopTaskGraphConnectedEdge[], key: string) => {
      const index = Math.max(
        0,
        edges.findIndex(candidate => candidate.key === key)
      )

      const availableWidth = LOOP_GRAPH_NODE_WIDTH - LOOP_GRAPH_EDGE_PORT_PADDING * 2

      return node.x + LOOP_GRAPH_EDGE_PORT_PADDING + (availableWidth * (index + 1)) / (edges.length + 1)
    }

    const preparedEdges: LoopTaskGraphPreparedEdge[] = connectedEdges.map(connected => ({
      ...connected,
      endX: portX(connected.to, incomingByTaskId.get(connected.edge.to) || [connected], connected.key),
      startX: portX(connected.from, outgoingByTaskId.get(connected.edge.from) || [connected], connected.key)
    }))

    const preparedByKey = new Map(preparedEdges.map(prepared => [prepared.key, prepared]))
    const laneGroups = new Map<string, string[]>()

    for (const prepared of preparedEdges) {
      if (prepared.to.depth === prepared.from.depth + 1) {
        const groupKey = `${prepared.from.depth}:${prepared.to.depth}`

        laneGroups.set(groupKey, [...(laneGroups.get(groupKey) || []), prepared.key])
      }
    }

    const laneByEdgeKey = new Map<string, { count: number; index: number }>()

    for (const keys of laneGroups.values()) {
      keys.sort((a, b) => {
        const edgeA = preparedByKey.get(a)!
        const edgeB = preparedByKey.get(b)!

        return (
          (edgeA.startX + edgeA.endX) / 2 - (edgeB.startX + edgeB.endX) / 2 ||
          edgeA.startX - edgeB.startX ||
          a.localeCompare(b)
        )
      })
      keys.forEach((key, index) => laneByEdgeKey.set(key, { count: keys.length, index }))
    }

    const railByEdgeKey = new Map<string, number>()
    const railGroups = { left: [] as LoopTaskGraphPreparedEdge[], right: [] as LoopTaskGraphPreparedEdge[] }

    for (const prepared of preparedEdges) {
      if (prepared.from.depth === prepared.to.depth || prepared.to.depth === prepared.from.depth + 1) {
        continue
      }

      const leftRail = Math.min(prepared.from.x, prepared.to.x) - LOOP_GRAPH_EDGE_RAIL_GAP

      const rightRail =
        Math.max(prepared.from.x + LOOP_GRAPH_NODE_WIDTH, prepared.to.x + LOOP_GRAPH_NODE_WIDTH) +
        LOOP_GRAPH_EDGE_RAIL_GAP

      const leftCost =
        Math.abs(prepared.startX - leftRail) +
        Math.abs(prepared.endX - leftRail) +
        railGroups.left.length * LOOP_GRAPH_EDGE_RAIL_BALANCE_COST

      const rightCost =
        Math.abs(rightRail - prepared.startX) +
        Math.abs(rightRail - prepared.endX) +
        railGroups.right.length * LOOP_GRAPH_EDGE_RAIL_BALANCE_COST

      railGroups[leftCost <= rightCost ? 'left' : 'right'].push(prepared)
    }

    for (const [side, railEdges] of Object.entries(railGroups) as [
      keyof typeof railGroups,
      LoopTaskGraphPreparedEdge[]
    ][]) {
      railEdges
        .sort(
          (a, b) =>
            Math.min(a.from.y, a.to.y) - Math.min(b.from.y, b.to.y) ||
            Math.max(a.from.y, a.to.y) - Math.max(b.from.y, b.to.y) ||
            a.key.localeCompare(b.key)
        )
        .forEach((prepared, index) => {
          const offset = 10 + index * LOOP_GRAPH_EDGE_RAIL_GAP
          const localLeft = Math.min(prepared.from.x, prepared.to.x) - offset

          const localRight =
            Math.max(prepared.from.x + LOOP_GRAPH_NODE_WIDTH, prepared.to.x + LOOP_GRAPH_NODE_WIDTH) + offset

          railByEdgeKey.set(
            prepared.key,
            side === 'left'
              ? Math.max(graphBounds.left + LOOP_GRAPH_EDGE_RAIL_INSET, localLeft)
              : Math.min(graphBounds.right - LOOP_GRAPH_EDGE_RAIL_INSET, localRight)
          )
        })
    }

    return preparedEdges.map<LoopTaskGraphRenderedEdge>(prepared => {
      const { edge, endX, from, key, startX, to } = prepared

      if (from.depth === to.depth) {
        const goingRight = to.x > from.x
        const direction = goingRight ? 1 : -1

        const start = {
          x: goingRight ? from.x + LOOP_GRAPH_NODE_WIDTH : from.x,
          y: from.y + LOOP_GRAPH_NODE_HEIGHT / 2
        }

        const end = { x: goingRight ? to.x : to.x + LOOP_GRAPH_NODE_WIDTH, y: to.y + LOOP_GRAPH_NODE_HEIGHT / 2 }
        const laneY = Math.max(graphBounds.top + LOOP_GRAPH_EDGE_RAIL_INSET, from.y - LOOP_GRAPH_ROW_GAP / 2)

        return {
          actionX: (start.x + end.x) / 2,
          actionY: laneY,
          d: loopTaskGraphRoundedPath([
            start,
            { x: start.x + direction * 8, y: start.y },
            { x: start.x + direction * 8, y: laneY },
            { x: end.x - direction * 8, y: laneY },
            { x: end.x - direction * 8, y: end.y },
            end
          ]),
          edge
        }
      }

      const forward = to.depth > from.depth
      const direction = forward ? 1 : -1
      const startY = forward ? from.y + LOOP_GRAPH_NODE_HEIGHT : from.y
      const endY = forward ? to.y : to.y + LOOP_GRAPH_NODE_HEIGHT
      const adjacentLane = forward ? laneByEdgeKey.get(key) : undefined

      if (adjacentLane) {
        const gap = endY - startY
        const laneY = startY + gap * (0.25 + (0.5 * (adjacentLane.index + 1)) / (adjacentLane.count + 1))

        return {
          actionX: (startX + endX) / 2,
          actionY: laneY,
          d: loopTaskGraphRoundedPath([
            { x: startX, y: startY },
            { x: startX, y: laneY },
            { x: endX, y: laneY },
            { x: endX, y: endY }
          ]),
          edge
        }
      }

      const bend = Math.min(12, Math.abs(endY - startY) / 4)
      const railX = railByEdgeKey.get(key) ?? graphBounds.left + LOOP_GRAPH_EDGE_RAIL_INSET
      const verticalDistance = endY - startY
      const controlY1 = startY + direction * bend + verticalDistance * 0.22
      const controlY2 = endY - direction * bend - verticalDistance * 0.22

      return {
        actionX: (startX + 6 * railX + endX) / 8,
        actionY: (startY + 3 * controlY1 + 3 * controlY2 + endY) / 8,
        d: `M ${startX} ${startY} C ${railX} ${controlY1}, ${railX} ${controlY2}, ${endX} ${endY}`,
        edge,
        railX
      }
    })
  }, [graphBounds, nodeById, visibleEdges])

  const selectedFocus = useMemo(() => loopTaskGraphFocusState(layout, selectedTaskId), [layout, selectedTaskId])
  const hoveredFocus = useMemo(() => loopTaskGraphFocusState(layout, hoveredTaskId), [hoveredTaskId, layout])
  const activeFocus = hoveredFocus.taskId ? hoveredFocus : selectedFocus

  const connectionPreviewPath = useMemo(() => {
    if (!connectionDrag) {
      return ''
    }

    const start =
      connectionDrag.side === 'output'
        ? { x: connectionDrag.startWorldX, y: connectionDrag.startWorldY }
        : { x: connectionDrag.worldX, y: connectionDrag.worldY }

    const end =
      connectionDrag.side === 'output'
        ? { x: connectionDrag.worldX, y: connectionDrag.worldY }
        : { x: connectionDrag.startWorldX, y: connectionDrag.startWorldY }

    const laneY = (start.y + end.y) / 2

    return loopTaskGraphRoundedPath([start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end])
  }, [connectionDrag])

  const effectiveViewportWidth = canvasViewport.width || graphBounds.width
  const effectiveViewportHeight = canvasViewport.height || graphBounds.height
  const viewportLeft = -view.x / view.scale
  const viewportTop = -view.y / view.scale
  const viewportWidth = effectiveViewportWidth / view.scale
  const viewportHeight = effectiveViewportHeight / view.scale
  const minimapWorldLeft = Math.min(graphBounds.left, viewportLeft)
  const minimapWorldTop = Math.min(graphBounds.top, viewportTop)
  const minimapWorldRight = Math.max(graphBounds.right, viewportLeft + viewportWidth)
  const minimapWorldBottom = Math.max(graphBounds.bottom, viewportTop + viewportHeight)
  const minimapWorldWidth = minimapWorldRight - minimapWorldLeft
  const minimapWorldHeight = minimapWorldBottom - minimapWorldTop

  const minimapScale = Math.min(
    (LOOP_GRAPH_MINIMAP_WIDTH - LOOP_GRAPH_MINIMAP_PADDING * 2) / Math.max(1, minimapWorldWidth),
    (LOOP_GRAPH_MINIMAP_HEIGHT - LOOP_GRAPH_MINIMAP_PADDING * 2) / Math.max(1, minimapWorldHeight)
  )

  const minimapGraphX =
    (LOOP_GRAPH_MINIMAP_WIDTH - minimapWorldWidth * minimapScale) / 2 - minimapWorldLeft * minimapScale

  const minimapGraphY =
    (LOOP_GRAPH_MINIMAP_HEIGHT - minimapWorldHeight * minimapScale) / 2 - minimapWorldTop * minimapScale

  const minimapViewportX = minimapGraphX + viewportLeft * minimapScale
  const minimapViewportY = minimapGraphY + viewportTop * minimapScale
  const minimapViewportWidth = viewportWidth * minimapScale
  const minimapViewportHeight = viewportHeight * minimapScale

  const handleFrame = useCallback(() => {
    setView(frameLoopGraphView(graphBounds, canvasViewport))
  }, [canvasViewport, graphBounds])

  const zoomAt = useCallback(
    (nextScale: number, clientX?: number, clientY?: number) => {
      setView(current => {
        const scale = clampLoopGraphZoom(nextScale)
        const rect = canvasRef.current?.getBoundingClientRect()

        const screenX =
          clientX !== undefined && rect ? clientX - rect.left : (canvasViewport.width || graphBounds.width) / 2

        const screenY =
          clientY !== undefined && rect ? clientY - rect.top : (canvasViewport.height || graphBounds.height) / 2

        const worldX = (screenX - current.x) / current.scale
        const worldY = (screenY - current.y) / current.scale

        return {
          scale,
          x: Math.round(screenX - worldX * scale),
          y: Math.round(screenY - worldY * scale)
        }
      })
    },
    [canvasViewport.height, canvasViewport.width, graphBounds.height, graphBounds.width]
  )

  const handleResetView = useCallback(() => {
    setView(INITIAL_LOOP_GRAPH_VIEW)
  }, [])

  const handleAddTask = useCallback(() => {
    if (graphScopeRef.current !== graphScopeKey) {
      return
    }

    const margin = 16 / view.scale
    const toolbarClearance = 52 / view.scale
    const stepX = LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_COLUMN_GAP
    const stepY = LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP
    const left = viewportLeft + margin
    const top = viewportTop + toolbarClearance
    const right = Math.max(left, viewportLeft + viewportWidth - LOOP_GRAPH_NODE_WIDTH - margin)
    const bottom = Math.max(top, viewportTop + viewportHeight - LOOP_GRAPH_NODE_HEIGHT - margin)
    let position: LoopTaskGraphPoint | null = null

    for (let y = top; y <= bottom && !position; y += stepY) {
      for (let x = left; x <= right; x += stepX) {
        const collides = layout.nodes.some(
          node =>
            x < node.x + LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_COLUMN_GAP / 2 &&
            x + LOOP_GRAPH_NODE_WIDTH + LOOP_GRAPH_COLUMN_GAP / 2 > node.x &&
            y < node.y + LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP / 2 &&
            y + LOOP_GRAPH_NODE_HEIGHT + LOOP_GRAPH_ROW_GAP / 2 > node.y
        )

        if (!collides) {
          position = { x: Math.round(x), y: Math.round(y) }

          break
        }
      }
    }

    setCreateDraft(position || { x: Math.round(left), y: Math.round(bottom) })
  }, [graphScopeKey, layout.nodes, view.scale, viewportHeight, viewportLeft, viewportTop, viewportWidth])

  const handleTidy = useCallback(() => {
    if (graphScopeRef.current !== graphScopeKey || baseLayout.nodes.length === 0) {
      return
    }

    const previous = new Map(positionOverrides)
    const tidy = new Map(baseLayout.nodes.map(node => [node.row.taskId, { x: node.x, y: node.y }]))

    setUndoPositions(previous)
    setPositionOverrides(tidy)
    void persistPositions(tidy).then(saved => {
      if (!saved) {
        setPositionOverrides(previous)
        setUndoPositions(null)
      }
    })
  }, [baseLayout.nodes, graphScopeKey, persistPositions, positionOverrides])

  const handleUndoPositions = useCallback(() => {
    if (graphScopeRef.current !== graphScopeKey || !undoPositions) {
      return
    }

    const previous = undoPositions
    const current = new Map(positionOverrides)

    setPositionOverrides(previous)
    setUndoPositions(null)
    void persistPositions(previous).then(saved => {
      if (!saved) {
        setPositionOverrides(current)
        setUndoPositions(previous)
      }
    })
  }, [graphScopeKey, persistPositions, positionOverrides, undoPositions])

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest('[data-loop-task-graph-interaction="create-task"]')) {
        return
      }

      if (!fullPanel) {
        if (!event.ctrlKey) {
          return
        }

        event.preventDefault()
        zoomAt(view.scale * Math.exp(-event.deltaY * LOOP_GRAPH_ZOOM_SENSITIVITY), event.clientX, event.clientY)

        return
      }

      event.preventDefault()

      if (event.ctrlKey || event.metaKey) {
        zoomAt(view.scale * Math.exp(-event.deltaY * LOOP_GRAPH_ZOOM_SENSITIVITY), event.clientX, event.clientY)

        return
      }

      setView(current => ({
        ...current,
        x: Math.round(current.x - event.deltaX),
        y: Math.round(current.y - event.deltaY)
      }))
    },
    [fullPanel, view.scale, zoomAt]
  )

  const connectionTargetAt = useCallback(
    (clientX: number, clientY: number, side: LoopTaskGraphConnectionSide): null | string => {
      const element = document.elementFromPoint?.(clientX, clientY)
      const attribute = side === 'output' ? 'data-loop-connection-input' : 'data-loop-connection-output'
      const portTaskId = element?.closest(`[${attribute}]`)?.getAttribute(attribute)

      if (portTaskId) {
        const target = nodeById.get(portTaskId)

        return target && (side === 'input' || loopGraphTargetAllowsDependency(target.row)) ? portTaskId : null
      }

      const cardTaskId = element
        ?.closest('[data-loop-task-graph-interaction]')
        ?.getAttribute('data-loop-task-graph-interaction')

      const target = cardTaskId ? nodeById.get(cardTaskId) : null

      return target && (side === 'input' || loopGraphTargetAllowsDependency(target.row)) ? cardTaskId || null : null
    },
    [nodeById]
  )

  const handleNodeDragStart = useCallback(
    (node: LoopTaskGraphNodeLayout, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (graphScopeRef.current !== graphScopeKey || !fullPanel || event.button !== 0) {
        return
      }

      event.stopPropagation()
      nodeDragRef.current = {
        currentX: node.x,
        currentY: node.y,
        moved: false,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPositions: new Map(positionOverrides),
        startX: node.x,
        startY: node.y,
        taskId: node.row.taskId
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [fullPanel, graphScopeKey, positionOverrides]
  )

  const handleConnectionStart = useCallback(
    (taskId: string, side: LoopTaskGraphConnectionSide, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (graphScopeRef.current !== graphScopeKey || !fullPanel || event.button !== 0) {
        return
      }

      const node = nodeById.get(taskId)

      if (!node || (side === 'input' && !loopGraphTargetAllowsDependency(node.row))) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const drag: LoopTaskGraphConnectionDrag = {
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
        pointerId: event.pointerId,
        side,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWorldX: node.x + LOOP_GRAPH_NODE_WIDTH / 2,
        startWorldY: side === 'output' ? node.y + LOOP_GRAPH_NODE_HEIGHT : node.y,
        taskId,
        worldX: node.x + LOOP_GRAPH_NODE_WIDTH / 2,
        worldY: side === 'output' ? node.y + LOOP_GRAPH_NODE_HEIGHT : node.y
      }

      connectionDragRef.current = drag
      setConnectionDrag(drag)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [fullPanel, graphScopeKey, nodeById]
  )

  const handleConnectionActivate = useCallback(
    (taskId: string, side: LoopTaskGraphConnectionSide) => {
      if (graphScopeRef.current !== graphScopeKey) {
        return
      }

      if (suppressConnectionClickRef.current) {
        suppressConnectionClickRef.current = false

        return
      }

      if (!armedConnection) {
        setArmedConnection({ side, taskId })

        return
      }

      if (armedConnection.taskId === taskId && armedConnection.side === side) {
        setArmedConnection(null)

        return
      }

      if (armedConnection.taskId !== taskId && armedConnection.side !== side) {
        const parentId = armedConnection.side === 'output' ? armedConnection.taskId : taskId
        const childId = armedConnection.side === 'output' ? taskId : armedConnection.taskId
        const child = nodeById.get(childId)

        setArmedConnection(null)

        if (!child || !loopGraphTargetAllowsDependency(child.row)) {
          return
        }

        setUndoPositions(null)
        void onLinkTasks?.(parentId, childId)

        return
      }

      setArmedConnection({ side, taskId })
    },
    [armedConnection, graphScopeKey, nodeById, onLinkTasks]
  )

  const handleNodeNudge = useCallback(
    (node: LoopTaskGraphNodeLayout, deltaX: number, deltaY: number) => {
      if (graphScopeRef.current !== graphScopeKey) {
        return
      }

      const previous = new Map(positionOverrides)
      const next = new Map(positionOverrides)

      next.set(node.row.taskId, {
        x: Math.round(node.x + deltaX),
        y: Math.round(node.y + deltaY)
      })
      setUndoPositions(null)
      setPositionOverrides(next)
      void persistPositions(next).then(saved => {
        if (!saved) {
          setPositionOverrides(previous)
        }
      })
    },
    [graphScopeKey, persistPositions, positionOverrides]
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        graphScopeRef.current !== graphScopeKey ||
        !fullPanel ||
        event.button !== 0 ||
        loopGraphTargetIsInteractive(event.target)
      ) {
        return
      }

      event.preventDefault()
      dragRef.current = { pointerId: event.pointerId, startView: view, startX: event.clientX, startY: event.clientY }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [fullPanel, graphScopeKey, view]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (graphScopeRef.current !== graphScopeKey) {
        return
      }

      const nodeDrag = nodeDragRef.current

      if (nodeDrag?.pointerId === event.pointerId) {
        const deltaX = event.clientX - nodeDrag.startClientX
        const deltaY = event.clientY - nodeDrag.startClientY

        if (!nodeDrag.moved && Math.hypot(deltaX, deltaY) < 4) {
          return
        }

        if (!nodeDrag.moved) {
          setUndoPositions(null)
        }

        nodeDrag.moved = true
        nodeDrag.currentX = Math.round(nodeDrag.startX + deltaX / view.scale)
        nodeDrag.currentY = Math.round(nodeDrag.startY + deltaY / view.scale)

        setPositionOverrides(current => {
          const next = new Map(current)

          next.set(nodeDrag.taskId, { x: nodeDrag.currentX, y: nodeDrag.currentY })

          return next
        })

        return
      }

      const edgeDrag = connectionDragRef.current

      if (edgeDrag?.pointerId === event.pointerId) {
        const world = screenToWorld(event.clientX, event.clientY)

        const next = {
          ...edgeDrag,
          clientX: event.clientX,
          clientY: event.clientY,
          moved:
            edgeDrag.moved ||
            Math.hypot(event.clientX - edgeDrag.startClientX, event.clientY - edgeDrag.startClientY) >= 4,
          worldX: world.x,
          worldY: world.y
        }

        const targetTaskId = connectionTargetAt(event.clientX, event.clientY, edgeDrag.side)

        connectionDragRef.current = next
        setConnectionDrag(next)
        setConnectionTargetTaskId(targetTaskId && targetTaskId !== edgeDrag.taskId ? targetTaskId : null)

        return
      }

      const drag = dragRef.current

      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }

      setView({
        ...drag.startView,
        x: Math.round(drag.startView.x + event.clientX - drag.startX),
        y: Math.round(drag.startView.y + event.clientY - drag.startY)
      })
    },
    [connectionTargetAt, graphScopeKey, screenToWorld, view.scale]
  )

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (graphScopeRef.current !== graphScopeKey) {
        return
      }

      const nodeDrag = nodeDragRef.current

      if (nodeDrag?.pointerId === event.pointerId) {
        nodeDragRef.current = null

        if (nodeDrag.moved) {
          const next = new Map(nodeDrag.startPositions)

          next.set(nodeDrag.taskId, { x: nodeDrag.currentX, y: nodeDrag.currentY })
          suppressNodeClickRef.current = nodeDrag.taskId
          setPositionOverrides(next)
          void persistPositions(next).then(saved => {
            if (!saved) {
              setPositionOverrides(nodeDrag.startPositions)
            }
          })
        }

        return
      }

      const edgeDrag = connectionDragRef.current

      if (edgeDrag?.pointerId === event.pointerId) {
        const targetTaskId = connectionTargetAt(event.clientX, event.clientY, edgeDrag.side)
        const targetElement = document.elementFromPoint?.(event.clientX, event.clientY) || null

        const gestureMoved =
          edgeDrag.moved ||
          Math.hypot(event.clientX - edgeDrag.startClientX, event.clientY - edgeDrag.startClientY) >= 4

        connectionDragRef.current = null
        setConnectionDrag(null)
        setConnectionTargetTaskId(null)

        if (gestureMoved) {
          suppressConnectionClickRef.current = true
        }

        if (gestureMoved && targetTaskId && targetTaskId !== edgeDrag.taskId) {
          const parentId = edgeDrag.side === 'output' ? edgeDrag.taskId : targetTaskId
          const childId = edgeDrag.side === 'output' ? targetTaskId : edgeDrag.taskId

          setUndoPositions(null)
          void onLinkTasks?.(parentId, childId)
        } else if (gestureMoved && !loopGraphTargetIsInteractive(targetElement)) {
          const world = screenToWorld(event.clientX, event.clientY)

          setUndoPositions(null)
          openCreateAt(world, edgeDrag.side === 'output' ? { parentId: edgeDrag.taskId } : { childId: edgeDrag.taskId })
        }

        return
      }

      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }
    },
    [connectionTargetAt, graphScopeKey, onLinkTasks, openCreateAt, persistPositions, screenToWorld]
  )

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (nodeDragRef.current?.pointerId === event.pointerId) {
      setPositionOverrides(nodeDragRef.current.startPositions)
      nodeDragRef.current = null
    }

    if (connectionDragRef.current?.pointerId === event.pointerId) {
      connectionDragRef.current = null
      setConnectionDrag(null)
      setConnectionTargetTaskId(null)
    }

    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }, [])

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (graphScopeRef.current !== graphScopeKey || !fullPanel || loopGraphTargetIsInteractive(event.target)) {
        return
      }

      openCreateAt(screenToWorld(event.clientX, event.clientY))
    },
    [fullPanel, graphScopeKey, openCreateAt, screenToWorld]
  )

  const navigateFromMinimap = useCallback(
    (currentTarget: HTMLElement, clientX: number, clientY: number) => {
      const rect = currentTarget.getBoundingClientRect()
      const renderedWidth = rect.width || LOOP_GRAPH_MINIMAP_WIDTH
      const renderedHeight = rect.height || LOOP_GRAPH_MINIMAP_HEIGHT
      const localX = ((clientX - rect.left) / renderedWidth) * LOOP_GRAPH_MINIMAP_WIDTH
      const localY = ((clientY - rect.top) / renderedHeight) * LOOP_GRAPH_MINIMAP_HEIGHT

      const worldX = Math.max(minimapWorldLeft, Math.min(minimapWorldRight, (localX - minimapGraphX) / minimapScale))

      const worldY = Math.max(minimapWorldTop, Math.min(minimapWorldBottom, (localY - minimapGraphY) / minimapScale))

      setView(current => ({
        ...current,
        x: Math.round(effectiveViewportWidth / 2 - worldX * current.scale),
        y: Math.round(effectiveViewportHeight / 2 - worldY * current.scale)
      }))
    },
    [
      effectiveViewportHeight,
      effectiveViewportWidth,
      minimapGraphX,
      minimapGraphY,
      minimapScale,
      minimapWorldBottom,
      minimapWorldLeft,
      minimapWorldRight,
      minimapWorldTop
    ]
  )

  const handleMinimapPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      minimapDragRef.current = event.pointerId
      event.currentTarget.setPointerCapture?.(event.pointerId)
      navigateFromMinimap(event.currentTarget, event.clientX, event.clientY)
    },
    [navigateFromMinimap]
  )

  const handleMinimapPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (minimapDragRef.current !== event.pointerId) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      navigateFromMinimap(event.currentTarget, event.clientX, event.clientY)
    },
    [navigateFromMinimap]
  )

  const handleMinimapPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (minimapDragRef.current === event.pointerId) {
      minimapDragRef.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !fullPanel ||
        event.defaultPrevented ||
        (event.target !== event.currentTarget && loopGraphTargetIsInteractive(event.target))
      ) {
        return
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomAt(view.scale * 1.2)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomAt(view.scale / 1.2)
      } else if (event.key === '0') {
        event.preventDefault()
        handleResetView()
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        handleFrame()
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        handleAddTask()
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        setView(current => ({
          ...current,
          x:
            current.x +
            (event.key === 'ArrowLeft'
              ? LOOP_GRAPH_KEYBOARD_PAN_STEP
              : event.key === 'ArrowRight'
                ? -LOOP_GRAPH_KEYBOARD_PAN_STEP
                : 0),
          y:
            current.y +
            (event.key === 'ArrowUp'
              ? LOOP_GRAPH_KEYBOARD_PAN_STEP
              : event.key === 'ArrowDown'
                ? -LOOP_GRAPH_KEYBOARD_PAN_STEP
                : 0)
        }))
      }
    },
    [fullPanel, handleAddTask, handleFrame, handleResetView, view.scale, zoomAt]
  )

  const handleActionStart = useCallback((taskId: string) => {
    setHoveredTaskId(taskId)
  }, [])

  const handleActionEnd = useCallback((taskId: string, relatedTarget: EventTarget | null) => {
    if (loopGraphRelatedTargetBelongsToInteraction(taskId, relatedTarget)) {
      return
    }

    setHoveredTaskId(currentTaskId => (currentTaskId === taskId ? null : currentTaskId))
  }, [])

  const handleEdgeActionEnd = useCallback((edgeKey: string, relatedTarget: EventTarget | null) => {
    if (loopGraphRelatedTargetBelongsToInteraction(`edge:${edgeKey}`, relatedTarget)) {
      return
    }

    setHoveredEdgeKey(currentEdgeKey => (currentEdgeKey === edgeKey ? null : currentEdgeKey))
  }, [])

  const handleUnlinkTasks = useCallback(
    async (edge: LoopTaskGraphEdge) => {
      const parent = nodeById.get(edge.from)
      const child = nodeById.get(edge.to)

      if (
        !onUnlinkTasks ||
        !parent ||
        !loopTaskAllowsDependencySource(parent.row) ||
        !child ||
        !loopGraphTargetAllowsDependency(child.row)
      ) {
        return
      }

      const edgeKey = `${edge.from}:${edge.to}`

      setRemovingEdgeKey(edgeKey)

      try {
        await onUnlinkTasks(edge.from, edge.to)
      } finally {
        setRemovingEdgeKey(currentEdgeKey => (currentEdgeKey === edgeKey ? null : currentEdgeKey))
      }
    },
    [nodeById, onUnlinkTasks]
  )

  return (
    <div
      aria-label={fullPanel ? 'Loop graph canvas' : undefined}
      className={cn(
        fullPanel
          ? 'h-full w-full min-h-0 overflow-hidden bg-(--ui-editor-surface-background) p-0'
          : 'max-h-80 min-h-48 overflow-auto rounded-md border border-(--ui-stroke-tertiary) p-3'
      )}
      data-testid="loop-task-graph"
      data-view-x={fullPanel ? roundedLoopGraphView(view.x) : undefined}
      data-view-y={fullPanel ? roundedLoopGraphView(view.y) : undefined}
      data-zoom={view.scale.toFixed(2)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      ref={canvasRef}
      role={fullPanel ? 'region' : undefined}
      tabIndex={fullPanel ? 0 : undefined}
    >
      {fullPanel ? (
        <div
          aria-label="Loop graph toolbar"
          className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background)/90 p-1 shadow-nous backdrop-blur"
          data-loop-task-graph-interaction="toolbar"
          data-testid="loop-task-graph-toolbar"
          role="toolbar"
        >
          <Button
            aria-label="Add task · N"
            className="h-6 px-1.5 text-[0.68rem]"
            onClick={handleAddTask}
            type="button"
            variant="ghost"
          >
            <Codicon name="new-file" size="0.72rem" />
          </Button>
          <Button
            aria-label="Tidy graph"
            className="h-6 gap-1 px-1.5 text-[0.68rem]"
            disabled={baseLayout.nodes.length === 0}
            onClick={handleTidy}
            type="button"
            variant="ghost"
          >
            <Codicon name="git-merge" size="0.72rem" />
            <span>Tidy</span>
          </Button>
          <Button
            aria-label="Undo tidy"
            className="h-6 px-1.5 text-[0.68rem]"
            disabled={!undoPositions}
            onClick={handleUndoPositions}
            type="button"
            variant="ghost"
          >
            <Codicon name="discard" size="0.72rem" />
          </Button>
        </div>
      ) : (
        <LoopGraphSummary rows={rows} />
      )}
      {fullPanel ? (
        <div
          className="absolute bottom-3 right-3 z-40 flex flex-col overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-surface-background)/90 shadow-lg backdrop-blur"
          data-loop-task-graph-interaction="navigator"
          data-testid="loop-task-graph-navigator"
          style={{ width: LOOP_GRAPH_MINIMAP_WIDTH }}
        >
          {minimapOpen ? (
            <button
              aria-label="Navigate Loop graph minimap"
              className="relative cursor-crosshair overflow-hidden border-b border-(--ui-stroke-tertiary)/60 bg-(--ui-surface-background)/70 p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
              data-loop-task-graph-interaction="minimap"
              data-testid="loop-task-graph-minimap"
              onPointerDown={handleMinimapPointerDown}
              onPointerMove={handleMinimapPointerMove}
              onPointerUp={handleMinimapPointerUp}
              style={{ height: LOOP_GRAPH_MINIMAP_HEIGHT, width: LOOP_GRAPH_MINIMAP_WIDTH }}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 text-(--ui-stroke-secondary)"
                height={LOOP_GRAPH_MINIMAP_HEIGHT}
                width={LOOP_GRAPH_MINIMAP_WIDTH}
              >
                {visibleEdges.map(edge => {
                  const from = nodeById.get(edge.from)
                  const to = nodeById.get(edge.to)

                  if (!from || !to) {
                    return null
                  }

                  return (
                    <line
                      key={`${edge.from}:${edge.to}`}
                      opacity="0.65"
                      stroke="currentColor"
                      strokeWidth="0.8"
                      x1={minimapGraphX + (from.x + LOOP_GRAPH_NODE_WIDTH / 2) * minimapScale}
                      x2={minimapGraphX + (to.x + LOOP_GRAPH_NODE_WIDTH / 2) * minimapScale}
                      y1={minimapGraphY + (from.y + LOOP_GRAPH_NODE_HEIGHT / 2) * minimapScale}
                      y2={minimapGraphY + (to.y + LOOP_GRAPH_NODE_HEIGHT / 2) * minimapScale}
                    />
                  )
                })}
              </svg>
              {createDraft ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-[1px] bg-(--ui-text-tertiary)/55"
                  data-testid="loop-task-graph-minimap-create-node"
                  style={{
                    height: Math.max(3, LOOP_GRAPH_NODE_HEIGHT * minimapScale),
                    left: minimapGraphX + createDraft.x * minimapScale,
                    top: minimapGraphY + createDraft.y * minimapScale,
                    width: Math.max(5, LOOP_GRAPH_NODE_WIDTH * minimapScale)
                  }}
                />
              ) : null}
              {layout.nodes.map(node => (
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute rounded-[1px] bg-(--ui-text-tertiary)/55',
                    node.row.taskId === selectedTaskId && 'bg-(--ui-text-primary)'
                  )}
                  data-testid={`loop-task-graph-minimap-node-${node.row.taskId}`}
                  key={node.row.taskId}
                  style={{
                    height: Math.max(3, LOOP_GRAPH_NODE_HEIGHT * minimapScale),
                    left: minimapGraphX + node.x * minimapScale,
                    top: minimapGraphY + node.y * minimapScale,
                    width: Math.max(5, LOOP_GRAPH_NODE_WIDTH * minimapScale)
                  }}
                />
              ))}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute rounded-sm border border-primary/70 bg-primary/5"
                data-testid="loop-task-graph-minimap-viewport"
                style={{
                  height: Math.max(1, minimapViewportHeight),
                  left: minimapViewportX,
                  top: minimapViewportY,
                  width: Math.max(1, minimapViewportWidth)
                }}
              />
            </button>
          ) : null}
          <div
            aria-label="Loop graph view controls"
            className="flex h-8 items-center gap-0.5 bg-(--ui-surface-background) px-1.5 py-1"
            role="toolbar"
          >
            <Button
              aria-expanded={minimapOpen}
              aria-label={minimapOpen ? 'Hide mini-map' : 'Show mini-map'}
              onClick={() => setMinimapOpen(open => !open)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name={minimapOpen ? 'chevron-down' : 'chevron-up'} size="0.875rem" />
            </Button>
            <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-(--ui-stroke-tertiary)" />
            <Button
              aria-label="Zoom out"
              onClick={() => zoomAt(view.scale / 1.2)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name="remove" size="0.875rem" />
            </Button>
            <input
              aria-label="Zoom level"
              aria-valuetext={`${Math.round(view.scale * 100)}%`}
              className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary) outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-(--ui-text-tertiary) [&::-webkit-slider-thumb]:bg-(--ui-surface-background)"
              max={LOOP_GRAPH_MAX_ZOOM}
              min={LOOP_GRAPH_MIN_ZOOM}
              onChange={event => zoomAt(event.currentTarget.valueAsNumber)}
              step={0.01}
              type="range"
              value={view.scale}
            />
            <Button
              aria-label="Zoom in"
              onClick={() => zoomAt(view.scale * 1.2)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name="add" size="0.875rem" />
            </Button>
            <span
              aria-live="polite"
              className="w-9 shrink-0 text-center font-mono text-[0.6875rem] tabular-nums text-(--ui-text-secondary)"
            >
              {Math.round(view.scale * 100)}%
            </span>
            <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-(--ui-stroke-tertiary)" />
            <Button aria-label="Fit to screen · F" onClick={handleFrame} size="icon-xs" type="button" variant="ghost">
              <Codicon name="screen-full" size="0.875rem" />
            </Button>
          </div>
        </div>
      ) : null}
      <div
        className={cn('relative', fullPanel ? 'h-full min-h-full min-w-full' : 'mx-auto')}
        data-testid="loop-task-graph-frame"
        style={{
          height: fullPanel ? '100%' : graphBounds.height * view.scale,
          minHeight: fullPanel ? '100%' : undefined,
          minWidth: fullPanel ? '100%' : undefined,
          width: fullPanel ? '100%' : graphBounds.width * view.scale
        }}
      >
        <div
          className={cn('relative origin-top-left', fullPanel && 'absolute')}
          data-testid="loop-task-graph-surface"
          data-world-left={graphBounds.left}
          data-world-top={graphBounds.top}
          style={{
            height: graphBounds.height,
            left: fullPanel ? 0 : undefined,
            top: fullPanel ? 0 : undefined,
            transform: fullPanel
              ? `translate(${roundedLoopGraphView(view.x)}px, ${roundedLoopGraphView(view.y)}px) scale(${view.scale})`
              : `translate(${-graphBounds.left * view.scale}px, ${-graphBounds.top * view.scale}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            width: graphBounds.width
          }}
        >
          <svg
            aria-hidden
            className="absolute inset-0 overflow-visible text-(--ui-text-quaternary)"
            height={graphBounds.height}
            width={graphBounds.width}
          >
            <defs>
              <marker
                id="loop-graph-arrow"
                markerHeight={6 / view.scale}
                markerUnits="userSpaceOnUse"
                markerWidth={6 / view.scale}
                orient="auto"
                refX="7"
                refY="5"
                viewBox="0 0 10 10"
              >
                <path d="M 0 1.5 L 7 5 L 0 8.5 z" fill="currentColor" />
              </marker>
              <marker
                id="loop-graph-arrow-dim"
                markerHeight={6 / view.scale}
                markerUnits="userSpaceOnUse"
                markerWidth={6 / view.scale}
                orient="auto"
                refX="7"
                refY="5"
                viewBox="0 0 10 10"
              >
                <path d="M 0 1.5 L 7 5 L 0 8.5 z" fill="currentColor" opacity="0.4" />
              </marker>
            </defs>
            {edgesWithPaths.map(({ d, edge, railX }) => {
              const edgeKey = `${edge.from}:${edge.to}`
              const target = nodeById.get(edge.to)

              const selectedConnected = selectedFocus.edgeKeys.has(edgeKey)
              const highlighted = activeFocus.edgeKeys.has(edgeKey)
              const hoverHighlighted = Boolean(hoveredFocus.taskId && hoveredFocus.edgeKeys.has(edgeKey))
              const dimmed = Boolean(activeFocus.taskId && !highlighted)

              let opacity: number

              if (highlighted) {
                opacity = 1
              } else if (dimmed) {
                opacity = 0.22
              } else {
                opacity = 0.85
              }

              const screenStrokeWidth = highlighted || hoverHighlighted ? 2 : 1.5

              const strokeWidth = screenStrokeWidth / view.scale

              return (
                <g key={edgeKey}>
                  {onUnlinkTasks &&
                  nodeById.get(edge.from) &&
                  loopTaskAllowsDependencySource(nodeById.get(edge.from)!.row) &&
                  target &&
                  loopGraphTargetAllowsDependency(target.row) ? (
                    <path
                      d={d}
                      data-loop-task-graph-interaction={`edge:${edgeKey}`}
                      data-testid={`loop-task-graph-hit-${edge.from}-${edge.to}`}
                      fill="none"
                      onMouseEnter={() => setHoveredEdgeKey(edgeKey)}
                      onMouseLeave={event => handleEdgeActionEnd(edgeKey, event.relatedTarget)}
                      stroke="transparent"
                      strokeWidth={16 / view.scale}
                      style={{ pointerEvents: 'stroke' }}
                    />
                  ) : null}
                  <path
                    className="pointer-events-none"
                    d={d}
                    data-dimmed={dimmed ? 'true' : 'false'}
                    data-route-rail={railX}
                    data-selected-connected={selectedConnected ? 'true' : 'false'}
                    data-testid={`loop-task-graph-edge-${edge.from}-${edge.to}`}
                    fill="none"
                    markerEnd={
                      highlighted || !activeFocus.taskId ? 'url(#loop-graph-arrow)' : 'url(#loop-graph-arrow-dim)'
                    }
                    opacity={opacity}
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={strokeWidth}
                    style={{ transition: 'opacity 150ms ease, stroke-width 150ms ease' }}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )
            })}
            {connectionDrag ? (
              <path
                className="pointer-events-none"
                d={connectionPreviewPath}
                data-testid="loop-task-graph-connection-preview"
                fill="none"
                markerEnd="url(#loop-graph-arrow)"
                opacity="0.85"
                stroke="currentColor"
                strokeDasharray={`${5 / view.scale} ${4 / view.scale}`}
                strokeWidth={1.5 / view.scale}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {onUnlinkTasks
            ? edgesWithPaths.map(({ actionX, actionY, edge }) => {
                const edgeKey = `${edge.from}:${edge.to}`
                const interactionId = `edge:${edgeKey}`
                const removing = removingEdgeKey === edgeKey
                const visible = hoveredEdgeKey === edgeKey || removing
                const from = nodeById.get(edge.from)
                const to = nodeById.get(edge.to)
                const size = 24 / view.scale

                if (
                  !from ||
                  !to ||
                  !loopTaskAllowsDependencySource(from.row) ||
                  !loopGraphTargetAllowsDependency(to.row)
                ) {
                  return null
                }

                return (
                  <Button
                    aria-label={`Delete dependency from ${from.row.title} to ${to.row.title}`}
                    className={cn(
                      'absolute z-30 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-surface-background) p-0 text-(--ui-text-secondary) shadow-md transition-[background-color,color,opacity] hover:bg-(--ui-bg-secondary) hover:text-(--ui-text-primary) focus-visible:opacity-100',
                      visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
                    )}
                    data-loop-task-graph-interaction={interactionId}
                    data-testid={`loop-task-graph-delete-${edge.from}-${edge.to}`}
                    disabled={removing}
                    key={edgeKey}
                    onBlur={event => handleEdgeActionEnd(edgeKey, event.relatedTarget)}
                    onClick={event => {
                      event.stopPropagation()
                      void handleUnlinkTasks(edge)
                    }}
                    onFocus={() => setHoveredEdgeKey(edgeKey)}
                    onMouseEnter={() => setHoveredEdgeKey(edgeKey)}
                    onMouseLeave={event => handleEdgeActionEnd(edgeKey, event.relatedTarget)}
                    style={{
                      borderWidth: 1 / view.scale,
                      height: size,
                      left: actionX - size / 2,
                      top: actionY - size / 2,
                      width: size
                    }}
                    title={`Delete dependency from ${from.row.title} to ${to.row.title}`}
                    type="button"
                    variant="ghost"
                  >
                    <Codicon name={removing ? 'loading' : 'trash'} size={`${12 / view.scale}px`} />
                  </Button>
                )
              })
            : null}
          {createDraft ? (
            <LoopTaskGraphCreateNode
              draft={createDraft}
              key={graphScopeKey}
              onCancel={() => setCreateDraft(null)}
              onCreated={handleCreatedTask}
              onCreateTask={onCreateTask}
              scopeKey={graphScopeKey}
              workflowId={workflowId}
            />
          ) : null}
          {layout.nodes.map(node => {
            const pathConnected = selectedFocus.nodeIds.has(node.row.taskId)
            const dimmed = Boolean(activeFocus.taskId && !activeFocus.nodeIds.has(node.row.taskId))
            const showActionTray = hoveredTaskId === node.row.taskId

            return (
              <Fragment key={node.row.taskId}>
                <LoopTaskGraphNode
                  armedSide={armedConnection?.taskId === node.row.taskId ? armedConnection.side : undefined}
                  connectionTarget={connectionTargetTaskId === node.row.taskId}
                  dimmed={dimmed}
                  inputEnabled={loopGraphTargetAllowsDependency(node.row)}
                  layout={node}
                  onActionEnd={handleActionEnd}
                  onActionStart={handleActionStart}
                  onActivate={(row, event) => {
                    if (suppressNodeClickRef.current === row.taskId) {
                      suppressNodeClickRef.current = null

                      return
                    }

                    if (event.shiftKey) {
                      onTaskAction?.('ask-hermes', row)

                      return
                    }

                    onSelectTask?.(row)
                    onOpenTaskTab?.(row)
                  }}
                  onConnectionActivate={handleConnectionActivate}
                  onConnectionStart={handleConnectionStart}
                  onDragStart={handleNodeDragStart}
                  onNudge={handleNodeNudge}
                  outputEnabled={loopTaskAllowsDependencySource(node.row)}
                  pathConnected={pathConnected}
                  selected={node.row.taskId === selectedTaskId}
                />
                {showActionTray ? (
                  <LoopTaskGraphActionTray
                    layout={node}
                    onActionEnd={handleActionEnd}
                    onActionStart={handleActionStart}
                    onTaskAction={onTaskAction}
                  />
                ) : null}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}
