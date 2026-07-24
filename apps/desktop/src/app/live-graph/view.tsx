import {
  type Force,
  forceCollide,
  forceLink,
  type ForceLink,
  forceManyBody,
  type ForceManyBody,
  forceSimulation,
  forceX,
  type ForceX,
  forceY,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchField } from '@/components/ui/search-field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { readJson, writeJson } from '@/lib/storage'

import { attachLiveGraphNodeToComposer } from './context'
import {
  LIVE_GRAPH_SETTLED_STATUSES,
  LIVE_GRAPH_WAITING_STATUSES,
  type LiveGraphEdge,
  type LiveGraphNode,
  type LiveGraphPulse,
  type LiveGraphSnapshot,
  normalizeLiveGraphStatus
} from './model'
import { LiveGraphWorkflowInbox } from './workflow-inbox'

export const LIVE_GRAPH_KINDS = ['session', 'project', 'workflow', 'task', 'agent', 'artifact'] as const
export type LiveGraphKind = (typeof LIVE_GRAPH_KINDS)[number]
export type LiveGraphFocusDepth = 1 | 2 | 'all'

export interface Camera {
  scale: number
  x: number
  y: number
}

export interface LiveGraphViewState {
  activeOnly: boolean
  arrows: boolean
  camera: Camera
  centerForce: number
  enabledKinds: LiveGraphKind[]
  focusDepth: LiveGraphFocusDepth
  labels: boolean
  linkDistance: number
  linkForce: number
  nodeSize: number
  orphans: boolean
  repelForce: number
  search: string
  textFadeThreshold: number
}

export interface SettledGraphNode {
  id: string
  node: LiveGraphNode
  x: number
  y: number
}

export interface VisibleGraph {
  edges: LiveGraphEdge[]
  nodes: LiveGraphNode[]
}

export interface LiveGraphTopologyAnalysis {
  components: readonly (readonly string[])[]
  degreeById: ReadonlyMap<string, number>
  neighbors: ReadonlyMap<string, ReadonlySet<string>>
}

export type DenseGraphLod = 'overview' | 'structure' | 'detail'

interface LayoutSettings {
  centerForce: number
  linkDistance: number
  linkForce: number
  repelForce: number
}

interface LayoutTopology {
  edges: LiveGraphEdge[]
  key: string
  nodes: LiveGraphNode[]
}

interface LiveGraphSemanticTopology {
  descendantHubIds: ReadonlySet<string>
  key: string
  semanticReachById: ReadonlyMap<string, number>
}

interface SimNode extends SimulationNodeDatum {
  id: string
  node: LiveGraphNode
  radius: number
}

interface LiveGraphLayoutMetrics {
  analysis: LiveGraphTopologyAnalysis
  radiusById: ReadonlyMap<string, number>
  semanticReachById: ReadonlyMap<string, number>
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  degreeStrength: number
  kind: LiveGraphEdge['kind']
}

interface LiveGraphComponentBody {
  bottom: number
  index: number
  left: number
  mass: number
  members: readonly SimNode[]
  right: number
  shiftX: number
  shiftY: number
  top: number
}

interface LiveGraphPackedComponent extends SimulationNodeDatum {
  centerX: number
  centerY: number
  index: number
  members: readonly SimNode[]
  radius: number
}

interface LiveGraphComponentForce extends Force<SimNode, SimLink> {
  centerStrength(value: number): LiveGraphComponentForce
}

interface LiveGraphSimulation extends Simulation<SimNode, SimLink> {
  liveGraphForces: {
    charge: ForceManyBody<SimNode>
    componentCollide: LiveGraphComponentForce
    centerX: ForceX<SimNode>
    centerY: ForceY<SimNode>
    link: ForceLink<SimNode, SimLink>
  }
}

interface LiveGraphWakeRequest {
  alpha: number
  alphaTarget?: number
  capDenseAlpha?: boolean
  duration: number
}

interface LiveGraphPaintNode {
  dirtyFrame: number
  element: SVGGElement
  lastX: number
  lastY: number
  layout: SettledGraphNode
  position: { x: number; y: number }
  sim: SimNode
}

interface LiveGraphPaintEdge {
  element: SVGLineElement | null
  growth: number
  source: LiveGraphPaintNode
  sourceRadius: number
  target: LiveGraphPaintNode
  targetRadius: number
}

type ForceSettingKey = 'centerForce' | 'linkDistance' | 'linkForce' | 'repelForce'

interface ActivePulse {
  edgeDuration: number
  id: string
  kind: string
  label: string
  sourceId: string
  startedAt: number
  status: string
  targetId: string
}

interface Viewport {
  height: number
  width: number
}

interface PanDragState {
  cameraX: number
  cameraY: number
  mode: 'pan'
  moved: boolean
  pendingX: number
  pendingY: number
  pointerId: number
  startX: number
  startY: number
  svg: SVGSVGElement
}

interface NodeDragState {
  attach: boolean
  id: string
  mode: 'node'
  moved: boolean
  pendingX: number
  pendingY: number
  pointerId: number
  pointerOffsetX: number
  pointerOffsetY: number
  startClientX: number
  startClientY: number
  svg: SVGSVGElement
}

type DragState = NodeDragState | PanDragState

interface GraphReveal {
  delays: Map<string, number>
  duration: number
  key: string
  startedAt: number
}

interface SuppressedNodeActivation {
  id: string
  until: number
}

const DEFAULT_CAMERA: Camera = { scale: 1, x: 0, y: 0 }
export const LIVE_GRAPH_MIN_SCALE = 0.02
const LIVE_GRAPH_MAX_SCALE = 4
const LIVE_GRAPH_FIT_MAX_SCALE = 2
const EMPTY_PULSES: readonly LiveGraphPulse[] = []
const EMPTY_RADIUS_BY_ID: ReadonlyMap<string, number> = new Map()
const EMPTY_LABEL_IDS: ReadonlySet<string> = new Set()
const DRAG_THRESHOLD = 4
const GRAPH_REVEAL_NODE_DURATION = 220
const GRAPH_REVEAL_WAVE_DELAY = 180
const LIVE_GRAPH_NODE_BASE_RADIUS = 4.2
const LIVE_GRAPH_AGENT_BASE_RADIUS = 3.2
const LIVE_GRAPH_WORKFLOW_BASE_RADIUS = 7
const LIVE_GRAPH_SESSION_BASE_RADIUS = 15
const LIVE_GRAPH_ROOT_TASK_MAX_RADIUS = 20.2
const LIVE_GRAPH_WORKFLOW_MAX_RADIUS = 31
const LIVE_GRAPH_SESSION_MAX_RADIUS = 40
const LIVE_GRAPH_NODE_SIZE_MIN = 50
const LIVE_GRAPH_NODE_SIZE_MAX = 200
const LIVE_GRAPH_NODE_SIZE_DEFAULT = 100
const LIVE_GRAPH_ROOT_TASK_DESCENDANT_CAP = 128
const LIVE_GRAPH_WORKFLOW_DESCENDANT_CAP = 256
const LIVE_GRAPH_SESSION_DESCENDANT_CAP = 512
const LIVE_GRAPH_VISIBLE_COLLISION_PADDING = 4
const LIVE_GRAPH_COMPONENT_GAP = 16
const LIVE_GRAPH_COMPONENT_COLLISION_ITERATIONS = 3
const LIVE_GRAPH_COMPONENT_LOCAL_NODE_TICK_BUDGET = 120_000
const LIVE_GRAPH_COMPONENT_LOCAL_WORK_TICK_BUDGET = 24_000
const LIVE_GRAPH_COMPONENT_MIN_MASS_SHARE = 0.25
const LIVE_GRAPH_COMPONENT_MIN_SHIFT_LIMIT = 3
const LIVE_GRAPH_COMPONENT_MAX_SHIFT_LIMIT = 24
const LIVE_GRAPH_LINK_SURFACE_GAP_MIN = 6
const LIVE_GRAPH_LINK_SURFACE_GAP_MAX = 42
const LIVE_GRAPH_EDGE_GAP = 4
const DENSE_GRAPH_NODE_THRESHOLD = 800
const DENSE_GRAPH_STRUCTURE_SCALE = 0.4
const DENSE_GRAPH_DETAIL_SCALE = 0.9
const DENSE_GRAPH_OVERVIEW_LABEL_LIMIT = 24
const DENSE_GRAPH_STRUCTURE_LABEL_LIMIT = 96
const DENSE_GRAPH_ARROW_EDGE_THRESHOLD = 1_500
const DENSE_GRAPH_REHEAT_ALPHA = 0.04
const DENSE_GRAPH_STARTUP_ALPHA = 0.22
const DENSE_GRAPH_STARTUP_DURATION = 2_500
const STRUCTURE_GRAPH_STARTUP_ALPHA = 0.12
const STRUCTURE_GRAPH_STARTUP_DURATION = 1_500
const STRUCTURE_GRAPH_STARTUP_THRESHOLD = 160
const LIVE_GRAPH_SETTLED_TICK_TARGET = 6
const LIVE_GRAPH_LOCAL_COOLING_TICK_BUDGET = 48
const LIVE_GRAPH_DENSE_COOLING_TICK_BUDGET = 24
const LIVE_GRAPH_COOLING_ALPHA_FLOOR = 0.002
const LIVE_GRAPH_SETTLED_RMS_RADIUS_RATIO = 0.005
const LIVE_GRAPH_SETTLED_MAX_RADIUS_RATIO = 0.02
const LIVE_GRAPH_SETTLED_RMS_SCREEN_PX = 0.1
const LIVE_GRAPH_SETTLED_MAX_SCREEN_PX = 0.2
const DEFAULT_LINK_FORCE = 42

function liveGraphLinkControlRatio(linkDistance: number): number {
  return (clamp(linkDistance, 48, 220) - 48) / (220 - 48)
}

export function liveGraphLinkTargetSurfaceGap(linkDistance: number): number {
  const distanceRatio = liveGraphLinkControlRatio(linkDistance)

  return (
    LIVE_GRAPH_LINK_SURFACE_GAP_MIN +
    distanceRatio * (LIVE_GRAPH_LINK_SURFACE_GAP_MAX - LIVE_GRAPH_LINK_SURFACE_GAP_MIN)
  )
}

export function liveGraphSemanticLinkSurfaceGap(kind: LiveGraphEdge['kind'], linkDistance: number): number {
  const surfaceGap = liveGraphLinkTargetSurfaceGap(linkDistance)

  if (kind === 'contains') {
    return clamp(surfaceGap * 0.35, 4, 14)
  }

  if (kind === 'delegated_to' || kind === 'produced') {
    return clamp(surfaceGap * 0.2, 2, 8)
  }

  return surfaceGap
}

export function liveGraphSemanticLinkStrength(
  kind: LiveGraphEdge['kind'],
  degreeStrength: number,
  linkForce: number
): number {
  const linkStrengthScale = clamp(linkForce / DEFAULT_LINK_FORCE, 0, 100 / DEFAULT_LINK_FORCE)

  if (kind === 'contains') {
    return clamp(0.72 * linkStrengthScale, 0, 1)
  }

  if (kind === 'delegated_to' || kind === 'produced') {
    return clamp(0.82 * linkStrengthScale, 0, 1)
  }

  return clamp(degreeStrength * linkStrengthScale, 0, 1)
}

const OVERVIEW_LABEL_KIND_RANK: Record<LiveGraphKind, number> = {
  workflow: 0,
  project: 1,
  session: 2,
  task: 3,
  agent: 4,
  artifact: 5
}

const LIVE_GRAPH_ACTIVE_WORK_KINDS = new Set<LiveGraphKind>(['task', 'agent'])
const LIVE_GRAPH_INSPECTOR_PREVIEW_CHARACTERS = 240
const LIVE_GRAPH_INSPECTOR_PREVIEW_LINES = 5
const LIVE_GRAPH_TEXT_FADE_THRESHOLD_DEFAULT = 200
const LIVE_GRAPH_TEXT_FADE_THRESHOLD_MAX = 200

export const DEFAULT_LIVE_GRAPH_VIEW_STATE: LiveGraphViewState = {
  activeOnly: false,
  arrows: true,
  camera: DEFAULT_CAMERA,
  centerForce: 72,
  enabledKinds: [...LIVE_GRAPH_KINDS],
  focusDepth: 2,
  labels: true,
  linkDistance: 112,
  linkForce: DEFAULT_LINK_FORCE,
  nodeSize: LIVE_GRAPH_NODE_SIZE_DEFAULT,
  orphans: false,
  repelForce: 62,
  search: '',
  textFadeThreshold: LIVE_GRAPH_TEXT_FADE_THRESHOLD_DEFAULT
}

function liveGraphLayoutSettings(state: LiveGraphViewState): LayoutSettings {
  return {
    centerForce: state.centerForce,
    linkDistance: state.linkDistance,
    linkForce: state.linkForce,
    repelForce: state.repelForce
  }
}

const KIND_ICON: Record<LiveGraphKind, string> = {
  agent: 'hubot',
  artifact: 'file',
  project: 'folder',
  session: 'comment-discussion',
  task: 'checklist',
  workflow: 'type-hierarchy'
}

// Mirrors the private-use glyphs in @vscode/codicons/dist/codicon.css so the
// graph can render the existing icon vocabulary as lightweight native SVG text.
const KIND_GLYPH: Record<LiveGraphKind, string> = {
  agent: '\ueb08',
  artifact: '\uea7b',
  project: '\uea83',
  session: '\ueac7',
  task: '\ueab3',
  workflow: '\uebb9'
}

const KIND_COLOR: Record<LiveGraphKind, string> = {
  agent: 'var(--live-graph-kind-agent)',
  artifact: 'var(--live-graph-kind-artifact)',
  project: 'var(--live-graph-kind-project)',
  session: 'var(--live-graph-kind-session)',
  task: 'var(--live-graph-kind-task)',
  workflow: 'var(--live-graph-kind-workflow)'
}

export function liveGraphNodeId(node: LiveGraphNode): string {
  return node.id
}

export function liveGraphNodeLabel(node: LiveGraphNode): string {
  return node.label || node.id
}

function liveGraphNodeDetail(node: LiveGraphNode): string {
  return node.detail || ''
}

export function liveGraphNodeKind(node: LiveGraphNode): LiveGraphKind {
  return node.kind
}

export function liveGraphNodeStatus(node: LiveGraphNode): string {
  return normalizeLiveGraphStatus(node.status)
}

function liveGraphTaskId(node: LiveGraphNode): string {
  return node.kind === 'task' ? node.entityId || node.id : ''
}

export interface LiveGraphTaskTarget {
  board?: string
  taskId: string
  workflowId?: string
}

function liveGraphTaskTarget(node: LiveGraphNode): LiveGraphTaskTarget | null {
  if (liveGraphNodeKind(node) !== 'task') {
    return null
  }

  const taskId = liveGraphTaskId(node)

  if (!taskId) {
    return null
  }

  return {
    ...(node.board ? { board: node.board } : {}),
    taskId,
    ...(node.workflowId ? { workflowId: node.workflowId } : {})
  }
}

interface LiveGraphInspectorTextSectionProps {
  collapseLabel: string
  expandLabel: string
  label: string
  value: string
}

function LiveGraphInspectorTextSection({
  collapseLabel,
  expandLabel,
  label,
  value
}: LiveGraphInspectorTextSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const lineCount = value.split(/\r?\n/).length

  const collapsible =
    value.length > LIVE_GRAPH_INSPECTOR_PREVIEW_CHARACTERS || lineCount > LIVE_GRAPH_INSPECTOR_PREVIEW_LINES

  return (
    <section className="grid min-w-0 max-w-full gap-1">
      <h3 className="m-0 text-[0.625rem] font-semibold tracking-wide text-(--ui-text-tertiary) uppercase">{label}</h3>
      <p
        className={
          'm-0 whitespace-pre-wrap break-words text-[0.6875rem] leading-4 text-(--ui-text-secondary)' +
          (collapsible && !expanded ? ' line-clamp-5' : '')
        }
        data-live-graph-inspector-section-text
        data-live-graph-inspector-truncated={collapsible && !expanded ? 'true' : undefined}
      >
        {value}
      </p>
      {collapsible && (
        <Button
          aria-expanded={expanded}
          aria-label={(expanded ? collapseLabel : expandLabel) + ' ' + label}
          className="-ml-2 h-5 w-fit justify-start px-2 text-[0.625rem]"
          onClick={() => setExpanded(current => !current)}
          size="xs"
          type="button"
          variant="text"
        >
          <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          {expanded ? collapseLabel : expandLabel}
        </Button>
      )}
    </section>
  )
}

export function liveGraphEdgeSource(edge: LiveGraphEdge): string {
  return edge.sourceId
}

export function liveGraphEdgeTarget(edge: LiveGraphEdge): string {
  return edge.targetId
}

function snapshotNodes(graph: LiveGraphSnapshot): LiveGraphNode[] {
  return graph.nodes
}

function snapshotEdges(graph: LiveGraphSnapshot): LiveGraphEdge[] {
  return graph.edges
}

function snapshotRootId(graph: LiveGraphSnapshot): string {
  return graph.rootId || graph.nodes.find(node => node.kind === 'session')?.id || ''
}

export function liveGraphTopologyKey(nodes: LiveGraphNode[], edges: LiveGraphEdge[]): string {
  const nodeKeys = nodes
    .map(node => [liveGraphNodeId(node), liveGraphNodeKind(node), liveGraphWorkflowEnvelopeId(node)])
    .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')))

  const edgeKeys = edges
    .map(edge => [edge.id, edge.kind, edge.sourceId, edge.targetId])
    .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')))

  return JSON.stringify([nodeKeys, edgeKeys])
}

function pulseId(pulse: LiveGraphPulse): string {
  return pulse.id
}

function pulseSourceId(pulse: LiveGraphPulse): string {
  return pulse.sourceId
}

function pulseTargetId(pulse: LiveGraphPulse): string {
  return pulse.targetId
}

function pulseKind(pulse: LiveGraphPulse): string {
  return pulse.kind
}

function pulseLabel(pulse: LiveGraphPulse, nodes: Map<string, LiveGraphNode>): string {
  const node = nodes.get(pulse.targetId)

  return node ? liveGraphNodeLabel(node) : ''
}

function pulseStatus(pulse: LiveGraphPulse): string {
  if (pulse.kind === 'completed') {
    return 'completed'
  }

  if (pulse.kind === 'blocked') {
    return 'blocked'
  }

  if (pulse.kind === 'failed') {
    return 'failed'
  }

  if (pulse.kind === 'activated' || pulse.kind === 'delegated') {
    return 'running'
  }

  if (pulse.kind === 'produced') {
    return 'completed'
  }

  if (pulse.kind === 'task_added') {
    return 'queued'
  }

  return 'unknown'
}

type LiveGraphWorkState = 'active' | 'blocked' | 'none' | 'running' | 'settled'

function liveGraphNodeWorkState(node: LiveGraphNode): LiveGraphWorkState {
  if (!LIVE_GRAPH_ACTIVE_WORK_KINDS.has(liveGraphNodeKind(node))) {
    return 'none'
  }

  const status = liveGraphNodeStatus(node)

  if (LIVE_GRAPH_SETTLED_STATUSES.has(status)) {
    return 'settled'
  }

  if (status === 'blocked') {
    return 'blocked'
  }

  if (status === 'running') {
    return 'running'
  }

  return 'active'
}

export function liveGraphActiveComponentNodeIds(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): ReadonlySet<string> {
  const nodesById = new Map(nodes.map(node => [liveGraphNodeId(node), node]))
  const activeIds = new Set<string>()

  for (const component of analyzeLiveGraphTopology(nodes, edges).components) {
    const active = component.some(id => {
      const node = nodesById.get(id)

      if (!node) {
        return false
      }

      const workState = liveGraphNodeWorkState(node)

      return workState !== 'none' && workState !== 'settled'
    })

    if (active) {
      for (const id of component) {
        activeIds.add(id)
      }
    }
  }

  return activeIds
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function liveGraphDenseLod(scale: number): DenseGraphLod {
  const safeScale = Number.isFinite(scale) ? scale : 1

  if (safeScale < DENSE_GRAPH_STRUCTURE_SCALE) {
    return 'overview'
  }

  if (safeScale < DENSE_GRAPH_DETAIL_SCALE) {
    return 'structure'
  }

  return 'detail'
}

export function liveGraphTextFadeOpacity(scale: number, threshold: number): number {
  const safeScale = Number.isFinite(scale) ? clamp(scale, 0.2, LIVE_GRAPH_MAX_SCALE) : 1

  const safeThreshold = Number.isFinite(threshold)
    ? clamp(threshold, 0, LIVE_GRAPH_TEXT_FADE_THRESHOLD_MAX)
    : LIVE_GRAPH_TEXT_FADE_THRESHOLD_DEFAULT

  const fadeStart = 0.25 + (safeThreshold / 100) * 0.75
  const fadeEnd = Math.max(0.2, fadeStart - 0.3)
  const progress = clamp((safeScale - fadeEnd) / Math.max(0.05, fadeStart - fadeEnd), 0, 1)

  return progress * progress * (3 - 2 * progress)
}

export function liveGraphStartupHeat(nodeCount: number): { alpha: number; duration: number } {
  if (nodeCount >= DENSE_GRAPH_NODE_THRESHOLD) {
    return { alpha: DENSE_GRAPH_STARTUP_ALPHA, duration: DENSE_GRAPH_STARTUP_DURATION }
  }

  if (nodeCount >= STRUCTURE_GRAPH_STARTUP_THRESHOLD) {
    return { alpha: STRUCTURE_GRAPH_STARTUP_ALPHA, duration: STRUCTURE_GRAPH_STARTUP_DURATION }
  }

  return { alpha: 0, duration: 0 }
}

export function clientToLiveGraphPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top'>,
  camera: Camera
): { x: number; y: number } {
  return {
    x: (clientX - bounds.left - camera.x) / camera.scale,
    y: (clientY - bounds.top - camera.y) / camera.scale
  }
}

function hashString(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function liveGraphNodeBaseRadius(node: LiveGraphNode): number {
  const kind = liveGraphNodeKind(node)

  if (kind === 'agent' || kind === 'artifact') {
    return LIVE_GRAPH_AGENT_BASE_RADIUS
  }

  if (kind === 'workflow') {
    return LIVE_GRAPH_WORKFLOW_BASE_RADIUS
  }

  if (kind === 'session' || kind === 'project') {
    return LIVE_GRAPH_SESSION_BASE_RADIUS
  }

  return LIVE_GRAPH_NODE_BASE_RADIUS
}

function liveGraphNodeHubProfile(node: LiveGraphNode): { cap: number; maxRadius: number } {
  const kind = liveGraphNodeKind(node)

  if (kind === 'session' || kind === 'project') {
    return { cap: LIVE_GRAPH_SESSION_DESCENDANT_CAP, maxRadius: LIVE_GRAPH_SESSION_MAX_RADIUS }
  }

  if (kind === 'workflow') {
    return { cap: LIVE_GRAPH_WORKFLOW_DESCENDANT_CAP, maxRadius: LIVE_GRAPH_WORKFLOW_MAX_RADIUS }
  }

  return { cap: LIVE_GRAPH_ROOT_TASK_DESCENDANT_CAP, maxRadius: LIVE_GRAPH_ROOT_TASK_MAX_RADIUS }
}

function liveGraphDefaultDescendantHub(node: LiveGraphNode): boolean {
  const kind = liveGraphNodeKind(node)

  return kind === 'project' || kind === 'session' || kind === 'workflow'
}

export function liveGraphNodeRadius(
  node: LiveGraphNode,
  descendantCount: number,
  _referenceCount = LIVE_GRAPH_SESSION_DESCENDANT_CAP,
  sizeByDescendants = liveGraphDefaultDescendantHub(node)
): number {
  const baseRadius = liveGraphNodeBaseRadius(node)
  const safeDescendantCount = Number.isFinite(descendantCount) ? Math.max(0, descendantCount) : 0

  if (!sizeByDescendants || safeDescendantCount === 0) {
    return baseRadius
  }

  const { cap, maxRadius } = liveGraphNodeHubProfile(node)

  const relativeDescendantCount = Math.log1p(Math.min(safeDescendantCount, cap)) / Math.log1p(cap)

  return baseRadius + (maxRadius - baseRadius) * Math.sqrt(relativeDescendantCount)
}

export function liveGraphDescendantHubIds(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): ReadonlySet<string> {
  const nodeById = new Map(nodes.map(node => [liveGraphNodeId(node), node]))

  const hubIds = new Set(nodes.filter(liveGraphDefaultDescendantHub).map(liveGraphNodeId).filter(Boolean))

  for (const edge of edges) {
    if (edge.kind !== 'contains') {
      continue
    }

    const sourceId = liveGraphEdgeSource(edge)
    const targetId = liveGraphEdgeTarget(edge)
    const source = nodeById.get(sourceId)
    const target = nodeById.get(targetId)

    if (source && target && liveGraphNodeKind(source) === 'workflow' && liveGraphNodeKind(target) === 'task') {
      hubIds.add(targetId)
    }
  }

  return hubIds
}

export function liveGraphNodeRadii(
  nodes: readonly LiveGraphNode[],
  countById: ReadonlyMap<string, number>,
  nodeSize = LIVE_GRAPH_NODE_SIZE_DEFAULT,
  descendantHubIds?: ReadonlySet<string>
): ReadonlyMap<string, number> {
  const safeNodeSize = Number.isFinite(nodeSize) ? nodeSize : LIVE_GRAPH_NODE_SIZE_DEFAULT
  const sizeScale = clamp(safeNodeSize, LIVE_GRAPH_NODE_SIZE_MIN, LIVE_GRAPH_NODE_SIZE_MAX) / 100

  return new Map(
    nodes.map(node => {
      const id = liveGraphNodeId(node)

      return [
        id,
        liveGraphNodeRadius(
          node,
          countById.get(id) ?? 0,
          LIVE_GRAPH_SESSION_DESCENDANT_CAP,
          descendantHubIds?.has(id)
        ) * sizeScale
      ] as const
    })
  )
}

export function trimLiveGraphEdge(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sourceRadius: number,
  targetRadius: number,
  gap = 2
): { x1: number; x2: number; y1: number; y2: number } {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const distance = Math.hypot(dx, dy)

  if (distance === 0) {
    return { x1: source.x, x2: target.x, y1: source.y, y2: target.y }
  }

  const sourceTrim = sourceRadius + gap
  const targetTrim = targetRadius + gap
  const trimScale = sourceTrim + targetTrim >= distance ? Math.max(0, (distance - 1) / (sourceTrim + targetTrim)) : 1
  const unitX = dx / distance
  const unitY = dy / distance

  return {
    x1: source.x + unitX * sourceTrim * trimScale,
    x2: target.x - unitX * targetTrim * trimScale,
    y1: source.y + unitY * sourceTrim * trimScale,
    y2: target.y - unitY * targetTrim * trimScale
  }
}

export function liveGraphEdgePath(
  edges: readonly LiveGraphEdge[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  radiusById: ReadonlyMap<string, number>,
  gap = LIVE_GRAPH_EDGE_GAP
): string {
  const commands: string[] = []

  for (const edge of edges) {
    const sourceId = liveGraphEdgeSource(edge)
    const targetId = liveGraphEdgeTarget(edge)
    const source = positions.get(sourceId)
    const target = positions.get(targetId)

    if (!source || !target) {
      continue
    }

    const segment = trimLiveGraphEdge(source, target, radiusById.get(sourceId) ?? 0, radiusById.get(targetId) ?? 0, gap)

    commands.push(`M${segment.x1},${segment.y1}L${segment.x2},${segment.y2}`)
  }

  return commands.join('')
}

function liveGraphNeighbors(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): Map<string, Set<string>> {
  const nodeIds = new Set(nodes.map(liveGraphNodeId).filter(Boolean))
  const neighbors = new Map([...nodeIds].map(id => [id, new Set<string>()]))

  for (const edge of edges) {
    const source = liveGraphEdgeSource(edge)
    const target = liveGraphEdgeTarget(edge)

    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue
    }

    neighbors.get(source)?.add(target)
    neighbors.get(target)?.add(source)
  }

  return neighbors
}

function liveGraphSemanticChildren(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): ReadonlyMap<string, readonly string[]> {
  const nodeById = new Map(nodes.map(node => [liveGraphNodeId(node), node]))
  const childrenById = new Map([...nodeById.keys()].sort().map(id => [id, new Set<string>()]))

  for (const edge of edges) {
    const sourceId = liveGraphEdgeSource(edge)
    const targetId = liveGraphEdgeTarget(edge)
    const source = nodeById.get(sourceId)
    const target = nodeById.get(targetId)

    if (!source || !target || sourceId === targetId) {
      continue
    }

    if (edge.kind === 'depends_on') {
      const sourceWorkflow = liveGraphWorkflowEnvelopeId(source)
      const targetWorkflow = liveGraphWorkflowEnvelopeId(target)

      if (
        liveGraphNodeKind(source) !== 'task' ||
        liveGraphNodeKind(target) !== 'task' ||
        !sourceWorkflow ||
        sourceWorkflow !== targetWorkflow
      ) {
        continue
      }

      childrenById.get(targetId)?.add(sourceId)

      continue
    }

    childrenById.get(sourceId)?.add(targetId)
  }

  return new Map([...childrenById].map(([id, children]) => [id, [...children].sort()]))
}

function liveGraphSemanticPeerGroups(
  nodeIds: readonly string[],
  childrenById: ReadonlyMap<string, readonly string[]>
): { groupIndexById: ReadonlyMap<string, number>; groups: readonly (readonly string[])[] } {
  const parentsById = new Map(nodeIds.map(id => [id, [] as string[]]))

  for (const [parentId, childIds] of childrenById) {
    for (const childId of childIds) {
      parentsById.get(childId)?.push(parentId)
    }
  }

  for (const parentIds of parentsById.values()) {
    parentIds.sort()
  }

  const visited = new Set<string>()
  const finishOrder: string[] = []

  for (const startId of nodeIds) {
    if (visited.has(startId)) {
      continue
    }

    visited.add(startId)
    const stack: Array<{ id: string; nextChild: number }> = [{ id: startId, nextChild: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const childId = (childrenById.get(frame.id) ?? [])[frame.nextChild]

      if (childId !== undefined) {
        frame.nextChild += 1

        if (!visited.has(childId)) {
          visited.add(childId)
          stack.push({ id: childId, nextChild: 0 })
        }

        continue
      }

      finishOrder.push(frame.id)
      stack.pop()
    }
  }

  const groups: string[][] = []
  const groupIndexById = new Map<string, number>()

  for (let finishIndex = finishOrder.length - 1; finishIndex >= 0; finishIndex -= 1) {
    const startId = finishOrder[finishIndex]!

    if (groupIndexById.has(startId)) {
      continue
    }

    const group: string[] = []
    const pending = [startId]
    const groupIndex = groups.length
    groupIndexById.set(startId, groupIndex)

    while (pending.length > 0) {
      const id = pending.pop()!
      group.push(id)

      for (const parentId of parentsById.get(id) ?? []) {
        if (!groupIndexById.has(parentId)) {
          groupIndexById.set(parentId, groupIndex)
          pending.push(parentId)
        }
      }
    }

    groups.push(group.sort())
  }

  return { groupIndexById, groups }
}

/**
 * Count each node's unique structural descendants.
 *
 * Physical links stay kind-agnostic. Only semantic ownership affects size:
 * contains/delegated/produced point parent-to-child, while same-workflow task
 * dependencies point child-to-parent in storage and are normalized here.
 * Cross-workflow dependencies remain visible context links but do not change
 * either workflow's hierarchy. Legacy cycles collapse into equal peer groups.
 */
export function liveGraphSemanticReachCounts(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): ReadonlyMap<string, number> {
  const nodeIds = nodes.map(liveGraphNodeId).filter(Boolean).sort()
  const childrenById = liveGraphSemanticChildren(nodes, edges)
  const { groupIndexById, groups } = liveGraphSemanticPeerGroups(nodeIds, childrenById)
  const childGroups = groups.map(() => new Set<number>())
  const indegree = groups.map(() => 0)

  for (const [parentId, childIds] of childrenById) {
    const parentGroup = groupIndexById.get(parentId)

    if (parentGroup === undefined) {
      continue
    }

    for (const childId of childIds) {
      const childGroup = groupIndexById.get(childId)

      if (childGroup === undefined || childGroup === parentGroup || childGroups[parentGroup]!.has(childGroup)) {
        continue
      }

      childGroups[parentGroup]!.add(childGroup)
      indegree[childGroup] = (indegree[childGroup] ?? 0) + 1
    }
  }

  const topologicalOrder: number[] = []
  const pendingGroups = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []))

  for (let pendingIndex = 0; pendingIndex < pendingGroups.length; pendingIndex += 1) {
    const groupIndex = pendingGroups[pendingIndex]!
    topologicalOrder.push(groupIndex)

    for (const childGroup of childGroups[groupIndex] ?? []) {
      indegree[childGroup] = (indegree[childGroup] ?? 1) - 1

      if (indegree[childGroup] === 0) {
        pendingGroups.push(childGroup)
      }
    }
  }

  const reachWordCount = Math.ceil(groups.length / 32)
  const reachableGroups = groups.map(() => new Uint32Array(reachWordCount))

  for (let orderIndex = topologicalOrder.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const groupIndex = topologicalOrder[orderIndex]!
    const reachable = reachableGroups[groupIndex]!

    for (const childGroup of childGroups[groupIndex] ?? []) {
      reachable[childGroup >>> 5] |= 1 << (childGroup & 31)
      const childReachable = reachableGroups[childGroup]!

      for (let wordIndex = 0; wordIndex < reachWordCount; wordIndex += 1) {
        reachable[wordIndex] |= childReachable[wordIndex] ?? 0
      }
    }
  }

  const descendantCountByGroup = reachableGroups.map(reachable => {
    let count = 0

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      if ((reachable[groupIndex >>> 5]! & (1 << (groupIndex & 31))) !== 0) {
        count += groups[groupIndex]?.length ?? 0
      }
    }

    return count
  })

  return new Map(nodeIds.map(id => [id, descendantCountByGroup[groupIndexById.get(id) ?? -1] ?? 0]))
}

export function analyzeLiveGraphTopology(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[]
): LiveGraphTopologyAnalysis {
  const neighbors = liveGraphNeighbors(nodes, edges)
  const degreeById = new Map([...neighbors].map(([id, adjacent]) => [id, adjacent.size]))
  const visited = new Set<string>()
  const components: string[][] = []

  for (const startId of [...neighbors.keys()].sort()) {
    if (visited.has(startId)) {
      continue
    }

    const component: string[] = []
    const queue = [startId]
    visited.add(startId)

    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]

      if (!id) {
        continue
      }

      component.push(id)

      for (const neighbor of [...(neighbors.get(id) ?? [])].sort()) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }

    components.push(component.sort())
  }

  components.sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''))

  return { components, degreeById, neighbors }
}

export function selectLiveGraphOverviewLabelIds(
  nodes: readonly LiveGraphNode[],
  analysis: LiveGraphTopologyAnalysis,
  limit = DENSE_GRAPH_OVERVIEW_LABEL_LIMIT
): ReadonlySet<string> {
  const capacity = Math.max(0, Math.floor(limit))
  const selected = new Set<string>()

  if (capacity === 0) {
    return selected
  }

  const nodesById = new Map(nodes.map(node => [liveGraphNodeId(node), node]))
  const degree = (id: string) => analysis.degreeById.get(id) ?? 0

  const kindRank = (id: string) => {
    const node = nodesById.get(id)

    return node ? OVERVIEW_LABEL_KIND_RANK[liveGraphNodeKind(node)] : Number.MAX_SAFE_INTEGER
  }

  const byKindThenDegree = (left: string, right: string) =>
    kindRank(left) - kindRank(right) || degree(right) - degree(left) || left.localeCompare(right)

  const byDegreeThenKind = (left: string, right: string) =>
    degree(right) - degree(left) || kindRank(left) - kindRank(right) || left.localeCompare(right)

  const add = (id: string | undefined) => {
    if (id && selected.size < capacity) {
      selected.add(id)
    }
  }

  const workflowReserve = Math.min(capacity, Math.max(1, Math.ceil(capacity / 4)))

  const workflows = nodes
    .filter(node => liveGraphNodeKind(node) === 'workflow' && degree(liveGraphNodeId(node)) > 0)
    .map(liveGraphNodeId)
    .sort(byDegreeThenKind)

  for (const id of workflows.slice(0, workflowReserve)) {
    add(id)
  }

  const components = [...analysis.components].sort((left, right) => {
    const connectedOrder = Number(left.length === 1) - Number(right.length === 1)

    return connectedOrder || right.length - left.length || (left[0] ?? '').localeCompare(right[0] ?? '')
  })

  for (const component of components) {
    if (selected.size >= capacity) {
      break
    }

    const connected = component.filter(id => degree(id) > 0 && nodesById.has(id))
    const semantic = connected.filter(id => kindRank(id) <= OVERVIEW_LABEL_KIND_RANK.session)
    add([...(semantic.length > 0 ? semantic : connected)].sort(byKindThenDegree)[0])
  }

  const semanticHubs = nodes
    .map(liveGraphNodeId)
    .filter(id => degree(id) > 0 && kindRank(id) <= OVERVIEW_LABEL_KIND_RANK.session)
    .sort(byDegreeThenKind)

  for (const id of semanticHubs) {
    add(id)
  }

  return selected
}

export function liveGraphEdgeAppearance(
  denseGraph: boolean,
  denseLod: DenseGraphLod,
  emphasisId: string | null,
  sourceId: string,
  targetId: string
): { emphasized: boolean; opacity: number; strokeWidth: number } {
  const emphasized = Boolean(emphasisId && (sourceId === emphasisId || targetId === emphasisId))

  if (!denseGraph) {
    if (!emphasisId) {
      return { emphasized, opacity: 0.48, strokeWidth: 1.1 }
    }

    return emphasized ? { emphasized, opacity: 1, strokeWidth: 1.8 } : { emphasized, opacity: 0.07, strokeWidth: 0.65 }
  }

  if (emphasisId) {
    return emphasized ? { emphasized, opacity: 1, strokeWidth: 1.8 } : { emphasized, opacity: 0.025, strokeWidth: 0.5 }
  }

  switch (denseLod) {
    case 'overview':
      return { emphasized, opacity: 0.14, strokeWidth: 0.65 }

    case 'structure':
      return { emphasized, opacity: 0.2, strokeWidth: 0.75 }

    default:
      return { emphasized, opacity: 0.3, strokeWidth: 0.9 }
  }
}

function liveGraphWorkflowEnvelopeId(node: LiveGraphNode): string {
  const kind = liveGraphNodeKind(node)

  if (kind !== 'task' && kind !== 'workflow') {
    return ''
  }

  const workflowId = node.workflowId || (kind === 'workflow' ? node.entityId : '')

  if (!workflowId) {
    return ''
  }

  const idParts = liveGraphNodeId(node).split(':')
  const scope = idParts.length >= 4 ? idParts.slice(1, -1).join(':') : node.board || ''

  return `workflow-envelope:${scope}:${encodeURIComponent(workflowId)}`
}

function liveGraphLayoutMetrics(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[],
  semanticReachById?: ReadonlyMap<string, number>,
  nodeSize = LIVE_GRAPH_NODE_SIZE_DEFAULT,
  descendantHubIds?: ReadonlySet<string>
): LiveGraphLayoutMetrics {
  const analysis = analyzeLiveGraphTopology(nodes, edges)
  const effectiveSemanticReachById = semanticReachById ?? liveGraphSemanticReachCounts(nodes, edges)
  const effectiveDescendantHubIds = descendantHubIds ?? liveGraphDescendantHubIds(nodes, edges)
  const radiusById = liveGraphNodeRadii(nodes, effectiveSemanticReachById, nodeSize, effectiveDescendantHubIds)

  return {
    analysis,
    radiusById,
    semanticReachById: effectiveSemanticReachById
  }
}

export function visibleLiveGraph(
  graph: LiveGraphSnapshot,
  options: {
    activeOnly?: boolean
    enabledKinds: ReadonlySet<LiveGraphKind>
    focusDepth: LiveGraphFocusDepth
    focusId?: string | null
    orphans: boolean
    search: string
  }
): VisibleGraph {
  const graphNodes = snapshotNodes(graph)

  const graphNodeIds = new Set(graphNodes.map(liveGraphNodeId))

  const graphEdges = snapshotEdges(graph).filter(
    edge => graphNodeIds.has(liveGraphEdgeSource(edge)) && graphNodeIds.has(liveGraphEdgeTarget(edge))
  )

  const activeComponentIds = options.activeOnly ? liveGraphActiveComponentNodeIds(graphNodes, graphEdges) : null

  const nodes = graphNodes.filter(node => {
    const id = liveGraphNodeId(node)

    return options.enabledKinds.has(liveGraphNodeKind(node)) && (!activeComponentIds || activeComponentIds.has(id))
  })

  const nodeIds = new Set(nodes.map(liveGraphNodeId))

  const edges = graphEdges.filter(
    edge => nodeIds.has(liveGraphEdgeSource(edge)) && nodeIds.has(liveGraphEdgeTarget(edge))
  )

  const neighbors = liveGraphNeighbors(nodes, edges)

  const eligibleNodes = options.orphans
    ? nodes
    : nodes.filter(node => (neighbors.get(liveGraphNodeId(node))?.size ?? 0) > 0)

  const eligibleIds = new Set(eligibleNodes.map(liveGraphNodeId))
  const selectedFocusId = options.focusId && eligibleIds.has(options.focusId) ? options.focusId : null
  const allowedByDepth = new Set<string>()
  const eligibleNodesById = new Map(eligibleNodes.map(node => [liveGraphNodeId(node), node]))
  const selectedFocusNode = selectedFocusId ? eligibleNodesById.get(selectedFocusId) : undefined

  const selectedWorkflowEnvelope =
    selectedFocusNode && liveGraphNodeKind(selectedFocusNode) === 'workflow'
      ? liveGraphWorkflowEnvelopeId(selectedFocusNode)
      : ''

  const workflowScopeIds = selectedWorkflowEnvelope
    ? new Set(
        eligibleNodes
          .filter(node => {
            const id = liveGraphNodeId(node)

            return (
              id === selectedFocusId ||
              (liveGraphNodeKind(node) === 'task' && liveGraphWorkflowEnvelopeId(node) === selectedWorkflowEnvelope)
            )
          })
          .map(liveGraphNodeId)
      )
    : null

  if (options.focusDepth === 'all' || !selectedFocusId) {
    for (const id of eligibleIds) {
      allowedByDepth.add(id)
    }
  } else if (workflowScopeIds) {
    for (const id of workflowScopeIds) {
      allowedByDepth.add(id)
    }

    if (options.focusDepth === 2) {
      for (const id of workflowScopeIds) {
        for (const neighborId of neighbors.get(id) ?? []) {
          const neighbor = eligibleNodesById.get(neighborId)

          if (!neighbor) {
            continue
          }

          const kind = liveGraphNodeKind(neighbor)

          if (kind === 'project' || kind === 'session' || kind === 'workflow') {
            continue
          }

          if (kind !== 'task' || workflowScopeIds.has(neighborId)) {
            allowedByDepth.add(neighborId)
          }
        }
      }
    }
  } else {
    const pending: Array<{ depth: number; id: string }> = [{ depth: 0, id: selectedFocusId }]
    const queued = new Set([selectedFocusId])

    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index]

      if (!current || allowedByDepth.has(current.id) || current.depth > options.focusDepth) {
        continue
      }

      allowedByDepth.add(current.id)

      if (current.depth === options.focusDepth) {
        continue
      }

      for (const neighbor of neighbors.get(current.id) ?? []) {
        if (!queued.has(neighbor)) {
          queued.add(neighbor)
          pending.push({ depth: current.depth + 1, id: neighbor })
        }
      }
    }
  }

  const query = options.search.trim().toLocaleLowerCase()

  const visibleNodes = eligibleNodes.filter(node => {
    const id = liveGraphNodeId(node)

    if (!allowedByDepth.has(id)) {
      return false
    }

    if (!query) {
      return true
    }

    return [liveGraphNodeLabel(node), liveGraphNodeDetail(node), liveGraphNodeStatus(node), id]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query)
  })

  const visibleIds = new Set(visibleNodes.map(liveGraphNodeId))

  const visibleEdges = edges.filter(
    edge => visibleIds.has(liveGraphEdgeSource(edge)) && visibleIds.has(liveGraphEdgeTarget(edge))
  )

  return { edges: visibleEdges, nodes: visibleNodes }
}

export function settledLiveGraphLayout(
  nodes: LiveGraphNode[],
  edges: LiveGraphEdge[],
  settings: LayoutSettings,
  _rootId?: string,
  metrics = liveGraphLayoutMetrics(nodes, edges)
): SettledGraphNode[] {
  const sortedNodes = [...nodes].sort((left, right) => liveGraphNodeId(left).localeCompare(liveGraphNodeId(right)))

  if (metrics.analysis.components.length > 1) {
    return settledDisjointLiveGraphLayout(sortedNodes, edges, metrics, settings)
  }

  const simNodes: SimNode[] = sortedNodes.map(node => {
    const id = liveGraphNodeId(node)

    return {
      id,
      node,
      radius: metrics.radiusById.get(id) ?? liveGraphNodeRadius(node, 0)
    }
  })

  const simulation = createLiveGraphSimulation(simNodes, edges, settings).stop()
  const settleTicks = liveGraphSettleTickBudget(simNodes.length)

  if (simNodes.length >= DENSE_GRAPH_NODE_THRESHOLD) {
    simulation.alpha(liveGraphSimulationHeat(simNodes.length).alphaTarget)
  }

  simulation.tick(settleTicks)

  if (simNodes.length < 160) {
    simulation.tick(8)
  }

  simulation.stop()

  return simNodes.map(node => ({
    id: node.id,
    node: node.node,
    x: Number.isFinite(node.x) ? Number(node.x) : 0,
    y: Number.isFinite(node.y) ? Number(node.y) : 0
  }))
}

export function liveGraphComponentSettleTickLimit(totalNodeCount: number): number {
  return clamp(Math.floor(LIVE_GRAPH_COMPONENT_LOCAL_NODE_TICK_BUDGET / Math.max(1, totalNodeCount)), 12, 120)
}

export function liveGraphComponentWorkTickLimit(nodeCount: number, edgeCount: number): number {
  return clamp(Math.floor(LIVE_GRAPH_COMPONENT_LOCAL_WORK_TICK_BUDGET / Math.max(1, nodeCount + edgeCount)), 4, 120)
}

function liveGraphComponentPackingTickBudget(componentCount: number): number {
  if (componentCount >= 500) {
    return 80
  }

  if (componentCount >= 200) {
    return 120
  }

  return 180
}

function settledDisjointLiveGraphLayout(
  nodes: readonly LiveGraphNode[],
  edges: readonly LiveGraphEdge[],
  metrics: LiveGraphLayoutMetrics,
  settings: LayoutSettings
): SettledGraphNode[] {
  const nodeById = new Map(nodes.map(node => [liveGraphNodeId(node), node]))
  const componentIndexById = new Map<string, number>()

  metrics.analysis.components.forEach((component, componentIndex) => {
    for (const id of component) {
      componentIndexById.set(id, componentIndex)
    }
  })

  const edgesByComponent = metrics.analysis.components.map(() => [] as LiveGraphEdge[])

  for (const edge of edges) {
    const sourceComponent = componentIndexById.get(liveGraphEdgeSource(edge))
    const targetComponent = componentIndexById.get(liveGraphEdgeTarget(edge))

    if (sourceComponent !== undefined && sourceComponent === targetComponent) {
      edgesByComponent[sourceComponent]!.push(edge)
    }
  }

  const tickLimit = liveGraphComponentSettleTickLimit(nodes.length)

  const bodies = metrics.analysis.components.flatMap<LiveGraphPackedComponent>((component, index) => {
    const members = component.flatMap<SimNode>(id => {
      const node = nodeById.get(id)

      return node
        ? [
            {
              id,
              node,
              radius: metrics.radiusById.get(id) ?? liveGraphNodeRadius(node, 0)
            } satisfies SimNode
          ]
        : []
    })

    if (members.length === 0) {
      return []
    }

    if (members.length > 1) {
      const memberEdges = edgesByComponent[index] ?? []

      const simulation = createLiveGraphSimulation(members, memberEdges, settings).stop()

      simulation
        .tick(
          Math.min(
            liveGraphSettleTickBudget(members.length),
            tickLimit,
            liveGraphComponentWorkTickLimit(members.length, memberEdges.length)
          )
        )
        .stop()
    } else {
      members[0]!.x = 0
      members[0]!.y = 0
    }

    const centerX = members.reduce((sum, node) => sum + Number(node.x), 0) / members.length
    const centerY = members.reduce((sum, node) => sum + Number(node.y), 0) / members.length

    const radius = Math.max(
      ...members.map(
        node =>
          Math.hypot(Number(node.x) - centerX, Number(node.y) - centerY) +
          node.radius +
          LIVE_GRAPH_VISIBLE_COLLISION_PADDING
      )
    )

    return [{ centerX, centerY, index, members, radius }]
  })

  const packing = forceSimulation<LiveGraphPackedComponent>(bodies)
    .force('x', forceX<LiveGraphPackedComponent>(0).strength(0.08))
    .force('y', forceY<LiveGraphPackedComponent>(0).strength(0.08))
    .force(
      'collide',
      forceCollide<LiveGraphPackedComponent>()
        .radius(body => body.radius + LIVE_GRAPH_COMPONENT_GAP)
        .strength(1)
        .iterations(3)
    )
    .stop()

  packing.tick(liveGraphComponentPackingTickBudget(bodies.length)).stop()

  return bodies.flatMap(body =>
    body.members.map(node => ({
      id: node.id,
      node: node.node,
      x: Number(node.x) - body.centerX + Number(body.x),
      y: Number(node.y) - body.centerY + Number(body.y)
    }))
  )
}

/** Bound synchronous force work so a global graph never blocks the renderer for seconds. */
export function liveGraphSettleTickBudget(nodeCount: number): number {
  if (nodeCount >= 1_800) {
    return 1
  }

  if (nodeCount >= 1_000) {
    return 2
  }

  if (nodeCount >= 600) {
    return 4
  }

  if (nodeCount >= 300) {
    return 12
  }

  if (nodeCount >= 160) {
    return 40
  }

  return 260
}

export function liveGraphSimulationHeat(nodeCount: number): {
  activeFrameInterval: number
  alphaTarget: number
} {
  if (nodeCount >= 1_800) {
    return { activeFrameInterval: 120, alphaTarget: 0.006 }
  }

  if (nodeCount >= 800) {
    return { activeFrameInterval: 80, alphaTarget: 0.01 }
  }

  if (nodeCount >= 300) {
    return { activeFrameInterval: 50, alphaTarget: 0.014 }
  }

  return { activeFrameInterval: 16, alphaTarget: 0.025 }
}

/** Cap the asynchronous settling pass so pathological layouts cannot stay hot forever. */
export function liveGraphCoolingTickBudget(nodeCount: number): number {
  return nodeCount >= DENSE_GRAPH_NODE_THRESHOLD
    ? LIVE_GRAPH_DENSE_COOLING_TICK_BUDGET
    : LIVE_GRAPH_LOCAL_COOLING_TICK_BUDGET
}

/** Reach a genuinely cold alpha within the finite tick budget without slowing dense layouts. */
export function liveGraphCoolingAlphaDecay(alpha: number, tickBudget: number, baseDecay: number): number {
  const safeAlpha = Math.max(LIVE_GRAPH_COOLING_ALPHA_FLOOR, alpha)
  const safeBudget = Math.max(1, tickBudget)
  const requiredDecay = 1 - Math.pow(LIVE_GRAPH_COOLING_ALPHA_FLOOR / safeAlpha, 1 / safeBudget)

  return Math.max(baseDecay, requiredDecay)
}

/** Compare actual post-force movement with node scale, rather than d3's internal heat alone. */
export function liveGraphMotionSettled(
  rmsDisplacement: number,
  maxDisplacement: number,
  medianRadius: number,
  cameraScale = 1
): boolean {
  const radius = Math.max(1, medianRadius)
  const scale = Math.max(LIVE_GRAPH_MIN_SCALE, Number.isFinite(cameraScale) ? cameraScale : 1)

  const rmsLimit = Math.min(radius * LIVE_GRAPH_SETTLED_RMS_RADIUS_RATIO, LIVE_GRAPH_SETTLED_RMS_SCREEN_PX / scale)

  const maxLimit = Math.min(radius * LIVE_GRAPH_SETTLED_MAX_RADIUS_RATIO, LIVE_GRAPH_SETTLED_MAX_SCREEN_PX / scale)

  return rmsDisplacement <= rmsLimit && maxDisplacement <= maxLimit
}

export function liveGraphReheatAlpha(nodeCount: number, requestedAlpha: number): number {
  return nodeCount >= DENSE_GRAPH_NODE_THRESHOLD ? Math.min(requestedAlpha, DENSE_GRAPH_REHEAT_ALPHA) : requestedAlpha
}

function liveGraphSimulationLinks(simNodes: readonly SimNode[], edges: readonly LiveGraphEdge[]): SimLink[] {
  const nodeIds = new Set(simNodes.map(node => node.id))
  const degreeById = new Map(simNodes.map(node => [node.id, 0]))

  const validEdges = edges.flatMap(edge => {
    const source = liveGraphEdgeSource(edge)
    const target = liveGraphEdgeTarget(edge)

    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) {
      return []
    }

    degreeById.set(source, (degreeById.get(source) ?? 0) + 1)
    degreeById.set(target, (degreeById.get(target) ?? 0) + 1)

    return [{ edge, source, target }]
  })

  return validEdges
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        left.edge.kind.localeCompare(right.edge.kind) ||
        left.edge.id.localeCompare(right.edge.id)
    )
    .map(({ edge, source, target }) => ({
      degreeStrength: 1 / Math.max(1, Math.min(degreeById.get(source) ?? 1, degreeById.get(target) ?? 1)),
      kind: edge.kind,
      source,
      target
    }))
}

function liveGraphSimulationLinkEndpoint(endpoint: SimLink['source']): SimNode | undefined {
  return typeof endpoint === 'object' ? endpoint : undefined
}

function liveGraphComponentBody(members: readonly SimNode[], index: number): LiveGraphComponentBody {
  let bottom = -Infinity
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let area = 0

  for (const node of members) {
    const radius = node.radius + LIVE_GRAPH_VISIBLE_COLLISION_PADDING
    const x = Number(node.x) + Number(node.vx || 0)
    const y = Number(node.y) + Number(node.vy || 0)

    bottom = Math.max(bottom, y + radius)
    left = Math.min(left, x - radius)
    right = Math.max(right, x + radius)
    top = Math.min(top, y - radius)
    area += radius * radius
  }

  return {
    bottom,
    index,
    left,
    mass: Math.max(1, Math.sqrt(area)),
    members,
    right,
    shiftX: 0,
    shiftY: 0,
    top
  }
}

export function liveGraphComponentShiftLimit(alpha: number): number {
  return (
    LIVE_GRAPH_COMPONENT_MIN_SHIFT_LIMIT +
    clamp(alpha, 0, 1) * (LIVE_GRAPH_COMPONENT_MAX_SHIFT_LIMIT - LIVE_GRAPH_COMPONENT_MIN_SHIFT_LIMIT)
  )
}

export function liveGraphComponentCollisionShares(
  leftMass: number,
  rightMass: number
): { left: number; right: number } {
  const safeLeftMass = Math.max(1, leftMass)
  const safeRightMass = Math.max(1, rightMass)
  const totalMass = safeLeftMass + safeRightMass

  const left = clamp(
    safeRightMass / totalMass,
    LIVE_GRAPH_COMPONENT_MIN_MASS_SHARE,
    1 - LIVE_GRAPH_COMPONENT_MIN_MASS_SHARE
  )

  return { left, right: 1 - left }
}

function boundLiveGraphComponentShift(body: LiveGraphComponentBody, limit: number): void {
  const distance = Math.hypot(body.shiftX, body.shiftY)

  if (distance <= limit || distance === 0) {
    return
  }

  const scale = limit / distance

  body.shiftX *= scale
  body.shiftY *= scale
}

/**
 * Keep disconnected graphs readable as separate bodies. Node collision alone
 * prevents circles from overlapping, but still allows branches from unrelated
 * components to weave through one another. This force collides the live AABB
 * envelope of each connected component and translates all of its nodes
 * together, preserving the component's internal layout.
 */
function forceSeparateLiveGraphComponents(componentIds: readonly (readonly string[])[]): LiveGraphComponentForce {
  let componentMembers: readonly (readonly SimNode[])[] = []
  let centerStrength = 0

  const force = ((alpha: number) => {
    if (componentMembers.length < 2) {
      return
    }

    const bodies = componentMembers.map(liveGraphComponentBody)
    const shiftLimit = liveGraphComponentShiftLimit(alpha)
    const collisionStrength = 0.25 + Math.sqrt(clamp(alpha, 0, 1)) * 0.75

    for (const body of bodies) {
      const centerX = (body.left + body.right) / 2
      const centerY = (body.top + body.bottom) / 2

      body.shiftX = -centerX * centerStrength * alpha
      body.shiftY = -centerY * centerStrength * alpha
      boundLiveGraphComponentShift(body, shiftLimit)
    }

    for (let iteration = 0; iteration < LIVE_GRAPH_COMPONENT_COLLISION_ITERATIONS; iteration += 1) {
      bodies.sort((left, right) => left.left + left.shiftX - (right.left + right.shiftX) || left.index - right.index)

      for (let leftIndex = 0; leftIndex < bodies.length; leftIndex += 1) {
        const leftBody = bodies[leftIndex]!
        const leftCenterX = (leftBody.left + leftBody.right) / 2 + leftBody.shiftX
        const leftCenterY = (leftBody.top + leftBody.bottom) / 2 + leftBody.shiftY
        const leftHalfWidth = (leftBody.right - leftBody.left) / 2
        const leftHalfHeight = (leftBody.bottom - leftBody.top) / 2

        for (let rightIndex = leftIndex + 1; rightIndex < bodies.length; rightIndex += 1) {
          const rightBody = bodies[rightIndex]!
          const rightLeft = rightBody.left + rightBody.shiftX

          if (rightLeft > leftCenterX + leftHalfWidth + LIVE_GRAPH_COMPONENT_GAP) {
            break
          }

          const rightCenterX = (rightBody.left + rightBody.right) / 2 + rightBody.shiftX
          const rightCenterY = (rightBody.top + rightBody.bottom) / 2 + rightBody.shiftY
          const rightHalfWidth = (rightBody.right - rightBody.left) / 2
          const rightHalfHeight = (rightBody.bottom - rightBody.top) / 2
          const deltaX = rightCenterX - leftCenterX
          const deltaY = rightCenterY - leftCenterY

          const overlapX = leftHalfWidth + rightHalfWidth + LIVE_GRAPH_COMPONENT_GAP - Math.abs(deltaX)

          const overlapY = leftHalfHeight + rightHalfHeight + LIVE_GRAPH_COMPONENT_GAP - Math.abs(deltaY)

          if (overlapX <= 0 || overlapY <= 0) {
            continue
          }

          const shares = liveGraphComponentCollisionShares(leftBody.mass, rightBody.mass)

          const separateOnX =
            Math.abs(overlapX - overlapY) > 0.001 ? overlapX < overlapY : (leftBody.index + rightBody.index) % 2 === 0

          if (separateOnX) {
            const direction = deltaX === 0 ? 1 : Math.sign(deltaX)
            const correction = overlapX * collisionStrength * direction

            leftBody.shiftX -= correction * shares.left
            rightBody.shiftX += correction * shares.right
          } else {
            const direction = deltaY === 0 ? 1 : Math.sign(deltaY)
            const correction = overlapY * collisionStrength * direction

            leftBody.shiftY -= correction * shares.left
            rightBody.shiftY += correction * shares.right
          }

          boundLiveGraphComponentShift(leftBody, shiftLimit)
          boundLiveGraphComponentShift(rightBody, shiftLimit)
        }
      }
    }

    for (const body of bodies) {
      for (const node of body.members) {
        if (node.fx == null) {
          node.vx = Number(node.vx || 0) + body.shiftX
        }

        if (node.fy == null) {
          node.vy = Number(node.vy || 0) + body.shiftY
        }
      }
    }
  }) as LiveGraphComponentForce

  force.initialize = nodes => {
    const nodeById = new Map(nodes.map(node => [node.id, node]))

    componentMembers = componentIds
      .map(component => component.flatMap(id => nodeById.get(id) ?? []))
      .filter(component => component.length > 0)
  }

  force.centerStrength = value => {
    centerStrength = Math.max(0, value)

    return force
  }

  return force
}

function updateLiveGraphSimulationForces(simulation: LiveGraphSimulation, settings: LayoutSettings): void {
  const centerRatio = clamp(settings.centerForce / 100, 0, 1)
  const { centerX, centerY, charge, componentCollide, link } = simulation.liveGraphForces
  const centerStrength = centerRatio * centerRatio * 0.2

  centerX.strength(centerStrength)
  centerY.strength(centerStrength)
  componentCollide.centerStrength(centerStrength)
  charge.strength(-clamp(settings.repelForce, 10, 180) * 0.5)
  link
    .distance(simLink => {
      const source = liveGraphSimulationLinkEndpoint(simLink.source)
      const target = liveGraphSimulationLinkEndpoint(simLink.target)
      const sourceRadius = source?.radius ?? LIVE_GRAPH_NODE_BASE_RADIUS
      const targetRadius = target?.radius ?? LIVE_GRAPH_NODE_BASE_RADIUS

      return sourceRadius + targetRadius + liveGraphSemanticLinkSurfaceGap(simLink.kind, settings.linkDistance)
    })
    .strength(simLink => liveGraphSemanticLinkStrength(simLink.kind, simLink.degreeStrength, settings.linkForce))
}

function createLiveGraphSimulation(
  simNodes: SimNode[],
  edges: readonly LiveGraphEdge[],
  settings: LayoutSettings
): LiveGraphSimulation {
  const dense = simNodes.length >= DENSE_GRAPH_NODE_THRESHOLD

  const components = analyzeLiveGraphTopology(
    simNodes.map(node => node.node),
    edges
  ).components

  const centerX = forceX<SimNode>(0)
  const centerY = forceY<SimNode>(0)
  const charge = forceManyBody<SimNode>()
  const componentCollide = forceSeparateLiveGraphComponents(components)

  const link = forceLink<SimNode, SimLink>(liveGraphSimulationLinks(simNodes, edges))
    .id(node => node.id)
    .iterations(2)

  const simulation = forceSimulation<SimNode>(simNodes)
    .force('link', link)
    .force('charge', charge)
    .force('center-x', centerX)
    .force('center-y', centerY)
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius(node => node.radius + LIVE_GRAPH_VISIBLE_COLLISION_PADDING)
        .strength(1)
        .iterations(dense ? 1 : 2)
    )
    .force('component-collide', componentCollide) as LiveGraphSimulation

  simulation.liveGraphForces = { centerX, centerY, charge, componentCollide, link }
  updateLiveGraphSimulationForces(simulation, settings)

  return simulation
}

function graphRevealDelays(nodes: LiveGraphNode[], edges: LiveGraphEdge[], rootId: string): Map<string, number> {
  const ids = nodes.map(liveGraphNodeId).filter(Boolean)

  if (ids.length === 0) {
    return new Map()
  }

  const root = ids.includes(rootId) ? rootId : [...ids].sort()[0]
  const adjacent = liveGraphNeighbors(nodes, edges)
  const depths = new Map([[root, 0]])
  const queue = [root]

  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    const depth = depths.get(id) ?? 0

    for (const neighbor of [...(adjacent.get(id) ?? [])].sort()) {
      if (!depths.has(neighbor)) {
        depths.set(neighbor, depth + 1)
        queue.push(neighbor)
      }
    }
  }

  const deepestConnected = Math.max(0, ...depths.values())
  const groups = new Map<number, string[]>()

  for (const id of ids) {
    const depth = depths.get(id) ?? deepestConnected + 1
    groups.set(depth, [...(groups.get(depth) ?? []), id])
  }

  const delays = new Map<string, number>()

  for (const [depth, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    const sorted = group.sort()
    const spread = sorted.length > 1 ? Math.min(18, 120 / (sorted.length - 1)) : 0

    sorted.forEach((id, index) => {
      delays.set(
        id,
        depth === 0 ? -GRAPH_REVEAL_NODE_DURATION : 70 + (depth - 1) * GRAPH_REVEAL_WAVE_DELAY + index * spread
      )
    })
  }

  return delays
}

function graphBounds(nodes: SettledGraphNode[], radiusById: ReadonlyMap<string, number>) {
  if (nodes.length === 0) {
    return { bottom: 0, left: 0, right: 0, top: 0 }
  }

  return nodes.reduce(
    (bounds, node) => {
      const radius = radiusById.get(node.id) ?? liveGraphNodeRadius(node.node, 0)

      return {
        bottom: Math.max(bounds.bottom, node.y + radius + 34),
        left: Math.min(bounds.left, node.x - radius - 34),
        right: Math.max(bounds.right, node.x + radius + 34),
        top: Math.min(bounds.top, node.y - radius - 34)
      }
    },
    { bottom: -Infinity, left: Infinity, right: -Infinity, top: Infinity }
  )
}

export function fitLiveGraphCamera(
  nodes: SettledGraphNode[],
  viewport: Viewport,
  radiusById: ReadonlyMap<string, number> = EMPTY_RADIUS_BY_ID
): Camera {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return DEFAULT_CAMERA
  }

  const bounds = graphBounds(nodes, radiusById)
  const width = Math.max(1, bounds.right - bounds.left)
  const height = Math.max(1, bounds.bottom - bounds.top)

  const scale = clamp(
    Math.min(Math.max(1, viewport.width - 48) / width, Math.max(1, viewport.height - 48) / height),
    LIVE_GRAPH_MIN_SCALE,
    LIVE_GRAPH_FIT_MAX_SCALE
  )

  return {
    scale,
    x: viewport.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
    y: viewport.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function validCamera(value: unknown): Camera {
  const record = asRecord(value)
  const scale = typeof record.scale === 'number' ? record.scale : 1
  const x = typeof record.x === 'number' ? record.x : 0
  const y = typeof record.y === 'number' ? record.y : 0

  return { scale: clamp(scale, LIVE_GRAPH_MIN_SCALE, LIVE_GRAPH_MAX_SCALE), x, y }
}

function cameraTransform(camera: Camera): string {
  return `translate(${camera.x} ${camera.y}) scale(${camera.scale})`
}

export function normalizeLiveGraphViewState(value: unknown): LiveGraphViewState {
  const record = asRecord(value)

  const enabledKinds = Array.isArray(record.enabledKinds)
    ? record.enabledKinds.filter(
        (kind): kind is LiveGraphKind => typeof kind === 'string' && LIVE_GRAPH_KINDS.includes(kind as LiveGraphKind)
      )
    : [...LIVE_GRAPH_KINDS]

  const focusDepth =
    record.focusDepth === 1 || record.focusDepth === 2 || record.focusDepth === 'all' ? record.focusDepth : 2

  return {
    activeOnly: typeof record.activeOnly === 'boolean' ? record.activeOnly : false,
    arrows: typeof record.arrows === 'boolean' ? record.arrows : true,
    camera: validCamera(record.camera),
    centerForce: typeof record.centerForce === 'number' ? clamp(record.centerForce, 0, 100) : 72,
    enabledKinds: enabledKinds.length > 0 ? enabledKinds : [...LIVE_GRAPH_KINDS],
    focusDepth,
    labels: typeof record.labels === 'boolean' ? record.labels : true,
    linkDistance: typeof record.linkDistance === 'number' ? clamp(record.linkDistance, 48, 220) : 112,
    linkForce: typeof record.linkForce === 'number' ? clamp(record.linkForce, 0, 100) : DEFAULT_LINK_FORCE,
    nodeSize:
      typeof record.nodeSize === 'number' && Number.isFinite(record.nodeSize)
        ? clamp(record.nodeSize, LIVE_GRAPH_NODE_SIZE_MIN, LIVE_GRAPH_NODE_SIZE_MAX)
        : LIVE_GRAPH_NODE_SIZE_DEFAULT,
    orphans: typeof record.orphans === 'boolean' ? record.orphans : false,
    repelForce: typeof record.repelForce === 'number' ? clamp(record.repelForce, 10, 180) : 62,
    search: typeof record.search === 'string' ? record.search : '',
    textFadeThreshold:
      typeof record.textFadeThreshold === 'number'
        ? clamp(record.textFadeThreshold, 0, LIVE_GRAPH_TEXT_FADE_THRESHOLD_MAX)
        : LIVE_GRAPH_TEXT_FADE_THRESHOLD_DEFAULT
  }
}

function statusColor(status: string): string {
  if (status === 'completed') {
    return 'var(--ui-green)'
  }

  if (status === 'blocked' || status === 'interrupted') {
    return 'var(--ui-yellow)'
  }

  if (status === 'failed') {
    return 'var(--ui-red)'
  }

  if (status === 'running') {
    return 'var(--ui-cyan)'
  }

  if (LIVE_GRAPH_WAITING_STATUSES.has(status)) {
    return 'var(--ui-purple)'
  }

  return 'var(--ui-text-quaternary)'
}

function signalColor(kind: string, status: string): string {
  if (kind === 'produced' || kind === 'produce') {
    return 'var(--ui-warm)'
  }

  if (kind === 'completed' || kind === 'verified' || kind === 'verify' || status === 'completed') {
    return 'var(--ui-green)'
  }

  if (kind === 'blocked' || status === 'blocked' || status === 'interrupted') {
    return 'var(--ui-yellow)'
  }

  if (kind === 'failed' || status === 'failed') {
    return 'var(--ui-red)'
  }

  return 'var(--ui-purple)'
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    if (!media) {
      return
    }

    const update = () => setReduced(media.matches)
    update()
    media.addEventListener?.('change', update)

    return () => media.removeEventListener?.('change', update)
  }, [])

  return reduced
}

function useSurfaceActive(rootRef: RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(true)
  useEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    const update = () => {
      const hiddenByPane = root.closest('[aria-hidden="true"], [inert]') !== null
      setActive(!hiddenByPane && !document.hidden)
    }

    const observer = new MutationObserver(update)
    let current: HTMLElement | null = root

    while (current) {
      observer.observe(current, { attributeFilter: ['aria-hidden', 'inert'], attributes: true })
      current = current.parentElement
    }

    document.addEventListener('visibilitychange', update)
    update()

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [rootRef])

  return active
}

export interface LiveGraphCanvasProps {
  autoFit?: boolean
  emptyDesc?: string
  emptyTitle?: string
  graph: LiveGraphSnapshot
  initialState?: LiveGraphViewState
  onAttachNode?: (node: LiveGraphNode) => void
  onOpenSession?: (sessionId: string) => void
  onOpenTask?: (target: LiveGraphTaskTarget) => void
  onStateChange?: (state: LiveGraphViewState) => void
  pulses?: readonly LiveGraphPulse[]
}

export function LiveGraphCanvas({
  autoFit = true,
  emptyDesc,
  emptyTitle,
  graph,
  initialState = DEFAULT_LIVE_GRAPH_VIEW_STATE,
  onAttachNode,
  onOpenSession,
  onOpenTask,
  onStateChange,
  pulses = EMPTY_PULSES
}: LiveGraphCanvasProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const pointerFrameRef = useRef<number | null>(null)
  const selectionFitFrameRef = useRef<number | null>(null)
  const cameraCommitTimerRef = useRef<number | null>(null)
  const pendingCameraRef = useRef<Camera | null>(null)
  const worldRef = useRef<SVGGElement>(null)
  const denseEdgeBatchRef = useRef<SVGPathElement>(null)
  const denseEdgeBatchArrowsRef = useRef<SVGPathElement>(null)
  const denseEdgeHighlightRef = useRef<SVGPathElement>(null)
  const denseEdgeHighlightArrowsRef = useRef<SVGPathElement>(null)
  const hoverLabelRef = useRef<SVGTextElement>(null)
  const hoverLabelNodeIdRef = useRef<string | null>(null)
  const paintDenseEdgePathsRef = useRef<(() => void) | null>(null)
  const paintDenseEdgeHighlightRef = useRef<(() => void) | null>(null)
  const denseHoveredNodeIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const fadeThresholdValueRef = useRef<HTMLSpanElement>(null)
  const nodeSizeValueRef = useRef<HTMLSpanElement>(null)
  const forceValueRefs = useRef<Partial<Record<ForceSettingKey, HTMLSpanElement | null>>>({})
  const simulationRef = useRef<LiveGraphSimulation | null>(null)
  const simulationNodesRef = useRef<Map<string, SimNode>>(new Map())
  const simulationPaintFrameRef = useRef<number | null>(null)
  const simulationActiveUntilRef = useRef(0)
  const settledSimulationRef = useRef<LiveGraphSimulation | null>(null)
  const wakeSimulationRef = useRef<((request: LiveGraphWakeRequest) => void) | null>(null)
  const paintSimulationRef = useRef<(() => void) | null>(null)
  const paintSimulationNodeRef = useRef<((id: string) => void) | null>(null)
  const interactivePhysicsKeyRef = useRef('')
  const interactivePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const layoutRef = useRef<SettledGraphNode[]>([])
  const suppressedCanvasActivationRef = useRef(0)
  const suppressedNodeActivationRef = useRef<SuppressedNodeActivation | null>(null)
  const revealFrameRef = useRef<number | null>(null)
  const pulseFrameRef = useRef<number | null>(null)
  const pulseOccurrenceRef = useRef(0)
  const pulseQueueRef = useRef<LiveGraphPulse[]>([])
  const activePulsesRef = useRef<ActivePulse[]>([])
  const pausedAtRef = useRef<number | null>(null)
  const processedPulseBatchRef = useRef<readonly LiveGraphPulse[] | null>(null)
  const semanticTopologyRef = useRef<LiveGraphSemanticTopology | null>(null)
  const layoutTopologyRef = useRef<LayoutTopology | null>(null)
  const layoutSettingsRef = useRef<{ key: string; settings: LayoutSettings } | null>(null)
  const viewStateRef = useRef(normalizeLiveGraphViewState(initialState))
  const persistedNodeSizeRef = useRef(viewStateRef.current.nodeSize)
  const persistedTextFadeThresholdRef = useRef(viewStateRef.current.textFadeThreshold)

  const persistedForceSettingsRef = useRef<LayoutSettings>({
    centerForce: viewStateRef.current.centerForce,
    linkDistance: viewStateRef.current.linkDistance,
    linkForce: viewStateRef.current.linkForce,
    repelForce: viewStateRef.current.repelForce
  })

  const initialDenseLod =
    autoFit && snapshotNodes(graph).length >= DENSE_GRAPH_NODE_THRESHOLD
      ? 'overview'
      : liveGraphDenseLod(viewStateRef.current.camera.scale)

  const denseLodRef = useRef<DenseGraphLod>(initialDenseLod)
  const [viewState, setViewState] = useState(() => normalizeLiveGraphViewState(initialState))
  const [denseLod, setDenseLod] = useState<DenseGraphLod>(initialDenseLod)
  const [viewport, setViewport] = useState<Viewport>({ height: 0, width: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clock, setClock] = useState(0)
  const [activePulses, setActivePulses] = useState<ActivePulse[]>([])
  const [announcement, setAnnouncement] = useState('')

  const [reveal, setReveal] = useState<GraphReveal | null>(null)
  const [revealClock, setRevealClock] = useState(0)
  selectedIdRef.current = selectedId
  const reducedMotion = useReducedMotion()
  const surfaceActive = useSurfaceActive(rootRef)
  const markerId = useId().replace(/:/g, '')

  useEffect(() => {
    if (!surfaceActive) {
      setSettingsOpen(false)
    }
  }, [surfaceActive])

  const commitState = useCallback(
    (updater: LiveGraphViewState | ((current: LiveGraphViewState) => LiveGraphViewState), persist = true) => {
      const current = viewStateRef.current
      const next = typeof updater === 'function' ? updater(current) : updater

      viewStateRef.current = next
      setViewState(next)

      if (persist) {
        onStateChange?.(next)
      }
    },
    [onStateChange]
  )

  const applyDenseCamera = useCallback(
    (camera: Camera, persist: boolean) => {
      const next = { ...viewStateRef.current, camera }
      const nextLod = liveGraphDenseLod(camera.scale)
      viewStateRef.current = next
      worldRef.current?.setAttribute('transform', cameraTransform(camera))
      canvasRef.current?.style.setProperty(
        '--live-graph-label-opacity',
        String(liveGraphTextFadeOpacity(camera.scale, next.textFadeThreshold))
      )
      hoverLabelRef.current?.setAttribute('opacity', '0')
      hoverLabelNodeIdRef.current = null

      if (denseLodRef.current !== nextLod) {
        denseLodRef.current = nextLod
        setDenseLod(nextLod)
      }

      if (persist) {
        onStateChange?.(next)
      }
    },
    [onStateChange]
  )

  const previewTextFadeThreshold = useCallback((value: number) => {
    const textFadeThreshold = clamp(value, 0, LIVE_GRAPH_TEXT_FADE_THRESHOLD_MAX)
    viewStateRef.current = { ...viewStateRef.current, textFadeThreshold }
    canvasRef.current?.style.setProperty(
      '--live-graph-label-opacity',
      String(liveGraphTextFadeOpacity(viewStateRef.current.camera.scale, textFadeThreshold))
    )

    if (fadeThresholdValueRef.current) {
      fadeThresholdValueRef.current.textContent = String(textFadeThreshold)
    }
  }, [])

  const persistTextFadeThreshold = useCallback(() => {
    const textFadeThreshold = viewStateRef.current.textFadeThreshold

    if (persistedTextFadeThresholdRef.current === textFadeThreshold) {
      return
    }

    persistedTextFadeThresholdRef.current = textFadeThreshold
    commitState(viewStateRef.current)
  }, [commitState])

  const previewNodeSize = useCallback((value: number) => {
    const nodeSize = clamp(value, LIVE_GRAPH_NODE_SIZE_MIN, LIVE_GRAPH_NODE_SIZE_MAX)
    const previewScale = nodeSize / persistedNodeSizeRef.current

    viewStateRef.current = { ...viewStateRef.current, nodeSize }
    worldRef.current?.style.setProperty('--live-graph-node-size-preview-scale', String(previewScale))

    if (nodeSizeValueRef.current) {
      nodeSizeValueRef.current.textContent = `${nodeSize}%`
    }
  }, [])

  const persistNodeSize = useCallback(() => {
    const nodeSize = viewStateRef.current.nodeSize

    worldRef.current?.style.setProperty('--live-graph-node-size-preview-scale', '1')

    if (persistedNodeSizeRef.current === nodeSize) {
      return
    }

    persistedNodeSizeRef.current = nodeSize
    commitState(viewStateRef.current)
  }, [commitState])

  const previewForceSetting = useCallback((key: ForceSettingKey, value: number) => {
    const nextValue =
      key === 'centerForce'
        ? clamp(value, 0, 100)
        : key === 'repelForce'
          ? clamp(value, 10, 180)
          : key === 'linkDistance'
            ? clamp(value, 48, 220)
            : clamp(value, 0, 100)

    viewStateRef.current = { ...viewStateRef.current, [key]: nextValue }

    if (forceValueRefs.current[key]) {
      forceValueRefs.current[key].textContent = String(nextValue)
    }

    const simulation = simulationRef.current

    if (!simulation) {
      return
    }

    const settings = liveGraphLayoutSettings(viewStateRef.current)

    updateLiveGraphSimulationForces(simulation, settings)
    wakeSimulationRef.current?.({ alpha: 0.42, duration: 1_500 })
  }, [])

  const persistForceSettings = useCallback(() => {
    const settings = liveGraphLayoutSettings(viewStateRef.current)
    const persisted = persistedForceSettingsRef.current

    if (
      settings.centerForce === persisted.centerForce &&
      settings.linkDistance === persisted.linkDistance &&
      settings.linkForce === persisted.linkForce &&
      settings.repelForce === persisted.repelForce
    ) {
      return
    }

    persistedForceSettingsRef.current = settings
    commitState(viewStateRef.current)
  }, [commitState])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewport({ height: entry.contentRect.height, width: entry.contentRect.width })
    })

    observer.observe(canvas)

    return () => observer.disconnect()
  }, [])

  const enabledKinds = useMemo(() => new Set(viewState.enabledKinds), [viewState.enabledKinds])
  const focusId = selectedId
  const layoutRootId = selectedId || snapshotRootId(graph)

  const visible = useMemo(
    () =>
      visibleLiveGraph(graph, {
        activeOnly: viewState.activeOnly,
        enabledKinds,
        focusDepth: viewState.focusDepth,
        focusId,
        orphans: viewState.orphans,
        search: viewState.search
      }),
    [enabledKinds, focusId, graph, viewState.activeOnly, viewState.focusDepth, viewState.orphans, viewState.search]
  )

  const graphNodes = snapshotNodes(graph)
  const graphEdges = snapshotEdges(graph)
  const semanticTopologyKey = liveGraphTopologyKey(graphNodes, graphEdges)

  if (semanticTopologyRef.current?.key !== semanticTopologyKey) {
    semanticTopologyRef.current = {
      descendantHubIds: liveGraphDescendantHubIds(graphNodes, graphEdges),
      key: semanticTopologyKey,
      semanticReachById: liveGraphSemanticReachCounts(graphNodes, graphEdges)
    }
  }

  const semanticTopology = semanticTopologyRef.current!

  const denseGraph = visible.nodes.length >= DENSE_GRAPH_NODE_THRESHOLD

  useEffect(() => {
    if (!denseGraph) {
      return
    }

    const nextLod = liveGraphDenseLod(viewStateRef.current.camera.scale)

    if (denseLodRef.current !== nextLod) {
      denseLodRef.current = nextLod
      setDenseLod(nextLod)
    }
  }, [denseGraph])

  const topologyKey = useMemo(() => liveGraphTopologyKey(visible.nodes, visible.edges), [visible.edges, visible.nodes])

  if (layoutTopologyRef.current?.key !== topologyKey) {
    layoutTopologyRef.current = { edges: visible.edges, key: topologyKey, nodes: visible.nodes }
  }

  const layoutTopology = layoutTopologyRef.current

  const physicsKey = useMemo(() => [topologyKey, viewState.nodeSize].join('\u0000'), [topologyKey, viewState.nodeSize])

  if (layoutSettingsRef.current?.key !== physicsKey) {
    layoutSettingsRef.current = { key: physicsKey, settings: liveGraphLayoutSettings(viewStateRef.current) }
  }

  const layoutSettings = layoutSettingsRef.current.settings

  const layoutMetrics = useMemo(
    () =>
      liveGraphLayoutMetrics(
        layoutTopology.nodes,
        layoutTopology.edges,
        semanticTopology.semanticReachById,
        viewState.nodeSize,
        semanticTopology.descendantHubIds
      ),
    [layoutTopology, semanticTopology, viewState.nodeSize]
  )

  const multipleComponents = layoutMetrics.analysis.components.length > 1

  const settledTopology = useMemo(
    () => settledLiveGraphLayout(layoutTopology.nodes, layoutTopology.edges, layoutSettings, undefined, layoutMetrics),
    [layoutMetrics, layoutSettings, layoutTopology]
  )

  const settledPositions = useMemo(
    () => new Map(settledTopology.map(node => [node.id, { x: node.x, y: node.y }])),
    [settledTopology]
  )

  useEffect(() => {
    const simNodes: SimNode[] = settledTopology.map(position => ({
      id: position.id,
      node: position.node,
      radius: layoutMetrics.radiusById.get(position.id) ?? liveGraphNodeRadius(position.node, 0),
      vx: 0,
      vy: 0,
      x: position.x,
      y: position.y
    }))

    const nodesById = new Map(simNodes.map(node => [node.id, node]))

    const startupHeat = liveGraphStartupHeat(simNodes.length)

    const simulation = createLiveGraphSimulation(simNodes, layoutTopology.edges, layoutSettings)
      .alpha(startupHeat.alpha)
      .stop()

    simulationActiveUntilRef.current = startupHeat.duration > 0 ? performance.now() + startupHeat.duration : 0

    if (startupHeat.alpha <= 0) {
      settledSimulationRef.current = simulation
      rootRef.current?.setAttribute('data-live-graph-simulation-state', 'settled')
      rootRef.current?.setAttribute('data-live-graph-sleep-reason', 'balanced')
    }

    const world = worldRef.current

    const nodeElementsById = new Map(
      [...(world?.querySelectorAll<SVGGElement>('[data-live-graph-node]') ?? [])].map(element => [
        element.dataset.liveGraphNodeId || '',
        element
      ])
    )

    const paintNodes = simNodes.flatMap<LiveGraphPaintNode>(sim => {
      const element = nodeElementsById.get(sim.id)

      if (!element) {
        return []
      }

      const x = Number.isFinite(sim.x) ? Number(sim.x) : 0
      const y = Number.isFinite(sim.y) ? Number(sim.y) : 0
      const position = { x, y }

      return [
        {
          dirtyFrame: 0,
          element,
          lastX: Number.NaN,
          lastY: Number.NaN,
          layout: { id: sim.id, node: sim.node, x, y },
          position,
          sim
        }
      ]
    })

    const paintNodesById = new Map(paintNodes.map(node => [node.sim.id, node]))
    const incidentEdgesById = new Map<string, LiveGraphPaintEdge[]>()

    const addIncidentEdge = (id: string, edge: LiveGraphPaintEdge) => {
      const incident = incidentEdgesById.get(id)

      if (incident) {
        incident.push(edge)
      } else {
        incidentEdgesById.set(id, [edge])
      }
    }

    const createPaintEdge = (
      sourceId: string,
      targetId: string,
      element: SVGLineElement | null
    ): LiveGraphPaintEdge | null => {
      const source = paintNodesById.get(sourceId)
      const target = paintNodesById.get(targetId)

      if (!source || !target) {
        return null
      }

      const edge: LiveGraphPaintEdge = {
        element,
        growth: element ? Number(element.dataset.liveGraphEdgeGrowth || 1) : 1,
        source,
        sourceRadius: source.sim.radius,
        target,
        targetRadius: target.sim.radius
      }

      addIncidentEdge(sourceId, edge)
      addIncidentEdge(targetId, edge)

      return edge
    }

    const paintEdges: LiveGraphPaintEdge[] = []

    if (denseGraph) {
      for (const edge of layoutTopology.edges) {
        const paintEdge = createPaintEdge(liveGraphEdgeSource(edge), liveGraphEdgeTarget(edge), null)

        if (paintEdge) {
          paintEdges.push(paintEdge)
        }
      }
    } else {
      const edgeElements = world?.querySelectorAll<SVGLineElement>('[data-live-graph-edge-source]') ?? []

      for (const element of edgeElements) {
        const paintEdge = createPaintEdge(
          element.dataset.liveGraphEdgeSource || '',
          element.dataset.liveGraphEdgeTarget || '',
          element
        )

        if (paintEdge) {
          paintEdges.push(paintEdge)
        }
      }
    }

    let paintFrame = 0

    const paintNode = (node: LiveGraphPaintNode, frame: number, force = false): boolean => {
      const x = Number.isFinite(node.sim.x) ? Number(node.sim.x) : 0
      const y = Number.isFinite(node.sim.y) ? Number(node.sim.y) : 0
      const threshold = 0.2 / Math.max(viewStateRef.current.camera.scale, LIVE_GRAPH_MIN_SCALE)

      node.position.x = x
      node.position.y = y
      node.layout.x = x
      node.layout.y = y

      if (!force && Math.hypot(x - node.lastX, y - node.lastY) < threshold) {
        return false
      }

      const scale = Number(node.element.dataset.liveGraphNodeScale || 1)

      node.lastX = x
      node.lastY = y
      node.dirtyFrame = frame
      node.element.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`)

      return true
    }

    const edgeSegment = (edge: LiveGraphPaintEdge) => {
      const segment = trimLiveGraphEdge(
        edge.source.position,
        edge.target.position,
        edge.sourceRadius,
        edge.targetRadius,
        LIVE_GRAPH_EDGE_GAP
      )

      const growth = edge.element ? Number(edge.element.dataset.liveGraphEdgeGrowth || 1) : edge.growth

      return {
        x1: segment.x1,
        x2: segment.x1 + (segment.x2 - segment.x1) * growth,
        y1: segment.y1,
        y2: segment.y1 + (segment.y2 - segment.y1) * growth
      }
    }

    const paintEdge = (edge: LiveGraphPaintEdge) => {
      if (!edge.element) {
        return
      }

      const segment = edgeSegment(edge)

      edge.element.setAttribute('x1', String(segment.x1))
      edge.element.setAttribute('y1', String(segment.y1))
      edge.element.setAttribute('x2', String(segment.x2))
      edge.element.setAttribute('y2', String(segment.y2))
    }

    const paintEdgeGeometry = (
      edges: readonly LiveGraphPaintEdge[],
      arrowSizeInPixels: number
    ): { arrows: string; lines: string } => {
      const arrowCommands: string[] = []
      const lineCommands: string[] = []
      const arrowSize = arrowSizeInPixels / Math.max(viewStateRef.current.camera.scale, 0.2)
      const coordinate = (value: number) => Math.round(value * 100) / 100

      for (const edge of edges) {
        const segment = edgeSegment(edge)

        lineCommands.push(
          `M${coordinate(segment.x1)},${coordinate(segment.y1)}L${coordinate(segment.x2)},${coordinate(segment.y2)}`
        )

        if (arrowSizeInPixels <= 0) {
          continue
        }

        const dx = segment.x2 - segment.x1
        const dy = segment.y2 - segment.y1
        const distance = Math.hypot(dx, dy)

        if (distance <= 0.5) {
          continue
        }

        const ux = dx / distance
        const uy = dy / distance
        const headLength = Math.min(arrowSize, distance * 0.45)
        const halfWidth = headLength * 0.46
        const baseX = segment.x2 - ux * headLength
        const baseY = segment.y2 - uy * headLength
        const leftX = baseX - uy * halfWidth
        const leftY = baseY + ux * halfWidth
        const rightX = baseX + uy * halfWidth
        const rightY = baseY - ux * halfWidth

        arrowCommands.push(
          `M${coordinate(segment.x2)},${coordinate(segment.y2)}L${coordinate(leftX)},${coordinate(leftY)}L${coordinate(rightX)},${coordinate(rightY)}Z`
        )
      }

      return { arrows: arrowCommands.join(''), lines: lineCommands.join('') }
    }

    const highlightedPaintEdges = () => {
      const ids = new Set<string>()
      const drag = dragRef.current

      if (selectedIdRef.current) {
        ids.add(selectedIdRef.current)
      }

      if (denseHoveredNodeIdRef.current) {
        ids.add(denseHoveredNodeIdRef.current)
      }

      if (drag?.mode === 'node') {
        ids.add(drag.id)
      }

      const highlighted = new Set<LiveGraphPaintEdge>()

      for (const id of ids) {
        for (const edge of incidentEdgesById.get(id) ?? []) {
          highlighted.add(edge)
        }
      }

      return [...highlighted]
    }

    const paintDenseEdgeBase = () => {
      const showArrows =
        viewStateRef.current.arrows &&
        (paintEdges.length < DENSE_GRAPH_ARROW_EDGE_THRESHOLD || denseLodRef.current === 'detail')

      const geometry = paintEdgeGeometry(paintEdges, showArrows ? 3 : 0)

      denseEdgeBatchRef.current?.setAttribute('d', geometry.lines)
      denseEdgeBatchArrowsRef.current?.setAttribute('d', geometry.arrows)
    }

    const paintDenseEdgeHighlight = () => {
      const geometry = paintEdgeGeometry(highlightedPaintEdges(), viewStateRef.current.arrows ? 7 : 0)

      denseEdgeHighlightRef.current?.setAttribute('d', geometry.lines)
      denseEdgeHighlightArrowsRef.current?.setAttribute('d', geometry.arrows)
    }

    const paintDenseEdgePaths = () => {
      paintDenseEdgeBase()
      paintDenseEdgeHighlight()
    }

    const paint = () => {
      if (simulationRef.current !== simulation) {
        return
      }

      paintFrame += 1
      let changed = false

      for (const node of paintNodes) {
        changed = paintNode(node, paintFrame) || changed
      }

      if (denseGraph) {
        if (changed) {
          paintDenseEdgePaths()
        }
      } else {
        for (const edge of paintEdges) {
          if (edge.source.dirtyFrame === paintFrame || edge.target.dirtyFrame === paintFrame) {
            paintEdge(edge)
          }
        }
      }
    }

    const paintOneNode = (id: string) => {
      const node = paintNodesById.get(id)

      if (!node || simulationRef.current !== simulation) {
        return
      }

      paintFrame += 1
      paintNode(node, paintFrame, true)

      if (denseGraph) {
        paintDenseEdgeHighlight()
      } else {
        for (const edge of incidentEdgesById.get(id) ?? []) {
          paintEdge(edge)
        }
      }
    }

    paintDenseEdgePathsRef.current = denseGraph ? paintDenseEdgePaths : null
    paintDenseEdgeHighlightRef.current = denseGraph ? paintDenseEdgeHighlight : null
    simulationRef.current = simulation
    simulationNodesRef.current = nodesById
    interactivePhysicsKeyRef.current = physicsKey
    interactivePositionsRef.current = new Map(paintNodes.map(node => [node.sim.id, node.position]))
    layoutRef.current = paintNodes.map(node => node.layout)
    paintSimulationRef.current = paint
    paintSimulationNodeRef.current = paintOneNode
    paint()

    return () => {
      simulation.alphaTarget(0).stop()

      for (const node of simNodes) {
        node.fx = null
        node.fy = null
      }

      if (simulationRef.current === simulation) {
        const drag = dragRef.current

        if (drag?.svg.hasPointerCapture(drag.pointerId)) {
          drag.svg.releasePointerCapture(drag.pointerId)
        }

        if (pointerFrameRef.current !== null) {
          cancelAnimationFrame(pointerFrameRef.current)
          pointerFrameRef.current = null
        }

        pendingCameraRef.current = null
        paintDenseEdgePathsRef.current = null
        paintDenseEdgeHighlightRef.current = null
        denseHoveredNodeIdRef.current = null
        simulationRef.current = null
        simulationNodesRef.current = new Map()
        paintSimulationRef.current = null
        paintSimulationNodeRef.current = null
        interactivePhysicsKeyRef.current = ''
        interactivePositionsRef.current = new Map()
        layoutRef.current = []
        dragRef.current = null
      }

      if (simulationPaintFrameRef.current !== null) {
        cancelAnimationFrame(simulationPaintFrameRef.current)
        simulationPaintFrameRef.current = null
      }
    }
  }, [denseGraph, layoutMetrics, layoutSettings, layoutTopology, physicsKey, settledTopology])

  useEffect(() => {
    const simulation = simulationRef.current

    if (!simulation) {
      return
    }

    const simNodes = simulation.nodes()
    const heat = liveGraphSimulationHeat(simNodes.length)
    const coolingTickBudget = liveGraphCoolingTickBudget(simNodes.length)
    const baseAlphaDecay = simulation.alphaDecay()
    const previousPositions = new Float64Array(simNodes.length * 2)
    const radii = simNodes.map(node => node.radius).sort((a, b) => a - b)
    const medianRadius = radii.length > 0 ? radii[Math.floor(radii.length / 2)] : 1
    let coolingTicks = 0
    let cooling = false
    let lastTick = 0
    let scheduledFrame: number | null = null
    let stableTicks = 0

    const stopLoop = () => {
      if (scheduledFrame === null) {
        return
      }

      cancelAnimationFrame(scheduledFrame)

      if (simulationPaintFrameRef.current === scheduledFrame) {
        simulationPaintFrameRef.current = null
      }

      scheduledFrame = null
    }

    const restoreAlphaDecay = () => {
      if (!cooling) {
        return
      }

      cooling = false
      simulation.alphaDecay(baseAlphaDecay)
    }

    const sleep = (reason: 'balanced' | 'capped' | 'reduced-motion') => {
      stopLoop()
      restoreAlphaDecay()
      simulationActiveUntilRef.current = 0
      settledSimulationRef.current = simulation
      simulation.alpha(0).alphaTarget(0).stop()

      rootRef.current?.setAttribute('data-live-graph-simulation-state', 'settled')
      rootRef.current?.setAttribute('data-live-graph-sleep-reason', reason)

      for (const node of simNodes) {
        node.vx = 0
        node.vy = 0
      }

      paintSimulationRef.current?.()
    }

    const settleReducedMotion = () => {
      if (simulation.alpha() > 0) {
        const previousDecay = simulation.alphaDecay()
        const decay = liveGraphCoolingAlphaDecay(simulation.alpha(), coolingTickBudget, previousDecay)

        simulation.alphaDecay(decay).alphaTarget(0).tick(coolingTickBudget).alphaDecay(previousDecay)
      }

      sleep('reduced-motion')
    }

    const releaseHiddenDrag = () => {
      const drag = dragRef.current

      if (!drag) {
        return
      }

      if (drag.mode === 'node') {
        const node = simulationNodesRef.current.get(drag.id)

        if (node) {
          node.fx = null
          node.fy = null
        }
      }

      if (drag.svg.hasPointerCapture(drag.pointerId)) {
        drag.svg.releasePointerCapture(drag.pointerId)
      }

      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current)
        pointerFrameRef.current = null
      }

      pendingCameraRef.current = null
      dragRef.current = null
    }

    const rememberPositions = () => {
      for (let index = 0; index < simNodes.length; index += 1) {
        previousPositions[index * 2] = Number(simNodes[index].x) || 0
        previousPositions[index * 2 + 1] = Number(simNodes[index].y) || 0
      }
    }

    const measureMotion = (): { max: number; rms: number } => {
      let max = 0
      let squaredDistance = 0

      for (let index = 0; index < simNodes.length; index += 1) {
        const node = simNodes[index]
        const x = Number(node.x) || 0
        const y = Number(node.y) || 0
        const delta = Math.hypot(x - previousPositions[index * 2], y - previousPositions[index * 2 + 1])

        max = Math.max(max, delta)
        squaredDistance += delta * delta
      }

      return {
        max,
        rms: simNodes.length > 0 ? Math.sqrt(squaredDistance / simNodes.length) : 0
      }
    }

    function scheduleTick() {
      if (scheduledFrame !== null || !surfaceActive || reducedMotion) {
        return
      }

      scheduledFrame = requestAnimationFrame(tick)
      simulationPaintFrameRef.current = scheduledFrame
    }

    function tick(now: number) {
      const completedFrame = scheduledFrame

      scheduledFrame = null

      if (simulationPaintFrameRef.current === completedFrame) {
        simulationPaintFrameRef.current = null
      }

      if (simulationRef.current !== simulation || !surfaceActive || reducedMotion) {
        return
      }

      const interacting = dragRef.current?.mode === 'node' || now < simulationActiveUntilRef.current

      if (lastTick !== 0 && now - lastTick < heat.activeFrameInterval) {
        scheduleTick()

        return
      }

      lastTick = now

      if (!interacting) {
        if (!cooling) {
          cooling = true
          simulation!.alphaDecay(liveGraphCoolingAlphaDecay(simulation!.alpha(), coolingTickBudget, baseAlphaDecay))
        }

        simulation!.alphaTarget(0)
      }

      rememberPositions()
      simulation!.tick()

      const motion = measureMotion()

      paintSimulationRef.current?.()

      if (interacting) {
        coolingTicks = 0
        stableTicks = 0
        scheduleTick()

        return
      }

      coolingTicks += 1
      stableTicks = liveGraphMotionSettled(motion.rms, motion.max, medianRadius, viewStateRef.current.camera.scale)
        ? stableTicks + 1
        : 0

      if (stableTicks >= LIVE_GRAPH_SETTLED_TICK_TARGET) {
        sleep('balanced')

        return
      }

      if (coolingTicks >= coolingTickBudget) {
        sleep('capped')

        return
      }

      scheduleTick()
    }

    const wake = ({ alpha, alphaTarget = heat.alphaTarget, capDenseAlpha = true, duration }: LiveGraphWakeRequest) => {
      if (simulationRef.current !== simulation) {
        return
      }

      const now = performance.now()

      coolingTicks = 0
      lastTick = 0
      stableTicks = 0
      restoreAlphaDecay()
      settledSimulationRef.current = null
      simulationActiveUntilRef.current = Math.max(simulationActiveUntilRef.current, now + duration)
      rootRef.current?.setAttribute('data-live-graph-simulation-state', 'running')
      rootRef.current?.removeAttribute('data-live-graph-sleep-reason')
      simulation
        .stop()
        .alpha(Math.max(simulation.alpha(), capDenseAlpha ? liveGraphReheatAlpha(simNodes.length, alpha) : alpha))
        .alphaTarget(surfaceActive && !reducedMotion ? liveGraphReheatAlpha(simNodes.length, alphaTarget) : 0)

      if (!surfaceActive) {
        return
      }

      if (reducedMotion) {
        settleReducedMotion()

        return
      }

      scheduleTick()
    }

    wakeSimulationRef.current = wake

    if (!surfaceActive) {
      stopLoop()
      restoreAlphaDecay()
      simulation.alphaTarget(0).stop()
      rootRef.current?.setAttribute('data-live-graph-simulation-state', 'paused')
      releaseHiddenDrag()
    } else if (reducedMotion) {
      settleReducedMotion()
    } else {
      const remainingActiveDuration = Math.max(0, simulationActiveUntilRef.current - performance.now())

      if (settledSimulationRef.current !== simulation) {
        wake({
          alpha: Math.max(simulation.alpha(), heat.alphaTarget),
          duration: remainingActiveDuration
        })
      }
    }

    return () => {
      stopLoop()
      restoreAlphaDecay()

      if (wakeSimulationRef.current === wake) {
        wakeSimulationRef.current = null
      }
    }
  }, [physicsKey, reducedMotion, surfaceActive])

  const activePositions =
    interactivePhysicsKeyRef.current === physicsKey ? interactivePositionsRef.current : settledPositions

  const layout = visible.nodes.flatMap(node => {
    const id = liveGraphNodeId(node)
    const position = activePositions.get(id)

    return position ? [{ id, node, ...position }] : []
  })

  const positions = new Map(layout.map(node => [node.id, node]))

  layoutRef.current = layout
  const allNodesById = useMemo(() => new Map(snapshotNodes(graph).map(node => [liveGraphNodeId(node), node])), [graph])
  const visibleNodeIds = useMemo(() => new Set(visible.nodes.map(liveGraphNodeId)), [visible.nodes])

  useEffect(() => {
    if (selectedId && !visibleNodeIds.has(selectedId)) {
      setSelectedId(null)
    }
  }, [selectedId, visibleNodeIds])

  const neighbors = layoutMetrics.analysis.neighbors
  const emphasisId = denseGraph ? selectedId : hoveredId

  const clearDenseHoverEdges = useCallback(() => {
    denseHoveredNodeIdRef.current = null
    paintDenseEdgeHighlightRef.current?.()
  }, [])

  const showDenseHoverEdges = useCallback((id: string) => {
    if (denseHoveredNodeIdRef.current === id) {
      return
    }

    denseHoveredNodeIdRef.current = id
    paintDenseEdgeHighlightRef.current?.()
  }, [])

  const enterNodeHover = useCallback(
    (id: string) => {
      if (denseGraph) {
        showDenseHoverEdges(id)
      } else {
        setHoveredId(id)
      }
    },
    [denseGraph, showDenseHoverEdges]
  )

  const leaveNodeHover = useCallback(() => {
    setHoveredId(null)
    clearDenseHoverEdges()
  }, [clearDenseHoverEdges])

  useEffect(() => {
    if (denseGraph) {
      paintDenseEdgeHighlightRef.current?.()
    }
  }, [denseGraph, selectedId])

  useEffect(() => {
    if (denseGraph) {
      paintDenseEdgePathsRef.current?.()
    }
  }, [denseGraph, denseLod, viewState.arrows])

  const emphasizedIds = useMemo(() => {
    if (!emphasisId) {
      return null
    }

    return new Set([emphasisId, ...(neighbors.get(emphasisId) ?? [])])
  }, [emphasisId, neighbors])

  const selectedNode = selectedId ? (allNodesById.get(selectedId) ?? null) : null
  const selectedTaskNode = selectedNode && liveGraphNodeKind(selectedNode) === 'task' ? selectedNode : null
  const selectedTaskTarget = selectedTaskNode ? liveGraphTaskTarget(selectedTaskNode) : null
  const selectedWorkflowNode = selectedNode && liveGraphNodeKind(selectedNode) === 'workflow' ? selectedNode : null
  const selectedWorkflowEnvelope = selectedWorkflowNode ? liveGraphWorkflowEnvelopeId(selectedWorkflowNode) : ''

  const selectedWorkflowTasks = useMemo(
    () =>
      selectedWorkflowEnvelope
        ? snapshotNodes(graph).filter(
            node => liveGraphNodeKind(node) === 'task' && liveGraphWorkflowEnvelopeId(node) === selectedWorkflowEnvelope
          )
        : [],
    [graph, selectedWorkflowEnvelope]
  )

  const selectWorkflowTask = useCallback(
    (nodeId: string) => {
      commitState(current => ({
        ...current,
        activeOnly: false,
        enabledKinds: current.enabledKinds.includes('task') ? current.enabledKinds : [...current.enabledKinds, 'task'],
        search: ''
      }))
      setSelectedId(nodeId)
    },
    [commitState]
  )

  const labelsOnHoverOnly = selectedTaskNode !== null

  const hideHoverLabel = useCallback(() => {
    hoverLabelRef.current?.setAttribute('opacity', '0')
    hoverLabelNodeIdRef.current = null
  }, [])

  useEffect(() => {
    hideHoverLabel()
  }, [hideHoverLabel, selectedId, surfaceActive, topologyKey])

  const showHoverLabelForPointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const labelElement = hoverLabelRef.current
      const nodeElement = (event.target as Element).closest<SVGGElement>('[data-live-graph-node]')

      if (!labelElement || !nodeElement || !viewStateRef.current.labels) {
        hideHoverLabel()

        return
      }

      const id = nodeElement.getAttribute('data-live-graph-node-id') ?? ''
      const node = allNodesById.get(id)
      const position = interactivePositionsRef.current.get(id)
      const selected = nodeElement.getAttribute('aria-pressed') === 'true'
      const regularLabel = nodeElement.querySelector('[data-live-graph-label]')

      const fadeOpacity = liveGraphTextFadeOpacity(
        viewStateRef.current.camera.scale,
        viewStateRef.current.textFadeThreshold
      )

      const persistentLabelIsVisible = Boolean(regularLabel) && fadeOpacity >= 0.99

      if (!id || !node || !position || (!labelsOnHoverOnly && (selected || persistentLabelIsVisible))) {
        hideHoverLabel()

        return
      }

      const scale = Math.max(viewStateRef.current.camera.scale, LIVE_GRAPH_MIN_SCALE)
      const fontSize = clamp(11 / scale, 3, 11 / LIVE_GRAPH_MIN_SCALE)
      const radius = layoutMetrics.radiusById.get(id) ?? liveGraphNodeRadius(node, 0)
      const nodeLabel = liveGraphNodeLabel(node)
      const statusLabel = nodeElement.getAttribute('data-live-graph-node-status-label') ?? ''
      const workState = liveGraphNodeWorkState(node)

      const label =
        workState === 'active' || workState === 'blocked' || workState === 'running'
          ? nodeLabel + ' · ' + statusLabel
          : nodeLabel

      labelElement.setAttribute('font-size', String(fontSize))
      labelElement.setAttribute('opacity', '1')
      labelElement.setAttribute('stroke-width', String(clamp(3 / scale, 0.75, 3 / LIVE_GRAPH_MIN_SCALE)))
      labelElement.setAttribute('x', String(position.x))
      labelElement.setAttribute('y', String(position.y + radius + fontSize * 0.9))

      if (hoverLabelNodeIdRef.current !== id) {
        labelElement.textContent = label.length > 36 ? label.slice(0, 35) + '…' : label
        hoverLabelNodeIdRef.current = id
      }
    },
    [allNodesById, hideHoverLabel, labelsOnHoverOnly, layoutMetrics.radiusById]
  )

  const overviewLabelIds = useMemo(
    () =>
      denseGraph
        ? selectLiveGraphOverviewLabelIds(
            layoutTopology.nodes,
            layoutMetrics.analysis,
            DENSE_GRAPH_OVERVIEW_LABEL_LIMIT
          )
        : EMPTY_LABEL_IDS,
    [denseGraph, layoutMetrics.analysis, layoutTopology]
  )

  const structureLabelIds = useMemo(
    () =>
      denseGraph
        ? selectLiveGraphOverviewLabelIds(
            layoutTopology.nodes,
            layoutMetrics.analysis,
            DENSE_GRAPH_STRUCTURE_LABEL_LIMIT
          )
        : EMPTY_LABEL_IDS,
    [denseGraph, layoutMetrics.analysis, layoutTopology]
  )

  const showArrowMarkers =
    viewState.arrows &&
    (!denseGraph || visible.edges.length < DENSE_GRAPH_ARROW_EDGE_THRESHOLD || denseLod === 'detail')

  const denseRestEdgeAppearance = liveGraphEdgeAppearance(true, denseLod, selectedId, '', '')

  const fitGraph = useCallback(
    (persist = true, targetViewport = viewport) => {
      if (cameraCommitTimerRef.current !== null) {
        window.clearTimeout(cameraCommitTimerRef.current)
        cameraCommitTimerRef.current = null
      }

      pendingCameraRef.current = null
      const camera = fitLiveGraphCamera(layoutRef.current, targetViewport, layoutMetrics.radiusById)

      if (denseGraph) {
        applyDenseCamera(camera, persist)
      } else {
        commitState(current => ({ ...current, camera }), persist)
      }
    },
    [applyDenseCamera, commitState, denseGraph, layoutMetrics.radiusById, viewport]
  )

  const fitGraphRef = useRef(fitGraph)
  const previousSelectedIdRef = useRef<string | null | undefined>(undefined)
  fitGraphRef.current = fitGraph

  const hasAutoFitRef = useRef(false)
  useEffect(() => {
    if (!autoFit || hasAutoFitRef.current) {
      return
    }

    if (viewport.width <= 0 || viewport.height <= 0 || layoutRef.current.length === 0) {
      return
    }

    hasAutoFitRef.current = true
    fitGraph(false)
  }, [autoFit, fitGraph, viewport])

  useEffect(() => {
    const previousSelectedId = previousSelectedIdRef.current
    previousSelectedIdRef.current = selectedId

    if (previousSelectedId === undefined || previousSelectedId === selectedId) {
      return
    }

    if (selectionFitFrameRef.current !== null) {
      cancelAnimationFrame(selectionFitFrameRef.current)
    }

    selectionFitFrameRef.current = requestAnimationFrame(() => {
      selectionFitFrameRef.current = null
      const bounds = canvasRef.current?.getBoundingClientRect()

      fitGraphRef.current(
        false,
        bounds && bounds.width > 0 && bounds.height > 0 ? { height: bounds.height, width: bounds.width } : viewport
      )
    })
  }, [selectedId, viewport])

  const revealProgress = useMemo(() => {
    if (!reveal || reveal.key !== physicsKey) {
      return null
    }

    const elapsed = revealClock - reveal.startedAt

    return new Map(
      [...reveal.delays].map(([id, delay]) => {
        const linear = clamp((elapsed - delay) / GRAPH_REVEAL_NODE_DURATION, 0, 1)
        const eased = 1 - Math.pow(1 - linear, 3)

        return [id, eased]
      })
    )
  }, [physicsKey, reveal, revealClock])

  const localizedStatus = useCallback(
    (status: string) => {
      const statuses = t.liveGraph.statuses

      return statuses[status as keyof typeof statuses] ?? statuses.unknown
    },
    [t.liveGraph.statuses]
  )

  const pumpPulseQueue = useCallback(
    (now = performance.now()) => {
      if (!surfaceActive) {
        return
      }

      if (reducedMotion || denseGraph) {
        const queued = pulseQueueRef.current.splice(0)
        const latest = queued.at(-1)

        if (!latest) {
          return
        }

        const targetStatus = liveGraphNodeStatus(allNodesById.get(pulseTargetId(latest)) ?? ({} as LiveGraphNode))

        setAnnouncement(
          t.liveGraph.pulseAnnouncement(
            pulseLabel(latest, allNodesById),
            localizedStatus(targetStatus === 'unknown' ? pulseStatus(latest) : targetStatus)
          )
        )
        activePulsesRef.current = []
        setActivePulses([])

        return
      }

      const running = [...activePulsesRef.current]
      let changed = false

      while (running.length < 2 && pulseQueueRef.current.length > 0) {
        const pulse = pulseQueueRef.current.shift()

        if (!pulse) {
          break
        }

        changed = true
        const semanticId = pulseId(pulse)
        const targetStatus = liveGraphNodeStatus(allNodesById.get(pulseTargetId(pulse)) ?? ({} as LiveGraphNode))

        pulseOccurrenceRef.current += 1
        running.push({
          edgeDuration: 300 + (hashString(semanticId) % 201),
          id: semanticId + ':' + pulseOccurrenceRef.current,
          kind: pulseKind(pulse),
          label: pulseLabel(pulse, allNodesById),
          sourceId: pulseSourceId(pulse),
          startedAt: now,
          status: targetStatus === 'unknown' ? pulseStatus(pulse) : targetStatus,
          targetId: pulseTargetId(pulse)
        })
      }

      if (!changed) {
        return
      }

      activePulsesRef.current = running
      setActivePulses(running)
    },
    [allNodesById, denseGraph, localizedStatus, reducedMotion, surfaceActive, t.liveGraph]
  )

  useEffect(() => {
    if (processedPulseBatchRef.current === pulses) {
      return
    }

    processedPulseBatchRef.current = pulses
    const additions: LiveGraphPulse[] = []
    const batchIds = new Set<string>()

    for (const pulse of pulses) {
      const id = pulseId(pulse)

      if (!id || batchIds.has(id)) {
        continue
      }

      batchIds.add(id)
      additions.push(pulse)
    }

    for (const pulse of additions) {
      const key = pulseSourceId(pulse) + '→' + pulseTargetId(pulse)
      pulseQueueRef.current = pulseQueueRef.current.filter(
        queued => pulseSourceId(queued) + '→' + pulseTargetId(queued) !== key
      )
      pulseQueueRef.current.push(pulse)
    }

    if (pulseQueueRef.current.length > 24) {
      pulseQueueRef.current.splice(0, pulseQueueRef.current.length - 24)
    }

    if (additions.length > 0) {
      pumpPulseQueue()
    }
  }, [pulses, pumpPulseQueue])

  useEffect(() => {
    if (!surfaceActive) {
      pausedAtRef.current = performance.now()

      if (pulseFrameRef.current !== null) {
        cancelAnimationFrame(pulseFrameRef.current)
      }

      pulseFrameRef.current = null

      return
    }

    const resumedAt = performance.now()

    if (pausedAtRef.current !== null) {
      const pausedFor = resumedAt - pausedAtRef.current
      activePulsesRef.current = activePulsesRef.current.map(pulse => ({
        ...pulse,
        startedAt: pulse.startedAt + pausedFor
      }))
      setActivePulses(activePulsesRef.current)
      pausedAtRef.current = null
    }

    pumpPulseQueue(resumedAt)
  }, [pumpPulseQueue, surfaceActive])

  useEffect(() => {
    if (!surfaceActive || activePulses.length === 0 || reducedMotion) {
      return
    }

    let lastPaint = 0

    const tick = (now: number) => {
      const finished: ActivePulse[] = []

      const running = activePulsesRef.current.filter(pulse => {
        const complete = now - pulse.startedAt >= 140 + pulse.edgeDuration + 220

        if (complete) {
          finished.push(pulse)
        }

        return !complete
      })

      for (const pulse of finished) {
        setAnnouncement(t.liveGraph.pulseAnnouncement(pulse.label, localizedStatus(pulse.status)))
      }

      activePulsesRef.current = running

      if (now - lastPaint >= 30) {
        lastPaint = now
        setClock(now)
        setActivePulses(running)
      }

      if (running.length < 2 && pulseQueueRef.current.length > 0) {
        pumpPulseQueue(now)
      }

      if (activePulsesRef.current.length > 0 || pulseQueueRef.current.length > 0) {
        pulseFrameRef.current = requestAnimationFrame(tick)
      } else {
        pulseFrameRef.current = null
      }
    }

    pulseFrameRef.current = requestAnimationFrame(tick)

    return () => {
      if (pulseFrameRef.current !== null) {
        cancelAnimationFrame(pulseFrameRef.current)
      }

      pulseFrameRef.current = null
    }
  }, [activePulses.length, localizedStatus, pumpPulseQueue, reducedMotion, surfaceActive, t.liveGraph])

  useEffect(() => {
    if (!reveal) {
      return
    }

    if (!surfaceActive || reducedMotion || reveal.key !== physicsKey) {
      const simulation = simulationRef.current

      for (const [id, position] of settledPositions) {
        const node = simulationNodesRef.current.get(id)

        if (node) {
          node.fx = null
          node.fy = null
          node.vx = 0
          node.vy = 0
          node.x = position.x
          node.y = position.y
        }
      }

      if (simulation) {
        if (!surfaceActive || reducedMotion) {
          simulationActiveUntilRef.current = 0
          settledSimulationRef.current = simulation
          simulation.alpha(0).alphaTarget(0).stop()
          rootRef.current?.setAttribute('data-live-graph-simulation-state', 'settled')
          rootRef.current?.setAttribute('data-live-graph-sleep-reason', reducedMotion ? 'reduced-motion' : 'balanced')
        } else {
          const heat = liveGraphSimulationHeat(simulation.nodes().length)

          wakeSimulationRef.current?.({
            alpha: Math.max(simulation.alpha(), heat.alphaTarget),
            duration: Math.max(0, simulationActiveUntilRef.current - performance.now())
          })
        }
      }

      paintSimulationRef.current?.()
      setReveal(null)

      return
    }

    const tick = (now: number) => {
      setRevealClock(now)

      if (now - reveal.startedAt < reveal.duration) {
        revealFrameRef.current = requestAnimationFrame(tick)
      } else {
        revealFrameRef.current = null
        setReveal(null)
      }
    }

    revealFrameRef.current = requestAnimationFrame(tick)

    return () => {
      if (revealFrameRef.current !== null) {
        cancelAnimationFrame(revealFrameRef.current)
        revealFrameRef.current = null
      }
    }
  }, [physicsKey, reducedMotion, reveal, settledPositions, surfaceActive])

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current)
      }

      if (selectionFitFrameRef.current !== null) {
        cancelAnimationFrame(selectionFitFrameRef.current)
      }

      if (pulseFrameRef.current !== null) {
        cancelAnimationFrame(pulseFrameRef.current)
      }

      if (revealFrameRef.current !== null) {
        cancelAnimationFrame(revealFrameRef.current)
      }

      if (cameraCommitTimerRef.current !== null) {
        window.clearTimeout(cameraCommitTimerRef.current)
      }
    },
    []
  )

  const zoomAt = useCallback(
    (nextScale: number, screenX: number, screenY: number) => {
      if (denseGraph) {
        const current = viewStateRef.current
        const scale = clamp(nextScale, LIVE_GRAPH_MIN_SCALE, LIVE_GRAPH_MAX_SCALE)
        const worldX = (screenX - current.camera.x) / current.camera.scale
        const worldY = (screenY - current.camera.y) / current.camera.scale

        const camera = {
          scale,
          x: screenX - worldX * scale,
          y: screenY - worldY * scale
        }

        applyDenseCamera(camera, false)
        pendingCameraRef.current = camera

        if (cameraCommitTimerRef.current !== null) {
          window.clearTimeout(cameraCommitTimerRef.current)
        }

        cameraCommitTimerRef.current = window.setTimeout(() => {
          cameraCommitTimerRef.current = null
          const pending = pendingCameraRef.current
          pendingCameraRef.current = null

          if (pending) {
            applyDenseCamera(pending, true)
          }
        }, 120)

        return
      }

      commitState(current => {
        const scale = clamp(nextScale, LIVE_GRAPH_MIN_SCALE, LIVE_GRAPH_MAX_SCALE)
        const worldX = (screenX - current.camera.x) / current.camera.scale
        const worldY = (screenY - current.camera.y) / current.camera.scale

        return {
          ...current,
          camera: {
            scale,
            x: screenX - worldX * scale,
            y: screenY - worldY * scale
          }
        }
      })
    },
    [applyDenseCamera, commitState, denseGraph]
  )

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    hideHoverLabel()

    if (dragRef.current?.mode === 'node') {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const factor = Math.exp(-event.deltaY * 0.0012)
    zoomAt(viewStateRef.current.camera.scale * factor, x, y)
  }

  const flushPointerMove = useCallback(() => {
    pointerFrameRef.current = null
    const drag = dragRef.current

    if (!drag) {
      return
    }

    if (drag.mode === 'pan') {
      const nextX = drag.cameraX + drag.pendingX - drag.startX
      const nextY = drag.cameraY + drag.pendingY - drag.startY
      const nextCamera = { ...viewStateRef.current.camera, x: nextX, y: nextY }
      pendingCameraRef.current = nextCamera

      if (denseGraph) {
        applyDenseCamera(nextCamera, false)
      } else {
        commitState(current => ({ ...current, camera: nextCamera }), false)
      }

      return
    }

    const screenDistance = Math.hypot(drag.pendingX - drag.startClientX, drag.pendingY - drag.startClientY)

    if (!drag.moved && screenDistance < DRAG_THRESHOLD) {
      return
    }

    drag.moved = true
    const node = simulationNodesRef.current.get(drag.id)
    const simulation = simulationRef.current

    if (!node || !simulation) {
      return
    }

    const point = clientToLiveGraphPoint(
      drag.pendingX,
      drag.pendingY,
      drag.svg.getBoundingClientRect(),
      viewStateRef.current.camera
    )

    node.x = point.x + drag.pointerOffsetX
    node.y = point.y + drag.pointerOffsetY
    node.fx = node.x
    node.fy = node.y

    wakeSimulationRef.current?.({ alpha: 0.36, alphaTarget: 0.16, duration: 1_500 })

    if (!reducedMotion) {
      paintSimulationNodeRef.current?.(drag.id)
    }
  }, [applyDenseCamera, commitState, denseGraph, reducedMotion])

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || dragRef.current) {
      return
    }

    hideHoverLabel()
    leaveNodeHover()

    if (cameraCommitTimerRef.current !== null) {
      window.clearTimeout(cameraCommitTimerRef.current)
      cameraCommitTimerRef.current = null
    }

    suppressedNodeActivationRef.current = null
    const nodeElement = (event.target as Element).closest('[data-live-graph-node]')
    const nodeId = nodeElement?.getAttribute('data-live-graph-node-id') ?? ''
    const node = simulationNodesRef.current.get(nodeId)

    if (node) {
      event.preventDefault()
      setReveal(null)

      const point = clientToLiveGraphPoint(
        event.clientX,
        event.clientY,
        event.currentTarget.getBoundingClientRect(),
        viewStateRef.current.camera
      )

      node.fx = Number(node.x)
      node.fy = Number(node.y)
      dragRef.current = {
        attach: event.shiftKey && Boolean(onAttachNode),
        id: nodeId,
        mode: 'node',
        moved: false,
        pendingX: event.clientX,
        pendingY: event.clientY,
        pointerId: event.pointerId,
        pointerOffsetX: Number(node.x) - point.x,
        pointerOffsetY: Number(node.y) - point.y,
        startClientX: event.clientX,
        startClientY: event.clientY,
        svg: event.currentTarget
      }
    } else {
      dragRef.current = {
        cameraX: viewStateRef.current.camera.x,
        cameraY: viewStateRef.current.camera.y,
        mode: 'pan',
        moved: false,
        pendingX: event.clientX,
        pendingY: event.clientY,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        svg: event.currentTarget
      }
    }

    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current

    if (!drag) {
      showHoverLabelForPointer(event)

      return
    }

    hideHoverLabel()

    if (drag.pointerId !== event.pointerId) {
      return
    }

    drag.pendingX = event.clientX
    drag.pendingY = event.clientY

    if (
      drag.mode === 'pan' &&
      !drag.moved &&
      Math.hypot(drag.pendingX - drag.startX, drag.pendingY - drag.startY) >= DRAG_THRESHOLD
    ) {
      drag.moved = true
    }

    if (pointerFrameRef.current === null) {
      pointerFrameRef.current = requestAnimationFrame(flushPointerMove)
    }
  }

  const finishPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    if (pointerFrameRef.current !== null) {
      cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = null
      flushPointerMove()
    }

    dragRef.current = null

    if (drag.mode === 'node' || drag.moved) {
      suppressedCanvasActivationRef.current = performance.now() + 500
    }

    if (denseGraph && drag.mode === 'node') {
      paintDenseEdgePathsRef.current?.()
    }

    if (drag.mode === 'pan') {
      const releasedAsClick =
        event.type === 'pointerup' &&
        !drag.moved &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD

      const pendingCamera = pendingCameraRef.current
      pendingCameraRef.current = null

      if (pendingCamera) {
        if (denseGraph) {
          applyDenseCamera(pendingCamera, true)
        } else {
          commitState(current => ({ ...current, camera: pendingCamera }))
        }
      } else {
        onStateChange?.(viewStateRef.current)
      }

      if (releasedAsClick) {
        setSelectedId(null)
      }
    } else {
      const node = simulationNodesRef.current.get(drag.id)
      const simulation = simulationRef.current

      if (node) {
        node.fx = null
        node.fy = null
      }

      if (simulation && drag.moved) {
        wakeSimulationRef.current?.({ alpha: 0.28, duration: 1_000 })
      } else if (reducedMotion) {
        paintSimulationRef.current?.()
      }

      if (drag.moved) {
        suppressedNodeActivationRef.current = { id: drag.id, until: performance.now() + 500 }
      } else if (event.type === 'pointerup') {
        if (drag.attach && node) {
          suppressedNodeActivationRef.current = { id: drag.id, until: performance.now() + 500 }
          onAttachNode?.(node.node)
        } else {
          setSelectedId(drag.id)
        }
      }
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const animateGraph = useCallback(() => {
    const simulation = simulationRef.current
    const simNodes = [...simulationNodesRef.current.values()]

    if (!simulation || simNodes.length === 0 || reducedMotion) {
      setReveal(null)

      return
    }

    if (denseGraph || multipleComponents) {
      const rootId = snapshotRootId(graph) || simNodes[0].id
      const delays = graphRevealDelays(layoutTopology.nodes, layoutTopology.edges, rootId)
      const elements = rootRef.current?.querySelectorAll<SVGGElement>('[data-live-graph-node]') ?? []

      for (const element of elements) {
        const id = element.dataset.liveGraphNodeId || ''
        const delay = Math.min(delays.get(id) ?? 0, 1_500)

        element.getAnimations().forEach(animation => animation.cancel())
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          delay,
          duration: GRAPH_REVEAL_NODE_DURATION,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards'
        })
      }

      const startupHeat = liveGraphStartupHeat(simNodes.length)
      const reheatAlpha = startupHeat.alpha || liveGraphReheatAlpha(simNodes.length, 0.42)

      wakeSimulationRef.current?.({
        alpha: reheatAlpha,
        capDenseAlpha: false,
        duration: Math.max(2_000, startupHeat.duration)
      })

      return
    }

    const snapshotRoot = snapshotRootId(graph)

    const rootId = simulationNodesRef.current.has(snapshotRoot)
      ? snapshotRoot
      : simulationNodesRef.current.has(layoutRootId)
        ? layoutRootId
        : simNodes[0].id

    const rootNode = simulationNodesRef.current.get(rootId) ?? simNodes[0]
    const rootSettled = settledPositions.get(rootId) ?? { x: Number(rootNode.x), y: Number(rootNode.y) }
    const originX = Number(rootNode.x)
    const originY = Number(rootNode.y)

    simNodes.forEach((node, index) => {
      const destination = settledPositions.get(node.id) ?? rootSettled
      const angle = index * Math.PI * (3 - Math.sqrt(5))

      node.fx = null
      node.fy = null
      node.vx = Math.cos(angle) * 0.2
      node.vy = Math.sin(angle) * 0.2
      node.x = originX + (destination.x - rootSettled.x) * 0.045 + Math.cos(angle) * 1.5
      node.y = originY + (destination.y - rootSettled.y) * 0.045 + Math.sin(angle) * 1.5
    })

    const delays = graphRevealDelays(layoutTopology.nodes, layoutTopology.edges, rootId)
    const startedAt = performance.now()
    const duration = Math.max(0, ...delays.values()) + GRAPH_REVEAL_NODE_DURATION
    simulationActiveUntilRef.current = startedAt + duration

    setReveal({ delays, duration, key: physicsKey, startedAt })
    setRevealClock(startedAt)
    paintSimulationRef.current?.()
    wakeSimulationRef.current?.({ alpha: 1, duration })
  }, [denseGraph, graph, layoutRootId, layoutTopology, multipleComponents, physicsKey, reducedMotion, settledPositions])

  const consumeSuppressedNodeActivation = (id: string): boolean => {
    const suppressed = suppressedNodeActivationRef.current

    if (!suppressed || suppressed.id !== id || performance.now() > suppressed.until) {
      return false
    }

    return true
  }

  const toggleKind = (kind: LiveGraphKind) => {
    commitState(current => {
      const kinds = new Set(current.enabledKinds)

      if (kinds.has(kind) && kinds.size > 1) {
        kinds.delete(kind)
      } else {
        kinds.add(kind)
      }

      return { ...current, enabledKinds: LIVE_GRAPH_KINDS.filter(value => kinds.has(value)) }
    })
  }

  const selectNode = (node: LiveGraphNode) => setSelectedId(liveGraphNodeId(node))
  const kindLabels = t.liveGraph.kinds

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--ui-surface-background)" ref={rootRef}>
      <div className="flex min-h-0 flex-1 overflow-hidden" data-live-graph-workspace>
        <div
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-live-graph-canvas
          ref={canvasRef}
          style={
            {
              '--live-graph-label-opacity': String(
                liveGraphTextFadeOpacity(viewStateRef.current.camera.scale, viewState.textFadeThreshold)
              )
            } as CSSProperties
          }
        >
          <div className="absolute top-3 right-3 z-30">
            <Popover onOpenChange={setSettingsOpen} open={settingsOpen}>
              <Tip label={t.liveGraph.settings}>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={t.liveGraph.settings}
                    className="border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)/90 backdrop-blur-sm"
                    size="icon-sm"
                    variant={settingsOpen ? 'secondary' : 'ghost'}
                  >
                    <Codicon name="settings-gear" />
                  </Button>
                </PopoverTrigger>
              </Tip>
              <PopoverContent
                align="end"
                aria-label={t.liveGraph.settings}
                className="max-h-[min(38rem,calc(100vh-6rem))] w-72 overflow-y-auto p-0"
                role="dialog"
              >
                <div className="border-b border-(--ui-stroke-tertiary) px-3 py-2.5 text-xs font-medium text-(--ui-text-primary)">
                  {t.liveGraph.settings}
                </div>

                <details className="group border-b border-(--ui-stroke-tertiary)" open>
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[0.6875rem] font-semibold text-(--ui-text-secondary) select-none marker:content-none">
                    <Codicon
                      className="transition-transform group-open:rotate-90"
                      name="chevron-right"
                      size="0.6875rem"
                    />
                    {t.liveGraph.filters}
                  </summary>
                  <div className="grid gap-2.5 px-3 pb-3">
                    <SearchField
                      aria-label={t.liveGraph.searchPlaceholder}
                      inputClassName="w-full"
                      onChange={search => commitState(current => ({ ...current, search }))}
                      placeholder={t.liveGraph.searchPlaceholder}
                      value={viewState.search}
                    />
                    <label className="flex cursor-pointer items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)">
                      <Codicon className="text-(--ui-text-tertiary)" name="pulse" />
                      <span className="flex-1">{t.liveGraph.activeOnly}</span>
                      <Switch
                        aria-label={t.liveGraph.activeOnly}
                        checked={viewState.activeOnly}
                        onCheckedChange={activeOnly => commitState(current => ({ ...current, activeOnly }))}
                        size="xs"
                      />
                    </label>
                    <div className="grid gap-2">
                      {LIVE_GRAPH_KINDS.map(kind => {
                        const enabled = enabledKinds.has(kind)

                        return (
                          <label
                            className="flex cursor-pointer items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)"
                            key={kind}
                          >
                            <Codicon name={KIND_ICON[kind]} style={{ color: KIND_COLOR[kind] }} />
                            <span className="flex-1">{kindLabels[kind]}</span>
                            <Switch
                              aria-label={kindLabels[kind]}
                              checked={enabled}
                              onCheckedChange={() => toggleKind(kind)}
                              size="xs"
                            />
                          </label>
                        )
                      })}
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)">
                      <Codicon className="text-(--ui-text-tertiary)" name="circle-outline" />
                      <span className="flex-1">{t.liveGraph.orphans}</span>
                      <Switch
                        aria-label={t.liveGraph.orphans}
                        checked={viewState.orphans}
                        onCheckedChange={orphans => commitState(current => ({ ...current, orphans }))}
                        size="xs"
                      />
                    </label>
                  </div>
                </details>

                <details className="group border-b border-(--ui-stroke-tertiary)" open>
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[0.6875rem] font-semibold text-(--ui-text-secondary) select-none marker:content-none">
                    <Codicon
                      className="transition-transform group-open:rotate-90"
                      name="chevron-right"
                      size="0.6875rem"
                    />
                    {t.liveGraph.display}
                  </summary>
                  <div className="grid gap-2.5 px-3 pb-3">
                    {[
                      {
                        checked: viewState.arrows,
                        icon: 'arrow-right',
                        key: 'arrows',
                        label: t.liveGraph.arrows
                      },
                      {
                        checked: viewState.labels,
                        icon: 'symbol-field',
                        key: 'labels',
                        label: t.liveGraph.labels
                      }
                    ].map(control => (
                      <label
                        className="flex cursor-pointer items-center gap-2 text-[0.6875rem] text-(--ui-text-secondary)"
                        key={control.key}
                      >
                        <Codicon className="text-(--ui-text-tertiary)" name={control.icon} />
                        <span className="flex-1">{control.label}</span>
                        <Switch
                          aria-label={control.label}
                          checked={control.checked}
                          onCheckedChange={checked => commitState(current => ({ ...current, [control.key]: checked }))}
                          size="xs"
                        />
                      </label>
                    ))}
                    <label className="grid gap-1 text-[0.6875rem] text-(--ui-text-secondary)">
                      <span className="flex justify-between gap-3">
                        {t.liveGraph.nodeSize}
                        <span className="font-mono text-(--ui-text-tertiary)" ref={nodeSizeValueRef}>
                          {viewState.nodeSize}%
                        </span>
                      </span>
                      <input
                        aria-label={t.liveGraph.nodeSize}
                        className="accent-(--ui-accent)"
                        defaultValue={viewState.nodeSize}
                        max={LIVE_GRAPH_NODE_SIZE_MAX}
                        min={LIVE_GRAPH_NODE_SIZE_MIN}
                        onBlur={persistNodeSize}
                        onInput={event => previewNodeSize(Number(event.currentTarget.value))}
                        onKeyUp={persistNodeSize}
                        onPointerCancel={persistNodeSize}
                        onPointerUp={persistNodeSize}
                        step="5"
                        type="range"
                      />
                    </label>
                    <label className="grid gap-1 text-[0.6875rem] text-(--ui-text-secondary)">
                      <span className="flex justify-between gap-3">
                        {t.liveGraph.textFadeThreshold}
                        <span className="font-mono text-(--ui-text-tertiary)" ref={fadeThresholdValueRef}>
                          {viewState.textFadeThreshold}
                        </span>
                      </span>
                      <input
                        aria-label={t.liveGraph.textFadeThreshold}
                        className="accent-(--ui-accent)"
                        defaultValue={viewState.textFadeThreshold}
                        max={LIVE_GRAPH_TEXT_FADE_THRESHOLD_MAX}
                        min="0"
                        onBlur={persistTextFadeThreshold}
                        onInput={event => previewTextFadeThreshold(Number(event.currentTarget.value))}
                        onKeyUp={persistTextFadeThreshold}
                        onPointerCancel={persistTextFadeThreshold}
                        onPointerUp={persistTextFadeThreshold}
                        type="range"
                      />
                    </label>
                    <fieldset className="grid gap-1.5">
                      <legend className="text-[0.6875rem] text-(--ui-text-secondary)">{t.liveGraph.focusDepth}</legend>
                      <SegmentedControl
                        onChange={value =>
                          commitState(current => ({
                            ...current,
                            focusDepth: value === 'one' ? 1 : value === 'two' ? 2 : 'all'
                          }))
                        }
                        options={[
                          { id: 'one', label: t.liveGraph.depthOne },
                          { id: 'two', label: t.liveGraph.depthTwo },
                          { id: 'all', label: t.liveGraph.depthAll }
                        ]}
                        value={viewState.focusDepth === 1 ? 'one' : viewState.focusDepth === 2 ? 'two' : 'all'}
                      />
                    </fieldset>
                    <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                      <Button onClick={() => fitGraph()} size="sm" variant="secondary">
                        <Codicon name="screen-full" />
                        {t.liveGraph.fit}
                      </Button>
                      <Button disabled={reducedMotion} onClick={animateGraph} size="sm">
                        <Codicon name="debug-start" />
                        {t.liveGraph.animate}
                      </Button>
                    </div>
                  </div>
                </details>

                <details className="group" open>
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[0.6875rem] font-semibold text-(--ui-text-secondary) select-none marker:content-none">
                    <Codicon
                      className="transition-transform group-open:rotate-90"
                      name="chevron-right"
                      size="0.6875rem"
                    />
                    {t.liveGraph.forces}
                  </summary>
                  <div className="grid gap-3 px-3 pb-3">
                    {[
                      {
                        key: 'centerForce' as const,
                        label: t.liveGraph.centerForce,
                        max: 100,
                        min: 0,
                        value: viewState.centerForce
                      },
                      {
                        key: 'repelForce' as const,
                        label: t.liveGraph.repelForce,
                        max: 180,
                        min: 10,
                        value: viewState.repelForce
                      },
                      {
                        key: 'linkForce' as const,
                        label: t.liveGraph.linkForce,
                        max: 100,
                        min: 0,
                        value: viewState.linkForce
                      },
                      {
                        key: 'linkDistance' as const,
                        label: t.liveGraph.linkDistance,
                        max: 220,
                        min: 48,
                        value: viewState.linkDistance
                      }
                    ].map(control => (
                      <label className="grid gap-1 text-[0.6875rem] text-(--ui-text-secondary)" key={control.key}>
                        <span className="flex justify-between gap-3">
                          {control.label}
                          <span
                            className="font-mono text-(--ui-text-tertiary)"
                            ref={element => {
                              forceValueRefs.current[control.key] = element
                            }}
                          >
                            {control.value}
                          </span>
                        </span>
                        <input
                          aria-label={control.label}
                          className="accent-(--ui-accent)"
                          defaultValue={control.value}
                          max={control.max}
                          min={control.min}
                          onBlur={persistForceSettings}
                          onInput={event => previewForceSetting(control.key, Number(event.currentTarget.value))}
                          onKeyUp={persistForceSettings}
                          onPointerCancel={persistForceSettings}
                          onPointerUp={persistForceSettings}
                          type="range"
                        />
                      </label>
                    ))}
                  </div>
                </details>
              </PopoverContent>
            </Popover>
          </div>

          {visible.nodes.length === 0 ? (
            <EmptyState
              className="h-full"
              description={snapshotNodes(graph).length === 0 ? emptyDesc || t.liveGraph.emptyDesc : undefined}
              title={snapshotNodes(graph).length === 0 ? emptyTitle || t.liveGraph.emptyTitle : t.liveGraph.noMatches}
            />
          ) : (
            <svg
              aria-label={t.liveGraph.title}
              className="size-full touch-none select-none"
              onClick={event => {
                if ((event.target as Element).closest('[data-live-graph-node]')) {
                  suppressedCanvasActivationRef.current = 0

                  return
                }

                if (performance.now() <= suppressedCanvasActivationRef.current) {
                  suppressedCanvasActivationRef.current = 0

                  return
                }

                setSelectedId(null)
              }}
              onLostPointerCapture={finishPointer}
              onPointerCancel={finishPointer}
              onPointerDown={onPointerDown}
              onPointerLeave={() => {
                hideHoverLabel()
                leaveNodeHover()
              }}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointer}
              onWheel={onWheel}
              role="application"
            >
              <defs>
                <marker
                  id={markerId}
                  markerHeight="5"
                  markerUnits="strokeWidth"
                  markerWidth="5"
                  orient="auto"
                  refX="8"
                  refY="3"
                  viewBox="0 0 9 6"
                >
                  <path d="M 0 0 L 9 3 L 0 6 z" fill="var(--ui-text-quaternary)" />
                </marker>
              </defs>
              <g
                data-live-graph-lod={denseGraph ? denseLod : 'detail'}
                data-live-graph-node-size-scale={viewState.nodeSize / 100}
                data-live-graph-world
                ref={worldRef}
                transform={cameraTransform(viewStateRef.current.camera)}
              >
                {denseGraph ? (
                  <>
                    <path
                      aria-hidden="true"
                      d=""
                      data-live-graph-edge-batch
                      fill="none"
                      opacity={denseRestEdgeAppearance.opacity}
                      pointerEvents="none"
                      ref={denseEdgeBatchRef}
                      stroke="var(--ui-text-quaternary)"
                      strokeLinecap="round"
                      strokeWidth={denseRestEdgeAppearance.strokeWidth}
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      aria-hidden="true"
                      d=""
                      data-live-graph-edge-batch-arrows
                      fill="var(--ui-text-quaternary)"
                      opacity={denseRestEdgeAppearance.opacity}
                      pointerEvents="none"
                      ref={denseEdgeBatchArrowsRef}
                    />
                    <path
                      aria-hidden="true"
                      d=""
                      data-live-graph-edge-highlight
                      fill="none"
                      opacity="1"
                      pointerEvents="none"
                      ref={denseEdgeHighlightRef}
                      stroke="var(--ui-text-secondary)"
                      strokeLinecap="round"
                      strokeWidth="1.8"
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      aria-hidden="true"
                      d=""
                      data-live-graph-edge-highlight-arrows
                      fill="var(--ui-text-secondary)"
                      opacity="1"
                      pointerEvents="none"
                      ref={denseEdgeHighlightArrowsRef}
                    />
                  </>
                ) : (
                  visible.edges.map(edge => {
                    const sourceId = liveGraphEdgeSource(edge)
                    const targetId = liveGraphEdgeTarget(edge)
                    const source = positions.get(sourceId)
                    const target = positions.get(targetId)

                    if (!source || !target) {
                      return null
                    }

                    const appearance = liveGraphEdgeAppearance(denseGraph, denseLod, emphasisId, sourceId, targetId)

                    const segment = trimLiveGraphEdge(
                      source,
                      target,
                      layoutMetrics.radiusById.get(sourceId) ?? liveGraphNodeRadius(source.node, 0),
                      layoutMetrics.radiusById.get(targetId) ?? liveGraphNodeRadius(target.node, 0),
                      LIVE_GRAPH_EDGE_GAP
                    )

                    const growth = Math.min(revealProgress?.get(sourceId) ?? 1, revealProgress?.get(targetId) ?? 1)
                    const edgeOpacity = appearance.opacity * growth
                    const edgeStroke = appearance.emphasized ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)'

                    return (
                      <line
                        data-live-graph-edge-growth={growth}
                        data-live-graph-edge-rest-opacity={edgeOpacity}
                        data-live-graph-edge-rest-stroke={edgeStroke}
                        data-live-graph-edge-rest-stroke-width={appearance.strokeWidth}
                        data-live-graph-edge-source={sourceId}
                        data-live-graph-edge-target={targetId}
                        key={edge.id}
                        markerEnd={
                          viewState.arrows && (showArrowMarkers || appearance.emphasized) && growth > 0.92
                            ? 'url(#' + markerId + ')'
                            : undefined
                        }
                        opacity={edgeOpacity}
                        stroke={edgeStroke}
                        strokeLinecap="round"
                        strokeWidth={appearance.strokeWidth}
                        vectorEffect="non-scaling-stroke"
                        x1={segment.x1}
                        x2={segment.x1 + (segment.x2 - segment.x1) * growth}
                        y1={segment.y1}
                        y2={segment.y1 + (segment.y2 - segment.y1) * growth}
                      />
                    )
                  })
                )}

                {activePulses.map(pulse => {
                  if (revealProgress) {
                    return null
                  }

                  const source = positions.get(pulse.sourceId)
                  const target = positions.get(pulse.targetId)

                  if (!source || !target) {
                    return null
                  }

                  const elapsed = Math.max(0, clock - pulse.startedAt)

                  const sourceRadius =
                    layoutMetrics.radiusById.get(pulse.sourceId) ?? liveGraphNodeRadius(source.node, 0)

                  const targetRadius =
                    layoutMetrics.radiusById.get(pulse.targetId) ?? liveGraphNodeRadius(target.node, 0)

                  const color = signalColor(pulse.kind, pulse.status)
                  const segment = trimLiveGraphEdge(source, target, sourceRadius, targetRadius, LIVE_GRAPH_EDGE_GAP)

                  if (elapsed < 140) {
                    const progress = elapsed / 140

                    return (
                      <circle
                        cx={source.x}
                        cy={source.y}
                        data-live-graph-pulse
                        fill="none"
                        key={pulse.id}
                        opacity={1 - progress * 0.55}
                        r={sourceRadius + 4 + progress * 10}
                        stroke={color}
                        strokeWidth={2 - progress}
                      />
                    )
                  }

                  if (elapsed < 140 + pulse.edgeDuration) {
                    const progress = (elapsed - 140) / pulse.edgeDuration

                    return (
                      <g key={pulse.id}>
                        <line
                          opacity={0.55}
                          stroke={color}
                          strokeLinecap="round"
                          strokeWidth="1.5"
                          x1={segment.x1}
                          x2={segment.x2}
                          y1={segment.y1}
                          y2={segment.y2}
                        />
                        <circle
                          cx={segment.x1 + (segment.x2 - segment.x1) * progress}
                          cy={segment.y1 + (segment.y2 - segment.y1) * progress}
                          data-live-graph-pulse
                          fill={color}
                          r="3.2"
                          stroke="var(--ui-bg-editor)"
                          strokeWidth="1.2"
                        />
                      </g>
                    )
                  }

                  const progress = clamp((elapsed - 140 - pulse.edgeDuration) / 220, 0, 1)

                  return (
                    <circle
                      cx={target.x}
                      cy={target.y}
                      data-live-graph-pulse
                      fill="none"
                      key={pulse.id}
                      opacity={1 - progress}
                      r={targetRadius + 12 - progress * 5}
                      stroke={color}
                      strokeWidth={2 - progress}
                    />
                  )
                })}

                {layout.map(position => {
                  const node = position.node
                  const id = position.id
                  const kind = liveGraphNodeKind(node)
                  const degree = layoutMetrics.analysis.degreeById.get(id) ?? 0
                  const semanticReach = layoutMetrics.semanticReachById.get(id) ?? degree
                  const radius = layoutMetrics.radiusById.get(id) ?? liveGraphNodeRadius(node, semanticReach)
                  const status = liveGraphNodeStatus(node)
                  const workState = liveGraphNodeWorkState(node)
                  const activeWork = workState === 'active' || workState === 'blocked' || workState === 'running'
                  const blockedTask = kind === 'task' && workState === 'blocked'
                  const runningTask = kind === 'task' && workState === 'running'
                  const settledContext = viewState.activeOnly && workState === 'settled'
                  const workColor = statusColor(status)
                  const workMarkerRadius = clamp(radius * 0.24 + 1.7, 2.8, 5.2)
                  const nodeKindIconSize = clamp(radius * 1.15, 4, 18)
                  const selected = selectedId === id
                  const dimmed = emphasizedIds !== null && !emphasizedIds.has(id)
                  const label = liveGraphNodeLabel(node)
                  const localizedKind = kindLabels[kind]
                  const localizedNodeStatus = localizedStatus(status)
                  const taskTarget = onOpenTask ? liveGraphTaskTarget(node) : null

                  const sessionTarget =
                    onOpenSession && kind === 'session' && node.openable !== false ? String(node.entityId || '') : ''

                  const isAgent = kind === 'agent'
                  const growth = revealProgress?.get(id) ?? 1
                  const nodeScale = 0.28 + growth * 0.72

                  const showLabel =
                    viewState.labels &&
                    !labelsOnHoverOnly &&
                    (!denseGraph ||
                      selected ||
                      denseLod === 'detail' ||
                      (denseLod === 'overview' ? overviewLabelIds.has(id) : structureLabelIds.has(id)))

                  const labelFontSize =
                    denseGraph && denseLod === 'overview'
                      ? kind === 'session'
                        ? 48
                        : 42
                      : denseGraph && denseLod === 'structure'
                        ? kind === 'session'
                          ? 24
                          : 20
                        : kind === 'session'
                          ? 11
                          : 9

                  const labelStrokeWidth = denseGraph && denseLod !== 'detail' ? labelFontSize * 0.16 : 3
                  const labelLimit = denseGraph && denseLod === 'overview' ? 24 : 28

                  return (
                    <g
                      aria-label={localizedKind + ': ' + label + ', ' + localizedNodeStatus}
                      aria-pressed={selected}
                      className="cursor-pointer outline-none"
                      data-live-graph-node
                      data-live-graph-node-degree={degree}
                      data-live-graph-node-id={id}
                      data-live-graph-node-kind={kind}
                      data-live-graph-node-radius={radius}
                      data-live-graph-node-reach={semanticReach}
                      data-live-graph-node-scale={nodeScale}
                      data-live-graph-node-status={status}
                      data-live-graph-node-status-label={localizedNodeStatus}
                      data-live-graph-node-work-state={workState}
                      data-live-graph-settled-context={settledContext || undefined}
                      key={id}
                      onBlur={leaveNodeHover}
                      onClick={event => {
                        if (consumeSuppressedNodeActivation(id)) {
                          event.preventDefault()
                          event.stopPropagation()

                          return
                        }

                        if (event.shiftKey && onAttachNode) {
                          event.preventDefault()
                          event.stopPropagation()
                          onAttachNode(node)

                          return
                        }

                        selectNode(node)
                      }}
                      onDoubleClick={
                        taskTarget || sessionTarget
                          ? event => {
                              if (consumeSuppressedNodeActivation(id)) {
                                event.preventDefault()
                                event.stopPropagation()

                                return
                              }

                              if (taskTarget) {
                                onOpenTask?.(taskTarget)
                              } else if (sessionTarget) {
                                onOpenSession?.(sessionTarget)
                              }
                            }
                          : undefined
                      }
                      onFocus={() => enterNodeHover(id)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()

                          if (event.shiftKey && onAttachNode) {
                            onAttachNode(node)
                          } else {
                            selectNode(node)
                          }
                        }
                      }}
                      onPointerEnter={() => enterNodeHover(id)}
                      onPointerLeave={leaveNodeHover}
                      opacity={(dimmed ? 0.2 : settledContext && !selected ? 0.14 : 1) * growth}
                      pointerEvents={growth < 0.05 ? 'none' : undefined}
                      role="button"
                      tabIndex={growth < 0.05 ? -1 : 0}
                      transform={'translate(' + position.x + ' ' + position.y + ') scale(' + nodeScale + ')'}
                    >
                      <g
                        data-live-graph-node-glyph
                        style={{
                          transform: 'scale(var(--live-graph-node-size-preview-scale, 1))',
                          transformOrigin: '0 0'
                        }}
                      >
                        {activeWork && (
                          <circle
                            data-live-graph-active-halo
                            fill="none"
                            r={radius + 4.5}
                            stroke={workColor}
                            strokeOpacity={blockedTask ? 0.92 : runningTask ? 0.78 : 0.52}
                            strokeWidth={blockedTask ? 3.2 : runningTask ? 2.7 : 2}
                          />
                        )}
                        <circle
                          data-live-graph-node-body
                          fill={KIND_COLOR[kind]}
                          r={radius}
                          stroke="var(--ui-bg-editor)"
                          strokeOpacity={selected ? 1 : 0.66}
                          strokeWidth={selected ? 2.25 : 1.15}
                        />
                        <circle
                          data-live-graph-node-status-ring
                          fill="none"
                          r={radius + 2.5}
                          stroke={workColor}
                          strokeOpacity={activeWork ? 1 : 0.68}
                          strokeWidth={activeWork ? (blockedTask ? 3 : 2.5) : 1.6}
                        />
                        {selected && (
                          <circle
                            data-live-graph-node-selection
                            fill="none"
                            r={Math.max(2, radius - 3.25)}
                            stroke="var(--ui-bg-editor)"
                            strokeOpacity="0.9"
                            strokeWidth="2"
                          />
                        )}
                        <text
                          aria-hidden="true"
                          data-live-graph-node-kind-icon={KIND_ICON[kind]}
                          dominantBaseline="central"
                          fill="var(--ui-bg-editor)"
                          fontFamily="codicon"
                          fontSize={nodeKindIconSize}
                          pointerEvents="none"
                          textAnchor="middle"
                        >
                          {KIND_GLYPH[kind]}
                        </text>
                        {kind === 'task' && activeWork && (
                          <g
                            data-live-graph-node-work-marker
                            transform={'translate(' + radius * 0.72 + ' ' + -radius * 0.72 + ')'}
                          >
                            <circle
                              fill={workColor}
                              r={workMarkerRadius}
                              stroke="var(--ui-bg-editor)"
                              strokeWidth="1.25"
                            />
                            {blockedTask ? (
                              <g
                                data-live-graph-node-blocked-marker
                                fill="var(--ui-bg-editor)"
                                stroke="var(--ui-bg-editor)"
                                strokeLinecap="round"
                                strokeWidth={Math.max(1.1, workMarkerRadius * 0.28)}
                              >
                                <line x1="0" x2="0" y1={-workMarkerRadius * 0.52} y2={workMarkerRadius * 0.08} />
                                <circle
                                  cy={workMarkerRadius * 0.52}
                                  r={Math.max(0.55, workMarkerRadius * 0.13)}
                                  stroke="none"
                                />
                              </g>
                            ) : runningTask ? (
                              <path
                                d={
                                  'M ' +
                                  -workMarkerRadius * 0.3 +
                                  ' ' +
                                  -workMarkerRadius * 0.46 +
                                  ' L ' +
                                  workMarkerRadius * 0.48 +
                                  ' 0 L ' +
                                  -workMarkerRadius * 0.3 +
                                  ' ' +
                                  workMarkerRadius * 0.46 +
                                  ' Z'
                                }
                                data-live-graph-node-running-marker
                                fill="var(--ui-bg-editor)"
                              />
                            ) : (
                              <circle
                                data-live-graph-node-pending-marker
                                fill="var(--ui-bg-editor)"
                                r={workMarkerRadius * 0.28}
                              />
                            )}
                          </g>
                        )}
                      </g>
                      {showLabel && (
                        <text
                          aria-hidden="true"
                          data-live-graph-label
                          fill="var(--ui-text-primary)"
                          fontSize={labelFontSize}
                          fontWeight={isAgent || selected ? 650 : 520}
                          paintOrder="stroke"
                          pointerEvents="none"
                          stroke="var(--ui-bg-editor)"
                          strokeLinejoin="round"
                          strokeWidth={labelStrokeWidth}
                          style={{ opacity: selected ? 1 : 'var(--live-graph-label-opacity, 1)' }}
                          textAnchor="middle"
                          y={radius + Math.max(15, labelFontSize * 0.85)}
                        >
                          {label.length > labelLimit ? label.slice(0, labelLimit - 1) + '…' : label}
                        </text>
                      )}
                    </g>
                  )
                })}
                <text
                  aria-hidden="true"
                  data-live-graph-hover-label
                  fill="var(--ui-text-primary)"
                  fontWeight="650"
                  opacity="0"
                  paintOrder="stroke"
                  pointerEvents="none"
                  ref={hoverLabelRef}
                  stroke="var(--ui-bg-editor)"
                  strokeLinejoin="round"
                  textAnchor="middle"
                />
              </g>
            </svg>
          )}
        </div>

        {selectedNode && (
          <aside
            aria-label={t.liveGraph.inspector}
            className="relative z-20 h-full min-w-[16rem] w-[clamp(16rem,46%,22rem)] shrink-0 overflow-x-hidden overflow-y-auto border-l border-(--stroke-nous) bg-(--ui-bg-elevated) [overflow-wrap:anywhere]"
            data-testid="live-graph-selection-inspector"
          >
            <div className="flex min-w-0 items-start gap-2 p-3">
              <Codicon
                className="mt-0.5 shrink-0"
                name={KIND_ICON[liveGraphNodeKind(selectedNode)]}
                style={{ color: KIND_COLOR[liveGraphNodeKind(selectedNode)] }}
              />
              <div className="min-w-0 max-w-full flex-1">
                <div className="text-[0.625rem] font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
                  {t.liveGraph.inspector} · {kindLabels[liveGraphNodeKind(selectedNode)]}
                </div>
                <div className="mt-1 break-words text-sm leading-5 font-semibold text-(--ui-text-primary)">
                  {liveGraphNodeLabel(selectedNode)}
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[0.625rem] text-(--ui-text-tertiary)">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: statusColor(liveGraphNodeStatus(selectedNode)) }}
                  />
                  {localizedStatus(liveGraphNodeStatus(selectedNode))}
                </div>
              </div>
              <Tip label={t.common.close}>
                <Button aria-label={t.common.close} onClick={() => setSelectedId(null)} size="icon-xs" variant="ghost">
                  <Codicon name="close" />
                </Button>
              </Tip>
            </div>
            {!selectedTaskNode && liveGraphNodeDetail(selectedNode) && (
              <p className="m-0 border-t border-(--ui-stroke-tertiary) px-3 py-3 whitespace-pre-wrap text-[0.6875rem] leading-4 text-(--ui-text-secondary)">
                {liveGraphNodeDetail(selectedNode)}
              </p>
            )}
            {selectedWorkflowNode && (
              <LiveGraphWorkflowInbox
                key={liveGraphNodeId(selectedWorkflowNode)}
                onSelectTask={selectWorkflowTask}
                tasks={selectedWorkflowTasks}
                workflowScope={liveGraphNodeId(selectedWorkflowNode)}
              />
            )}
            {selectedTaskNode && selectedTaskTarget && (
              <div
                className="grid min-w-0 max-w-full gap-3 border-t border-(--ui-stroke-tertiary) px-3 py-3"
                data-live-graph-inspector-details
              >
                {[
                  {
                    id: 'description',
                    label: t.liveGraph.description,
                    value: liveGraphNodeDetail(selectedTaskNode)
                  },
                  { id: 'summary', label: t.liveGraph.summary, value: selectedTaskNode.summary || '' },
                  { id: 'result', label: t.liveGraph.result, value: selectedTaskNode.result || '' }
                ]
                  .filter(section => section.value)
                  .map(section => (
                    <LiveGraphInspectorTextSection
                      collapseLabel={t.liveGraph.showLess}
                      expandLabel={t.liveGraph.showMore}
                      key={selectedId + ':' + section.id}
                      label={section.label}
                      value={section.value}
                    />
                  ))}
                <dl className="m-0 grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.625rem] leading-4">
                  {[
                    { id: 'task', label: t.liveGraph.taskId, value: selectedTaskTarget.taskId },
                    { id: 'assignee', label: t.liveGraph.assignee, value: selectedTaskNode.assignee || '' },
                    {
                      id: 'priority',
                      label: t.liveGraph.priority,
                      value: selectedTaskNode.priority === undefined ? '' : `P${selectedTaskNode.priority}`
                    },
                    { id: 'board', label: t.liveGraph.board, value: selectedTaskTarget.board || '' },
                    { id: 'workflow', label: t.liveGraph.workflow, value: selectedTaskTarget.workflowId || '' }
                  ]
                    .filter(item => item.value)
                    .map(item => (
                      <div className="contents" key={item.id}>
                        <dt className="text-(--ui-text-tertiary)">{item.label}</dt>
                        <dd className="m-0 min-w-0 break-all font-mono text-(--ui-text-secondary)">{item.value}</dd>
                      </div>
                    ))}
                </dl>
                {onOpenTask && (
                  <Button onClick={() => onOpenTask(selectedTaskTarget)} size="sm" variant="secondary">
                    <Codicon name="go-to-file" />
                    {t.liveGraph.openTask}
                  </Button>
                )}
              </div>
            )}
            {onOpenSession && liveGraphNodeKind(selectedNode) === 'session' && selectedNode.openable !== false && (
              <div className="border-t border-(--ui-stroke-tertiary) px-3 py-3">
                <Button
                  onClick={() => onOpenSession(String(selectedNode.entityId || ''))}
                  size="sm"
                  variant="secondary"
                >
                  <Codicon name="go-to-file" />
                  {t.liveGraph.openSession}
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}

export interface LiveGraphPaneDescriptorLike {
  key?: string
  profile?: string
  sessionRootId?: string
  title?: string
}

export interface LiveGraphPaneViewProps {
  defaultViewState?: LiveGraphViewState
  descriptor?: LiveGraphPaneDescriptorLike
  error?: unknown
  graph?: LiveGraphSnapshot | null
  loading?: boolean
  onAttachNode?: (node: LiveGraphNode) => void
  onOpenSession?: (sessionId: string) => void
  onOpenTask?: (target: LiveGraphTaskTarget) => void
  pulses?: readonly LiveGraphPulse[]
  scope?: 'global' | 'session'
}

function liveGraphStorageKey(descriptor?: LiveGraphPaneDescriptorLike): string {
  const profile = descriptor?.profile || 'default'
  const identity = descriptor?.sessionRootId || descriptor?.key || 'session'

  return 'hermes.desktop.live-graph.view:' + encodeURIComponent(profile) + ':' + encodeURIComponent(identity)
}

export function LiveGraphPaneView({
  defaultViewState = DEFAULT_LIVE_GRAPH_VIEW_STATE,
  descriptor,
  error,
  graph,
  loading = false,
  onAttachNode,
  onOpenSession,
  onOpenTask,
  pulses = EMPTY_PULSES,
  scope = 'session'
}: LiveGraphPaneViewProps) {
  const { t } = useI18n()
  const storageKey = liveGraphStorageKey(descriptor)
  const persistedState = useMemo(() => readJson<LiveGraphViewState>(storageKey), [storageKey])

  const initialState = useMemo(
    () => normalizeLiveGraphViewState(persistedState ?? defaultViewState),
    [defaultViewState, persistedState]
  )

  const attachNode = useCallback(
    (node: LiveGraphNode) => {
      if (onAttachNode) {
        onAttachNode(node)

        return
      }

      attachLiveGraphNodeToComposer(node, descriptor?.profile)
    },
    [descriptor?.profile, onAttachNode]
  )

  const global = scope === 'global'

  if (loading) {
    return (
      <div className="grid size-full place-items-center bg-(--ui-surface-background)">
        <Loader
          aria-label={global ? t.liveGraph.globalLoading : t.liveGraph.loading}
          label={global ? t.liveGraph.globalLoading : t.liveGraph.loading}
          type="lemniscate-bloom"
        />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        className="size-full place-content-center bg-(--ui-surface-background) p-6"
        title={global ? t.liveGraph.globalLoadFailed : t.liveGraph.loadFailed}
      />
    )
  }

  if (!graph) {
    return (
      <EmptyState
        className="size-full bg-(--ui-surface-background)"
        description={global ? t.liveGraph.globalEmptyDesc : t.liveGraph.emptyDesc}
        title={global ? t.liveGraph.globalEmptyTitle : t.liveGraph.emptyTitle}
      />
    )
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-(--ui-surface-background)">
      <LiveGraphCanvas
        autoFit={!persistedState}
        emptyDesc={global ? t.liveGraph.globalEmptyDesc : t.liveGraph.emptyDesc}
        emptyTitle={global ? t.liveGraph.globalEmptyTitle : t.liveGraph.emptyTitle}
        graph={graph}
        initialState={initialState}
        key={storageKey}
        onAttachNode={attachNode}
        onOpenSession={onOpenSession}
        onOpenTask={onOpenTask}
        onStateChange={state => writeJson(storageKey, state)}
        pulses={pulses}
      />
    </div>
  )
}
