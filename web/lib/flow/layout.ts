/**
 * Layered force layout.
 *
 * Positions live here, in mutable `LayoutNode` objects, and are never written
 * back onto `FlowNode`. That is deliberate: positions change every frame, and
 * copying a few hundred node objects per tick — which is what the legacy
 * simulation does — burns allocations for no benefit. The renderer, hit test,
 * and camera all read positions from this map instead.
 *
 * Two forces do the layered part:
 *   - `forceX` pulls each node toward `depth × LAYER_SPACING`, producing the
 *     left-to-right pipeline reading order.
 *   - `forceY` is a weak pull toward the centreline; collision does the rest,
 *     so nodes at the same depth spread vertically on their own.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

import type { FlowEdge, FlowNode } from './graph'

export interface LayoutNode extends SimulationNodeDatum {
  id: string
  depth: number
  /** Radius used for collision, from the node type registry. */
  radius: number
  x: number
  y: number
  /** Seconds remaining on the spawn pin. While pinned the node holds its
   *  entry position so the graph does not visibly recoil when it appears. */
  pinHold: number
  /** True while the user is dragging — an indefinite pin. */
  dragging: boolean
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  id: string
}

export const LAYOUT = {
  /** Horizontal distance between pipeline stages. */
  layerSpacing: 260,
  /** How hard a node is pulled to its layer. Strong enough to read as columns,
   *  loose enough that collision can still resolve overlaps. */
  layerStrength: 0.35,
  /** Weak vertical centring; collision provides the actual separation. */
  centerStrength: 0.045,
  chargeStrength: -900,
  collidePadding: 34,
  linkDistance: 150,
  linkStrength: 0.25,
  velocityDecay: 0.45,
  /** Idle alpha decay. Low so the graph keeps settling gently. */
  alphaDecay: 0.025,
  /** Energy injected when the graph changes. Kept small — the legacy code used
   *  `alpha(0.3)` plus 15 synchronous ticks, which is what made the whole
   *  layout visibly jump every time a node appeared. */
  reheatTarget: 0.12,
  /** Seconds the reheat is held before decaying back to rest. */
  reheatHold: 1.2,
  /** Seconds a newly spawned node stays pinned at its entry position. */
  spawnPinHold: 0.35,
} as const

export class FlowLayout {
  private sim: Simulation<LayoutNode, LayoutLink>
  private nodes = new Map<string, LayoutNode>()
  private links: LayoutLink[] = []
  private reheatRemaining = 0

  constructor() {
    this.sim = forceSimulation<LayoutNode, LayoutLink>([])
      .force('charge', forceManyBody<LayoutNode>().strength(LAYOUT.chargeStrength))
      .force('collide', forceCollide<LayoutNode>(d => d.radius + LAYOUT.collidePadding))
      .force('x', forceX<LayoutNode>(d => d.depth * LAYOUT.layerSpacing).strength(LAYOUT.layerStrength))
      .force('y', forceY<LayoutNode>(0).strength(LAYOUT.centerStrength))
      .force('link', forceLink<LayoutNode, LayoutLink>([]).id(d => d.id).distance(LAYOUT.linkDistance).strength(LAYOUT.linkStrength))
      .alphaDecay(LAYOUT.alphaDecay)
      .velocityDecay(LAYOUT.velocityDecay)

    // The simulation is advanced manually from the frame loop so layout and
    // rendering share one clock; d3's internal timer would run independently.
    this.sim.stop()
  }

  /** Live position map. Mutated in place every tick — read it, do not copy it. */
  get positions(): ReadonlyMap<string, LayoutNode> {
    return this.nodes
  }

  positionOf(id: string): LayoutNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * Reconcile the simulation with the current graph.
   *
   * Existing nodes keep their object identity, and therefore their velocity —
   * rebuilding them would reset momentum and cause a visible twitch on every
   * structural change.
   */
  sync(
    graphNodes: ReadonlyMap<string, FlowNode>,
    edges: readonly FlowEdge[],
    radiusOf: (node: FlowNode) => number,
    participatesInLayout: (node: FlowNode) => boolean,
  ): void {
    let structureChanged = false

    for (const [id, node] of graphNodes) {
      const existing = this.nodes.get(id)
      if (existing) {
        if (existing.depth !== node.depth) { existing.depth = node.depth; structureChanged = true }
        existing.radius = radiusOf(node)
        continue
      }

      const entry: LayoutNode = {
        id,
        depth: node.depth,
        radius: radiusOf(node),
        x: node.x,
        y: node.y,
        vx: 0,
        vy: 0,
        // Held at the entry position for a moment so the spawn animation plays
        // against a still background instead of a graph-wide shove.
        fx: node.x,
        fy: node.y,
        pinHold: LAYOUT.spawnPinHold,
        dragging: false,
      }
      this.nodes.set(id, entry)
      structureChanged = true
    }

    for (const id of this.nodes.keys()) {
      if (!graphNodes.has(id)) { this.nodes.delete(id); structureChanged = true }
    }

    // Only structural edges shape the layout. Response edges point backwards
    // and would pull a node on top of its own caller.
    const wanted = edges.filter(e =>
      e.kind !== 'response' && this.nodes.has(e.source) && this.nodes.has(e.target),
    )
    if (wanted.length !== this.links.length) structureChanged = true

    if (!structureChanged) return

    this.links = wanted.map(e => ({ id: e.id, source: e.source, target: e.target }))

    const active: LayoutNode[] = []
    for (const [id, layoutNode] of this.nodes) {
      const graphNode = graphNodes.get(id)
      if (graphNode && participatesInLayout(graphNode)) active.push(layoutNode)
    }

    this.sim.nodes(active)
    const link = this.sim.force('link') as ReturnType<typeof forceLink<LayoutNode, LayoutLink>> | undefined
    link?.links(this.links.filter(l =>
      active.some(n => n.id === l.source) && active.some(n => n.id === l.target),
    ))

    this.reheat()
  }

  /** Nudge the simulation awake without the jolt of a full restart. */
  reheat(): void {
    this.reheatRemaining = LAYOUT.reheatHold
    this.sim.alphaTarget(LAYOUT.reheatTarget).restart()
    this.sim.stop()
  }

  /** Advance one frame. `deltaTime` is seconds. */
  tick(deltaTime: number): void {
    for (const node of this.nodes.values()) {
      if (node.dragging || node.pinHold <= 0) continue
      node.pinHold -= deltaTime
      if (node.pinHold <= 0) {
        // Release into the simulation; forces take over from here.
        node.fx = undefined
        node.fy = undefined
      }
    }

    if (this.reheatRemaining > 0) {
      this.reheatRemaining -= deltaTime
      if (this.reheatRemaining <= 0) this.sim.alphaTarget(0)
    }

    this.sim.tick()
  }

  /**
   * Run the simulation to rest immediately.
   *
   * Used after a seek: the graph at the target time should appear already
   * settled. Without this the whole layout drifts into place over the next few
   * seconds, which reads as the visualization being confused about a moment
   * that is, in fact, fully determined.
   */
  settle(iterations = 120): void {
    for (const node of this.nodes.values()) {
      if (node.dragging) continue
      node.pinHold = 0
      node.fx = undefined
      node.fy = undefined
    }
    this.sim.alpha(1).alphaTarget(0)
    for (let i = 0; i < iterations; i++) this.sim.tick()
    this.sim.alpha(0)
    this.reheatRemaining = 0
  }

  /** Nodes outside the simulation still need somewhere to sit. Parks them
   *  below their nearest neighbour instead of leaving them at the origin. */
  park(id: string, x: number, y: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.x = x
    node.y = y
    node.fx = x
    node.fy = y
    node.pinHold = 0
  }

  beginDrag(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.dragging = true
    node.pinHold = 0
    this.sim.alphaTarget(LAYOUT.reheatTarget).restart()
    this.sim.stop()
  }

  drag(id: string, x: number, y: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.fx = x
    node.fy = y
    node.x = x
    node.y = y
  }

  endDrag(id: string, keepPinned: boolean): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.dragging = false
    if (!keepPinned) {
      node.fx = undefined
      node.fy = undefined
    }
    this.reheatRemaining = LAYOUT.reheatHold
  }

  dispose(): void {
    this.sim.stop()
    this.nodes.clear()
    this.links = []
  }
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** Bounding box of every positioned node, padded by its radius. Returns null
 *  when there is nothing to frame. */
export function layoutBounds(positions: ReadonlyMap<string, LayoutNode>, extraPadding = 0): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const node of positions.values()) {
    const r = node.radius + extraPadding
    if (node.x - r < minX) minX = node.x - r
    if (node.x + r > maxX) maxX = node.x + r
    if (node.y - r < minY) minY = node.y - r
    if (node.y + r > maxY) maxY = node.y + r
  }

  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}
