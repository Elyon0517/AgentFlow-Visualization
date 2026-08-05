/**
 * Per-frame animation advance.
 *
 * Every value here is driven by elapsed time and by state the reducer already
 * produced — there are no independent timers and no randomness, so what you
 * see during a replay is what happened during the live run.
 *
 * Everything mutates in place. `node.anim` is shared by reference across the
 * reducer's node copies precisely so this loop can run without allocating.
 */

import type { FlowNode, FlowState } from './graph'

export const FLOW_ANIM = {
  /** Opacity units per second while a node fades in. */
  fadeIn: 3.5,
  /** Scale units per second while a node grows to full size. */
  scaleIn: 4,
  /** Edge opacity units per second. */
  edgeFadeIn: 2.5,
  /** Fraction of an edge traversed per second. ~1.1s end to end reads clearly
   *  without feeling sluggish when several fire at once. */
  particleSpeed: 0.9,
  /** Focus dim/undim lerp per second. Slow enough to read as a transition. */
  focusLerp: 6,
  /** Opacity multiplier for nodes outside the focused path. Dimmed, never
   *  hidden — the rest of the graph must stay legible. */
  focusDim: 0.28,
  /** Seconds of frame time to process at most, so a backgrounded tab does not
   *  fast-forward the whole animation on return. */
  maxDelta: 0.1,
} as const

/** Advance a single node's visual state. Exported for unit testing. */
export function advanceNodeAnim(node: FlowNode, deltaTime: number, focusTarget: number): void {
  const anim = node.anim

  anim.spawnAge += deltaTime
  anim.statusAge += deltaTime

  if (anim.opacity < 1) anim.opacity = Math.min(1, anim.opacity + deltaTime * FLOW_ANIM.fadeIn)
  if (anim.scale < 1) anim.scale = Math.min(1, anim.scale + deltaTime * FLOW_ANIM.scaleIn)

  if (anim.oneShot) {
    anim.oneShot.age += deltaTime
    // One-shot means one shot: cleared on completion, never looped. A failed
    // node keeps its failed *status* styling; only the flash is transient.
    if (anim.oneShot.age >= anim.oneShot.duration) anim.oneShot = null
  }

  if (anim.focus !== focusTarget) {
    const step = deltaTime * FLOW_ANIM.focusLerp
    const delta = focusTarget - anim.focus
    anim.focus = Math.abs(delta) <= step ? focusTarget : anim.focus + Math.sign(delta) * step
  }
}

export interface AdvanceOptions {
  /** Nodes on the focused path. `null` means no focus is active and every
   *  node renders at full brightness. */
  focusSet: Set<string> | null
  /** Playback rate. Scales particle travel so a sped-up replay stays coherent. */
  speed: number
}

/**
 * Advance every animated value by one frame.
 *
 * Returns true when a particle finished this frame, which is the only change
 * the caller may need to react to (edges lose their "active" glow).
 */
export function advanceFlowAnimations(state: FlowState, rawDelta: number, options: AdvanceOptions): boolean {
  const deltaTime = Math.min(rawDelta, FLOW_ANIM.maxDelta)
  const { focusSet, speed } = options

  for (const node of state.nodes.values()) {
    const focusTarget = focusSet == null || focusSet.has(node.id) ? 1 : FLOW_ANIM.focusDim
    advanceNodeAnim(node, deltaTime, focusTarget)
  }

  for (const edge of state.edges) {
    if (edge.opacity < 1) edge.opacity = Math.min(1, edge.opacity + deltaTime * FLOW_ANIM.edgeFadeIn)
  }

  // Compact in place rather than allocating a filtered array every frame.
  const particles = state.particles
  const step = deltaTime * FLOW_ANIM.particleSpeed * speed
  let write = 0
  let completed = false

  for (let read = 0; read < particles.length; read++) {
    const particle = particles[read]
    particle.progress += step
    if (particle.progress >= 1) { completed = true; continue }
    if (write !== read) particles[write] = particle
    write++
  }
  particles.length = write

  return completed
}

// ─── Derived animation values ────────────────────────────────────────────────
// Pure functions of (state, time). The renderer calls these; keeping them here
// means the same numbers can be asserted in tests without a canvas.

/** Gentle size oscillation for a node, by status.
 *
 * Running breathes slightly; waiting breathes less. Everything else is still —
 * motion is what distinguishes an executing node from a finished one, so idle
 * states must not move at all. */
export function breatheScale(node: FlowNode, time: number): number {
  switch (node.status) {
    case 'running':
      return 1 + Math.sin(time * 0.9 + node.anim.spawnAge) * 0.025
    case 'waiting':
      return 1 + Math.sin(time * 0.6 + node.anim.spawnAge) * 0.015
    default:
      return 1
  }
}

/** Border alpha by status. Success is deliberately dimmer than running, and
 *  is further distinguished by having no motion at all. */
export function borderAlpha(node: FlowNode, time: number): number {
  switch (node.status) {
    case 'running': return 0.9
    case 'waiting': return 0.35 + (Math.sin(time * 0.6) * 0.5 + 0.5) * 0.2
    case 'success': return 0.55
    case 'warning': return 0.75
    case 'failed': return 0.85
    case 'queued': return 0.45
    case 'skipped': return 0.25
    default: return 0.35
  }
}

/** Outer glow strength. Running and failed nodes bloom; finished ones recede. */
export function glowAlpha(node: FlowNode, isSelected: boolean, isHovered: boolean): number {
  if (isSelected || isHovered) return 0.38
  switch (node.status) {
    case 'running': return 0.28
    case 'waiting': return 0.2
    case 'failed': return 0.24
    case 'warning': return 0.16
    case 'success': return 0.08
    default: return 0.05
  }
}

/** Horizontal offset for the failure shake. A damped oscillation played once,
 *  never looped — an error should register, not nag. */
export function failureShakeOffset(node: FlowNode): number {
  const shot = node.anim.oneShot
  if (!shot || shot.kind !== 'failed') return 0
  const progress = shot.age / shot.duration
  return Math.sin(shot.age * 42) * 3 * (1 - progress)
}

/** Expanding-ring progress for a completion flash, or null when not playing. */
export function completionPulse(node: FlowNode): { progress: number; kind: 'success' | 'warning' | 'handoff' | 'spawn' } | null {
  const shot = node.anim.oneShot
  if (!shot || shot.kind === 'failed') return null
  return { progress: Math.min(1, shot.age / shot.duration), kind: shot.kind }
}
