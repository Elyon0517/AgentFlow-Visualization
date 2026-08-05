'use client'

/**
 * React binding for the live event stream.
 *
 * Incoming events are queued in a ref and drained by the frame loop, matching
 * how `useFlowRun` already consumes `liveEvents` — a burst of a hundred events
 * costs one render, not a hundred.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FlowEvent } from '@/lib/flow/events'
import { connectFlowStream, type StreamHandle, type StreamStatus } from '@/lib/flow/stream'

export interface UseFlowStreamResult {
  /** Events waiting to be applied. Drained via `consume`. */
  pending: readonly FlowEvent[]
  consume: () => void
  status: StreamStatus
  /** Human-readable reason for the current status, when there is one. */
  detail?: string
  /** Count of events the producer sent that failed validation. */
  rejected: number
  /** Events accepted since the stream opened — a simple liveness signal. */
  received: number
}

export function useFlowStream(url: string | null): UseFlowStreamResult {
  const pendingRef = useRef<FlowEvent[]>([])
  const [, bumpVersion] = useState(0)
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [detail, setDetail] = useState<string | undefined>(undefined)
  const [rejected, setRejected] = useState(0)
  const [received, setReceived] = useState(0)

  useEffect(() => {
    if (!url) {
      setStatus('idle')
      setDetail(undefined)
      return
    }

    // A fresh connection starts a fresh tally; stale counts from a previous
    // endpoint would misrepresent this one's health.
    setRejected(0)
    setReceived(0)
    pendingRef.current.length = 0

    let handle: StreamHandle | null = null
    handle = connectFlowStream({
      url,
      onEvents: events => {
        pendingRef.current.push(...events)
        setReceived(n => n + events.length)
        bumpVersion(v => v + 1)
      },
      onStatus: (next, why) => {
        setStatus(next)
        setDetail(why)
      },
      onRejected: (count, reason) => {
        setRejected(n => n + count)
        console.warn(`[flow-stream] dropped ${count} invalid event(s): ${reason}`)
      },
    })

    return () => handle?.close()
  }, [url])

  // Cleared in place so a stale closure inside the animation frame sees the
  // emptied queue too, rather than replaying the batch on the next tick.
  const consume = useCallback(() => {
    pendingRef.current.length = 0
  }, [])

  return { pending: pendingRef.current, consume, status, detail, rejected, received }
}
