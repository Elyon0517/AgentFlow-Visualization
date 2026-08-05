import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLOW_ANIM,
  advanceFlowAnimations,
  advanceNodeAnim,
  borderAlpha,
  breatheScale,
  completionPulse,
  failureShakeOffset,
  glowAlpha,
} from './animate'
import type { FlowNodeStatus } from './events'
import { createFlowState, createNodeAnim, type FlowNode, type FlowParticle } from './graph'

function node(id: string, status: FlowNodeStatus = 'idle'): FlowNode {
  return {
    id, type: 'task', label: id, parentId: null,
    status, attempt: 1, createdAt: 0,
    requests: [], logs: [],
    x: 0, y: 0, vx: 0, vy: 0, pinned: false, depth: 0,
    anim: createNodeAnim(),
  }
}

function particle(id: string, spawnedAt = 0): FlowParticle {
  return { id, edgeId: 'e1', kind: 'data', progress: 0, reverse: false, size: 4, spawnedAt }
}

// ─── Node animation ──────────────────────────────────────────────────────────

test('a node fades and scales in, then stops', () => {
  const n = node('a')
  for (let i = 0; i < 60; i++) advanceNodeAnim(n, 1 / 60, 1)

  assert.equal(n.anim.opacity, 1)
  assert.equal(n.anim.scale, 1)
})

test('the spawn one-shot clears itself and never repeats', () => {
  const n = node('a')
  assert.equal(n.anim.oneShot?.kind, 'spawn')

  for (let i = 0; i < 120; i++) advanceNodeAnim(n, 1 / 60, 1)
  assert.equal(n.anim.oneShot, null)

  // Two more seconds must not resurrect it.
  for (let i = 0; i < 120; i++) advanceNodeAnim(n, 1 / 60, 1)
  assert.equal(n.anim.oneShot, null)
})

test('the failure shake plays once, decays, and settles at zero', () => {
  const n = node('a', 'failed')
  n.anim.oneShot = { kind: 'failed', age: 0, duration: 0.45 }

  const early = Math.abs(failureShakeOffset(n))
  n.anim.oneShot.age = 0.4
  const late = Math.abs(failureShakeOffset(n))

  assert.ok(late < 3, 'amplitude decays toward the end')
  assert.ok(early <= 3.01, 'amplitude is bounded')

  for (let i = 0; i < 60; i++) advanceNodeAnim(n, 1 / 60, 1)
  assert.equal(failureShakeOffset(n), 0, 'a failed node stops moving once the flash ends')
})

test('a failed node keeps its status after the flash ends', () => {
  const n = node('a', 'failed')
  n.anim.oneShot = { kind: 'failed', age: 0, duration: 0.45 }
  for (let i = 0; i < 60; i++) advanceNodeAnim(n, 1 / 60, 1)

  assert.equal(n.status, 'failed', 'the animation is transient, the state is not')
  assert.ok(borderAlpha(n, 0) > 0.5, 'and it still reads as failed')
})

test('focus dims unrelated nodes without hiding them', () => {
  const n = node('a')
  for (let i = 0; i < 120; i++) advanceNodeAnim(n, 1 / 60, FLOW_ANIM.focusDim)

  assert.equal(n.anim.focus, FLOW_ANIM.focusDim)
  assert.ok(n.anim.focus > 0.15, 'dimmed nodes must remain legible')
  assert.ok(n.anim.focus < 1)
})

test('focus transitions rather than snapping', () => {
  const n = node('a')
  advanceNodeAnim(n, 1 / 60, FLOW_ANIM.focusDim)

  assert.ok(n.anim.focus < 1, 'it started moving')
  assert.ok(n.anim.focus > FLOW_ANIM.focusDim, 'but did not arrive in one frame')
})

// ─── Motion by status ────────────────────────────────────────────────────────

test('only running and waiting nodes breathe', () => {
  const moving: FlowNodeStatus[] = ['running', 'waiting']
  const still: FlowNodeStatus[] = ['idle', 'queued', 'success', 'warning', 'failed', 'skipped']

  for (const status of moving) {
    const n = node('a', status)
    const samples = [0, 0.5, 1.2, 2.4].map(t => breatheScale(n, t))
    assert.ok(new Set(samples).size > 1, `${status} should breathe`)
  }

  for (const status of still) {
    const n = node('a', status)
    for (const t of [0, 0.5, 1.2, 2.4]) {
      assert.equal(breatheScale(n, t), 1, `${status} must not move`)
    }
  }
})

test('breathing stays subtle enough to read against', () => {
  const n = node('a', 'running')
  for (let t = 0; t < 10; t += 0.05) {
    const scale = breatheScale(n, t)
    assert.ok(scale > 0.97 && scale < 1.03, `scale ${scale} is too aggressive`)
  }
})

test('running is brighter than success, and success does not move', () => {
  const running = node('a', 'running')
  const success = node('b', 'success')

  assert.ok(borderAlpha(running, 0) > borderAlpha(success, 0))
  assert.ok(glowAlpha(running, false, false) > glowAlpha(success, false, false))
  assert.equal(breatheScale(success, 1.3), 1, 'motion is what separates the two')
})

test('selection outshines every resting status', () => {
  const idle = node('a', 'idle')
  assert.ok(glowAlpha(idle, true, false) > glowAlpha(idle, false, false))
  assert.ok(glowAlpha(idle, false, true) > glowAlpha(idle, false, false))
})

test('completion pulse reports progress and excludes failures', () => {
  const ok = node('a', 'success')
  ok.anim.oneShot = { kind: 'success', age: 0.3, duration: 0.6 }
  assert.equal(completionPulse(ok)?.progress, 0.5)

  const bad = node('b', 'failed')
  bad.anim.oneShot = { kind: 'failed', age: 0.2, duration: 0.45 }
  assert.equal(completionPulse(bad), null, 'failure uses the shake, not the ring')
})

// ─── Particles ───────────────────────────────────────────────────────────────

test('particles advance forward and retire at the end', () => {
  const state = createFlowState({ particles: [particle('p1')] })

  advanceFlowAnimations(state, 0.1, { focusSet: null, speed: 1 })
  assert.equal(state.particles.length, 1)
  assert.ok(state.particles[0].progress > 0, 'progress only ever increases')

  // Each call advances at most one frame's worth, so run it to completion.
  let completed = false
  for (let i = 0; i < 40 && !completed; i++) {
    completed = advanceFlowAnimations(state, 0.1, { focusSet: null, speed: 1 })
  }

  assert.equal(completed, true)
  assert.equal(state.particles.length, 0)
})

test('reverse particles still advance 0 → 1', () => {
  const reversed = { ...particle('p1'), reverse: true }
  const state = createFlowState({ particles: [reversed] })

  advanceFlowAnimations(state, 0.3, { focusSet: null, speed: 1 })

  assert.ok(state.particles[0].progress > 0, 'direction is a flag, not a negative rate')
  assert.equal(state.particles[0].reverse, true)
})

test('playback speed scales particle travel', () => {
  const slow = createFlowState({ particles: [particle('p1')] })
  const fast = createFlowState({ particles: [particle('p1')] })

  advanceFlowAnimations(slow, 0.2, { focusSet: null, speed: 1 })
  advanceFlowAnimations(fast, 0.2, { focusSet: null, speed: 4 })

  assert.ok(fast.particles[0].progress > slow.particles[0].progress)
})

test('concurrent particles all advance', () => {
  const state = createFlowState({ particles: [particle('p1'), particle('p2'), particle('p3')] })
  advanceFlowAnimations(state, 0.2, { focusSet: null, speed: 1 })

  assert.equal(state.particles.length, 3)
  for (const p of state.particles) assert.ok(p.progress > 0)
})

test('retiring one particle does not disturb its neighbours', () => {
  // The loop compacts the array in place; an off-by-one would drop live ones.
  const state = createFlowState({
    particles: [
      { ...particle('done'), progress: 0.99 },
      { ...particle('mid'), progress: 0.2 },
      { ...particle('new'), progress: 0 },
    ],
  })

  advanceFlowAnimations(state, 0.05, { focusSet: null, speed: 1 })

  assert.deepEqual(state.particles.map(p => p.id), ['mid', 'new'])
})

test('a seek can reconstruct in-flight particles from their spawn time', () => {
  // Mirrors what seekTo does: progress is a pure function of elapsed time, so
  // scrubbing to a moment shows the same transfers the live run showed.
  const spawnedAt = 10
  const progressAt = (t: number) => (t - spawnedAt) * FLOW_ANIM.particleSpeed

  assert.equal(progressAt(10), 0, 'at the transfer instant it has not moved')
  assert.ok(progressAt(10.5) > 0 && progressAt(10.5) < 1, 'mid-flight halfway through')
  assert.ok(progressAt(12) >= 1, 'and has landed well before two seconds')
})

// ─── Frame budget ────────────────────────────────────────────────────────────

test('a long stall does not fast-forward the animation', () => {
  const state = createFlowState({ particles: [particle('p1')] })

  // A backgrounded tab can hand back a multi-second delta.
  advanceFlowAnimations(state, 30, { focusSet: null, speed: 1 })

  assert.equal(state.particles.length, 1, 'clamped to one frame of work')
  assert.ok(state.particles[0].progress <= FLOW_ANIM.maxDelta * FLOW_ANIM.particleSpeed + 1e-9)
})

test('edges fade in and stop at full opacity', () => {
  const state = createFlowState({
    edges: [{ id: 'e1', source: 'a', target: 'b', kind: 'data', createdAt: 0, opacity: 0 }],
  })

  for (let i = 0; i < 120; i++) advanceFlowAnimations(state, 1 / 60, { focusSet: null, speed: 1 })
  assert.equal(state.edges[0].opacity, 1)
})

test('animation mutates in place so the frame loop allocates nothing', () => {
  const nodes = new Map([['a', node('a', 'running')]])
  const particles = [particle('p1')]
  const state = createFlowState({ nodes, particles })

  const nodeRef = state.nodes.get('a')!
  const animRef = nodeRef.anim

  advanceFlowAnimations(state, 1 / 60, { focusSet: null, speed: 1 })

  assert.equal(state.nodes, nodes, 'the node map is not rebuilt')
  assert.equal(state.nodes.get('a'), nodeRef, 'nor are node objects')
  assert.equal(state.nodes.get('a')!.anim, animRef, 'anim is shared by reference on purpose')
  assert.equal(state.particles, particles, 'particles are compacted in place')
})
