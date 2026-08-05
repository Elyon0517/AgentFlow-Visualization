/**
 * Demo workflow: an options trading pipeline.
 *
 * Exercises every feature the generic visualizer is meant to support, so it
 * doubles as a manual test fixture:
 *
 *   - all nine node types
 *   - a fan-out into two concurrent API calls that rejoin
 *   - a `waiting` state with a named dependency
 *   - a failure followed by a successful retry (attempt badge)
 *   - a `warning` terminal state distinct from plain success
 *   - an agent handoff mid-run
 *   - memory read at the start and write at the end
 *   - structured logs carrying reason / observation / result
 *
 * Shape:
 *
 *   TradingView Signal → Market Data ─┬─► Heatmap API ─┐
 *                                     └─► Broker API  ─┴─► GEX/VEX → Strategy
 *                                          → Risk → LLM Analysis → Trade Decision
 */

import type { FlowEvent, FlowEventType, FlowNodeType, StructuredLog } from './events'

const RUN_ID = 'run_mock_trading_001'
/** Fixed epoch so replay, screenshots, and tests are byte-identical. */
const RUN_START_MS = Date.parse('2026-08-04T13:30:00.000Z')

// ─── Builder ─────────────────────────────────────────────────────────────────

interface EmitOptions {
  node?: { id: string; type: FlowNodeType; label: string; group?: string }
  parentNodeId?: string
  edge?: { source: string; target: string; kind?: 'request' | 'response' | 'data' | 'handoff' | 'error' | 'control'; label?: string }
  metadata?: Record<string, unknown>
}

function createBuilder() {
  const events: FlowEvent[] = []
  let seq = 0

  function emit(atSeconds: number, eventType: FlowEventType, options: EmitOptions = {}): void {
    seq++
    events.push({
      eventId: `evt_${String(seq).padStart(3, '0')}`,
      runId: RUN_ID,
      timestamp: new Date(RUN_START_MS + atSeconds * 1000).toISOString(),
      eventType,
      seq,
      ...(options.node ? { node: options.node } : {}),
      ...(options.parentNodeId ? { parentNodeId: options.parentNodeId } : {}),
      ...(options.edge ? { edge: options.edge } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    } as FlowEvent)
  }

  return { events, emit }
}

// ─── Node catalogue ──────────────────────────────────────────────────────────
// Business identity lives here as data. The renderer only ever sees `type`.

const N = {
  orchestrator: { id: 'strategy-orchestrator', type: 'orchestrator' as const, label: 'Strategy Orchestrator' },
  analysisAgent: { id: 'analysis-agent', type: 'agent' as const, label: 'Analysis Agent' },
  memory: { id: 'memory-store', type: 'memory' as const, label: 'Memory Store' },
  signal: { id: 'tradingview-signal', type: 'data_source' as const, label: 'TradingView Signal', group: 'ingest' },
  marketData: { id: 'market-data', type: 'data_source' as const, label: 'Market Data', group: 'ingest' },
  heatmap: { id: 'heatmap-api', type: 'api' as const, label: 'Heatmap API', group: 'market-data' },
  broker: { id: 'broker-api', type: 'api' as const, label: 'Broker API', group: 'market-data' },
  gex: { id: 'gex-vex-analysis', type: 'task' as const, label: 'GEX/VEX Analysis', group: 'analytics' },
  strategy: { id: 'strategy-engine', type: 'task' as const, label: 'Strategy Engine', group: 'analytics' },
  risk: { id: 'risk-engine', type: 'task' as const, label: 'Risk Engine', group: 'analytics' },
  llm: { id: 'llm-analysis', type: 'llm' as const, label: 'LLM Analysis', group: 'analytics' },
  decision: { id: 'trade-decision', type: 'decision' as const, label: 'Trade Decision', group: 'execution' },
}

function log(entry: StructuredLog): { log: StructuredLog } {
  return { log: entry }
}

// ─── Scenario ────────────────────────────────────────────────────────────────

function buildMockTradingWorkflow(): FlowEvent[] {
  const { events, emit } = createBuilder()

  emit(0, 'run.started', { metadata: { summary: 'SPY 0DTE signal evaluation' } })

  // ── Orchestrator boots and recalls prior context ──
  emit(0.2, 'node.started', {
    node: N.orchestrator,
    metadata: { summary: 'Evaluating incoming signal' },
  })

  emit(0.5, 'memory.read', {
    node: N.memory,
    parentNodeId: N.orchestrator.id,
    metadata: {
      summary: 'Recalling open positions and today’s realized P&L',
      bytes: 2048,
      outputSummary: '2 open positions, realized P&L +$430',
    },
  })
  emit(1.0, 'node.completed', { node: N.memory, metadata: { summary: 'Context loaded' } })

  // ── Step 1: TradingView signal ──
  emit(1.2, 'node.started', {
    node: N.signal,
    parentNodeId: N.orchestrator.id,
    metadata: { summary: 'Reading webhook payload' },
  })
  emit(1.6, 'log.created', {
    node: N.signal,
    metadata: log({
      phase: 'signal_ingest',
      summary: 'Validating the inbound TradingView alert',
      reason: 'Alerts can arrive duplicated or stale after a reconnect',
      action: 'verify_signal_freshness',
      observation: 'Alert timestamp is 1.2s old, within the 5s window',
      result: 'Signal accepted',
      next_step: 'fetch_market_data',
      confidence: 0.94,
    }),
  })
  emit(2.4, 'node.completed', {
    node: N.signal,
    metadata: { summary: 'SPY 0DTE long signal', outputSummary: 'SPY 0DTE call, strength 0.72, bias long' },
  })

  // ── Step 2: Market data ──
  emit(2.6, 'data.transferred', {
    edge: { source: N.signal.id, target: N.marketData.id, kind: 'data', label: 'signal' },
    metadata: { bytes: 512 },
  })
  emit(2.7, 'node.started', {
    node: N.marketData,
    parentNodeId: N.signal.id,
    metadata: { summary: 'Fetching chain + underlying quotes', inputSummary: 'SPY, 0DTE expiry' },
  })
  emit(3.6, 'node.progress', { node: N.marketData, metadata: { progress: 0.55, summary: 'Loaded 412 of 750 contracts' } })
  emit(4.8, 'node.completed', {
    node: N.marketData,
    metadata: { summary: 'Chain loaded', outputSummary: '750 contracts, spot 621.40', bytes: 184_320, durationMs: 2100 },
  })

  // ── Step 3: two APIs in parallel ──
  emit(5.0, 'data.transferred', {
    edge: { source: N.marketData.id, target: N.heatmap.id, kind: 'data', label: 'chain' },
    metadata: { bytes: 92_160 },
  })
  emit(5.0, 'data.transferred', {
    edge: { source: N.marketData.id, target: N.broker.id, kind: 'data', label: 'symbols' },
    metadata: { bytes: 1024 },
  })

  emit(5.1, 'node.started', {
    node: N.heatmap,
    parentNodeId: N.marketData.id,
    metadata: { summary: 'Fetching dealer positioning data', request: 'GET /v2/heatmap?symbol=SPY&expiry=0dte' },
  })
  emit(5.1, 'node.started', {
    node: N.broker,
    parentNodeId: N.marketData.id,
    metadata: { summary: 'Fetching account positions', request: 'GET /v1/accounts/positions' },
  })

  emit(6.0, 'node.progress', { node: N.heatmap, metadata: { progress: 0.4 } })

  // Broker stalls on an upstream dependency, then fails.
  emit(6.4, 'node.waiting', {
    node: N.broker,
    metadata: { summary: 'Waiting on broker session', waitingOn: 'broker session token refresh' },
  })
  emit(8.2, 'node.failed', {
    node: N.broker,
    metadata: {
      summary: 'Request timed out',
      error: { message: 'Upstream timeout after 3000ms', code: 'ETIMEDOUT', retryable: true },
      attempt: 1,
      maxAttempts: 3,
      response: 'HTTP 504 Gateway Timeout',
    },
  })

  emit(8.6, 'node.completed', {
    node: N.heatmap,
    metadata: {
      summary: 'Dealer positioning retrieved',
      outputSummary: 'Gamma flip 619.80, call wall 625, put wall 615',
      response: 'HTTP 200, 48 KB',
      bytes: 49_152,
      durationMs: 3500,
    },
  })

  // ── Retry ──
  emit(9.0, 'node.queued', { node: N.broker, metadata: { summary: 'Retrying after backoff', attempt: 2 } })
  emit(9.6, 'node.started', {
    node: N.broker,
    metadata: { summary: 'Fetching account positions (retry 2/3)', attempt: 2, request: 'GET /v1/accounts/positions' },
  })
  emit(11.0, 'node.completed', {
    node: N.broker,
    metadata: {
      summary: 'Positions retrieved',
      outputSummary: 'Net delta -0.18, buying power $42,300',
      response: 'HTTP 200, 6 KB',
      attempt: 2,
      durationMs: 1400,
    },
  })

  // ── Step 4: GEX/VEX analysis (fan-in) ──
  emit(11.2, 'data.transferred', {
    edge: { source: N.heatmap.id, target: N.gex.id, kind: 'data', label: 'dealer gamma' },
    metadata: { bytes: 49_152 },
  })
  emit(11.2, 'data.transferred', {
    edge: { source: N.broker.id, target: N.gex.id, kind: 'data', label: 'positions' },
    metadata: { bytes: 6144 },
  })
  emit(11.4, 'node.started', {
    node: N.gex,
    parentNodeId: N.heatmap.id,
    metadata: { summary: 'Computing gamma and vanna exposure' },
  })
  emit(12.0, 'log.created', {
    node: N.gex,
    metadata: log({
      phase: 'exposure_analysis',
      summary: 'Estimating dealer hedging pressure around spot',
      reason: 'Spot is sitting between the gamma flip and the call wall',
      action: 'compute_gex_vex_profile',
      observation: 'Net GEX +2.1B, VEX -340M, flip at 619.80',
      result: 'Positive gamma regime — mean reversion favoured',
      next_step: 'evaluate_strategy',
      confidence: 0.81,
    }),
  })
  emit(13.8, 'node.completed', {
    node: N.gex,
    metadata: { summary: 'Positive gamma regime', outputSummary: 'GEX +2.1B, flip 619.80, pin risk at 620' },
  })

  // ── Step 5: Strategy engine ──
  emit(14.0, 'data.transferred', {
    edge: { source: N.gex.id, target: N.strategy.id, kind: 'data', label: 'exposure profile' },
  })
  emit(14.1, 'node.started', {
    node: N.strategy,
    parentNodeId: N.gex.id,
    metadata: { summary: 'Selecting strategy for the regime' },
  })
  emit(14.8, 'log.created', {
    node: N.strategy,
    metadata: log({
      phase: 'strategy_selection',
      summary: 'Choosing between a debit spread and an iron condor',
      reason: 'Positive gamma with a nearby pin favours a defined-risk premium sell',
      action: 'rank_candidate_strategies',
      observation: 'Iron condor scores 0.78 vs debit spread 0.51',
      result: 'Iron condor 615/618/623/626 selected',
      next_step: 'risk_analysis',
      confidence: 0.78,
    }),
  })
  emit(16.4, 'node.completed', {
    node: N.strategy,
    metadata: { summary: 'Iron condor selected', outputSummary: '615/618/623/626, credit $1.12, max loss $188' },
  })

  // ── Step 6: Risk engine — completes with a warning, not a clean pass ──
  emit(16.6, 'data.transferred', {
    edge: { source: N.strategy.id, target: N.risk.id, kind: 'data', label: 'proposed trade' },
  })
  emit(16.7, 'node.started', {
    node: N.risk,
    parentNodeId: N.strategy.id,
    metadata: { summary: 'Checking exposure against configured limits' },
  })
  emit(17.2, 'memory.read', {
    edge: { source: N.memory.id, target: N.risk.id, kind: 'data', label: 'limits' },
    metadata: { summary: 'Loading configured risk limits', bytes: 1024 },
  })
  emit(17.6, 'log.created', {
    node: N.risk,
    metadata: log({
      phase: 'risk_analysis',
      summary: 'Checking whether the proposed trade meets risk limits',
      reason: 'Current exposure may exceed the configured maximum',
      action: 'fetch_broker_positions',
      observation: 'Current portfolio delta is -0.18',
      result: 'Risk check passed',
      next_step: 'generate_trade_decision',
      confidence: 0.69,
    }),
  })
  emit(19.2, 'node.completed', {
    node: N.risk,
    metadata: {
      status: 'warning',
      summary: 'Passed at 82% of exposure limit',
      outputSummary: 'Approved with reduced size: 2 contracts instead of 3',
    },
  })

  // ── Step 7: hand off to an analysis agent for the LLM review ──
  emit(19.5, 'agent.handoff', {
    node: N.analysisAgent,
    parentNodeId: N.orchestrator.id,
    metadata: { summary: 'Delegating narrative review', inputSummary: 'Iron condor + risk warning' },
  })
  emit(19.7, 'node.started', {
    node: N.analysisAgent,
    metadata: { summary: 'Reviewing the proposed trade' },
  })

  emit(19.9, 'data.transferred', {
    edge: { source: N.risk.id, target: N.llm.id, kind: 'data', label: 'risk verdict' },
  })
  emit(20.0, 'node.started', {
    node: N.llm,
    parentNodeId: N.analysisAgent.id,
    metadata: { summary: 'Assessing macro context and trade rationale', inputSummary: 'Regime, exposure, proposed structure' },
  })
  emit(21.2, 'node.progress', { node: N.llm, metadata: { progress: 0.6, summary: 'Drafting rationale' } })
  emit(23.4, 'node.completed', {
    node: N.llm,
    metadata: {
      summary: 'Rationale generated',
      outputSummary: 'Supports the condor; flags CPI print at 14:30 as the main risk',
      tokens: 3820,
      cost: 0.021,
      durationMs: 3400,
    },
  })

  // ── Step 8: decision + persistence ──
  emit(23.6, 'data.transferred', {
    edge: { source: N.llm.id, target: N.decision.id, kind: 'data', label: 'rationale' },
  })
  emit(23.7, 'node.started', {
    node: N.decision,
    parentNodeId: N.llm.id,
    metadata: { summary: 'Assembling the final order' },
  })
  emit(24.2, 'decision.created', {
    node: N.decision,
    metadata: {
      summary: 'ENTER — iron condor, 2 contracts',
      outputSummary: 'SPY 0DTE 615/618/623/626 IC ×2, credit $1.12, exit at 50% or 14:25',
    },
  })
  emit(24.6, 'memory.written', {
    edge: { source: N.decision.id, target: N.memory.id, kind: 'data', label: 'decision record' },
    metadata: { summary: 'Persisting the decision and its rationale', bytes: 4096 },
  })
  emit(25.0, 'node.completed', { node: N.decision, metadata: { summary: 'Order staged for execution' } })

  emit(25.4, 'node.completed', { node: N.analysisAgent, metadata: { summary: 'Review complete' } })
  emit(25.6, 'node.completed', { node: N.orchestrator, metadata: { summary: 'Run complete' } })
  emit(26.0, 'run.completed', { metadata: { summary: 'Decision: ENTER iron condor ×2' } })

  return events
}

export const MOCK_TRADING_WORKFLOW: FlowEvent[] = buildMockTradingWorkflow()


