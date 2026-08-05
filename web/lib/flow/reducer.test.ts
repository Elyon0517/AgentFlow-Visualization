import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FlowEvent, FlowEventType, FlowNodeType } from './events'
import { createFlowState, type FlowState } from './graph'
import { MOCK_TRADING_WORKFLOW } from './mock-trading-workflow'
import { activeEdgeIds, applyFlowEvent, applyFlowEvents, nodeElapsedSeconds, runningNodeIds } from './reducer'

const RUN = 'run_t'
const T0 = Date.parse('2026-08-04T13:30:00.000Z')

let counter = 0
function ev(
  atSeconds: number,
  eventType: FlowEventType,
  extra: Partial<Omit<FlowEvent, 'eventId' | 'runId' | 'timestamp' | 'eventType'>> = {},
): FlowEvent {
  return {
    eventId: `e${++counter}`,
    runId: RUN,
    timestamp: new Date(T0 + atSeconds * 1000).toISOString(),
    eventType,
    ...extra,
  }
}

function node(id: string, type: FlowNodeType = 'task') {
  return { id, type, label: id }
}

function run(events: FlowEvent[]): FlowState {
  return applyFlowEvents(createFlowState(), events)
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────

test('run.started establishes the time origin', () => {
  const state = run([
    ev(0, 'run.started', { metadata: { summary: 'Trading run' } }),
    ev(5, 'node.started', { node: node('a') }),
  ])

  assert.equal(state.run?.runId, RUN)
  assert.equal(state.run?.status, 'running')
  assert.equal(state.run?.label, 'Trading run')
  assert.equal(state.nodes.get('a')?.startedAt, 5)
})

test('bootstraps a run when run.started was never received', () => {
  // A late SSE subscriber joins mid-run; the first event it sees becomes t=0.
  const state = run([ev(100, 'node.started', { node: node('a') })])

  assert.equal(state.run?.runId, RUN)
  assert.equal(state.nodes.get('a')?.startedAt, 0)
})

test('clamps events stamped before the run start', () => {
  const state = run([ev(10, 'run.started'), ev(2, 'node.started', { node: node('a') })])
  assert.equal(state.nodes.get('a')?.startedAt, 0)
})

test('records run completion and failure', () => {
  assert.equal(run([ev(0, 'run.started'), ev(9, 'run.completed')]).run?.status, 'completed')

  const failed = run([
    ev(0, 'run.started'),
    ev(9, 'run.failed', { metadata: { error: { message: 'broker unreachable' } } }),
  ])
  assert.equal(failed.run?.status, 'failed')
  assert.equal(failed.run?.error?.message, 'broker unreachable')
})

// ─── Idempotency ─────────────────────────────────────────────────────────────

test('a duplicate eventId is ignored', () => {
  const duplicate = ev(1, 'node.started', { node: node('a') })
  const once = applyFlowEvent(createFlowState(), duplicate)
  const twice = applyFlowEvent(once, duplicate)

  assert.equal(twice, once, 'returns the identical state object')
  assert.equal(twice.eventLog.length, 1)
})

test('reconnect replay does not duplicate nodes, edges or particles', () => {
  const events = [
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('a') }),
    ev(2, 'data.transferred', { edge: { source: 'a', target: 'b' } }),
  ]
  const first = run(events)
  const replayed = applyFlowEvents(first, events)

  assert.equal(replayed.nodes.size, first.nodes.size)
  assert.equal(replayed.edges.length, first.edges.length)
  assert.equal(replayed.particles.length, first.particles.length)
})

// ─── Node lifecycle ──────────────────────────────────────────────────────────

test('creates a node implicitly from a bare node.started', () => {
  const state = run([ev(1, 'node.started', { node: node('heatmap-api', 'api') })])
  const n = state.nodes.get('heatmap-api')!

  assert.equal(n.type, 'api')
  assert.equal(n.status, 'running')
  assert.equal(n.attempt, 1)
})

test('walks the full status sequence', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.created', { node: node('a') }),
    ev(2, 'node.queued', { node: node('a') }),
    ev(3, 'node.started', { node: node('a') }),
    ev(4, 'node.waiting', { node: node('a'), metadata: { waitingOn: 'broker token' } }),
  ])

  const n = state.nodes.get('a')!
  assert.equal(n.status, 'waiting')
  assert.equal(n.waitingOn, 'broker token')
  assert.equal(n.startedAt, 3, 'startedAt is set once, at the first run')
})

test('completion stamps endedAt and yields elapsed time', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(2, 'node.started', { node: node('a') }),
    ev(6.5, 'node.completed', { node: node('a') }),
  ])

  const n = state.nodes.get('a')!
  assert.equal(n.status, 'success')
  assert.equal(n.endedAt, 6.5)
  assert.equal(nodeElapsedSeconds(n, 99), 4.5)
})

test('a producer-reported duration wins over the derived one', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(2, 'node.started', { node: node('a') }),
    ev(6, 'node.completed', { node: node('a'), metadata: { durationMs: 1500 } }),
  ])
  assert.equal(nodeElapsedSeconds(state.nodes.get('a')!, 99), 1.5)
})

test('a running node reports elapsed time against now', () => {
  const state = run([ev(0, 'run.started'), ev(2, 'node.started', { node: node('a') })])
  assert.equal(nodeElapsedSeconds(state.nodes.get('a')!, 10), 8)
})

test('metadata.status overrides the implied success', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('risk') }),
    ev(2, 'node.completed', { node: node('risk'), metadata: { status: 'warning' } }),
  ])
  assert.equal(state.nodes.get('risk')!.status, 'warning')
})

test('a later event can improve a placeholder label and type', () => {
  const state = run([
    // Referenced as an edge endpoint before it was ever described.
    ev(1, 'edge.created', { edge: { source: 'a', target: 'broker-api' } }),
    ev(2, 'node.started', { node: { id: 'broker-api', type: 'api', label: 'Broker API' } }),
  ])

  const n = state.nodes.get('broker-api')!
  assert.equal(n.type, 'api')
  assert.equal(n.label, 'Broker API')
})

// ─── Retry ───────────────────────────────────────────────────────────────────

test('failure records the error and keeps it visible', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('broker', 'api') }),
    ev(3, 'node.failed', {
      node: node('broker', 'api'),
      metadata: { error: { message: 'Upstream timeout', code: 'ETIMEDOUT', retryable: true }, maxAttempts: 3 },
    }),
  ])

  const n = state.nodes.get('broker')!
  assert.equal(n.status, 'failed')
  assert.equal(n.error?.code, 'ETIMEDOUT')
  assert.equal(n.maxAttempts, 3)
})

test('restarting a failed node increments the attempt counter', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('broker', 'api') }),
    ev(3, 'node.failed', { node: node('broker', 'api'), metadata: { error: { message: 'timeout' } } }),
    ev(4, 'node.started', { node: node('broker', 'api') }),
  ])

  const n = state.nodes.get('broker')!
  assert.equal(n.attempt, 2)
  assert.equal(n.status, 'running')
  assert.equal(n.error, undefined, 'a retry clears the stale failure')
})

test('an explicit attempt number wins over the inferred one', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('broker', 'api') }),
    ev(3, 'node.failed', { node: node('broker', 'api'), metadata: { error: { message: 'x' } } }),
    ev(4, 'node.started', { node: node('broker', 'api'), metadata: { attempt: 7 } }),
  ])
  assert.equal(state.nodes.get('broker')!.attempt, 7)
})

test('retrying keeps one node rather than spawning a second', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('broker', 'api') }),
    ev(2, 'node.failed', { node: node('broker', 'api'), metadata: { error: { message: 'x' } } }),
    ev(3, 'node.started', { node: node('broker', 'api') }),
    ev(4, 'node.completed', { node: node('broker', 'api') }),
  ])

  assert.equal(state.nodes.size, 1)
  assert.equal(state.nodes.get('broker')!.status, 'success')
})

// ─── Edges ───────────────────────────────────────────────────────────────────

test('parentNodeId implies a parent → node edge', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('child'), parentNodeId: 'parent' }),
  ])

  assert.equal(state.edges.length, 1)
  assert.equal(state.edges[0].source, 'parent')
  assert.equal(state.edges[0].target, 'child')
})

test('an explicit edge and an inferred one collapse into a single edge', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'edge.created', { edge: { source: 'a', target: 'b', kind: 'data' } }),
    ev(2, 'data.transferred', { node: node('b'), parentNodeId: 'a' }),
    ev(3, 'data.transferred', { edge: { source: 'a', target: 'b', kind: 'data' } }),
  ])

  assert.equal(state.edges.length, 1, 'deterministic edge ids prevent duplicates')
})

test('an unknown endpoint becomes a visible placeholder node', () => {
  const state = run([ev(1, 'edge.created', { edge: { source: 'ghost', target: 'b' } })])

  assert.ok(state.nodes.has('ghost'), 'a dropped edge would be undebuggable')
  assert.equal(state.edges.length, 1)
})

test('self-edges are rejected', () => {
  const state = run([ev(1, 'edge.created', { edge: { source: 'a', target: 'a' } })])
  assert.equal(state.edges.length, 0)
})

// ─── Particles ───────────────────────────────────────────────────────────────

test('a transfer spawns a forward particle on its edge', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'data.transferred', { edge: { source: 'a', target: 'b', kind: 'data' } }),
  ])

  assert.equal(state.particles.length, 1)
  const p = state.particles[0]
  assert.equal(p.kind, 'data')
  assert.equal(p.progress, 0, 'progress always starts at 0')
  assert.equal(p.reverse, false)

  const edge = state.edges.find(e => e.id === p.edgeId)!
  assert.equal(edge.source, 'a')
  assert.equal(edge.target, 'b')
})

test('a response travels backwards along the existing forward edge', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'tool.called', { edge: { source: 'agent', target: 'tool', kind: 'request' } }),
    ev(2, 'tool.returned', { edge: { source: 'tool', target: 'agent', kind: 'response' } }),
  ])

  assert.equal(state.edges.length, 1, 'no second, backwards edge is created')
  const response = state.particles[1]
  assert.equal(response.reverse, true)
  assert.equal(response.progress, 0, 'direction is a flag, not a reversed progress')
})

test('memory.read reuses the outbound channel', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'memory.read', { node: node('memory-store', 'memory'), parentNodeId: 'agent' }),
  ])

  assert.equal(state.edges.length, 1)
  assert.equal(state.edges[0].source, 'agent')
  assert.equal(state.edges[0].target, 'memory-store')
  assert.equal(state.particles[0].reverse, true, 'the payload flows back to the reader')
})

test('concurrent transfers produce simultaneous particles on distinct edges', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'data.transferred', { edge: { source: 'src', target: 'heatmap', kind: 'data' } }),
    ev(1, 'data.transferred', { edge: { source: 'src', target: 'broker', kind: 'data' } }),
  ])

  assert.equal(state.particles.length, 2)
  assert.notEqual(state.particles[0].edgeId, state.particles[1].edgeId)
})

test('payload size scales the particle, with a ceiling', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'data.transferred', { edge: { source: 'a', target: 'b', kind: 'data' } }),
    ev(2, 'data.transferred', { edge: { source: 'a', target: 'c', kind: 'data' }, metadata: { bytes: 200_000 } }),
  ])

  const [small, large] = state.particles
  assert.ok(large.size > small.size)
  assert.ok(large.size <= small.size * 2, 'log scale keeps a 200 KB payload from dwarfing the graph')
})

test('particles are capped so a burst cannot grow without bound', () => {
  const events = [ev(0, 'run.started')]
  for (let i = 0; i < 600; i++) {
    events.push(ev(1 + i * 0.001, 'data.transferred', { edge: { source: 'a', target: `n${i}`, kind: 'data' } }))
  }

  assert.equal(run(events).particles.length, 400)
})

// ─── Structured logs ─────────────────────────────────────────────────────────

test('logs land on the node and in the global stream', () => {
  const entry = {
    phase: 'risk_analysis',
    summary: 'Checking whether the proposed trade meets risk limits',
    reason: 'Current exposure may exceed the configured maximum',
    action: 'fetch_broker_positions',
    observation: 'Current portfolio delta is -0.18',
    result: 'Risk check passed',
    next_step: 'generate_trade_decision',
  }

  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('risk-engine') }),
    ev(2, 'log.created', { node: node('risk-engine'), metadata: { log: entry } }),
  ])

  assert.deepEqual(state.nodes.get('risk-engine')!.logs, [entry])
  assert.equal(state.logs.length, 1)
  assert.equal(state.logs[0].nodeId, 'risk-engine')
  assert.equal(state.logs[0].at, 2)
})

test('log.created does not change node status', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('a') }),
    ev(2, 'log.created', { node: node('a'), metadata: { log: { phase: 'p', summary: 's' } } }),
  ])
  assert.equal(state.nodes.get('a')!.status, 'running')
})

// ─── Detail accumulation ─────────────────────────────────────────────────────

test('collects request/response pairs for the detail popup', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('api', 'api'), metadata: { request: 'GET /v2/heatmap' } }),
    ev(2, 'node.completed', { node: node('api', 'api'), metadata: { response: 'HTTP 200, 48 KB', durationMs: 900 } }),
  ])

  const n = state.nodes.get('api')!
  assert.equal(n.requests.length, 2)
  assert.equal(n.requests[0].request, 'GET /v2/heatmap')
  assert.equal(n.requests[1].response, 'HTTP 200, 48 KB')
})

test('tokens and cost accumulate across events', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('llm', 'llm'), metadata: { tokens: 1000, cost: 0.01 } }),
    ev(2, 'node.completed', { node: node('llm', 'llm'), metadata: { tokens: 820, cost: 0.005 } }),
  ])

  const n = state.nodes.get('llm')!
  assert.equal(n.tokens, 1820)
  assert.ok(Math.abs(n.cost! - 0.015) < 1e-9)
})

test('leaving waiting clears the dependency label', () => {
  // The unblocking event usually carries no metadata at all, so the clear
  // cannot live in metadata handling.
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.waiting', { node: node('a'), metadata: { waitingOn: 'broker token' } }),
    ev(2, 'node.started', { node: node('a') }),
  ])
  assert.equal(state.nodes.get('a')!.waitingOn, undefined)
})

test('failing out of waiting also clears the dependency label', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.waiting', { node: node('a'), metadata: { waitingOn: 'broker token' } }),
    ev(2, 'node.failed', { node: node('a'), metadata: { error: { message: 'gave up' } } }),
  ])

  const n = state.nodes.get('a')!
  assert.equal(n.waitingOn, undefined)
  assert.equal(n.error?.message, 'gave up')
})

// ─── Derived queries ─────────────────────────────────────────────────────────

test('reports every concurrently running node', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('heatmap', 'api') }),
    ev(1, 'node.started', { node: node('broker', 'api') }),
    ev(2, 'node.completed', { node: node('heatmap', 'api') }),
    ev(3, 'node.waiting', { node: node('gex') }),
  ])

  assert.deepEqual(runningNodeIds(state).sort(), ['broker', 'gex'])
})

test('edge activity decays out of the current-path highlight', () => {
  const state = run([
    ev(0, 'run.started'),
    ev(1, 'data.transferred', { edge: { source: 'a', target: 'b', kind: 'data' } }),
  ])
  const edgeId = state.edges[0].id

  assert.ok(activeEdgeIds({ ...state, particles: [] }, 2).has(edgeId), 'recent traffic stays lit')
  assert.equal(activeEdgeIds({ ...state, particles: [] }, 60).has(edgeId), false, 'old traffic fades out')
  assert.ok(activeEdgeIds(state, 60).has(edgeId), 'an in-flight particle keeps it lit regardless')
})

// ─── Determinism ─────────────────────────────────────────────────────────────

test('replaying the same events twice yields identical layout seeds', () => {
  const events = [
    ev(0, 'run.started'),
    ev(1, 'node.started', { node: node('a') }),
    ev(2, 'node.started', { node: node('b'), parentNodeId: 'a' }),
    ev(3, 'node.started', { node: node('c'), parentNodeId: 'a' }),
  ]

  const first = run(events)
  const second = run(events)

  for (const [id, n] of first.nodes) {
    const other = second.nodes.get(id)!
    assert.equal(n.x, other.x, `${id} x`)
    assert.equal(n.y, other.y, `${id} y`)
  }
})

// ─── The mock workflow, end to end ───────────────────────────────────────────

test('mock workflow: every node reaches a terminal state', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])

  assert.equal(state.run?.status, 'completed')
  for (const [id, n] of state.nodes) {
    assert.ok(
      ['success', 'warning', 'failed', 'skipped'].includes(n.status),
      `${id} ended as ${n.status}`,
    )
  }
})

test('mock workflow: covers every node type', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])
  const types = new Set([...state.nodes.values()].map(n => n.type))

  for (const type of ['orchestrator', 'agent', 'task', 'api', 'data_source', 'llm', 'memory', 'decision'] as const) {
    assert.ok(types.has(type), `missing node type: ${type}`)
  }
})

test('mock workflow: the two APIs run concurrently', () => {
  // Replay only up to the point where both should be in flight.
  const upTo = MOCK_TRADING_WORKFLOW.filter(e => Date.parse(e.timestamp) <= Date.parse('2026-08-04T13:30:06.000Z'))
  const state = run([...upTo])

  const running = new Set(runningNodeIds(state))
  assert.ok(running.has('heatmap-api'), 'heatmap should be in flight')
  assert.ok(running.has('broker-api'), 'broker should be in flight at the same time')
})

test('mock workflow: the broker failure is followed by a successful retry', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])
  const broker = state.nodes.get('broker-api')!

  assert.equal(broker.status, 'success')
  assert.equal(broker.attempt, 2, 'the retry is visible as attempt 2')
  assert.ok(
    broker.requests.some(r => r.error?.includes('timeout')),
    'the original failure stays in the request history',
  )
})

test('mock workflow: risk engine ends in warning, not plain success', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])
  assert.equal(state.nodes.get('risk-engine')!.status, 'warning')
})

test('mock workflow: lays out left to right along the pipeline', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])
  const depth = (id: string) => state.nodes.get(id)!.depth

  assert.ok(depth('tradingview-signal') < depth('market-data'))
  assert.ok(depth('market-data') < depth('heatmap-api'))
  assert.equal(depth('heatmap-api'), depth('broker-api'), 'parallel calls share a column')
  assert.ok(depth('heatmap-api') < depth('gex-vex-analysis'))
  assert.ok(depth('gex-vex-analysis') < depth('strategy-engine'))
  assert.ok(depth('strategy-engine') < depth('risk-engine'))
  assert.ok(depth('risk-engine') < depth('llm-analysis'))
  assert.ok(depth('llm-analysis') < depth('trade-decision'))
})

test('mock workflow: carries structured logs on the analysis nodes', () => {
  const state = run([...MOCK_TRADING_WORKFLOW])

  const risk = state.nodes.get('risk-engine')!
  assert.equal(risk.logs.length, 1)
  assert.equal(risk.logs[0].phase, 'risk_analysis')
  assert.equal(risk.logs[0].action, 'fetch_broker_positions')

  assert.ok(state.logs.length >= 4, 'the Logs view has content from several phases')
  const phases = new Set(state.logs.map(l => l.log.phase))
  assert.ok(phases.has('signal_ingest') && phases.has('exposure_analysis') && phases.has('strategy_selection'))
})

test('mock workflow: survives a JSONL round-trip unchanged', async () => {
  const { parseFlowJsonl, serializeFlowJsonl } = await import('./events')
  const { events, errors } = parseFlowJsonl(serializeFlowJsonl(MOCK_TRADING_WORKFLOW))

  assert.deepEqual(errors, [])

  const live = run([...MOCK_TRADING_WORKFLOW])
  const replayed = run(events)

  assert.equal(replayed.nodes.size, live.nodes.size)
  assert.equal(replayed.edges.length, live.edges.length)
  for (const [id, n] of live.nodes) {
    const other = replayed.nodes.get(id)!
    assert.equal(other.status, n.status, `${id} status`)
    assert.equal(other.attempt, n.attempt, `${id} attempt`)
    assert.equal(other.depth, n.depth, `${id} depth`)
  }
})
