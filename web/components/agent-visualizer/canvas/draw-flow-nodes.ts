/**
 * Generic node renderer.
 *
 * Everything visual is resolved from the node type registry and the node's
 * status. There is no branch anywhere in this file on a business concept —
 * "Heatmap API" reaches the screen as `label` text and nothing more. Adding a
 * node category means adding a registry entry, not editing this file.
 */

import {
  borderAlpha,
  breatheScale,
  completionPulse,
  failureShakeOffset,
  glowAlpha,
} from '@/lib/flow/animate'
import type { FlowNode } from '@/lib/flow/graph'
import type { LayoutNode } from '@/lib/flow/layout'
import { getNodeSpec, getStatusColor, type NodeTypeSpec, type RunningMotion } from '@/lib/flow/node-registry'
import { COLORS } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { truncateText } from './draw-misc'
import { getGlowSprite, measureTextCached } from './render-cache'
import { drawCylinderLid, nodeShapeExtents, traceNodeShape } from './flow-shapes'

const DRAW = {
  glowPadding: 22,
  labelGap: 10,
  labelFont: '11px monospace',
  summaryFont: '9px monospace',
  metaFont: '8px monospace',
  labelMaxWidth: 150,
  /** Below this camera scale, secondary text is skipped — it would be
   *  unreadable anyway and costs a measureText per node per frame. */
  detailScaleThreshold: 0.55,
  badgeRadius: 7,
  progressRingOffset: 5,
  pulseExpand: 34,
} as const

// ─── Inner motion ────────────────────────────────────────────────────────────

/** Motion played inside a running node. Pure function of (time, radius) —
 *  no per-node timers, so a replay reproduces it exactly. */
function drawRunningMotion(
  ctx: CanvasRenderingContext2D,
  motion: RunningMotion,
  x: number, y: number, r: number, color: string, time: number,
): void {
  switch (motion) {
    case 'arc-sweep': {
      const start = time * 2.2
      ctx.beginPath()
      ctx.arc(x, y, r * 0.62, start, start + Math.PI * 1.15)
      ctx.strokeStyle = color + 'aa'
      ctx.lineWidth = 1.6
      ctx.stroke()
      break
    }
    case 'orbit': {
      for (let i = 0; i < 3; i++) {
        const angle = time * 1.4 + (i / 3) * Math.PI * 2
        ctx.beginPath()
        ctx.fillStyle = color + '90'
        ctx.arc(x + Math.cos(angle) * r * 0.72, y + Math.sin(angle) * r * 0.72, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'pulse-bar': {
      const w = r * 0.9
      for (let i = 0; i < 3; i++) {
        // Staggered phase so the bars ripple rather than blink together.
        const level = Math.sin(time * 3 + i * 0.7) * 0.5 + 0.5
        ctx.fillStyle = color + alphaHex(0.25 + level * 0.5)
        ctx.fillRect(x - w / 2 + i * (w / 3), y + r * 0.34 - level * r * 0.3, w / 3 - 2, level * r * 0.3 + 1)
      }
      break
    }
    case 'scan': {
      const { halfW, halfH } = { halfW: r * 0.8, halfH: r * 0.8 }
      const scanY = y - halfH + ((time * 26) % (halfH * 2))
      ctx.save()
      ctx.beginPath()
      ctx.rect(x - halfW, y - halfH, halfW * 2, halfH * 2)
      ctx.clip()
      const grad = ctx.createLinearGradient(x, scanY - 4, x, scanY + 4)
      grad.addColorStop(0, color + '00')
      grad.addColorStop(0.5, color + '55')
      grad.addColorStop(1, color + '00')
      ctx.fillStyle = grad
      ctx.fillRect(x - halfW, scanY - 4, halfW * 2, 8)
      ctx.restore()
      break
    }
    case 'none':
      break
  }
}

// ─── Decorations ─────────────────────────────────────────────────────────────

/** Expanding ring played once when a node reaches a terminal state. */
function drawCompletionPulse(
  ctx: CanvasRenderingContext2D, node: FlowNode, x: number, y: number, r: number, color: string,
): void {
  const pulse = completionPulse(node)
  if (!pulse) return

  const eased = 1 - Math.pow(1 - pulse.progress, 2)
  const radius = r + eased * DRAW.pulseExpand
  ctx.save()
  ctx.globalAlpha = (1 - pulse.progress) * 0.7
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 2 * (1 - pulse.progress)
  ctx.stroke()
  ctx.restore()
}

/** Arc showing reported completion, for nodes that publish `progress`. */
function drawProgressRing(
  ctx: CanvasRenderingContext2D, node: FlowNode, x: number, y: number, r: number, color: string,
): void {
  if (node.progress == null || node.status !== 'running') return

  const radius = r + DRAW.progressRingOffset
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.holoBorder08
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + node.progress * Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()
}

/** Retry counter, shown only once a node has actually been retried. */
function drawRetryBadge(
  ctx: CanvasRenderingContext2D, node: FlowNode, x: number, y: number, halfW: number, halfH: number,
): void {
  if (node.attempt <= 1) return

  const bx = x + halfW
  const by = y - halfH
  ctx.beginPath()
  ctx.arc(bx, by, DRAW.badgeRadius, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.cardBgDark
  ctx.fill()
  ctx.strokeStyle = COLORS.tool + 'cc'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = COLORS.tool
  ctx.font = DRAW.metaFont
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`↻${node.attempt}`, bx, by + 0.5)
}

/** Name, current action summary, and — while waiting — what is blocking. */
function drawNodeText(
  ctx: CanvasRenderingContext2D,
  node: FlowNode,
  x: number, y: number, halfH: number,
  color: string,
  cameraScale: number,
  elapsedSeconds: number | null,
): void {
  let cursorY = y + halfH + DRAW.labelGap

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = DRAW.labelFont
  ctx.fillStyle = COLORS.textPrimary
  ctx.fillText(truncateText(ctx, node.label, DRAW.labelMaxWidth), x, cursorY)
  cursorY += 13

  if (cameraScale < DRAW.detailScaleThreshold) return

  if (node.summary) {
    ctx.font = DRAW.summaryFont
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(truncateText(ctx, node.summary, DRAW.labelMaxWidth), x, cursorY)
    cursorY += 11
  }

  // A waiting node must say what it is waiting on, and for how long — that is
  // the whole reason the state exists as something separate from running.
  if (node.status === 'waiting' && node.waitingOn) {
    ctx.font = DRAW.metaFont
    ctx.fillStyle = color + 'cc'
    const elapsed = elapsedSeconds != null ? `  ${elapsedSeconds.toFixed(1)}s` : ''
    ctx.fillText(truncateText(ctx, `⏱ ${node.waitingOn}${elapsed}`, DRAW.labelMaxWidth), x, cursorY)
    cursorY += 10
  } else if (node.status === 'running' && elapsedSeconds != null && elapsedSeconds > 1) {
    ctx.font = DRAW.metaFont
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(`${elapsedSeconds.toFixed(1)}s`, x, cursorY)
    cursorY += 10
  }

  if (node.status === 'failed' && node.error) {
    ctx.font = DRAW.metaFont
    ctx.fillStyle = COLORS.error + 'cc'
    ctx.fillText(truncateText(ctx, node.error.message, DRAW.labelMaxWidth), x, cursorY)
  }
}

// ─── Node ────────────────────────────────────────────────────────────────────

export interface DrawNodesOptions {
  nodes: ReadonlyMap<string, FlowNode>
  positions: ReadonlyMap<string, LayoutNode>
  selectedId: string | null
  hoveredId: string | null
  /** Node types the user has filtered out. */
  hiddenTypes: ReadonlySet<string>
  /** Frame clock in seconds, for motion. */
  time: number
  /** Run clock in seconds, for elapsed-time readouts. */
  runTime: number
  cameraScale: number
  /** Visible world rect, for culling. */
  viewport: { minX: number; minY: number; maxX: number; maxY: number }
}

function drawSingleNode(
  ctx: CanvasRenderingContext2D,
  node: FlowNode,
  position: LayoutNode,
  spec: NodeTypeSpec,
  options: DrawNodesOptions,
): void {
  const { time, runTime, cameraScale, selectedId, hoveredId } = options
  const isSelected = node.id === selectedId
  const isHovered = node.id === hoveredId
  const color = getStatusColor(node.status)

  const shake = failureShakeOffset(node)
  const x = position.x + shake
  const y = position.y
  const r = spec.radius * breatheScale(node, time) * node.anim.scale
  const { halfW, halfH } = nodeShapeExtents(spec.shape, r)

  ctx.save()
  ctx.globalAlpha = node.anim.opacity * node.anim.focus

  // Outer glow — a pre-rendered sprite, never a per-frame gradient.
  const glow = glowAlpha(node, isSelected, isHovered)
  if (glow > 0.02) {
    const glowR = Math.ceil(Math.max(halfW, halfH) + DRAW.glowPadding)
    const sprite = getGlowSprite(color, glowR, alphaHex(glow), '00')
    ctx.drawImage(sprite, x - glowR, y - glowR)
  }

  // Body
  traceNodeShape(ctx, spec.shape, x, y, r)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()

  // Border. Skipped nodes are dashed to read as "never ran".
  ctx.strokeStyle = color + alphaHex(borderAlpha(node, time))
  ctx.lineWidth = isSelected || isHovered ? 2.4 : 1.8
  if (node.status === 'skipped') ctx.setLineDash([3, 4])
  else if (node.status === 'success') ctx.setLineDash([5, 3])
  ctx.stroke()
  ctx.setLineDash([])

  if (spec.shape === 'cylinder') {
    drawCylinderLid(ctx, x, y, r)
    ctx.strokeStyle = color + '55'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  if (node.status === 'running') {
    drawRunningMotion(ctx, spec.runningMotion, x, y, r, color, time)
  }

  // Type glyph, tinted by the type accent so categories stay distinguishable
  // even when several nodes share a status color.
  ctx.font = `${Math.round(r * 0.8)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = spec.accent + (node.status === 'skipped' ? '55' : 'cc')
  ctx.fillText(node.icon ?? spec.glyph, x, y)

  drawProgressRing(ctx, node, x, y, Math.max(halfW, halfH), color)
  drawCompletionPulse(ctx, node, x, y, Math.max(halfW, halfH), color)
  drawRetryBadge(ctx, node, x, y, halfW, halfH)

  const elapsed = node.startedAt != null
    ? (node.durationMs != null ? node.durationMs / 1000 : Math.max(0, (node.endedAt ?? runTime) - node.startedAt))
    : null
  drawNodeText(ctx, node, x, y, halfH, color, cameraScale, elapsed)

  ctx.restore()
}

export function drawFlowNodes(ctx: CanvasRenderingContext2D, options: DrawNodesOptions): void {
  const { nodes, positions, hiddenTypes, viewport } = options

  for (const [id, node] of nodes) {
    if (hiddenTypes.has(node.type)) continue
    const position = positions.get(id)
    if (!position) continue

    const spec = getNodeSpec(node.type)
    // Cull off-screen nodes. The margin covers the glow and the label stack,
    // so nothing pops in at the edge of the viewport.
    const margin = spec.radius * 2 + 60
    if (
      position.x + margin < viewport.minX || position.x - margin > viewport.maxX ||
      position.y + margin < viewport.minY || position.y - margin > viewport.maxY
    ) continue

    drawSingleNode(ctx, node, position, spec, options)
  }
}

// ─── Hit detection ───────────────────────────────────────────────────────────

/** Topmost node at a world-space point, or null. Iterates in reverse so the
 *  most recently added node — drawn last, on top — wins a tie. */
export function findFlowNodeAt(
  x: number, y: number,
  nodes: ReadonlyMap<string, FlowNode>,
  positions: ReadonlyMap<string, LayoutNode>,
  hiddenTypes: ReadonlySet<string>,
): string | null {
  const ids = [...nodes.keys()]
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    const node = nodes.get(id)!
    if (hiddenTypes.has(node.type)) continue
    const position = positions.get(id)
    if (!position) continue

    const spec = getNodeSpec(node.type)
    const { halfW, halfH } = nodeShapeExtents(spec.shape, spec.radius)
    if (Math.abs(x - position.x) <= halfW && Math.abs(y - position.y) <= halfH) return id
  }
  return null
}

