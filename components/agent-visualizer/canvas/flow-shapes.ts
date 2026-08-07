/**
 * Node outline primitives.
 *
 * Each function traces a path centred on (x, y) and leaves it open for the
 * caller to fill or stroke, matching the convention `drawHexagon` in
 * draw-misc.ts already uses.
 */

import type { NodeShape } from '@/lib/flow/node-registry'
import { drawHexagon } from './draw-misc'

/** Chamfered module housing — the default engineering-diagram block. */
function traceRounded(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const w = r * 2.2
  const h = r * 1.5
  const cut = r * 0.22
  ctx.beginPath()
  ctx.moveTo(x - w / 2 + cut, y - h / 2)
  ctx.lineTo(x + w / 2 - cut, y - h / 2)
  ctx.lineTo(x + w / 2, y - h / 2 + cut)
  ctx.lineTo(x + w / 2, y + h / 2 - cut)
  ctx.lineTo(x + w / 2 - cut, y + h / 2)
  ctx.lineTo(x - w / 2 + cut, y + h / 2)
  ctx.lineTo(x - w / 2, y + h / 2 - cut)
  ctx.lineTo(x - w / 2, y - h / 2 + cut)
  ctx.closePath()
}

/** Pill — reads as an endpoint you call out to. */
function traceCapsule(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const w = r * 2.4
  const h = r * 1.3
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2)
}

/** Diamond — the conventional decision shape in flowcharts. */
function traceDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const d = r * 1.25
  ctx.beginPath()
  ctx.moveTo(x, y - d)
  ctx.lineTo(x + d, y)
  ctx.lineTo(x, y + d)
  ctx.lineTo(x - d, y)
  ctx.closePath()
}

/**
 * Database cylinder.
 *
 * Traced as a single closed path (body plus the front curve of the top
 * ellipse) so one fill and one stroke render the whole silhouette; the top
 * ellipse's back edge is drawn separately by {@link drawCylinderLid}.
 */
function traceCylinder(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const w = r * 1.7
  const h = r * 1.9
  const lid = r * 0.34
  const top = y - h / 2
  const bottom = y + h / 2

  ctx.beginPath()
  ctx.moveTo(x - w / 2, top)
  ctx.lineTo(x - w / 2, bottom - lid)
  ctx.ellipse(x, bottom - lid, w / 2, lid, 0, Math.PI, 0, true)
  ctx.lineTo(x + w / 2, top)
  ctx.ellipse(x, top, w / 2, lid, 0, 0, Math.PI, true)
  ctx.closePath()
}

/** The lid seam of a cylinder. Drawn after the body so it sits on top. */
export function drawCylinderLid(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const w = r * 1.7
  const h = r * 1.9
  const lid = r * 0.34
  ctx.beginPath()
  ctx.ellipse(x, y - h / 2, w / 2, lid, 0, 0, Math.PI * 2)
}

/** Trace the outline for a node shape. Leaves the path open for fill/stroke. */
export function traceNodeShape(
  ctx: CanvasRenderingContext2D, shape: NodeShape, x: number, y: number, r: number,
): void {
  switch (shape) {
    case 'hexagon': drawHexagon(ctx, x, y, r); break
    case 'rounded': traceRounded(ctx, x, y, r); break
    case 'capsule': traceCapsule(ctx, x, y, r); break
    case 'diamond': traceDiamond(ctx, x, y, r); break
    case 'cylinder': traceCylinder(ctx, x, y, r); break
  }
}

/**
 * Half-extents of a shape's bounding box.
 *
 * Hit detection and the label layout both need this, and they must agree with
 * what was drawn — so the numbers live next to the tracing code rather than
 * being re-derived at each call site.
 */
export function nodeShapeExtents(shape: NodeShape, r: number): { halfW: number; halfH: number } {
  switch (shape) {
    case 'hexagon': return { halfW: r, halfH: r }
    case 'rounded': return { halfW: r * 1.1, halfH: r * 0.75 }
    case 'capsule': return { halfW: r * 1.2, halfH: r * 0.65 }
    case 'diamond': return { halfW: r * 1.25, halfH: r * 1.25 }
    case 'cylinder': return { halfW: r * 0.85, halfH: r * 0.95 + r * 0.34 }
  }
}

/**
 * Where an edge should meet a node's outline.
 *
 * Approximated on the bounding box rather than the true outline: exact
 * ray/shape intersection costs more than it is worth at these sizes, and the
 * difference is under a pixel for every shape here.
 */
export function shapeBoundaryPoint(
  shape: NodeShape, cx: number, cy: number, r: number, towardX: number, towardY: number,
): { x: number; y: number } {
  const dx = towardX - cx
  const dy = towardY - cy
  const len = Math.hypot(dx, dy)
  if (len < 0.001) return { x: cx, y: cy }

  const { halfW, halfH } = nodeShapeExtents(shape, r)
  const ux = dx / len
  const uy = dy / len

  // Distance along the ray to the box edge, whichever it hits first.
  const tx = Math.abs(ux) < 1e-6 ? Infinity : halfW / Math.abs(ux)
  const ty = Math.abs(uy) < 1e-6 ? Infinity : halfH / Math.abs(uy)
  const t = Math.min(tx, ty)

  return { x: cx + ux * t, y: cy + uy * t }
}
