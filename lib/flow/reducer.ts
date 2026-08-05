/**
 * Event → graph state reducer.
 *
 * The single place where a {@link FlowEvent} becomes graph state. Live SSE
 * playback, JSONL replay, and seek all funnel through here, which is what
 * guarantees a replayed run looks identical to the original.
 *
 * Two invariants worth preserving when editing:
 *
 *  1. **Deterministic.** No `Math.random()`, no `Date.now()`. Spawn jitter is
 *     derived from a hash of the node id so replay reproduces the same layout.
 *  2. **Reference-honest.** Node objects are copied on change; `node.anim` is
 *     the one deliberate exception — it is mutable per-frame state owned by the
 *     animation loop and is carried by reference across updates.
 */

import {
  deriveEdgeId,
  impliedEdgeKind,
  impliedStatus,
  type FlowEdgeKind,
  type FlowEvent,
  type FlowNodeStatus,
  type FlowNodeType,
} from './events'
import {
  ACTIVE_EDGE_WINDOW_S,
  MAX_FLOW_EVENT_LOG,
  MAX_GLOBAL_LOGS,
  MAX_LOGS_PER_NODE,
  MAX_PARTICLES,
  MAX_REQUESTS_PER_NODE,
  PARTICLE_BASE_SIZE,
  createNodeAnim,
  isTerminal,
  oneShotForStatus,
  particleSizeForBytes,
  recomputeDepths,
  type FlowEdge,
  type FlowLogEntry,
  type FlowNode,
  type FlowParticle,
  type FlowState,
} from './graph'

/** Events whose payload flows target → source (a result coming back). */
const RESPONSE_EVENTS = new Set<FlowEvent['eventType']>(['tool.returned', 'memory.read'])

/** Horizontal spacing hint used when seeding a new node's position. The real
 *  layout is settled by d3-force; this only picks a sane starting point so the
 *  node does not fly in from the origin. */
const SEED_STEP_X = 220
const SEED_SPREAD_Y = 160

// ─── Deterministic helpers ───────────────────────────────────────────────────

function hashId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  return Math.abs(hash)
}

/** Stable pseudo-jitter in [-1, 1] so siblings do not stack exactly. */
function jitter(id: string): number {
  return ((hashId(id) % 1000) / 500) - 1
}

// ─── Ring buffers ────────────────────────────────────────────────────────────

function pushCapped<T>(list: T[], item: T, cap: number): T[] {
  const next = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice()
  next.push(item)
  return next
}

// ─── Working state ───────────────────────────────────────────────────────────

/** Mutable containers for one reducer pass. Mirrors `MutableEventState` in
 *  hooks/simulation so the two reducers stay recognizably similar. */
interface Draft {
  nodes: Map<string, FlowNode>
  edges: FlowEdge[]
  particles: FlowParticle[]
  logs: FlowLogEntry[]
  edgesChanged: boolean
}

// ─── Node helpers ────────────────────────────────────────────────────────────

function seedPosition(draft: Draft, parentId: string | null, id: string): { x: number; y: number } {
  const parent = parentId ? draft.nodes.get(parentId) : undefined
  if (parent) {
    return { x: parent.x + SEED_STEP_X, y: parent.y + jitter(id) * SEED_SPREAD_Y }
  }
  // Root node: spread vertically so multiple entry points do not overlap.
  return { x: 0, y: jitter(id) * SEED_SPREAD_Y }
}

function createNode(
  draft: Draft,
  id: string,
  type: FlowNodeType,
  label: string,
  parentId: string | null,
  at: number,
  extra?: { group?: string; icon?: string },
): FlowNode {
  const { x, y } = seedPosition(draft, parentId, id)
  const node: FlowNode = {
    id, type, label, parentId,
    ...(extra?.group ? { group: extra.group } : {}),
    ...(extra?.icon ? { icon: extra.icon } : {}),
    status: 'idle',
    attempt: 1,
    createdAt: at,
    requests: [],
    logs: [],
    x, y, vx: 0, vy: 0,
    pinned: false,
    depth: parentId ? (draft.nodes.get(parentId)?.depth ?? 0) + 1 : 0,
    anim: createNodeAnim(),
  }
  draft.nodes.set(id, node)
  return node
}

/**
 * Resolve the node an event is about, creating it if the producer never sent
 * an explicit `node.created`. Producers are allowed to be terse — a bare
 * `node.started` should just work.
 */
function ensureNode(draft: Draft, event: FlowEvent, at: number): FlowNode | null {
  const ref = event.node
  if (!ref) return null

  const existing = draft.nodes.get(ref.id)
  if (!existing) {
    return createNode(draft, ref.id, ref.type, ref.label, event.parentNodeId ?? null, at, { group: ref.group, icon: ref.icon })
  }

  // Later events may carry a better label/type than the one we first saw.
  const patch: Partial<FlowNode> = {}
  if (ref.label && ref.label !== existing.label && ref.label !== existing.id) patch.label = ref.label
  if (ref.type !== existing.type) patch.type = ref.type
  if (ref.group && ref.group !== existing.group) patch.group = ref.group
  if (event.parentNodeId && existing.parentId === null) patch.parentId = event.parentNodeId

  if (Object.keys(patch).length === 0) return existing
  const updated = { ...existing, ...patch }
  draft.nodes.set(ref.id, updated)
  return updated
}

/** Referenced-but-unknown endpoint. Better a visible placeholder than a
 *  silently dropped edge — a ghost node is debuggable, a missing edge is not. */
function ensurePlaceholder(draft: Draft, id: string, at: number): FlowNode {
  const existing = draft.nodes.get(id)
  if (existing) return existing
  return createNode(draft, id, 'task', id, null, at)
}

function patchNode(draft: Draft, id: string, patch: Partial<FlowNode>): FlowNode | null {
  const node = draft.nodes.get(id)
  if (!node) return null
  const updated = { ...node, ...patch }
  draft.nodes.set(id, updated)
  return updated
}

// ─── Status transition ───────────────────────────────────────────────────────

function applyStatus(draft: Draft, node: FlowNode, status: FlowNodeStatus, at: number, event: FlowEvent): void {
  if (node.status === status && status !== 'running') return

  const patch: Partial<FlowNode> = { status }
  const md = event.metadata

  // Retry: a failed node going active again is attempt N+1, unless the
  // producer numbers attempts itself.
  if (typeof md?.attempt === 'number') {
    patch.attempt = md.attempt
  } else if (node.status === 'failed' && (status === 'running' || status === 'queued')) {
    patch.attempt = node.attempt + 1
  }

  if (status === 'running' && node.startedAt == null) patch.startedAt = at
  if (status === 'running') {
    // A retry clears the previous failure so the node stops rendering as failed.
    patch.error = undefined
    patch.endedAt = undefined
  }
  if (isTerminal(status)) patch.endedAt = at

  // Leaving `waiting` means the node is no longer blocked. This lives here
  // rather than in metadata handling because the unblocking event usually
  // carries no metadata at all.
  if (status !== 'waiting') patch.waitingOn = undefined

  // Reset the status clock so the breathing/pulse phase restarts, and queue
  // the one-shot flash. `anim` is shared by reference on purpose.
  const shot = oneShotForStatus(status)
  node.anim.statusAge = 0
  if (shot) node.anim.oneShot = { kind: shot.kind, age: 0, duration: shot.duration }

  patchNode(draft, node.id, patch)
}

// ─── Edge / particle helpers ─────────────────────────────────────────────────

interface Endpoints { source: string; target: string }

/**
 * Where this event's data is flowing.
 *
 * Explicit `edge` always wins. Otherwise it is inferred from
 * `parentNodeId` — reversed for response-shaped events, since a returning
 * result travels child → parent.
 */
function resolveEndpoints(event: FlowEvent): Endpoints | null {
  if (event.edge) return { source: event.edge.source, target: event.edge.target }
  if (!event.node || !event.parentNodeId) return null
  return RESPONSE_EVENTS.has(event.eventType)
    ? { source: event.node.id, target: event.parentNodeId }
    : { source: event.parentNodeId, target: event.node.id }
}

function findEdge(draft: Draft, source: string, target: string): FlowEdge | undefined {
  return draft.edges.find(e => e.source === source && e.target === target)
}

/** Insert an edge unless the same logical edge already exists. Both the
 *  explicit `edge.created` path and the inferred `parentNodeId` path land
 *  here, which is what keeps duplicates out. */
function ensureEdge(
  draft: Draft, source: string, target: string, kind: FlowEdgeKind, at: number, label?: string,
): FlowEdge | null {
  if (source === target) return null
  ensurePlaceholder(draft, source, at)
  ensurePlaceholder(draft, target, at)

  const id = deriveEdgeId(source, target, kind)
  const existing = draft.edges.find(e => e.id === id)
  if (existing) return existing

  const edge: FlowEdge = { id, source, target, kind, createdAt: at, opacity: 0, ...(label ? { label } : {}) }
  draft.edges.push(edge)
  draft.edgesChanged = true
  return edge
}

/**
 * Attach a particle to the edge that best represents this transfer.
 *
 * A response reuses the existing forward edge with `reverse: true` rather than
 * creating a backwards edge. Two reasons: the graph stays a DAG so depth
 * stays meaningful, and the user sees one channel with traffic in both
 * directions instead of two parallel lines.
 */
function spawnParticle(
  draft: Draft, source: string, target: string, kind: FlowEdgeKind, at: number, label?: string, bytes?: number,
): void {
  let edge = findEdge(draft, source, target)
  let reverse = false

  if (!edge) {
    const forward = findEdge(draft, target, source)
    if (forward) {
      edge = forward
      reverse = true
    } else {
      edge = ensureEdge(draft, source, target, kind, at, label) ?? undefined
    }
  }
  if (!edge) return

  const index = draft.edges.indexOf(edge)
  if (index !== -1) draft.edges[index] = { ...edge, lastActiveAt: at }

  const particle: FlowParticle = {
    id: `p:${edge.id}:${at.toFixed(3)}:${draft.particles.length}`,
    edgeId: edge.id,
    kind,
    progress: 0,
    reverse,
    spawnedAt: at,
    size: particleSizeForBytes(PARTICLE_BASE_SIZE[kind] ?? PARTICLE_BASE_SIZE.control, bytes),
    ...(label ? { label: label.slice(0, 40) } : {}),
  }

  draft.particles.push(particle)
  if (draft.particles.length > MAX_PARTICLES) {
    draft.particles.splice(0, draft.particles.length - MAX_PARTICLES)
  }
}

// ─── Detail accumulation ─────────────────────────────────────────────────────

function recordDetails(draft: Draft, node: FlowNode, event: FlowEvent, at: number): void {
  const md = event.metadata
  if (!md) return

  const patch: Partial<FlowNode> = {}
  if (typeof md.summary === 'string') patch.summary = md.summary
  if (typeof md.progress === 'number') patch.progress = md.progress
  if (typeof md.inputSummary === 'string') patch.inputSummary = md.inputSummary
  if (typeof md.outputSummary === 'string') patch.outputSummary = md.outputSummary
  if (typeof md.waitingOn === 'string') patch.waitingOn = md.waitingOn
  if (typeof md.maxAttempts === 'number') patch.maxAttempts = md.maxAttempts
  if (typeof md.durationMs === 'number') patch.durationMs = md.durationMs
  if (typeof md.tokens === 'number') patch.tokens = (node.tokens ?? 0) + md.tokens
  if (typeof md.cost === 'number') patch.cost = (node.cost ?? 0) + md.cost
  if (md.error) patch.error = md.error

  if (md.request != null || md.response != null || md.error) {
    patch.requests = pushCapped(node.requests, {
      at,
      ...(typeof md.request === 'string' ? { request: md.request } : {}),
      ...(typeof md.response === 'string' ? { response: md.response } : {}),
      ...(md.error ? { error: md.error.message } : {}),
      ...(typeof md.durationMs === 'number' ? { durationMs: md.durationMs } : {}),
    }, MAX_REQUESTS_PER_NODE)
  }

  if (Object.keys(patch).length > 0) patchNode(draft, node.id, patch)
}

function recordLog(draft: Draft, node: FlowNode, event: FlowEvent, at: number): void {
  const log = event.metadata?.log
  if (!log) return

  const current = draft.nodes.get(node.id) ?? node
  patchNode(draft, node.id, { logs: pushCapped(current.logs, log, MAX_LOGS_PER_NODE) })
  draft.logs = pushCapped(draft.logs, { nodeId: node.id, nodeLabel: current.label, at, log }, MAX_GLOBAL_LOGS)
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

/** Run-relative seconds for an event. Clamped at 0 so an event stamped
 *  slightly before `run.started` does not produce negative time. */
function relativeTime(event: FlowEvent, startedAtMs: number): number {
  return Math.max(0, (Date.parse(event.timestamp) - startedAtMs) / 1000)
}

export function applyFlowEvent(prev: FlowState, event: FlowEvent): FlowState {
  // Idempotent: an SSE reconnect replays recent events, and a JSONL file may
  // overlap with what is already in memory.
  if (prev.seenEventIds.has(event.eventId)) return prev

  const eventMs = Date.parse(event.timestamp)

  // Bootstrap a run from the first event we see, even if `run.started` was
  // missed (late SSE subscriber, truncated JSONL).
  let run = prev.run
  if (!run || run.runId !== event.runId) {
    run = {
      runId: event.runId,
      status: 'running',
      startedAtIso: event.timestamp,
      startedAtMs: eventMs,
    }
  }

  const at = relativeTime(event, run.startedAtMs)

  const draft: Draft = {
    nodes: new Map(prev.nodes),
    edges: prev.edges.slice(),
    particles: prev.particles.slice(),
    logs: prev.logs,
    edgesChanged: false,
  }

  const node = ensureNode(draft, event, at)
  const endpoints = resolveEndpoints(event)

  // Structural edge first. Any event naming both a node and a parent implies
  // parent → node, and creating it up front lets a response particle travel
  // backwards along that edge instead of spawning a second, reversed one.
  if (node && event.parentNodeId && event.eventType !== 'edge.created') {
    const implied = impliedEdgeKind(event)
    // A response is traffic, not structure — the channel itself is plain control.
    const structural = implied === 'response' || RESPONSE_EVENTS.has(event.eventType) ? 'control' : implied
    ensureEdge(draft, event.parentNodeId, node.id, structural, at)
  }

  switch (event.eventType) {
    case 'run.started':
      run = {
        ...run,
        status: 'running',
        startedAtIso: event.timestamp,
        startedAtMs: eventMs,
        ...(typeof event.metadata?.summary === 'string' ? { label: event.metadata.summary } : {}),
      }
      break

    case 'run.completed':
      run = { ...run, status: 'completed', endedAtMs: eventMs }
      break

    case 'run.failed':
      run = { ...run, status: 'failed', endedAtMs: eventMs, ...(event.metadata?.error ? { error: event.metadata.error } : {}) }
      break

    case 'edge.created':
      if (endpoints) {
        ensureEdge(draft, endpoints.source, endpoints.target, impliedEdgeKind(event), at, event.edge?.label)
      }
      break

    case 'data.transferred':
    case 'agent.handoff':
    case 'tool.called':
    case 'tool.returned':
    case 'memory.read':
    case 'memory.written':
      if (endpoints) {
        spawnParticle(
          draft, endpoints.source, endpoints.target, impliedEdgeKind(event), at,
          event.edge?.label ?? event.metadata?.summary,
          typeof event.metadata?.bytes === 'number' ? event.metadata.bytes : undefined,
        )
      }
      break

    default:
      // node.* and log.created move no data of their own.
      break
  }

  if (node) {
    const current = draft.nodes.get(node.id) ?? node
    recordDetails(draft, current, event, at)
    const status = impliedStatus(event)
    if (status) applyStatus(draft, draft.nodes.get(node.id) ?? current, status, at, event)
    recordLog(draft, draft.nodes.get(node.id) ?? current, event, at)
  }

  // Depth only shifts when the edge set changes.
  if (draft.edgesChanged) recomputeDepths(draft.nodes, draft.edges)

  const seenEventIds = new Set(prev.seenEventIds)
  seenEventIds.add(event.eventId)

  return {
    ...prev,
    run,
    nodes: draft.nodes,
    edges: draft.edges,
    particles: draft.particles,
    logs: draft.logs,
    eventLog: pushCapped(prev.eventLog, event, MAX_FLOW_EVENT_LOG),
    seenEventIds,
    maxTimeReached: Math.max(prev.maxTimeReached, at),
  }
}

export function applyFlowEvents(state: FlowState, events: readonly FlowEvent[]): FlowState {
  let next = state
  for (const event of events) next = applyFlowEvent(next, event)
  return next
}

// ─── Derived queries ─────────────────────────────────────────────────────────

/** Edges carrying traffic right now — the "current activity path" as opposed
 *  to the full execution graph. */
export function activeEdgeIds(state: FlowState, now: number): Set<string> {
  const ids = new Set<string>()
  for (const particle of state.particles) ids.add(particle.edgeId)
  for (const edge of state.edges) {
    if (edge.lastActiveAt != null && now - edge.lastActiveAt <= ACTIVE_EDGE_WINDOW_S) ids.add(edge.id)
  }
  return ids
}

/** Nodes the user would consider "currently executing" — drives focus-on-active. */
export function runningNodeIds(state: FlowState): string[] {
  const ids: string[] = []
  for (const [id, node] of state.nodes) {
    if (node.status === 'running' || node.status === 'waiting') ids.push(id)
  }
  return ids
}

/** Elapsed seconds for a node, preferring the producer's own measurement. */
export function nodeElapsedSeconds(node: FlowNode, now: number): number | null {
  if (node.durationMs != null) return node.durationMs / 1000
  if (node.startedAt == null) return null
  return Math.max(0, (node.endedAt ?? now) - node.startedAt)
}
