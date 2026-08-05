import { BEAM } from '@/lib/canvas-config'
import { alphaHex } from '@/lib/utils'

export function bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number) {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

/** Compute bezier control points for an edge between two positions */
export function computeControlPoints(fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX, dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return null
  const curvature = dist * BEAM.curvature
  const perpX = -dy / dist * curvature, perpY = dx / dist * curvature
  return {
    cp1x: fromX + dx * BEAM.cp1 + perpX, cp1y: fromY + dy * BEAM.cp1 + perpY,
    cp2x: fromX + dx * BEAM.cp2 + perpX, cp2y: fromY + dy * BEAM.cp2 + perpY,
    dist, dx, dy,
  }
}

/** Compute bezier position and perpendicular normal at parameter t */
function bezierNormalAt(
  t: number,
  fromX: number, fromY: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  toX: number, toY: number,
  halfW: number,
) {
  const x = bezierPoint(t, fromX, cp1x, cp2x, toX)
  const y = bezierPoint(t, fromY, cp1y, cp2y, toY)
  const dt = 0.001
  const t0 = Math.max(0, t - dt)
  const t1 = Math.min(1, t + dt)
  const tx = bezierPoint(t1, fromX, cp1x, cp2x, toX) - bezierPoint(t0, fromX, cp1x, cp2x, toX)
  const ty = bezierPoint(t1, fromY, cp1y, cp2y, toY) - bezierPoint(t0, fromY, cp1y, cp2y, toY)
  const len = Math.sqrt(tx * tx + ty * ty) || 1
  return { x, y, nx: (-ty / len) * halfW, ny: (tx / len) * halfW }
}

export function drawTaperedBezier(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  toX: number, toY: number,
  startWidth: number, endWidth: number,
  color: string, alpha: number,
) {
  const steps = BEAM.segments

  // Build outline points along both sides of the tapered curve
  // then fill as a single polygon (1 draw call instead of N strokes)
  ctx.beginPath()

  // Forward pass: left side
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const halfW = (startWidth + (endWidth - startWidth) * t) / 2
    const p = bezierNormalAt(t, fromX, fromY, cp1x, cp1y, cp2x, cp2y, toX, toY, halfW)
    if (i === 0) ctx.moveTo(p.x + p.nx, p.y + p.ny)
    else ctx.lineTo(p.x + p.nx, p.y + p.ny)
  }

  // Reverse pass: right side
  for (let i = steps; i >= 0; i--) {
    const t = i / steps
    const halfW = (startWidth + (endWidth - startWidth) * t) / 2
    const p = bezierNormalAt(t, fromX, fromY, cp1x, cp1y, cp2x, cp2y, toX, toY, halfW)
    ctx.lineTo(p.x - p.nx, p.y - p.ny)
  }

  ctx.closePath()
  ctx.fillStyle = color + alphaHex(alpha)
  ctx.fill()
}
