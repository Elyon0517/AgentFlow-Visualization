/**
 * Small, generic canvas/UI constants shared by the flow renderer.
 *
 * Trimmed out of the original app-wide `agent-types.ts` / `canvas-constants.ts`,
 * which mixed these in with a lot of Agent-specific config. Nothing here
 * depends on any business concept.
 */

/** A single background parallax star, drawn by `background-layer.ts`. */
export interface DepthParticle {
  x: number
  y: number
  size: number
  brightness: number
  speed: number
  depth: number
}

export const CAMERA = {
  zoomStepDown: 0.92,
  zoomStepUp: 1.08,
  minZoom: 0.2,
  maxZoom: 4,
  /** Per-frame lerp fraction toward the auto-fit target. */
  autoFitLerp: 0.06,
} as const

/** Bezier geometry shared by the tapered-beam edge renderer. */
export const BEAM = {
  curvature: 0.15,
  cp1: 0.33,
  cp2: 0.66,
  segments: 16,
} as const

/** Cached once at module load — avoids parsing location.search every frame */
export const PERF_OVERLAY_ENABLED = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('perf')

export const PERF_OVERLAY = {
  x: 8,
  y: 8,
  width: 260,
  height: 140,
  padding: 8,
  lineHeight: 18,
  font: '12px monospace',
  maxFrameSamples: 120,
  fpsWarning: 30,
  fpsCaution: 50,
  updateIntervalMs: 1000,
  bgColor: 'rgba(0, 0, 0, 0.75)',
  fpsGoodColor: '#44ff44',
  fpsCautionColor: '#ffaa00',
  fpsWarningColor: '#ff4444',
  textColor: '#cccccc',
} as const

/** Combined height of the view bar and the source bar. Full-screen panels
 *  start below it so they never sit underneath the chrome. */
export const CHROME_HEIGHT = 62
