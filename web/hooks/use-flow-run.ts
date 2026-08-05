'use client'

/**
 * Drives a workflow run.
 *
 * Follows the frameRef discipline the legacy simulation established and that
 * the acceptance criteria depend on: the animation loop writes to a ref every
 * frame, and React state is committed only when the *structure* changed — new
 * events, playback controls, seek. Sixty frames a second do not produce sixty
 * renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { advanceFlowAnimations, FLOW_ANIM } from '@/lib/flow/animate'
import type { FlowEvent } from '@/lib/flow/events'
import { collectConnectedPath, createFlowState, type FlowState } from '@/lib/flow/graph'
import { FlowLayout } from '@/lib/flow/layout'
import { getNodeSpec } from '@/lib/flow/node-registry'
import { applyFlowEvent, applyFlowEvents } from '@/lib/flow/reducer'

/** Commit to React at most this often. The canvas is unaffected — it reads
 *  the ref directly. */
const UI_THROTTLE_MS = 200
/** 60fps cap, with a millisecond of slack for timer jitter. */
const MIN_FRAME_MS = 1000 / 60 - 1

export interface UseFlowRunOptions {
  /** Pre-recorded events played against the clock. Used for the demo and for
   *  JSONL replay. */
  scenario?: readonly FlowEvent[]
  /** Live events applied the moment they arrive, ignoring the clock. */
  liveEvents?: readonly FlowEvent[]
  onLiveEventsConsumed?: () => void
  /** Node id whose upstream/downstream path should stay lit. */
  focusNodeId?: string | null
  autoPlay?: boolean
}

export function useFlowRun(options: UseFlowRunOptions = {}) {
  const { scenario, liveEvents, onLiveEventsConsumed, focusNodeId = null, autoPlay = true } = options

  const [state, setState] = useState<FlowState>(() => createFlowState({ isPlaying: autoPlay }))
  const frameRef = useRef<FlowState>(createFlowState({ isPlaying: autoPlay }))

  const layoutRef = useRef<FlowLayout | null>(null)
  const lastFrameMsRef = useRef(0)
  const lastCommitMsRef = useRef(0)
  const scenarioIndexRef = useRef(0)

  /** Focus path, recomputed only when the selection or the edge set changes —
   *  never per frame. */
  const focusSetRef = useRef<Set<string> | null>(null)
  const focusInputRef = useRef<{ nodeId: string | null; edges: FlowState['edges'] | null }>({ nodeId: null, edges: null })

  const commit = useCallback((next: FlowState) => {
    frameRef.current = next
    setState(next)
  }, [])

  // ─── Layout ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const layout = new FlowLayout()
    layoutRef.current = layout
    return () => { layout.dispose(); layoutRef.current = null }
  }, [])

  const syncLayout = useCallback((next: FlowState) => {
    layoutRef.current?.sync(
      next.nodes,
      next.edges,
      node => getNodeSpec(node.type).radius,
      node => getNodeSpec(node.type).forceParticipant,
    )
  }, [])

  // ─── Scenario reset ────────────────────────────────────────────────────────

  useEffect(() => {
    scenarioIndexRef.current = 0
    layoutRef.current?.dispose()
    layoutRef.current = new FlowLayout()
    commit(createFlowState({ isPlaying: autoPlay }))
    // Only re-run when the scenario itself is swapped out.
  }, [scenario, autoPlay, commit])

  // ─── Frame loop ────────────────────────────────────────────────────────────

  const frameRef_ = useRef<(ts: number) => void>(() => {})

  /** One frame of work. Scheduling is owned entirely by the effect below —
   *  this function must never queue the next frame itself, or cancelling the
   *  loop becomes a race. */
  const frame = useCallback((timestamp: number) => {
    const elapsedMs = timestamp - lastFrameMsRef.current
    if (lastFrameMsRef.current && elapsedMs < MIN_FRAME_MS) return
    if (!lastFrameMsRef.current) lastFrameMsRef.current = timestamp
    const deltaTime = Math.min((timestamp - lastFrameMsRef.current) / 1000, 0.1)
    lastFrameMsRef.current = timestamp

    let next = frameRef.current
    let structureChanged = false

    // Live events are applied immediately and pull the clock forward with
    // them, so a node never renders as "not started yet" while its start
    // event has already arrived.
    if (liveEvents && liveEvents.length > 0) {
      const batch = liveEvents.slice()
      onLiveEventsConsumed?.()
      next = applyFlowEvents(next, batch)
      next = { ...next, currentTime: next.maxTimeReached }
      structureChanged = true
    }

    if (next.isPlaying) {
      const newTime = next.currentTime + deltaTime * next.speed

      if (scenario) {
        while (
          scenarioIndexRef.current < scenario.length &&
          relativeTimeOf(scenario[scenarioIndexRef.current], scenario[0]) <= newTime
        ) {
          next = applyFlowEvent(next, scenario[scenarioIndexRef.current])
          scenarioIndexRef.current++
          structureChanged = true
        }
      }

      next = {
        ...next,
        currentTime: newTime,
        maxTimeReached: Math.max(next.maxTimeReached, newTime),
      }
    }

    if (structureChanged) syncLayout(next)

    // Focus path: recompute only when the inputs actually changed.
    const focusInput = focusInputRef.current
    if (focusInput.nodeId !== focusNodeId || focusInput.edges !== next.edges) {
      focusSetRef.current = focusNodeId ? collectConnectedPath(focusNodeId, next.edges) : null
      focusInputRef.current = { nodeId: focusNodeId, edges: next.edges }
    }

    advanceFlowAnimations(next, deltaTime, { focusSet: focusSetRef.current, speed: next.speed })
    layoutRef.current?.tick(deltaTime)

    frameRef.current = next

    if (structureChanged && timestamp - lastCommitMsRef.current >= UI_THROTTLE_MS) {
      lastCommitMsRef.current = timestamp
      setState(next)
    }
  }, [scenario, liveEvents, onLiveEventsConsumed, focusNodeId, syncLayout])

  frameRef_.current = frame

  // Single owner of the animation loop. `active` plus a locally captured
  // handle means cleanup can only ever cancel the frame this effect queued —
  // under StrictMode's mount/unmount/mount the previous pattern cancelled the
  // *live* handle and the loop never started.
  useEffect(() => {
    let active = true
    let handle = 0

    const loop = (timestamp: number) => {
      if (!active) return
      frameRef_.current(timestamp)
      handle = requestAnimationFrame(loop)
    }

    lastFrameMsRef.current = 0
    handle = requestAnimationFrame(loop)

    return () => { active = false; cancelAnimationFrame(handle) }
  }, [])

  // ─── Controls ──────────────────────────────────────────────────────────────

  const play = useCallback(() => commit({ ...frameRef.current, isPlaying: true }), [commit])
  const pause = useCallback(() => commit({ ...frameRef.current, isPlaying: false }), [commit])
  const setSpeed = useCallback((speed: number) => commit({ ...frameRef.current, speed }), [commit])

  /**
   * Jump to a point in time by replaying from the start.
   *
   * Replay rather than interpolation is what makes seeking exact: the same
   * events through the same reducer produce the same state, so scrubbing
   * backwards and forwards is lossless.
   */
  const seekTo = useCallback((targetTime: number) => {
    const previous = frameRef.current
    const events = scenario ?? previous.eventLog
    if (events.length === 0) return

    let replayed = createFlowState({ speed: previous.speed, isPlaying: false })
    let index = 0
    while (index < events.length && relativeTimeOf(events[index], events[0]) <= targetTime) {
      replayed = applyFlowEvent(replayed, events[index])
      index++
    }

    scenarioIndexRef.current = index
    replayed = {
      ...replayed,
      currentTime: targetTime,
      maxTimeReached: Math.max(previous.maxTimeReached, targetTime),
      // Reconstruct exactly the transfers that were still in flight at the
      // target. Derived from each particle's spawn time, so scrubbing to a
      // moment shows the same data movement the live run showed.
      particles: replayed.particles
        .map(p => ({ ...p, progress: (targetTime - p.spawnedAt) * FLOW_ANIM.particleSpeed }))
        .filter(p => p.progress >= 0 && p.progress < 1),
    }

    // Everything already visible at the seek target should be *there*, not
    // fading in, so spawn animations do not replay en masse after a scrub.
    for (const node of replayed.nodes.values()) {
      node.anim.opacity = 1
      node.anim.scale = 1
      node.anim.oneShot = null
    }
    for (const edge of replayed.edges) edge.opacity = 1

    layoutRef.current?.dispose()
    layoutRef.current = new FlowLayout()
    syncLayout(replayed)
    // The graph at the seek target is fully determined, so it should look
    // settled the instant you land there rather than drifting into place.
    layoutRef.current.settle()
    commit(replayed)
  }, [scenario, syncLayout, commit])

  const restart = useCallback(() => {
    scenarioIndexRef.current = 0
    layoutRef.current?.dispose()
    layoutRef.current = new FlowLayout()
    commit(createFlowState({ isPlaying: true, speed: frameRef.current.speed }))
  }, [commit])

  /** Ingest events from outside the hook — used by the SSE and JSONL paths. */
  const ingest = useCallback((events: readonly FlowEvent[]) => {
    const next = applyFlowEvents(frameRef.current, events)
    syncLayout(next)
    commit({ ...next, currentTime: next.maxTimeReached })
  }, [syncLayout, commit])

  /**
   * Full length of the timeline.
   *
   * For a known scenario this is the whole recording, not just how far
   * playback has reached — otherwise the scrubber could only ever seek
   * backwards, which makes replay useless. A live run has no known end, so it
   * falls back to the furthest point observed.
   */
  const duration = scenario && scenario.length > 0
    ? relativeTimeOf(scenario[scenario.length - 1], scenario[0])
    : state.maxTimeReached

  return {
    /** Read every frame by the canvas; never use this to render React. */
    frameRef,
    layoutRef,
    focusSetRef,
    duration,
    // Structural state for React consumers.
    run: state.run,
    nodes: state.nodes,
    edges: state.edges,
    logs: state.logs,
    eventLog: state.eventLog,
    currentTime: state.currentTime,
    maxTimeReached: state.maxTimeReached,
    isPlaying: state.isPlaying,
    speed: state.speed,
    play, pause, setSpeed, seekTo, restart, ingest,
  }
}

/** Seconds between an event and the run's first event. */
function relativeTimeOf(event: FlowEvent, first: FlowEvent): number {
  return Math.max(0, (Date.parse(event.timestamp) - Date.parse(first.timestamp)) / 1000)
}
