import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveEdgeId,
  impliedEdgeKind,
  impliedStatus,
  parseFlowJsonl,
  serializeFlowJsonl,
  sortFlowEvents,
  validateFlowEvent,
  type FlowEvent,
} from './events'

function makeEvent(overrides: Partial<FlowEvent> = {}): FlowEvent {
  return {
    eventId: 'evt_1',
    runId: 'run_1',
    timestamp: '2026-08-03T22:00:00.000Z',
    eventType: 'node.started',
    ...overrides,
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

test('accepts the documented event shape', () => {
  const result = validateFlowEvent({
    eventId: 'evt_123',
    runId: 'run_456',
    timestamp: '2026-08-03T22:00:00.000Z',
    eventType: 'node.started',
    node: { id: 'heatmap-api', type: 'api', label: 'Heatmap API' },
    parentNodeId: 'market-analysis',
    metadata: { summary: 'Fetching dealer positioning data' },
  })

  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.equal(result.event.node?.id, 'heatmap-api')
  assert.equal(result.event.parentNodeId, 'market-analysis')
  assert.equal(result.event.metadata?.summary, 'Fetching dealer positioning data')
})

test('rejects events missing structural fields', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'nope'],
    ['missing eventId', { runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.started' }],
    ['missing runId', { eventId: 'e', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.started' }],
    ['bad timestamp', { eventId: 'e', runId: 'r', timestamp: 'yesterday', eventType: 'node.started' }],
    ['unknown eventType', { eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.exploded' }],
    ['unknown node.type', {
      eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.started',
      node: { id: 'n', type: 'quantum_flux', label: 'x' },
    }],
  ]

  for (const [name, raw] of cases) {
    const result = validateFlowEvent(raw)
    assert.equal(result.ok, false, `expected rejection: ${name}`)
  }
})

test('drops malformed cosmetic fields instead of rejecting the event', () => {
  const result = validateFlowEvent({
    eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.progress',
    metadata: {
      progress: 'halfway',
      status: 'exploded',
      attempt: 'two',
      summary: 42,
      error: { code: 'E1' },
      customDomainField: { keep: 'me' },
    },
  })

  assert.ok(result.ok)
  const md = result.event.metadata!
  assert.equal(md.progress, undefined)
  assert.equal(md.status, undefined)
  assert.equal(md.attempt, undefined)
  assert.equal(md.summary, undefined)
  assert.equal(md.error, undefined, 'error without message is dropped')
  assert.deepEqual(md.customDomainField, { keep: 'me' }, 'unknown keys pass through')
})

test('clamps progress and confidence to 0..1', () => {
  const result = validateFlowEvent({
    eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'log.created',
    metadata: {
      progress: 4.2,
      log: { phase: 'risk_analysis', summary: 'checking', confidence: -3 },
    },
  })

  assert.ok(result.ok)
  assert.equal(result.event.metadata?.progress, 1)
  assert.equal(result.event.metadata?.log?.confidence, 0)
})

test('keeps the full structured log shape', () => {
  const result = validateFlowEvent({
    eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'log.created',
    node: { id: 'risk-engine', type: 'task', label: 'Risk Engine' },
    metadata: {
      log: {
        phase: 'risk_analysis',
        summary: 'Checking whether the proposed trade meets risk limits',
        reason: 'Current exposure may exceed the configured maximum',
        action: 'fetch_broker_positions',
        observation: 'Current portfolio delta is -0.18',
        result: 'Risk check passed',
        next_step: 'generate_trade_decision',
      },
    },
  })

  assert.ok(result.ok)
  const log = result.event.metadata!.log!
  assert.equal(log.phase, 'risk_analysis')
  assert.equal(log.action, 'fetch_broker_positions')
  assert.equal(log.next_step, 'generate_trade_decision')
})

test('drops a log missing phase or summary', () => {
  const result = validateFlowEvent({
    eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'log.created',
    metadata: { log: { reason: 'no phase, no summary' } },
  })

  assert.ok(result.ok)
  assert.equal(result.event.metadata?.log, undefined)
})

test('falls back to node id when label is absent', () => {
  const result = validateFlowEvent({
    eventId: 'e', runId: 'r', timestamp: '2026-08-03T22:00:00.000Z', eventType: 'node.created',
    node: { id: 'broker-api', type: 'api' },
  })

  assert.ok(result.ok)
  assert.equal(result.event.node?.label, 'broker-api')
})

// ─── Implied semantics ───────────────────────────────────────────────────────

test('derives node status from event type', () => {
  assert.equal(impliedStatus(makeEvent({ eventType: 'node.queued' })), 'queued')
  assert.equal(impliedStatus(makeEvent({ eventType: 'node.started' })), 'running')
  assert.equal(impliedStatus(makeEvent({ eventType: 'node.waiting' })), 'waiting')
  assert.equal(impliedStatus(makeEvent({ eventType: 'node.completed' })), 'success')
  assert.equal(impliedStatus(makeEvent({ eventType: 'node.failed' })), 'failed')
})

test('explicit metadata.status overrides the implied status', () => {
  const event = makeEvent({ eventType: 'node.completed', metadata: { status: 'warning' } })
  assert.equal(impliedStatus(event), 'warning')
})

test('status-neutral events do not change node status', () => {
  assert.equal(impliedStatus(makeEvent({ eventType: 'log.created' })), null)
  assert.equal(impliedStatus(makeEvent({ eventType: 'edge.created' })), null)
  assert.equal(impliedStatus(makeEvent({ eventType: 'data.transferred' })), null)
})

test('derives edge kind from event type', () => {
  assert.equal(impliedEdgeKind(makeEvent({ eventType: 'tool.called' })), 'request')
  assert.equal(impliedEdgeKind(makeEvent({ eventType: 'tool.returned' })), 'response')
  assert.equal(impliedEdgeKind(makeEvent({ eventType: 'agent.handoff' })), 'handoff')
  assert.equal(impliedEdgeKind(makeEvent({ eventType: 'data.transferred' })), 'data')
  assert.equal(impliedEdgeKind(makeEvent({ eventType: 'edge.created' })), 'control')
})

test('explicit edge.kind wins over the implied kind', () => {
  const event = makeEvent({
    eventType: 'data.transferred',
    edge: { source: 'a', target: 'b', kind: 'handoff' },
  })
  assert.equal(impliedEdgeKind(event), 'handoff')
})

test('edge ids are deterministic, so the same edge is never duplicated', () => {
  assert.equal(deriveEdgeId('a', 'b', 'data'), deriveEdgeId('a', 'b', 'data'))
  assert.notEqual(deriveEdgeId('a', 'b', 'data'), deriveEdgeId('b', 'a', 'data'))
  assert.notEqual(deriveEdgeId('a', 'b', 'data'), deriveEdgeId('a', 'b', 'request'))
})

// ─── JSONL codec ─────────────────────────────────────────────────────────────

test('JSONL round-trips without loss', () => {
  const events: FlowEvent[] = [
    makeEvent({ eventId: 'e1', eventType: 'run.started', metadata: { summary: 'Trading run' } }),
    makeEvent({
      eventId: 'e2',
      eventType: 'node.started',
      node: { id: 'heatmap-api', type: 'api', label: 'Heatmap API', group: 'market-data' },
      parentNodeId: 'market-analysis',
      metadata: { summary: 'Fetching dealer positioning', bytes: 4096 },
    }),
    makeEvent({
      eventId: 'e3',
      eventType: 'node.failed',
      node: { id: 'broker-api', type: 'api', label: 'Broker API' },
      metadata: { error: { message: 'timeout', code: 'ETIMEDOUT', retryable: true }, attempt: 2 },
    }),
  ]

  const { events: parsed, errors } = parseFlowJsonl(serializeFlowJsonl(events))

  assert.deepEqual(errors, [])
  assert.deepEqual(parsed, events)
})

test('a corrupt line is reported without losing the surrounding events', () => {
  const good = serializeFlowJsonl([makeEvent({ eventId: 'a' }), makeEvent({ eventId: 'b' })])
  const jsonl = good.trimEnd().split('\n')
  const withGarbage = [jsonl[0], '{ not json', '', jsonl[1]].join('\n')

  const { events, errors } = parseFlowJsonl(withGarbage)

  assert.equal(events.length, 2)
  assert.deepEqual(events.map(e => e.eventId), ['a', 'b'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 2, 'blank lines are skipped, not reported')
})

test('empty input parses to an empty result', () => {
  assert.deepEqual(parseFlowJsonl(''), { events: [], errors: [] })
  assert.equal(serializeFlowJsonl([]), '')
})

// ─── Ordering ────────────────────────────────────────────────────────────────

test('sorts by seq when every event has one', () => {
  const events = [
    makeEvent({ eventId: 'c', seq: 3, timestamp: '2026-08-03T22:00:00.000Z' }),
    makeEvent({ eventId: 'a', seq: 1, timestamp: '2026-08-03T22:00:09.000Z' }),
    makeEvent({ eventId: 'b', seq: 2, timestamp: '2026-08-03T22:00:05.000Z' }),
  ]
  assert.deepEqual(sortFlowEvents(events).map(e => e.eventId), ['a', 'b', 'c'])
})

test('falls back to timestamp when seq is not universal', () => {
  const events = [
    makeEvent({ eventId: 'late', timestamp: '2026-08-03T22:00:09.000Z' }),
    makeEvent({ eventId: 'early', seq: 99, timestamp: '2026-08-03T22:00:01.000Z' }),
  ]
  assert.deepEqual(sortFlowEvents(events).map(e => e.eventId), ['early', 'late'])
})

test('sorting is stable for identical keys', () => {
  const ts = '2026-08-03T22:00:00.000Z'
  const events = [
    makeEvent({ eventId: 'first', timestamp: ts }),
    makeEvent({ eventId: 'second', timestamp: ts }),
    makeEvent({ eventId: 'third', timestamp: ts }),
  ]
  assert.deepEqual(sortFlowEvents(events).map(e => e.eventId), ['first', 'second', 'third'])
})
