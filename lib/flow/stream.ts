/**
 * Live event stream client.
 *
 * Transport-agnostic by construction: the producer only has to deliver
 * `FlowEvent` JSON. Server-Sent Events is the default because the browser
 * reconnects on its own and it rides plain HTTP through proxies and CDNs
 * without an upgrade handshake. A WebSocket transport can be added here
 * without touching anything downstream — see {@link connectFlowStream}.
 */

import {
  parseFlowJsonl,
  serializeFlowJsonl,
  sortFlowEvents,
  validateFlowEvent,
  type FlowEvent,
} from './events'

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StreamHandle {
  close: () => void
}

export interface StreamOptions {
  url: string
  onEvents: (events: FlowEvent[]) => void
  onStatus: (status: StreamStatus, detail?: string) => void
  /** Reports events the producer sent that failed validation. */
  onRejected?: (count: number, reason: string) => void
}

/** A payload may carry one event or a batch; both are accepted. */
function extractEvents(
  raw: unknown,
  reject: (reason: string) => void,
): FlowEvent[] {
  const candidates = Array.isArray(raw) ? raw : [raw]
  const events: FlowEvent[] = []

  for (const candidate of candidates) {
    const result = validateFlowEvent(candidate)
    if (result.ok) events.push(result.event)
    else reject(result.reason)
  }
  return events
}

/**
 * Ordering note.
 *
 * A single SSE connection preserves order, so each payload is simply sorted by
 * `seq` and handed straight on. No time-based reorder buffer: it would add
 * latency to every live update to compensate for a case that only arises on
 * reconnect — and the reducer already tolerates that, being idempotent on
 * `eventId` and creating placeholders for nodes it has not seen yet.
 */
export function connectFlowStream({ url, onEvents, onStatus, onRejected }: StreamOptions): StreamHandle {
  let source: EventSource | null = null
  let closedByCaller = false
  let hasConnected = false

  // Rate-limited so a misbehaving producer cannot flood the console.
  let rejectedSinceReport = 0
  let lastRejectReason = ''
  let lastReportMs = 0

  const reportRejections = () => {
    if (rejectedSinceReport === 0) return
    const now = Date.now()
    if (now - lastReportMs < 2000) return
    lastReportMs = now
    onRejected?.(rejectedSinceReport, lastRejectReason)
    rejectedSinceReport = 0
  }

  onStatus('connecting')

  try {
    source = new EventSource(url)
  } catch (error) {
    onStatus('closed', error instanceof Error ? error.message : 'invalid stream URL')
    return { close: () => {} }
  }

  source.onopen = () => {
    hasConnected = true
    onStatus('open')
  }

  source.onmessage = (message) => {
    let raw: unknown
    try {
      raw = JSON.parse(message.data)
    } catch {
      rejectedSinceReport++
      lastRejectReason = 'invalid JSON'
      reportRejections()
      return
    }

    const events = extractEvents(raw, reason => {
      rejectedSinceReport++
      lastRejectReason = reason
    })
    reportRejections()

    if (events.length > 0) onEvents(sortFlowEvents(events))
  }

  source.onerror = () => {
    if (closedByCaller) return
    // EventSource retries by itself; CLOSED means it gave up for good
    // (usually a 4xx, a CORS rejection, or a bad URL).
    if (source?.readyState === EventSource.CLOSED) {
      onStatus('closed', hasConnected ? 'stream ended' : 'could not connect')
    } else {
      onStatus('reconnecting')
    }
  }

  return {
    close: () => {
      closedByCaller = true
      source?.close()
      onStatus('idle')
    },
  }
}

// ─── File loading ────────────────────────────────────────────────────────────

export interface LoadedRun {
  events: FlowEvent[]
  /** Malformed lines, reported so a bad producer is debuggable. */
  errors: Array<{ line: number; reason: string }>
}

/** Read a `.jsonl` file the user picked or dropped onto the page. */
export async function loadRunFromFile(file: File): Promise<LoadedRun> {
  const { events, errors } = parseFlowJsonl(await file.text())
  return { events: sortFlowEvents(events), errors }
}

/** Fetch a `.jsonl` run over HTTP — used by the `?replay=<url>` parameter. */
export async function loadRunFromUrl(url: string): Promise<LoadedRun> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const { events, errors } = parseFlowJsonl(await response.text())
  return { events: sortFlowEvents(events), errors }
}

/** Trigger a download of the current run as JSONL. */
export function downloadRunAsJsonl(events: readonly FlowEvent[], runId?: string): void {
  const blob = new Blob([serializeFlowJsonl(events)], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${runId ?? 'run'}.jsonl`
  anchor.click()
  URL.revokeObjectURL(url)
}
