/**
 * Directed edge and particle rendering.
 *
 * Edges are drawn source → target with an arrowhead, and particles travel the
 * curve in the direction the data actually moved. A response reuses its
 * request's edge with `reverse` set, so one channel shows traffic both ways
 * rather than the graph sprouting a second, backwards line.
 */

import type { FlowEdge, FlowNode, FlowParticle } from '@/lib/flow/graph'
import type { LayoutNode } from '@/lib/flow/layout'
import { getEdgeKindSpec, getNodeSpec } from '@/lib/flow/node-registry'
import { COLORS } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { bezierPoint, computeControlPoints, drawTaperedBezier } from './draw-edges'
import { shapeBoundaryPoint } from './flow-shapes'
import { getGlowSprite } from './render-cache'

const EDGE = {
  idleAlpha: 0.13,
  activeAlpha: 0.34,
  focusedIdleAlpha: 0.2,
  startWidth: 2.2,
  endWidth: 1.1,
  arrowLength: 9,
  arrowWidth: 6,
  /** Trail samples behind a particle. */
  trailSegments: 7,
  particleGlowRadius: 13,
  labelFont: '8px monospace',
  labelMinScale: 0.7,
} as const

interface EdgeGeometry {
  fromX: number; fromY: number
  toX: number; toY: number
  cp1x: number; cp1y: number
  cp2x: number; cp2y: number
}

/**
 * Curve for an edge, trimmed to each node's outline.
 *
 * Trimming matters for arrowheads: an arrow drawn at the node *centre* is
 * hidden underneath the node, so the direction of flow becomes invisible.
 */
function edgeGeometry(
  edge: FlowEdge,
  nodes: ReadonlyMap<string, FlowNode>,
  positions: ReadonlyMap<string, LayoutNode>,
): EdgeGeometry | null {
  const sourceNode = nodes.get(edge.source)
  const targetNode = nodes.get(edge.target)
  const sourcePos = positions.get(edge.source)
  const targetPos = positions.get(edge.target)
  if (!sourceNode || !targetNode || !sourcePos || !targetPos) return null

  const sourceSpec = getNodeSpec(sourceNode.type)
  const targetSpec = getNodeSpec(targetNode.type)

  const from = shapeBoundaryPoint(sourceSpec.shape, sourcePos.x, sourcePos.y, sourceSpec.radius, targetPos.x, targetPos.y)
  const to = shapeBoundaryPoint(targetSpec.shape, targetPos.x, targetPos.y, targetSpec.radius, sourcePos.x, sourcePos.y)

  const cp = computeControlPoints(from.x, from.y, to.x, to.y)
  if (!cp) return null

  return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, cp1x: cp.cp1x, cp1y: cp.cp1y, cp2x: cp.cp2x, cp2y: cp.cp2y }
}

function drawArrowhead(ctx: CanvasRenderingContext2D, geo: EdgeGeometry, color: string, alpha: number): void {
  // Tangent at the very end of the curve, sampled just short of t=1.
  const px = bezierPoint(0.94, geo.fromX, geo.cp1x, geo.cp2x, geo.toX)
  const py = bezierPoint(0.94, geo.fromY, geo.cp1y, geo.cp2y, geo.toY)
  const dx = geo.toX - px
  const dy = geo.toY - py
  const len = Math.hypot(dx, dy)
  if (len < 0.001) return

  const ux = dx / len
  const uy = dy / len
  const baseX = geo.toX - ux * EDGE.arrowLength
  const baseY = geo.toY - uy * EDGE.arrowLength

  ctx.beginPath()
  ctx.moveTo(geo.toX, geo.toY)
  ctx.lineTo(baseX - uy * EDGE.arrowWidth / 2, baseY + ux * EDGE.arrowWidth / 2)
  ctx.lineTo(baseX + uy * EDGE.arrowWidth / 2, baseY - ux * EDGE.arrowWidth / 2)
  ctx.closePath()
  ctx.fillStyle = color + alphaHex(alpha)
  ctx.fill()
}

export interface DrawEdgesOptions {
  edges: readonly FlowEdge[]
  nodes: ReadonlyMap<string, FlowNode>
  positions: ReadonlyMap<string, LayoutNode>
  /** Edges carrying traffic right now — the current activity path. */
  activeEdgeIds: ReadonlySet<string>
  /** Nodes on the focused path, or null when no focus is active. */
  focusSet: ReadonlySet<string> | null
  hiddenTypes: ReadonlySet<string>
  cameraScale: number
}

export function drawFlowEdges(ctx: CanvasRenderingContext2D, options: DrawEdgesOptions): void {
  const { edges, nodes, positions, activeEdgeIds, focusSet, hiddenTypes } = options

  for (const edge of edges) {
    const sourceNode = nodes.get(edge.source)
    const targetNode = nodes.get(edge.target)
    if (!sourceNode || !targetNode) continue
    if (hiddenTypes.has(sourceNode.type) || hiddenTypes.has(targetNode.type)) continue

    const geo = edgeGeometry(edge, nodes, positions)
    if (!geo) continue

    const isActive = activeEdgeIds.has(edge.id)
    // An edge is on the focused path only when *both* ends are — otherwise a
    // highlighted node would light up edges leading into dimmed neighbours.
    const inFocus = focusSet == null || (focusSet.has(edge.source) && focusSet.has(edge.target))

    const spec = getEdgeKindSpec(edge.kind)
    const baseAlpha = isActive ? EDGE.activeAlpha : inFocus ? EDGE.focusedIdleAlpha : EDGE.idleAlpha
    const alpha = baseAlpha * edge.opacity * (inFocus ? 1 : 0.35)
    const color = isActive ? spec.color : COLORS.holoBase

    ctx.save()
    drawTaperedBezier(
      ctx, geo.fromX, geo.fromY, geo.cp1x, geo.cp1y, geo.cp2x, geo.cp2y, geo.toX, geo.toY,
      EDGE.startWidth, EDGE.endWidth, color, alpha,
    )
    drawArrowhead(ctx, geo, color, Math.min(1, alpha * 2.4))

    if (edge.label && isActive && options.cameraScale > EDGE.labelMinScale) {
      const mx = bezierPoint(0.5, geo.fromX, geo.cp1x, geo.cp2x, geo.toX)
      const my = bezierPoint(0.5, geo.fromY, geo.cp1y, geo.cp2y, geo.toY)
      ctx.font = EDGE.labelFont
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = spec.color + 'aa'
      ctx.fillText(edge.label, mx, my - 6)
    }
    ctx.restore()
  }
}

// ─── Particles ───────────────────────────────────────────────────────────────

export interface DrawParticlesOptions {
  particles: readonly FlowParticle[]
  edges: readonly FlowEdge[]
  nodes: ReadonlyMap<string, FlowNode>
  positions: ReadonlyMap<string, LayoutNode>
  focusSet: ReadonlySet<string> | null
  hiddenTypes: ReadonlySet<string>
  cameraScale: number
}

export function drawFlowParticles(ctx: CanvasRenderingContext2D, options: DrawParticlesOptions): void {
  const { particles, edges, nodes, positions, focusSet, hiddenTypes } = options
  if (particles.length === 0) return

  const edgeById = new Map<string, FlowEdge>()
  for (const edge of edges) edgeById.set(edge.id, edge)

  for (const particle of particles) {
    const edge = edgeById.get(particle.edgeId)
    if (!edge) continue

    const sourceNode = nodes.get(edge.source)
    const targetNode = nodes.get(edge.target)
    if (!sourceNode || !targetNode) continue
    if (hiddenTypes.has(sourceNode.type) || hiddenTypes.has(targetNode.type)) continue

    const geo = edgeGeometry(edge, nodes, positions)
    if (!geo) continue

    const inFocus = focusSet == null || (focusSet.has(edge.source) && focusSet.has(edge.target))
    const spec = getEdgeKindSpec(particle.kind)

    // `progress` always runs 0 → 1. A reverse particle walks the same curve
    // from the far end, so its head still leads in the direction of travel.
    const sample = (t: number) => {
      const u = particle.reverse ? 1 - t : t
      return {
        x: bezierPoint(u, geo.fromX, geo.cp1x, geo.cp2x, geo.toX),
        y: bezierPoint(u, geo.fromY, geo.cp1y, geo.cp2y, geo.toY),
      }
    }

    const head = sample(particle.progress)

    ctx.save()
    ctx.globalAlpha = inFocus ? 1 : 0.3

    // Comet trail behind the head.
    for (let i = EDGE.trailSegments; i >= 1; i--) {
      const t = Math.max(0, particle.progress - (i / EDGE.trailSegments) * spec.trail)
      const point = sample(t)
      const fade = (EDGE.trailSegments - i) / EDGE.trailSegments
      ctx.beginPath()
      ctx.fillStyle = spec.color + alphaHex(fade * 0.5)
      ctx.arc(point.x, point.y, particle.size * fade, 0, Math.PI * 2)
      ctx.fill()
    }

    const glowR = EDGE.particleGlowRadius
    ctx.drawImage(getGlowSprite(spec.color, glowR, '55', '00'), head.x - glowR, head.y - glowR)

    ctx.beginPath()
    ctx.fillStyle = spec.color
    ctx.arc(head.x, head.y, particle.size, 0, Math.PI * 2)
    ctx.fill()

    ctx.beginPath()
    ctx.fillStyle = COLORS.holoHot + '90'
    ctx.arc(head.x, head.y, particle.size * 0.4, 0, Math.PI * 2)
    ctx.fill()

    if (particle.label && options.cameraScale > EDGE.labelMinScale && particle.progress > 0.15 && particle.progress < 0.85) {
      ctx.font = EDGE.labelFont
      ctx.textAlign = 'center'
      ctx.fillStyle = spec.color + 'cc'
      ctx.fillText(particle.label, head.x, head.y - 10)
    }

    ctx.restore()
  }
}
