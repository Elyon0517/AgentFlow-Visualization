import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FlowNodeType } from './events'
import {
  collectConnectedPath,
  createFlowState,
  createNodeAnim,
  isActive,
  isTerminal,
  oneShotForStatus,
  recomputeDepths,
  type FlowEdge,
  type FlowNode,
} from './graph'

function node(id: string, type: FlowNodeType = 'task', parentId: string | null = null): FlowNode {
  return {
    id, type, label: id, parentId,
    status: 'idle',
    attempt: 1,
    createdAt: 0,
    requests: [],
    logs: [],
    x: 0, y: 0, vx: 0, vy: 0,
    pinned: false,
    depth: 0,
    anim: createNodeAnim(),
  }
}

function edge(source: string, target: string, kind: FlowEdge['kind'] = 'control'): FlowEdge {
  return { id: `${source}->${target}:${kind}`, source, target, kind, createdAt: 0, opacity: 1 }
}

// ─── Status helpers ──────────────────────────────────────────────────────────

test('classifies terminal and active statuses', () => {
  for (const status of ['success', 'warning', 'failed', 'skipped'] as const) {
    assert.equal(isTerminal(status), true, status)
    assert.equal(isActive(status), false, status)
  }
  for (const status of ['running', 'waiting'] as const) {
    assert.equal(isActive(status), true, status)
    assert.equal(isTerminal(status), false, status)
  }
  for (const status of ['idle', 'queued'] as const) {
    assert.equal(isActive(status), false, status)
    assert.equal(isTerminal(status), false, status)
  }
})

test('only terminal-ish statuses trigger a one-shot animation', () => {
  assert.equal(oneShotForStatus('success')?.kind, 'success')
  assert.equal(oneShotForStatus('failed')?.kind, 'failed')
  assert.equal(oneShotForStatus('warning')?.kind, 'warning')
  assert.equal(oneShotForStatus('running'), null)
  assert.equal(oneShotForStatus('waiting'), null)
  assert.equal(oneShotForStatus('skipped'), null)
})

test('one-shot animations are short and non-looping', () => {
  for (const status of ['success', 'warning', 'failed'] as const) {
    const shot = oneShotForStatus(status)!
    assert.ok(shot.duration > 0 && shot.duration <= 1, `${status} lasts ${shot.duration}s`)
  }
})

test('a fresh node starts invisible and plays its spawn animation', () => {
  const anim = createNodeAnim()
  assert.equal(anim.opacity, 0)
  assert.ok(anim.scale < 1)
  assert.equal(anim.oneShot?.kind, 'spawn')
  assert.equal(anim.focus, 1)
})

test('createFlowState starts empty and playing', () => {
  const state = createFlowState()
  assert.equal(state.run, null)
  assert.equal(state.nodes.size, 0)
  assert.deepEqual(state.edges, [])
  assert.equal(state.isPlaying, true)
  assert.equal(state.currentTime, 0)
})

// ─── Depth (left-to-right layered layout) ────────────────────────────────────

test('assigns depth along a linear pipeline', () => {
  const nodes = new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]])
  const edges = [edge('a', 'b', 'data'), edge('b', 'c', 'data')]

  assert.equal(recomputeDepths(nodes, edges), true)
  assert.equal(nodes.get('a')!.depth, 0)
  assert.equal(nodes.get('b')!.depth, 1)
  assert.equal(nodes.get('c')!.depth, 2)
})

test('parallel branches share a depth and rejoin at the next one', () => {
  // market-data ──┬──► heatmap ──┐
  //               └──► broker  ──┴──► gex
  const ids = ['market-data', 'heatmap', 'broker', 'gex']
  const nodes = new Map(ids.map(id => [id, node(id)] as const))
  const edges = [
    edge('market-data', 'heatmap', 'data'),
    edge('market-data', 'broker', 'data'),
    edge('heatmap', 'gex', 'data'),
    edge('broker', 'gex', 'data'),
  ]

  recomputeDepths(nodes, edges)

  assert.equal(nodes.get('market-data')!.depth, 0)
  assert.equal(nodes.get('heatmap')!.depth, 1)
  assert.equal(nodes.get('broker')!.depth, 1, 'concurrent nodes sit in the same column')
  assert.equal(nodes.get('gex')!.depth, 2)
})

test('a node takes the longest path depth, not the shortest', () => {
  // a ──► b ──► c   and   a ──────────► c
  const nodes = new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]])
  const edges = [edge('a', 'b', 'data'), edge('b', 'c', 'data'), edge('a', 'c', 'data')]

  recomputeDepths(nodes, edges)

  assert.equal(nodes.get('c')!.depth, 2, 'shortcut edge must not pull c left of b')
})

test('response edges do not affect depth', () => {
  // Without the response filter, the back-edge would create a cycle and
  // collapse the layout into a single column.
  const nodes = new Map([['caller', node('caller')], ['api', node('api')]])
  const edges = [edge('caller', 'api', 'request'), edge('api', 'caller', 'response')]

  recomputeDepths(nodes, edges)

  assert.equal(nodes.get('caller')!.depth, 0)
  assert.equal(nodes.get('api')!.depth, 1)
})

test('memory reads and writes do not create a cycle that flattens the layout', () => {
  // Memory is read early and written late. Treated as a pipeline edge, that
  // closes a loop over the whole run and collapses every depth.
  const nodes = new Map([
    ['risk', node('risk')],
    ['decision', node('decision')],
    ['mem', node('mem', 'memory')],
  ])
  const edges = [
    edge('risk', 'decision', 'data'),
    edge('mem', 'risk', 'data'),
    edge('decision', 'mem', 'data'),
  ]

  recomputeDepths(nodes, edges)

  assert.ok(
    nodes.get('risk')!.depth < nodes.get('decision')!.depth,
    'the pipeline must stay ordered despite the memory round trip',
  )
})

test('cycle depths do not depend on node creation order', () => {
  const edges = [edge('a', 'b', 'data'), edge('b', 'c', 'data'), edge('c', 'b', 'data')]

  const forward = new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]])
  const reversed = new Map([['c', node('c')], ['b', node('b')], ['a', node('a')]])

  recomputeDepths(forward, edges)
  recomputeDepths(reversed, edges)

  for (const id of ['a', 'b', 'c']) {
    assert.equal(forward.get(id)!.depth, reversed.get(id)!.depth, `${id} depth`)
  }
})

test('a cycle does not hang or throw', () => {
  const nodes = new Map([['a', node('a')], ['b', node('b')], ['c', node('c')]])
  const edges = [edge('a', 'b', 'data'), edge('b', 'c', 'data'), edge('c', 'a', 'data')]

  assert.doesNotThrow(() => recomputeDepths(nodes, edges))
  for (const n of nodes.values()) assert.ok(Number.isFinite(n.depth))
})

test('edges pointing at unknown nodes are ignored', () => {
  const nodes = new Map([['a', node('a')]])
  const edges = [edge('a', 'ghost', 'data'), edge('ghost', 'a', 'data')]

  assert.doesNotThrow(() => recomputeDepths(nodes, edges))
  assert.equal(nodes.get('a')!.depth, 0)
})

test('reports no change when depths are already correct', () => {
  const nodes = new Map([['a', node('a')], ['b', node('b')]])
  const edges = [edge('a', 'b', 'data')]

  assert.equal(recomputeDepths(nodes, edges), true, 'first pass assigns b')
  assert.equal(recomputeDepths(nodes, edges), false, 'second pass is a no-op')
})

test('a node gains depth when its incoming edge arrives later', () => {
  // Node ids are generated at run time, so a node can exist before anything
  // points at it. Depth must correct itself once the edge shows up.
  const nodes = new Map([['a', node('a')], ['b', node('b')]])

  recomputeDepths(nodes, [])
  assert.equal(nodes.get('b')!.depth, 0)

  recomputeDepths(nodes, [edge('a', 'b', 'data')])
  assert.equal(nodes.get('b')!.depth, 1)
})

// ─── Focus path ──────────────────────────────────────────────────────────────

test('collects the full upstream and downstream path', () => {
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]
  const path = collectConnectedPath('c', edges)

  assert.deepEqual([...path].sort(), ['a', 'b', 'c', 'd'])
})

test('excludes unrelated branches', () => {
  //  a ──► b ──► c        x ──► y
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')]
  const path = collectConnectedPath('b', edges)

  assert.deepEqual([...path].sort(), ['a', 'b', 'c'])
  assert.equal(path.has('x'), false)
  assert.equal(path.has('y'), false)
})

test('an isolated node focuses only itself', () => {
  assert.deepEqual([...collectConnectedPath('lonely', [edge('a', 'b')])], ['lonely'])
})

test('a cyclic path terminates', () => {
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
  assert.deepEqual([...collectConnectedPath('a', edges)].sort(), ['a', 'b', 'c'])
})
