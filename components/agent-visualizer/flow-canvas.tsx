'use client'

/**
 * Canvas host for the generic workflow view.
 *
 * Reuses the shared background layer, bloom post-processing, and bezier
 * primitives. Reads simulation state from a ref every frame so panning,
 * animating, and 60fps rendering never trigger a React render.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { PERF_OVERLAY, PERF_OVERLAY_ENABLED, type DepthParticle } from '@/lib/canvas-config'
import type { FlowState } from '@/lib/flow/graph'
import type { FlowLayout } from '@/lib/flow/layout'
import { getStatusColor } from '@/lib/flow/node-registry'
import { BloomRenderer } from './bloom-renderer'
import { createDepthParticles, drawBackground, updateDepthParticles } from './background-layer'
import { drawFlowEdges, drawFlowParticles } from './canvas/draw-flow-edges'
import { drawFlowNodes, findFlowNodeAt } from './canvas/draw-flow-nodes'
import { useFlowViewport } from '@/hooks/use-flow-viewport'
import { ACTIVE_EDGE_WINDOW_S } from '@/lib/flow/graph'

interface FlowCanvasProps {
  stateRef: MutableRefObject<FlowState>
  layoutRef: MutableRefObject<FlowLayout | null>
  focusSetRef: MutableRefObject<Set<string> | null>
  selectedNodeId: string | null
  hiddenTypes: ReadonlySet<string>
  showGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  onSelectNode: (nodeId: string | null) => void
}

export function FlowCanvas({
  stateRef, layoutRef, focusSetRef, selectedNodeId, hiddenTypes, showGrid,
  zoomToFitTrigger, pauseAutoFit, onSelectNode,
}: FlowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  const bloomRef = useRef<BloomRenderer | null>(null)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const dprRef = useRef(1)
  const timeRef = useRef(0)
  const lastFrameMsRef = useRef(0)
  const lastErrorMsRef = useRef(0)

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  // Mirrored into a ref so the draw loop sees hover changes without waiting
  // for a re-render to hand it a new prop.
  const hoveredRef = useRef<string | null>(null)
  hoveredRef.current = hoveredNodeId
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedNodeId
  const hiddenTypesRef = useRef<ReadonlySet<string>>(hiddenTypes)
  hiddenTypesRef.current = hiddenTypes
  const showGridRef = useRef(showGrid)
  showGridRef.current = showGrid

  const perfRef = useRef({ frames: 0, lastUpdateMs: 0, fps: 0, frameTimes: [] as number[], p95: 0 })

  // ─── Viewport ──────────────────────────────────────────────────────────────

  const hitTest = useCallback((worldX: number, worldY: number) => {
    const layout = layoutRef.current
    if (!layout) return null
    return findFlowNodeAt(worldX, worldY, stateRef.current.nodes, layout.positions, hiddenTypesRef.current)
  }, [layoutRef, stateRef])

  const {
    transformRef, isPanning, worldViewport, updateCamera, handlers,
  } = useFlowViewport({
    canvasRef, layoutRef, dimensions, hitTest,
    onSelect: onSelectNode,
    onHover: setHoveredNodeId,
    zoomToFitTrigger,
    pauseAutoFit,
  })

  // ─── Setup ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    bloomRef.current = new BloomRenderer(0.45)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { bloomRef.current = null }
    // Particles are created once; the draw loop handles resizing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width, height })
        bloomRef.current?.resize(width * dpr, height * dpr)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Draw loop ─────────────────────────────────────────────────────────────

  const drawRef = useRef<(ts: number) => void>(() => {})

  /** One frame. Scheduling belongs to the effect below — see the note there. */
  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
      const state = stateRef.current
      const layout = layoutRef.current
      if (!layout) return

      const deltaTime = lastFrameMsRef.current ? (timestamp - lastFrameMsRef.current) / 1000 : 0.016
      lastFrameMsRef.current = timestamp
      timeRef.current += Math.min(deltaTime, 0.1)

      const dpr = dprRef.current
      const { width, height } = dimensions
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
        ctx.scale(dpr, dpr)
      }

      updateCamera()
      const transform = transformRef.current

      ctx.clearRect(0, 0, width, height)
      updateDepthParticles(depthParticlesRef.current, deltaTime, width, height)

      // Ambient spotlight tracks the first running node, so the eye is drawn
      // to wherever execution currently is.
      let activeSpot: { x: number; y: number; color: string } | undefined
      for (const [id, node] of state.nodes) {
        if (node.status !== 'running' && node.status !== 'waiting') continue
        const position = layout.positionOf(id)
        if (!position) continue
        activeSpot = { x: position.x, y: position.y, color: getStatusColor(node.status) }
        break
      }

      drawBackground(ctx, width, height, depthParticlesRef.current, transform, showGridRef.current, timeRef.current, activeSpot)

      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.scale, transform.scale)

      const activeEdges = new Set<string>()
      for (const particle of state.particles) activeEdges.add(particle.edgeId)
      for (const edge of state.edges) {
        if (edge.lastActiveAt != null && state.currentTime - edge.lastActiveAt <= ACTIVE_EDGE_WINDOW_S) {
          activeEdges.add(edge.id)
        }
      }

      const shared = {
        nodes: state.nodes,
        positions: layout.positions,
        focusSet: focusSetRef.current,
        hiddenTypes: hiddenTypesRef.current,
        cameraScale: transform.scale,
      }

      drawFlowEdges(ctx, { ...shared, edges: state.edges, activeEdgeIds: activeEdges })
      drawFlowNodes(ctx, {
        ...shared,
        selectedId: selectedRef.current,
        hoveredId: hoveredRef.current,
        time: timeRef.current,
        runTime: state.currentTime,
        viewport: worldViewport(),
      })
      drawFlowParticles(ctx, { ...shared, particles: state.particles, edges: state.edges })

      ctx.restore()

      bloomRef.current?.apply(canvas, ctx, width, height)

      if (PERF_OVERLAY_ENABLED) drawPerfOverlay(ctx, perfRef.current, timestamp, state)
    } catch (error) {
      // Rate-limited: a draw error repeats every frame and would otherwise
      // flood the console faster than it could be read.
      const now = Date.now()
      if (now - lastErrorMsRef.current > 5000) {
        lastErrorMsRef.current = now
        console.warn('[FlowCanvas] draw error:', error)
      }
    }
  }, [dimensions, stateRef, layoutRef, focusSetRef, transformRef, updateCamera, worldViewport])

  drawRef.current = draw

  // Single owner of the draw loop, cancelling only the handle it created.
  // Sharing a mutable ref between the scheduler and the cleanup lets
  // StrictMode's mount/unmount/mount cancel a live frame and kill the loop.
  useEffect(() => {
    let active = true
    let handle = 0

    const loop = (timestamp: number) => {
      if (!active) return
      drawRef.current(timestamp)
      handle = requestAnimationFrame(loop)
    }

    handle = requestAnimationFrame(loop)
    return () => { active = false; cancelAnimationFrame(handle) }
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      style={{ cursor: isPanning ? 'grabbing' : hoveredNodeId ? 'pointer' : 'grab' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: dimensions.width, height: dimensions.height, touchAction: 'none' }}
        className="w-full h-full"
        {...handlers}
      />
    </div>
  )
}

// ─── Perf overlay (?perf or ?stress) ─────────────────────────────────────────

function drawPerfOverlay(
  ctx: CanvasRenderingContext2D,
  perf: { frames: number; lastUpdateMs: number; fps: number; frameTimes: number[]; p95: number },
  timestamp: number,
  state: FlowState,
): void {
  const frameEnd = performance.now()
  const frameMs = frameEnd - timestamp
  perf.frameTimes.push(frameMs)
  if (perf.frameTimes.length > PERF_OVERLAY.maxFrameSamples) perf.frameTimes.shift()
  perf.frames++

  if (frameEnd - perf.lastUpdateMs >= PERF_OVERLAY.updateIntervalMs) {
    perf.fps = perf.frames
    perf.frames = 0
    perf.lastUpdateMs = frameEnd
    const sorted = [...perf.frameTimes].sort((a, b) => a - b)
    perf.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  }

  const po = PERF_OVERLAY
  ctx.save()
  ctx.fillStyle = po.bgColor
  ctx.fillRect(po.x, po.y, po.width, po.height)
  ctx.font = po.font
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  let y = po.y + po.lineHeight + 2
  const x = po.x + po.padding
  ctx.fillStyle = perf.fps < po.fpsWarning ? po.fpsWarningColor : perf.fps < po.fpsCaution ? po.fpsCautionColor : po.fpsGoodColor
  ctx.fillText(`FPS: ${perf.fps}`, x, y); y += po.lineHeight
  ctx.fillStyle = po.textColor
  ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, x, y); y += po.lineHeight
  ctx.fillText(`Nodes: ${state.nodes.size}`, x, y); y += po.lineHeight
  ctx.fillText(`Edges: ${state.edges.length}`, x, y); y += po.lineHeight
  ctx.fillText(`Particles: ${state.particles.length}`, x, y); y += po.lineHeight
  ctx.fillText(`Events: ${state.eventLog.length}`, x, y)
  ctx.restore()
}
