'use client'

/**
 * Camera and pointer handling for the flow canvas.
 *
 * All camera state lives in refs and is read by the draw loop — nothing here
 * triggers a React render while panning, zooming, or dragging a node.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { CAMERA } from '@/lib/canvas-config'
import { layoutBounds, type FlowLayout } from '@/lib/flow/layout'

export interface Transform { x: number; y: number; scale: number }

const FIT_PADDING = 90
const MAX_FIT_SCALE = 1.4
const DRAG_THRESHOLD_PX = 4

interface ViewportOptions {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
  layoutRef: MutableRefObject<FlowLayout | null>
  dimensions: { width: number; height: number }
  /** World-space hit test, supplied by the canvas. */
  hitTest: (worldX: number, worldY: number) => string | null
  onSelect: (nodeId: string | null) => void
  onHover: (nodeId: string | null) => void
  /** Bumping this number re-frames the graph. */
  zoomToFitTrigger?: number
  /** Suspends auto-fit — e.g. while a popup is anchored to a node. */
  pauseAutoFit?: boolean
}

export function useFlowViewport({
  canvasRef, layoutRef, dimensions, hitTest, onSelect, onHover, zoomToFitTrigger, pauseAutoFit,
}: ViewportOptions) {
  const transformRef = useRef<Transform>({ x: dimensions.width / 2, y: dimensions.height / 2, scale: 1 })
  const targetRef = useRef<Transform | null>(null)
  const userHasNavigatedRef = useRef(false)

  const [isPanning, setIsPanning] = useState(false)
  const panStateRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false })
  const dragStateRef = useRef<{ nodeId: string | null; moved: boolean }>({ nodeId: null, moved: false })

  // ─── Coordinate conversion ─────────────────────────────────────────────────

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return { x: (clientX - rect.left - t.x) / t.scale, y: (clientY - rect.top - t.y) / t.scale }
  }, [canvasRef])

  /** Visible world rectangle. The draw loop uses this to cull. */
  const worldViewport = useCallback(() => {
    const t = transformRef.current
    return {
      minX: -t.x / t.scale,
      minY: -t.y / t.scale,
      maxX: (dimensions.width - t.x) / t.scale,
      maxY: (dimensions.height - t.y) / t.scale,
    }
  }, [dimensions])

  // ─── Auto-fit ──────────────────────────────────────────────────────────────

  const computeFit = useCallback((): Transform | null => {
    const layout = layoutRef.current
    if (!layout) return null
    const bounds = layoutBounds(layout.positions, FIT_PADDING)
    if (!bounds) return null

    const boundsW = bounds.maxX - bounds.minX
    const boundsH = bounds.maxY - bounds.minY
    if (boundsW <= 0 || boundsH <= 0) return null

    const scale = Math.min(dimensions.width / boundsW, dimensions.height / boundsH, MAX_FIT_SCALE)
    return {
      x: dimensions.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
      y: dimensions.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
      scale,
    }
  }, [layoutRef, dimensions])

  const zoomToFit = useCallback(() => {
    userHasNavigatedRef.current = false
    const fit = computeFit()
    if (fit) targetRef.current = fit
  }, [computeFit])

  useEffect(() => {
    if (zoomToFitTrigger != null && zoomToFitTrigger > 0) zoomToFit()
  }, [zoomToFitTrigger, zoomToFit])

  /** Called once per frame from the draw loop. */
  const updateCamera = useCallback(() => {
    if (!userHasNavigatedRef.current && !panStateRef.current.active && !pauseAutoFit) {
      const fit = computeFit()
      if (fit) targetRef.current = fit
    }

    const target = targetRef.current
    if (!target) return

    const t = transformRef.current
    const nx = t.x + (target.x - t.x) * CAMERA.autoFitLerp
    const ny = t.y + (target.y - t.y) * CAMERA.autoFitLerp
    const ns = t.scale + (target.scale - t.scale) * CAMERA.autoFitLerp

    if (Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001) {
      transformRef.current = { ...target }
      targetRef.current = null
    } else {
      transformRef.current = { x: nx, y: ny, scale: ns }
    }
  }, [computeFit, pauseAutoFit])

  // ─── Pointer ───────────────────────────────────────────────────────────────

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)

    const world = screenToWorld(e.clientX, e.clientY)
    const hit = hitTest(world.x, world.y)

    if (hit) {
      dragStateRef.current = { nodeId: hit, moved: false }
      layoutRef.current?.beginDrag(hit)
      return
    }

    const t = transformRef.current
    panStateRef.current = { active: true, startX: e.clientX, startY: e.clientY, originX: t.x, originY: t.y, moved: false }
    setIsPanning(true)
  }, [screenToWorld, hitTest, layoutRef])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current
    if (drag.nodeId) {
      const world = screenToWorld(e.clientX, e.clientY)
      layoutRef.current?.drag(drag.nodeId, world.x, world.y)
      drag.moved = true
      // Dragging a node is an explicit statement about where things belong;
      // auto-fit must stop fighting the user for control of the camera.
      userHasNavigatedRef.current = true
      return
    }

    const pan = panStateRef.current
    if (pan.active) {
      const dx = e.clientX - pan.startX
      const dy = e.clientY - pan.startY
      if (!pan.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        pan.moved = true
        userHasNavigatedRef.current = true
        targetRef.current = null
      }
      if (pan.moved) {
        transformRef.current = { ...transformRef.current, x: pan.originX + dx, y: pan.originY + dy }
      }
      return
    }

    const world = screenToWorld(e.clientX, e.clientY)
    onHover(hitTest(world.x, world.y))
  }, [screenToWorld, hitTest, onHover, layoutRef])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current
    if (drag.nodeId) {
      // A drag that never moved is a click; only a real drag pins the node.
      layoutRef.current?.endDrag(drag.nodeId, drag.moved)
      if (!drag.moved) onSelect(drag.nodeId)
      dragStateRef.current = { nodeId: null, moved: false }
      return
    }

    const pan = panStateRef.current
    if (pan.active && !pan.moved) {
      const world = screenToWorld(e.clientX, e.clientY)
      onSelect(hitTest(world.x, world.y))
    }
    pan.active = false
    setIsPanning(false)
  }, [screenToWorld, hitTest, onSelect, layoutRef])

  const onPointerLeave = useCallback(() => {
    panStateRef.current.active = false
    setIsPanning(false)
    onHover(null)
  }, [onHover])

  // Wheel zoom is registered natively rather than via React's onWheel, because
  // React attaches wheel listeners as passive and preventDefault is required
  // to stop the page from scrolling underneath the canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      userHasNavigatedRef.current = true
      targetRef.current = null

      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const t = transformRef.current

      const factor = e.deltaY > 0 ? CAMERA.zoomStepDown : CAMERA.zoomStepUp
      const scale = Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, t.scale * factor))
      // Keep the point under the cursor fixed while zooming.
      const ratio = scale / t.scale
      transformRef.current = { x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio, scale }
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [canvasRef])

  return {
    transformRef,
    isPanning,
    screenToWorld,
    worldViewport,
    updateCamera,
    zoomToFit,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave,
    },
  }
}
