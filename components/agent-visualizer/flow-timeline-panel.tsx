'use client'

/**
 * Timeline view.
 *
 * A Gantt of every node's lifetime, ordered by when it started. Reads the
 * concurrency of a run at a glance — overlapping bars are the parallel work,
 * and gaps are where the pipeline was blocked.
 *
 * Canvas rather than DOM, matching the existing timeline panel: a long run has
 * hundreds of bars, and a canvas redraw beats reconciling hundreds of nodes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { CHROME_HEIGHT } from '@/lib/canvas-config'
import type { FlowNode } from '@/lib/flow/graph'
import { getNodeSpec, getStatusColor } from '@/lib/flow/node-registry'

const ROW_HEIGHT = 34
const HEADER_HEIGHT = 34
const LABEL_WIDTH = 230
const FONT = '11px monospace'

interface FlowTimelinePanelProps {
  nodes: ReadonlyMap<string, FlowNode>
  currentTime: number
  /** Full run length, so the axis does not rescale on every frame. */
  duration: number
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
  onSeek: (time: number) => void
}

interface Row {
  node: FlowNode
  start: number
  end: number
  /** True while the node is still running — the bar is drawn open-ended. */
  open: boolean
}

export function FlowTimelinePanel({
  nodes, currentTime, duration, selectedNodeId, onSelectNode, onSeek,
}: FlowTimelinePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)

  const rows = useMemo((): Row[] => {
    const list: Row[] = []
    for (const node of nodes.values()) {
      const start = node.startedAt ?? node.createdAt
      const open = node.endedAt == null && (node.status === 'running' || node.status === 'waiting')
      list.push({ node, start, end: node.endedAt ?? currentTime, open })
    }
    return list.sort((a, b) => a.start - b.start || a.node.label.localeCompare(b.node.label))
  }, [nodes, currentTime])

  const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT
  const metrics = useMemo(() => {
    const attempts = rows.reduce((sum, row) => sum + Math.max(0, row.node.attempt - 1), 0)
    const issues = rows.filter(row => row.node.status === 'warning' || row.node.status === 'failed').length
    const points = rows.flatMap(row => [{ t: row.start, delta: 1 }, { t: row.end, delta: -1 }])
      .sort((a, b) => a.t - b.t || a.delta - b.delta)
    let active = 0
    let peak = 0
    for (const point of points) { active += point.delta; peak = Math.max(peak, active) }
    return { attempts, issues, peak }
  }, [rows])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    drawGantt(ctx, rows, currentTime, duration, width, height, dpr, selectedNodeId)
  }, [rows, currentTime, duration, width, height, selectedNodeId])

  /** Map a click to either a row (select) or the time axis (seek). */
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (y < HEADER_HEIGHT) {
      const span = Math.max(duration, 1)
      const barWidth = width - LABEL_WIDTH
      onSeek(Math.max(0, Math.min(span, ((x - LABEL_WIDTH) / barWidth) * span)))
      return
    }

    const index = Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT)
    onSelectNode(rows[index] ? rows[index].node.id : null)
  }

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ top: CHROME_HEIGHT, background: COLORS.void }}>
      <div className="px-4 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${COLORS.glassBorder}`, background: COLORS.panelBg }}>
        <div className="mr-3">
          <div className="text-[12px] font-mono" style={{ color: COLORS.textPrimary }}>Execution timeline</div>
          <div className="text-[9px] font-mono mt-0.5" style={{ color: COLORS.textMuted }}>Select a row to inspect · select the axis to seek</div>
        </div>
        <Metric label="NODES" value={rows.length} />
        <Metric label="PEAK PARALLEL" value={metrics.peak} />
        <Metric label="RETRIES" value={metrics.attempts} tone={metrics.attempts ? COLORS.waiting_permission : undefined} />
        <Metric label="ISSUES" value={metrics.issues} tone={metrics.issues ? COLORS.error : undefined} />
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto">
        <canvas ref={canvasRef} onClick={handleClick} style={{ display: 'block', cursor: 'pointer' }} />
      </div>
    </div>
  )
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function drawGantt(
  ctx: CanvasRenderingContext2D,
  rows: Row[],
  currentTime: number,
  duration: number,
  width: number,
  height: number,
  dpr: number,
  selectedNodeId: string | null,
): void {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.font = FONT

  if (rows.length === 0) {
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'center'
    ctx.fillText('No nodes yet', width / 2, height / 2)
    ctx.restore()
    return
  }

  const span = Math.max(duration, currentTime, 1)
  const barWidth = width - LABEL_WIDTH
  const toX = (t: number) => LABEL_WIDTH + (t / span) * barWidth

  // ── Axis ──
  const step = span > 120 ? 30 : span > 60 ? 10 : span > 20 ? 5 : span > 10 ? 2 : 1
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLORS.textMuted
  for (let t = 0; t <= span; t += step) {
    ctx.fillText(`${t}s`, toX(t), HEADER_HEIGHT - 7)
  }

  // ── Rows ──
  for (let i = 0; i < rows.length; i++) {
    const { node, start, end, open } = rows[i]
    const y = HEADER_HEIGHT + i * ROW_HEIGHT
    const isSelected = node.id === selectedNodeId
    const color = getStatusColor(node.status)
    const spec = getNodeSpec(node.type)

    if (isSelected) {
      ctx.fillStyle = COLORS.toggleActive
      ctx.fillRect(0, y, width, ROW_HEIGHT)
    } else if (i % 2 === 0) {
      ctx.fillStyle = COLORS.holoBg03
      ctx.fillRect(0, y, width, ROW_HEIGHT)
    }

    // Label, prefixed with the type glyph so categories are scannable.
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = spec.accent
    ctx.fillText(spec.glyph, 12, y + ROW_HEIGHT / 2)
    ctx.fillStyle = isSelected ? COLORS.textPrimary : COLORS.textDim
    ctx.fillText(clip(ctx, node.label, LABEL_WIDTH - 70), 30, y + 12)
    ctx.font = '9px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.fillText(node.status.toUpperCase(), 30, y + 25)
    ctx.font = FONT

    // Track
    const trackY = y + 8
    const trackH = ROW_HEIGHT - 16
    ctx.fillStyle = COLORS.holoBg03
    ctx.fillRect(LABEL_WIDTH, trackY, barWidth, trackH)

    ctx.fillStyle = COLORS.panelSeparator
    for (let t = 0; t <= span; t += step) ctx.fillRect(toX(t), trackY, 1, trackH)

    // Bar
    const x0 = toX(start)
    const x1 = toX(Math.max(end, start))
    const w = Math.max(x1 - x0, 2)

    ctx.globalAlpha = 0.35
    ctx.fillStyle = color
    ctx.fillRect(x0, trackY, w, trackH)
    ctx.globalAlpha = 0.85
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, trackY + 0.5, w - 1, trackH - 1)
    ctx.globalAlpha = 1

    if (w > 48) {
      ctx.font = '9px monospace'
      ctx.fillStyle = COLORS.textPrimary
      ctx.textAlign = 'left'
      ctx.fillText(`${Math.max(0, end - start).toFixed(1)}s`, x0 + 6, y + ROW_HEIGHT / 2)
      ctx.font = FONT
    }

    // An unfinished bar gets a soft leading edge so it does not read as
    // having ended exactly at the playhead.
    if (open) {
      const grad = ctx.createLinearGradient(x1 - 14, 0, x1, 0)
      grad.addColorStop(0, color + '00')
      grad.addColorStop(1, color + '99')
      ctx.fillStyle = grad
      ctx.fillRect(Math.max(x0, x1 - 14), trackY, Math.min(14, w), trackH)
    }

    // Retry marker
    if (node.attempt > 1) {
      ctx.fillStyle = COLORS.tool
      ctx.textAlign = 'left'
      ctx.fillText(`↻${node.attempt}`, x1 + 4, y + ROW_HEIGHT / 2)
    }
  }

  // ── Playhead ──
  const playX = toX(Math.min(currentTime, span))
  ctx.fillStyle = COLORS.holoHot
  ctx.globalAlpha = 0.6
  ctx.fillRect(playX, 0, 1, height)
  ctx.globalAlpha = 1

  ctx.restore()
}

function Metric({ label, value, tone = COLORS.textPrimary }: { label: string; value: number; tone?: string }) {
  return (
    <div className="af-panel px-3 py-1.5 min-w-[84px]" style={{ background: COLORS.holoBg05, border: `1px solid ${COLORS.panelSeparator}` }}>
      <div className="text-[8px] font-mono tracking-wider" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="text-[13px] font-mono mt-0.5" style={{ color: tone }}>{value}</div>
    </div>
  )
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1)
  return out + '…'
}
