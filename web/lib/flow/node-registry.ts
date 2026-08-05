/**
 * Node type registry.
 *
 * The canvas renderer resolves everything it needs to draw a node from this
 * table, keyed only by `FlowNodeType`. Business identity ("Heatmap API",
 * "GEX/VEX Analysis", "Trade Decision") never appears here or in any drawing
 * code — it arrives as `FlowNode.label` and is rendered as text.
 *
 * Adding a node category means adding one entry here plus a glyph. It must
 * never mean touching the draw loop.
 */

import { COLORS } from '@/lib/colors'
import type { FlowEdgeKind, FlowNodeStatus, FlowNodeType } from './events'
import { PARTICLE_BASE_SIZE } from './graph'

/** Outline drawn for a node. Implemented by the shape renderers. */
export type NodeShape = 'hexagon' | 'rounded' | 'diamond' | 'cylinder' | 'capsule'

/**
 * Idle-safe motion played inside a node while it is `running`.
 * Driven entirely by the shared frame clock — no per-node timers, so the
 * animation is a pure function of (state, time) and stays replay-accurate.
 */
export type RunningMotion = 'orbit' | 'arc-sweep' | 'pulse-bar' | 'scan' | 'none'

export interface NodeTypeSpec {
  type: FlowNodeType
  /** Shown in filter chips and the detail popup. */
  displayName: string
  shape: NodeShape
  /** Base radius in world units, before breathing and spawn scaling. */
  radius: number
  /** Type accent color. Status color wins for the border; this tints the
   *  interior glyph so types stay distinguishable at a glance. */
  accent: string
  runningMotion: RunningMotion
  /** False pins the node outside the force layout (memory sits to the side
   *  rather than being flung around by charge forces). */
  forceParticipant: boolean
  /** Monospace glyph drawn at the node center. Kept to single characters so
   *  it renders identically across platforms without a font dependency. */
  glyph: string
}

// Type accents. Deliberately drawn from the existing holographic palette so
// new node types sit inside the established look instead of fighting it.
const ACCENT = {
  agent: COLORS.holoBase,
  orchestrator: COLORS.holoBright,
  task: '#8fb8ff',
  tool: COLORS.tool,
  api: '#5ad6d0',
  dataSource: '#7fd4ff',
  llm: COLORS.dispatch,
  memory: '#b9a2ff',
  decision: '#ffd166',
} as const

const SPECS: NodeTypeSpec[] = [
  {
    type: 'orchestrator',
    displayName: 'Orchestrator',
    shape: 'hexagon',
    radius: 30,
    accent: ACCENT.orchestrator,
    runningMotion: 'orbit',
    forceParticipant: true,
    glyph: '✲',
  },
  {
    type: 'agent',
    displayName: 'Agent',
    shape: 'hexagon',
    radius: 24,
    accent: ACCENT.agent,
    runningMotion: 'orbit',
    forceParticipant: true,
    glyph: '◇',
  },
  {
    type: 'task',
    displayName: 'Task',
    shape: 'rounded',
    radius: 20,
    accent: ACCENT.task,
    runningMotion: 'pulse-bar',
    forceParticipant: true,
    glyph: '▦',
  },
  {
    type: 'tool',
    displayName: 'Tool',
    shape: 'rounded',
    radius: 18,
    accent: ACCENT.tool,
    runningMotion: 'arc-sweep',
    forceParticipant: true,
    glyph: '⚙',
  },
  {
    type: 'api',
    displayName: 'API',
    shape: 'capsule',
    radius: 20,
    accent: ACCENT.api,
    runningMotion: 'arc-sweep',
    forceParticipant: true,
    glyph: '⇄',
  },
  {
    type: 'data_source',
    displayName: 'Data Source',
    shape: 'cylinder',
    radius: 20,
    accent: ACCENT.dataSource,
    runningMotion: 'scan',
    forceParticipant: true,
    glyph: '≡',
  },
  {
    type: 'llm',
    displayName: 'LLM',
    shape: 'hexagon',
    radius: 24,
    accent: ACCENT.llm,
    runningMotion: 'pulse-bar',
    forceParticipant: true,
    glyph: '✵',
  },
  {
    type: 'memory',
    displayName: 'Memory',
    shape: 'cylinder',
    radius: 18,
    accent: ACCENT.memory,
    runningMotion: 'pulse-bar',
    // Memory participates like any other node. Excluding it only meant nothing
    // pushed it clear of its neighbours, so it sat on top of them with the two
    // labels overlapping. Its edges are already excluded from *depth*, which is
    // what actually prevents the read-early/write-late cycle.
    forceParticipant: true,
    glyph: '◫',
  },
  {
    type: 'decision',
    displayName: 'Decision',
    shape: 'diamond',
    radius: 22,
    accent: ACCENT.decision,
    runningMotion: 'none',
    forceParticipant: true,
    glyph: '◆',
  },
]

const REGISTRY = new Map<FlowNodeType, NodeTypeSpec>(SPECS.map(spec => [spec.type, spec]))

/** Fallback for a type that somehow slipped past validation — draw something
 *  neutral rather than throwing inside the draw loop. */
const FALLBACK: NodeTypeSpec = {
  type: 'task',
  displayName: 'Node',
  shape: 'rounded',
  radius: 20,
  accent: COLORS.holoBase,
  runningMotion: 'none',
  forceParticipant: true,
  glyph: '○',
}

export function getNodeSpec(type: FlowNodeType): NodeTypeSpec {
  return REGISTRY.get(type) ?? FALLBACK
}

/** Override or add a node type at runtime. Lets a host app extend the
 *  visualizer without forking the registry. */
export function registerNodeType(spec: NodeTypeSpec): void {
  REGISTRY.set(spec.type, spec)
}

export function allNodeSpecs(): NodeTypeSpec[] {
  return SPECS.slice()
}

// ─── Status colors ───────────────────────────────────────────────────────────

/** Border/glow color per status. Success and running are deliberately
 *  different hues — the two are also distinguished by motion, never by
 *  brightness alone. */
const STATUS_COLORS: Record<FlowNodeStatus, string> = {
  idle: '#5a6b8c',
  queued: '#7d8aa8',
  running: COLORS.holoBase,
  waiting: COLORS.waiting_permission,
  success: COLORS.complete,
  warning: '#ffbb44',
  failed: COLORS.error,
  skipped: '#4a4a5e',
}

export function getStatusColor(status: FlowNodeStatus): string {
  return STATUS_COLORS[status] ?? COLORS.holoBase
}

export function getStatusLabel(status: FlowNodeStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// ─── Edge kind styling ───────────────────────────────────────────────────────

export interface EdgeKindSpec {
  color: string
  /** Particle radius in world units. Sourced from the state layer so the
   *  reducer and the renderer cannot drift apart. */
  particleSize: number
  /** Trail length as a fraction of the curve. */
  trail: number
  displayName: string
}

const EDGE_KINDS: Record<FlowEdgeKind, EdgeKindSpec> = {
  request: { color: COLORS.tool, particleSize: PARTICLE_BASE_SIZE.request, trail: 0.15, displayName: 'Request' },
  response: { color: COLORS.return, particleSize: PARTICLE_BASE_SIZE.response, trail: 0.15, displayName: 'Response' },
  data: { color: COLORS.holoBase, particleSize: PARTICLE_BASE_SIZE.data, trail: 0.18, displayName: 'Data' },
  handoff: { color: COLORS.dispatch, particleSize: PARTICLE_BASE_SIZE.handoff, trail: 0.25, displayName: 'Handoff' },
  error: { color: COLORS.error, particleSize: PARTICLE_BASE_SIZE.error, trail: 0.15, displayName: 'Error' },
  control: { color: COLORS.textMuted, particleSize: PARTICLE_BASE_SIZE.control, trail: 0.1, displayName: 'Control' },
}

export function getEdgeKindSpec(kind: FlowEdgeKind): EdgeKindSpec {
  return EDGE_KINDS[kind] ?? EDGE_KINDS.control
}
