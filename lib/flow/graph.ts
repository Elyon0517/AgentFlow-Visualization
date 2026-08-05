/**
 * Graph state for the generic workflow visualizer.
 *
 * Mirrors the split that already works well in `hooks/simulation/`:
 * structural data (nodes, edges, logs) is read by React; per-frame visual data
 * lives in `node.anim` / `particles` and is only ever touched by the animation
 * loop via a ref. Nothing here should be mutated from a React render.
 */

import type {
  FlowEdgeKind,
  FlowErrorInfo,
  FlowEvent,
  FlowNodeStatus,
  FlowNodeType,
  StructuredLog,
} from './events'

// ─── Node ────────────────────────────────────────────────────────────────────

/** Per-node visual state. Advanced by the animation loop, never by React. */
export interface NodeAnim {
  opacity: number
  scale: number
  /** Seconds since the node appeared — drives the spawn animation. */
  spawnAge: number
  /** Seconds since `status` last changed — drives breathing/pulse phase so
   *  every node is not synchronized to the same sine wave. */
  statusAge: number
  /** A single non-looping animation (success flash, failure shake, handoff
   *  arrival). Cleared once `age >= duration`. */
  oneShot: { kind: OneShotKind; age: number; duration: number } | null
  /** 1 = fully lit, <1 = dimmed by the focus effect. Lerped, never snapped. */
  focus: number
}

export type OneShotKind = 'spawn' | 'success' | 'warning' | 'failed' | 'handoff'

export interface NodeRequestRecord {
  at: number
  request?: string
  response?: string
  error?: string
  durationMs?: number
}

export interface FlowNode {
  id: string
  type: FlowNodeType
  label: string
  group?: string
  /** Per-node glyph override; falls back to the registry glyph for its type. */
  icon?: string
  parentId: string | null

  status: FlowNodeStatus
  /** One-line "what is this doing right now", rendered under the node. */
  summary?: string
  /** 0..1 when the producer reports it. */
  progress?: number
  waitingOn?: string
  /** 1-based; >1 renders the `↻n` retry badge. */
  attempt: number
  maxAttempts?: number

  /** All times are run-relative seconds, matching the existing simulation clock. */
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** Producer-reported duration, preferred over endedAt-startedAt when present. */
  durationMs?: number

  inputSummary?: string
  outputSummary?: string
  requests: NodeRequestRecord[]
  logs: StructuredLog[]
  error?: FlowErrorInfo

  tokens?: number
  cost?: number

  // ── Layout (written by d3-force) ──
  x: number
  y: number
  vx: number
  vy: number
  fx?: number
  fy?: number
  pinned: boolean
  /** Topological depth from the roots. Drives the left-to-right layered layout.
   *  Computed incrementally as edges arrive, since node ids are generated at
   *  run time rather than known up front. */
  depth: number

  anim: NodeAnim
}

// ─── Edge / particle ─────────────────────────────────────────────────────────

export interface FlowEdge {
  id: string
  source: string
  target: string
  kind: FlowEdgeKind
  label?: string
  createdAt: number
  opacity: number
  /** Run-relative seconds of the last particle on this edge. Edges active
   *  within ACTIVE_EDGE_WINDOW_S render as part of the "current path". */
  lastActiveAt?: number
}

export interface FlowParticle {
  id: string
  edgeId: string
  kind: FlowEdgeKind
  /** Always 0 → 1. Direction is expressed by `reverse`, not by running the
   *  progress backwards — so source → target stays explicit in the data. */
  progress: number
  /** True for responses travelling target → source along a forward edge. */
  reverse: boolean
  size: number
  label?: string
  /** Run-relative seconds when the transfer started. Lets a seek reconstruct
   *  exactly which particles were mid-flight at the target time, so scrubbing
   *  shows data moving rather than a frozen graph. */
  spawnedAt: number
}

// ─── Run / state ─────────────────────────────────────────────────────────────

export interface FlowRun {
  runId: string
  status: 'running' | 'completed' | 'failed'
  label?: string
  /** Wall-clock start, kept so the UI can show absolute times. */
  startedAtIso: string
  startedAtMs: number
  endedAtMs?: number
  error?: FlowErrorInfo
}

export interface FlowLogEntry {
  nodeId: string
  nodeLabel: string
  at: number
  log: StructuredLog
}

export interface FlowState {
  run: FlowRun | null
  nodes: Map<string, FlowNode>
  edges: FlowEdge[]
  particles: FlowParticle[]
  /** Flat, chronological log stream for the Logs view. */
  logs: FlowLogEntry[]
  /** Retained events, the source of truth for seek and replay. */
  eventLog: FlowEvent[]
  /** Guards against duplicate delivery after an SSE reconnect. */
  seenEventIds: Set<string>

  currentTime: number
  maxTimeReached: number
  isPlaying: boolean
  speed: number
}

// ─── Caps ────────────────────────────────────────────────────────────────────

export const MAX_LOGS_PER_NODE = 200
export const MAX_GLOBAL_LOGS = 2000
export const MAX_REQUESTS_PER_NODE = 50
export const MAX_FLOW_EVENT_LOG = 20_000
export const MAX_PARTICLES = 400
/** Seconds an edge stays in the "current activity" highlight after a particle. */
export const ACTIVE_EDGE_WINDOW_S = 3

// ─── Particle sizing ─────────────────────────────────────────────────────────
// Lives here rather than in the node registry so the reducer stays free of any
// rendering dependency — state must be computable without a canvas or a theme.

/** Base particle radius in world units, per edge kind. */
export const PARTICLE_BASE_SIZE: Record<FlowEdgeKind, number> = {
  request: 4,
  response: 4,
  data: 5,
  handoff: 6,
  error: 5,
  control: 3,
}

/** Scale a particle by payload size so a large transfer visibly weighs more
 *  than a ping. Log-scaled and capped at 2× — 1 KB and 1 MB should differ,
 *  but not by 1000×. */
export function particleSizeForBytes(base: number, bytes?: number): number {
  if (!bytes || bytes <= 0) return base
  return Math.min(base * 2, base * (1 + Math.log10(1 + bytes / 1024) * 0.25))
}

// ─── Constructors ────────────────────────────────────────────────────────────

export function createNodeAnim(overrides?: Partial<NodeAnim>): NodeAnim {
  return {
    opacity: 0,
    scale: 0.3,
    spawnAge: 0,
    statusAge: 0,
    oneShot: { kind: 'spawn', age: 0, duration: 0.45 },
    focus: 1,
    ...overrides,
  }
}

export function createFlowState(overrides?: Partial<FlowState>): FlowState {
  return {
    run: null,
    nodes: new Map(),
    edges: [],
    particles: [],
    logs: [],
    eventLog: [],
    seenEventIds: new Set(),
    currentTime: 0,
    maxTimeReached: 0,
    isPlaying: true,
    speed: 1,
    ...overrides,
  }
}

// ─── Status helpers ──────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<FlowNodeStatus>(['success', 'warning', 'failed', 'skipped'])
const ACTIVE_STATUSES = new Set<FlowNodeStatus>(['running', 'waiting'])

export function isTerminal(status: FlowNodeStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** A node the user would consider "currently working". */
export function isActive(status: FlowNodeStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

/** One-shot animation to play when entering a status, if any. */
export function oneShotForStatus(status: FlowNodeStatus): { kind: OneShotKind; duration: number } | null {
  switch (status) {
    case 'success': return { kind: 'success', duration: 0.6 }
    case 'warning': return { kind: 'warning', duration: 0.6 }
    case 'failed': return { kind: 'failed', duration: 0.45 }
    default: return null
  }
}

// ─── Graph traversal ─────────────────────────────────────────────────────────

/** Nodes reachable upstream and downstream of `rootId`, inclusive.
 *  Used by the focus effect — computed once per selection, never per frame. */
export function collectConnectedPath(rootId: string, edges: readonly FlowEdge[]): Set<string> {
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source)!.push(edge.target)
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    incoming.get(edge.target)!.push(edge.source)
  }

  const result = new Set<string>([rootId])
  for (const adjacency of [outgoing, incoming]) {
    const queue = [rootId]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of adjacency.get(current) ?? []) {
        if (result.has(next)) continue
        result.add(next)
        queue.push(next)
      }
    }
  }
  return result
}

/**
 * Node types that are shared stores rather than pipeline stages.
 *
 * A memory node is typically read early and written late, which turns the
 * whole run into one big cycle and collapses the layered layout. Reading or
 * writing memory does not advance you through the pipeline, so those edges are
 * excluded from depth — they are still drawn, and still carry particles.
 */
const NON_PIPELINE_TYPES = new Set<FlowNodeType>(['memory'])

function isPipelineEdge(edge: FlowEdge, nodes: Map<string, FlowNode>): boolean {
  // A response points backwards by definition; counting it would create a
  // two-node cycle out of every ordinary call.
  if (edge.kind === 'response') return false
  if (edge.source === edge.target) return false

  const source = nodes.get(edge.source)
  const target = nodes.get(edge.target)
  if (!source || !target) return false

  return !NON_PIPELINE_TYPES.has(source.type) && !NON_PIPELINE_TYPES.has(target.type)
}

/**
 * Recompute topological depth for every node.
 *
 * Node ids are generated at run time, so depth cannot be assigned when a node
 * is created — an incoming edge may arrive later and push it right. This runs
 * on edge insertion (cheap: the graphs are hundreds of nodes, not millions)
 * and is cycle-safe via the visit cap.
 *
 * Replaces changed entries with copies rather than mutating node objects in
 * place — the previous state's map may still be held by a React render, and
 * retroactively editing it would produce a stale-but-different snapshot.
 *
 * Returns true when any depth changed, so the caller can skip re-seeding the
 * layout forces on a no-op.
 */
export function recomputeDepths(nodes: Map<string, FlowNode>, edges: readonly FlowEdge[]): boolean {
  const pipelineEdges = edges.filter(edge => isPipelineEdge(edge, nodes))

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of nodes.keys()) indegree.set(id, 0)

  for (const edge of pipelineEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source)!.push(edge.target)
  }

  const depths = new Map<string, number>()
  const queue: string[] = []
  for (const [id, degree] of indegree) {
    if (degree === 0) { depths.set(id, 0); queue.push(id) }
  }

  // Kahn's algorithm. Nodes left unvisited are inside a cycle.
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentDepth = depths.get(current) ?? 0
    for (const next of outgoing.get(current) ?? []) {
      depths.set(next, Math.max(depths.get(next) ?? 0, currentDepth + 1))
      const remaining = (indegree.get(next) ?? 1) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }

  // Cycle members: place each one just right of its deepest resolved
  // predecessor. Derived from the edge set rather than map iteration order, so
  // the result does not depend on which node happened to be created first.
  for (const [id, node] of nodes) {
    if (depths.has(id)) continue
    let deepestPredecessor = -1
    for (const edge of pipelineEdges) {
      if (edge.target !== id) continue
      const depth = depths.get(edge.source)
      if (depth != null && depth > deepestPredecessor) deepestPredecessor = depth
    }
    if (deepestPredecessor >= 0) {
      depths.set(id, deepestPredecessor + 1)
      continue
    }
    const parentDepth = node.parentId ? depths.get(node.parentId) : undefined
    depths.set(id, parentDepth != null ? parentDepth + 1 : node.depth)
  }

  let changed = false
  for (const [id, node] of nodes) {
    const depth = depths.get(id) ?? 0
    if (node.depth !== depth) { nodes.set(id, { ...node, depth }); changed = true }
  }
  return changed
}
