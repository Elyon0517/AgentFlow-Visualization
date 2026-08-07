import assert from 'node:assert/strict'
import test from 'node:test'

import type { FlowEvent } from './events'
import { createFlowState } from './graph'
import { FlowLayout, LAYOUT } from './layout'
import { getNodeSpec } from './node-registry'
import { applyFlowEvents } from './reducer'

function event(
  seq: number,
  eventType: FlowEvent['eventType'],
  extra: Partial<FlowEvent> = {},
): FlowEvent {
  return {
    eventId: `evt-${seq}`,
    runId: 'layout-spawn-test',
    timestamp: new Date(Date.parse('2026-08-06T12:00:00.000Z') + seq * 1000).toISOString(),
    eventType,
    seq,
    ...extra,
  }
}

test('new nodes appear directly in their resolved depth layer', () => {
  const state = applyFlowEvents(createFlowState(), [
    event(0, 'run.started'),
    event(1, 'edge.created', { edge: { source: 'root', target: 'middle' } }),
    event(2, 'edge.created', { edge: { source: 'middle', target: 'leaf' } }),
  ])

  // Edge-only events create placeholders whose reducer x seed is the origin.
  assert.equal(state.nodes.get('leaf')?.x, 0)
  assert.equal(state.nodes.get('leaf')?.depth, 2)

  const layout = new FlowLayout()
  layout.sync(
    state.nodes,
    state.edges,
    node => getNodeSpec(node.type).radius,
    node => getNodeSpec(node.type).forceParticipant,
  )

  const leaf = layout.positionOf('leaf')
  assert.ok(leaf)
  assert.equal(leaf.x, 2 * LAYOUT.layerSpacing)
  assert.equal(leaf.fx, 2 * LAYOUT.layerSpacing)
  assert.ok(leaf.pinHold > 0, 'spawn stays locally pinned while fading in')
  layout.dispose()
})

test('a depth correction during spawn snaps locally to the corrected layer', () => {
  const layout = new FlowLayout()
  const initial = applyFlowEvents(createFlowState(), [
    event(0, 'run.started'),
    event(1, 'node.created', { node: { id: 'late', type: 'task', label: 'Late node' } }),
  ])
  layout.sync(
    initial.nodes,
    initial.edges,
    node => getNodeSpec(node.type).radius,
    node => getNodeSpec(node.type).forceParticipant,
  )
  assert.equal(layout.positionOf('late')?.x, 0)

  const corrected = new Map(initial.nodes)
  corrected.set('late', { ...initial.nodes.get('late')!, depth: 3 })
  layout.sync(
    corrected,
    initial.edges,
    node => getNodeSpec(node.type).radius,
    node => getNodeSpec(node.type).forceParticipant,
  )

  assert.equal(layout.positionOf('late')?.x, 3 * LAYOUT.layerSpacing)
  assert.equal(layout.positionOf('late')?.fx, 3 * LAYOUT.layerSpacing)
  layout.dispose()
})
