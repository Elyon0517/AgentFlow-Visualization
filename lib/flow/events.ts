/**
 * Unified AI-workflow event protocol.
 *
 * Deliberately decoupled from any agent framework: Claude Code, Codex, a
 * trading pipeline, or a plain script all emit the same shape. Producers are
 * expected to be sloppy (extra fields, missing optionals, out-of-order
 * delivery), so everything here is validated at the boundary rather than
 * trusted — see {@link validateFlowEvent}.
 *
 * Transport-agnostic: the same JSON works over SSE, a WebSocket, or one event
 * per line in a `.jsonl` file. That is what makes live playback and historical
 * replay share a single code path.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Node categories the renderer knows how to draw. Business identity
 *  ("Heatmap API", "GEX/VEX Analysis") lives in `label`, never in this union —
 *  that is what keeps business concepts out of the canvas renderer. */
export const FLOW_NODE_TYPES = [
  'agent',
  'task',
  'tool',
  'api',
  'data_source',
  'llm',
  'memory',
  'decision',
  'orchestrator',
] as const
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number]

export const FLOW_NODE_STATUSES = [
  'idle',
  'queued',
  'running',
  'waiting',
  'success',
  'warning',
  'failed',
  'skipped',
] as const
export type FlowNodeStatus = (typeof FLOW_NODE_STATUSES)[number]

/** What is travelling along an edge. Drives particle color, size and trail. */
export const FLOW_EDGE_KINDS = [
  'request',
  'response',
  'data',
  'handoff',
  'error',
  'control',
] as const
export type FlowEdgeKind = (typeof FLOW_EDGE_KINDS)[number]

export const FLOW_EVENT_TYPES = [
  'run.started',
  'run.completed',
  'run.failed',
  'node.created',
  'node.queued',
  'node.started',
  'node.progress',
  'node.waiting',
  'node.completed',
  'node.failed',
  'edge.created',
  'data.transferred',
  'agent.handoff',
  'tool.called',
  'tool.returned',
  'memory.read',
  'memory.written',
  'decision.created',
  'log.created',
] as const
export type FlowEventType = (typeof FLOW_EVENT_TYPES)[number]

// ─── Structured log ──────────────────────────────────────────────────────────

/**
 * Explainable execution log.
 *
 * This is NOT model chain-of-thought and must never be populated from hidden
 * reasoning tokens. It is a deliberate, producer-authored account of what a
 * step did and why — safe to display, safe to persist, safe to share.
 */
export interface StructuredLog {
  /** Coarse stage name, e.g. 'risk_analysis'. Groups entries in the Logs view. */
  phase: string
  /** One-line human summary of what this step is doing. */
  summary: string
  /** Why the step was taken. */
  reason?: string
  /** The concrete operation performed, e.g. 'fetch_broker_positions'. */
  action?: string
  /** What came back / was measured. */
  observation?: string
  /** Outcome of the step. */
  result?: string
  /** 0..1. Values outside the range are clamped by the reducer. */
  confidence?: number
  /** What the producer intends to do next. */
  next_step?: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** ISO 8601. Defaults to the carrying event's timestamp when absent. */
  timestamp?: string
}

// ─── Event payload ───────────────────────────────────────────────────────────

export interface FlowNodeRef {
  id: string
  type: FlowNodeType
  label: string
  /** Optional swimlane / subsystem grouping, e.g. 'market-data'. */
  group?: string
  /** Overrides the registry glyph for this node only. */
  icon?: string
}

export interface FlowEdgeRef {
  /** Omit to let the reducer derive a deterministic id from source+target+kind. */
  id?: string
  source: string
  target: string
  kind?: FlowEdgeKind
  label?: string
}

export interface FlowErrorInfo {
  message: string
  code?: string
  retryable?: boolean
  stack?: string
}

export interface FlowEventMetadata {
  /** Short action summary rendered directly on the node. */
  summary?: string
  /** Explicit status override. Most events imply their own status. */
  status?: FlowNodeStatus
  /** 0..1 completion fraction. Non-numeric values are ignored. */
  progress?: number
  /** What a `waiting` node is blocked on, e.g. 'broker-api rate limit'. */
  waitingOn?: string

  inputSummary?: string
  outputSummary?: string
  /** Raw payloads. Kept for the detail popup; never rendered on canvas. */
  input?: unknown
  output?: unknown
  request?: string
  response?: string

  error?: FlowErrorInfo
  /** 1-based retry counter. Drives the `↻n` badge. */
  attempt?: number
  maxAttempts?: number

  durationMs?: number
  bytes?: number
  tokens?: number
  cost?: number

  /** Carried by `log.created`. */
  log?: StructuredLog

  [key: string]: unknown
}

export interface FlowEvent {
  eventId: string
  runId: string
  /** ISO 8601 absolute time. The reducer converts to run-relative seconds. */
  timestamp: string
  eventType: FlowEventType
  /** Monotonic per-run sequence number. When present, the SSE client uses it
   *  to reorder events that arrive out of order after a reconnect. */
  seq?: number
  node?: FlowNodeRef
  /** Implies an edge parent → node when no explicit `edge` is given. */
  parentNodeId?: string
  edge?: FlowEdgeRef
  metadata?: FlowEventMetadata
}

// ─── Event → status mapping ──────────────────────────────────────────────────

/**
 * Status implied by an event type, when `metadata.status` is absent.
 * `null` means "this event does not change node status" (e.g. log.created).
 */
const IMPLIED_STATUS: Partial<Record<FlowEventType, FlowNodeStatus | null>> = {
  'node.created': 'idle',
  'node.queued': 'queued',
  'node.started': 'running',
  'node.progress': 'running',
  'node.waiting': 'waiting',
  'node.completed': 'success',
  'node.failed': 'failed',
  'tool.called': 'running',
  'tool.returned': 'success',
  'memory.read': 'running',
  'memory.written': 'running',
  'decision.created': 'success',
}

export function impliedStatus(event: FlowEvent): FlowNodeStatus | null {
  const explicit = event.metadata?.status
  if (explicit && (FLOW_NODE_STATUSES as readonly string[]).includes(explicit)) {
    return explicit
  }
  return IMPLIED_STATUS[event.eventType] ?? null
}

/** Default edge kind for events that create an edge without naming one. */
const IMPLIED_EDGE_KIND: Partial<Record<FlowEventType, FlowEdgeKind>> = {
  'data.transferred': 'data',
  'agent.handoff': 'handoff',
  'tool.called': 'request',
  'tool.returned': 'response',
  'memory.read': 'data',
  'memory.written': 'data',
  'node.failed': 'error',
}

export function impliedEdgeKind(event: FlowEvent): FlowEdgeKind {
  return event.edge?.kind ?? IMPLIED_EDGE_KIND[event.eventType] ?? 'control'
}

/** Deterministic edge id so the same logical edge is never created twice,
 *  whether it came from an explicit `edge.created` or from `parentNodeId`. */
export function deriveEdgeId(source: string, target: string, kind: FlowEdgeKind): string {
  return `e:${source}->${target}:${kind}`
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true; event: FlowEvent }
  | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
}

/**
 * Validate an untrusted object into a {@link FlowEvent}.
 *
 * Rejects rather than coerces on anything structural (ids, event type, node
 * type). Tolerates and drops anything cosmetic — a bad `progress` or an
 * unknown metadata key must never take down the visualizer mid-run.
 */
export function validateFlowEvent(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: 'event is not an object' }

  if (!isNonEmptyString(raw.eventId)) return { ok: false, reason: 'missing eventId' }
  if (!isNonEmptyString(raw.runId)) return { ok: false, reason: 'missing runId' }
  if (!isNonEmptyString(raw.timestamp)) return { ok: false, reason: 'missing timestamp' }
  if (Number.isNaN(Date.parse(raw.timestamp))) {
    return { ok: false, reason: `unparseable timestamp: ${raw.timestamp}` }
  }
  if (!oneOf(raw.eventType, FLOW_EVENT_TYPES)) {
    return { ok: false, reason: `unknown eventType: ${String(raw.eventType)}` }
  }

  const event: FlowEvent = {
    eventId: raw.eventId,
    runId: raw.runId,
    timestamp: raw.timestamp,
    eventType: raw.eventType,
  }

  if (typeof raw.seq === 'number' && Number.isFinite(raw.seq)) event.seq = raw.seq

  if (raw.node !== undefined) {
    if (!isRecord(raw.node)) return { ok: false, reason: 'node is not an object' }
    if (!isNonEmptyString(raw.node.id)) return { ok: false, reason: 'node.id missing' }
    if (!oneOf(raw.node.type, FLOW_NODE_TYPES)) {
      return { ok: false, reason: `unknown node.type: ${String(raw.node.type)}` }
    }
    event.node = {
      id: raw.node.id,
      type: raw.node.type,
      label: isNonEmptyString(raw.node.label) ? raw.node.label : raw.node.id,
      ...(isNonEmptyString(raw.node.group) ? { group: raw.node.group } : {}),
      ...(isNonEmptyString(raw.node.icon) ? { icon: raw.node.icon } : {}),
    }
  }

  if (isNonEmptyString(raw.parentNodeId)) event.parentNodeId = raw.parentNodeId

  if (raw.edge !== undefined) {
    if (!isRecord(raw.edge)) return { ok: false, reason: 'edge is not an object' }
    if (!isNonEmptyString(raw.edge.source)) return { ok: false, reason: 'edge.source missing' }
    if (!isNonEmptyString(raw.edge.target)) return { ok: false, reason: 'edge.target missing' }
    event.edge = {
      source: raw.edge.source,
      target: raw.edge.target,
      ...(isNonEmptyString(raw.edge.id) ? { id: raw.edge.id } : {}),
      ...(oneOf(raw.edge.kind, FLOW_EDGE_KINDS) ? { kind: raw.edge.kind } : {}),
      ...(isNonEmptyString(raw.edge.label) ? { label: raw.edge.label } : {}),
    }
  }

  if (raw.metadata !== undefined) {
    if (!isRecord(raw.metadata)) return { ok: false, reason: 'metadata is not an object' }
    event.metadata = sanitizeMetadata(raw.metadata)
  }

  return { ok: true, event }
}

/** Drop malformed known fields; pass unknown keys through untouched so
 *  producers can carry domain data we do not model yet. */
function sanitizeMetadata(raw: Record<string, unknown>): FlowEventMetadata {
  const md: FlowEventMetadata = { ...raw }

  if (!oneOf(md.status, FLOW_NODE_STATUSES)) delete md.status
  if (typeof md.progress !== 'number' || !Number.isFinite(md.progress)) delete md.progress
  else md.progress = Math.min(1, Math.max(0, md.progress))

  for (const key of ['summary', 'waitingOn', 'inputSummary', 'outputSummary', 'request', 'response'] as const) {
    if (md[key] !== undefined && typeof md[key] !== 'string') delete md[key]
  }
  for (const key of ['attempt', 'maxAttempts', 'durationMs', 'bytes', 'tokens', 'cost'] as const) {
    const v = md[key]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) delete md[key]
  }

  if (md.error !== undefined) {
    if (isRecord(md.error) && isNonEmptyString(md.error.message)) {
      md.error = {
        message: md.error.message,
        ...(isNonEmptyString(md.error.code) ? { code: md.error.code } : {}),
        ...(typeof md.error.retryable === 'boolean' ? { retryable: md.error.retryable } : {}),
        ...(isNonEmptyString(md.error.stack) ? { stack: md.error.stack } : {}),
      }
    } else {
      delete md.error
    }
  }

  if (md.log !== undefined) {
    const log = sanitizeLog(md.log)
    if (log) md.log = log
    else delete md.log
  }

  return md
}

function sanitizeLog(raw: unknown): StructuredLog | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.phase) || !isNonEmptyString(raw.summary)) return null

  const log: StructuredLog = { phase: raw.phase, summary: raw.summary }
  for (const key of ['reason', 'action', 'observation', 'result', 'next_step', 'timestamp'] as const) {
    if (isNonEmptyString(raw[key])) log[key] = raw[key] as string
  }
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
    log.confidence = Math.min(1, Math.max(0, raw.confidence))
  }
  if (oneOf(raw.level, ['debug', 'info', 'warn', 'error'] as const)) log.level = raw.level
  return log
}

// ─── JSONL codec ─────────────────────────────────────────────────────────────

/** Serialize one event to a single JSONL line (no trailing newline). */
export function serializeFlowEvent(event: FlowEvent): string {
  return JSON.stringify(event)
}

export function serializeFlowJsonl(events: readonly FlowEvent[]): string {
  return events.map(serializeFlowEvent).join('\n') + (events.length > 0 ? '\n' : '')
}

export interface JsonlParseResult {
  events: FlowEvent[]
  /** 1-based line number + why it was rejected. Surfaced in the UI so a bad
   *  producer is debuggable instead of silently dropping half a run. */
  errors: Array<{ line: number; reason: string }>
}

export function parseFlowJsonl(text: string): JsonlParseResult {
  const events: FlowEvent[] = []
  const errors: JsonlParseResult['errors'] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue

    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      errors.push({ line: i + 1, reason: 'invalid JSON' })
      continue
    }

    const result = validateFlowEvent(raw)
    if (result.ok) events.push(result.event)
    else errors.push({ line: i + 1, reason: result.reason })
  }

  return { events, errors }
}

/** Order events for replay: by `seq` when every event has one, else by
 *  timestamp. Ties keep their original relative order (stable sort). */
export function sortFlowEvents(events: readonly FlowEvent[]): FlowEvent[] {
  const allHaveSeq = events.every(e => typeof e.seq === 'number')
  const indexed = events.map((event, index) => ({ event, index }))

  indexed.sort((a, b) => {
    const key = allHaveSeq
      ? a.event.seq! - b.event.seq!
      : Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp)
    return key !== 0 ? key : a.index - b.index
  })

  return indexed.map(x => x.event)
}
