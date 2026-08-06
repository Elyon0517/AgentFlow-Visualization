'use client'

/**
 * Node inspector.
 *
 * Everything the acceptance criteria ask to see on click: status, timing,
 * input/output summaries, request/response history, structured logs, and the
 * error with its retry count.
 *
 * Data comes from a snapshot taken at click time rather than from live state,
 * so the panel does not shift under the cursor while the run continues.
 */

import { useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { StructuredLog } from '@/lib/flow/events'
import type { FlowNode } from '@/lib/flow/graph'
import { getNodeSpec, getStatusColor, getStatusLabel } from '@/lib/flow/node-registry'
import { PanelHeader, stopPropagationHandlers } from './shared-ui'

interface FlowNodePopupProps {
  node: FlowNode
  /** Run clock, so an in-progress node reports a live duration. */
  runTime: number
  /** Wall-clock start of the run, for absolute timestamps. */
  runStartedAtMs?: number
  onClose: () => void
  onFocusPath: () => void
  isFocused: boolean
}

export function FlowNodePopup({
  node, runTime, runStartedAtMs, onClose, onFocusPath, isFocused,
}: FlowNodePopupProps) {
  const [showRaw, setShowRaw] = useState(false)
  const spec = getNodeSpec(node.type)
  const statusColor = getStatusColor(node.status)

  const timing = useMemo(() => describeTiming(node, runTime, runStartedAtMs), [node, runTime, runStartedAtMs])

  return (
    <div
      {...stopPropagationHandlers}
      className="absolute top-[108px] right-3 bottom-20 flex flex-col rounded-xl overflow-hidden"
      style={{
        width: 380,
        background: COLORS.panelBg,
        border: `1px solid ${COLORS.glassBorder}`,
        backdropFilter: 'blur(20px)',
        zIndex: 100,
      }}
    >
      <div className="px-4 pt-4 pb-2" style={{ borderBottom: `1px solid ${COLORS.panelSeparator}` }}>
        <PanelHeader
          onClose={onClose}
          actions={
            <button
              onClick={onFocusPath}
              title="Highlight this node's upstream and downstream path"
              className="px-2 py-1 rounded-md text-[10px] font-mono mr-1"
              style={{
                background: isFocused ? COLORS.toggleActive : COLORS.toggleInactive,
                border: `1px solid ${COLORS.toggleBorder}`,
                color: isFocused ? COLORS.holoBase : COLORS.textMuted,
              }}
            >
              path
            </button>
          }
        >
          <span className="w-8 h-8 flex items-center justify-center rounded-lg text-[13px]" style={{ color: spec.accent, background: spec.accent + '14' }}>{node.icon ?? spec.glyph}</span>
          <span className="text-[13px] font-mono font-semibold truncate" style={{ color: COLORS.textPrimary }}>
            {node.label}
          </span>
        </PanelHeader>
      </div>

      <div className="overflow-y-auto px-4 py-3 flex-1 min-h-0">
        {/* ── Status ── */}
        <Section>
          <div className="flex items-center gap-2 flex-wrap">
            <Pill color={statusColor}>{getStatusLabel(node.status)}</Pill>
            <Pill color={spec.accent}>{spec.displayName}</Pill>
            {node.group && <Pill color={COLORS.textMuted}>{node.group}</Pill>}
            {node.attempt > 1 && (
              <Pill color={COLORS.tool}>
                attempt {node.attempt}{node.maxAttempts ? ` / ${node.maxAttempts}` : ''}
              </Pill>
            )}
          </div>
          {node.summary && (
            <div className="mt-1.5 text-[10px] font-mono" style={{ color: COLORS.textDim }}>
              {node.summary}
            </div>
          )}
          {node.status === 'waiting' && node.waitingOn && (
            <div className="mt-1 text-[10px] font-mono" style={{ color: COLORS.waiting_permission }}>
              ⏱ waiting on {node.waitingOn}
            </div>
          )}
          {node.progress != null && node.status === 'running' && (
            <div className="mt-1 text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
              {Math.round(node.progress * 100)}% complete
            </div>
          )}
        </Section>

        {/* ── Timing ── */}
        <Section title="Timing">
          <Field label="started" value={timing.started} />
          {timing.ended && <Field label="ended" value={timing.ended} />}
          <Field label="elapsed" value={timing.elapsed} />
          {timing.reported && <Field label="reported" value={timing.reported} />}
        </Section>

        {/* ── Error ── */}
        {node.error && (
          <Section title="Error" accent={COLORS.error}>
            <div className="text-[10px] font-mono" style={{ color: COLORS.error }}>
              {node.error.message}
            </div>
            {node.error.code && <Field label="code" value={node.error.code} />}
            {node.error.retryable != null && (
              <Field label="retryable" value={node.error.retryable ? 'yes' : 'no'} />
            )}
          </Section>
        )}

        {/* ── Input / output ── */}
        {(node.inputSummary || node.outputSummary) && (
          <Section title="Data">
            {node.inputSummary && <Field label="input" value={node.inputSummary} wrap />}
            {node.outputSummary && <Field label="output" value={node.outputSummary} wrap />}
            {node.tokens != null && <Field label="tokens" value={node.tokens.toLocaleString()} />}
            {node.cost != null && <Field label="cost" value={`$${node.cost.toFixed(4)}`} />}
          </Section>
        )}

        {/* ── Request / response history ── */}
        {node.requests.length > 0 && (
          <Section title={`Requests (${node.requests.length})`}>
            {node.requests.map((entry, i) => (
              <div
                key={i}
                className="mb-1.5 pl-2 text-[9px] font-mono"
                style={{ borderLeft: `1px solid ${COLORS.holoBorder12}` }}
              >
                <div style={{ color: COLORS.textMuted }}>{entry.at.toFixed(2)}s</div>
                {entry.request && <div style={{ color: COLORS.tool }}>→ {entry.request}</div>}
                {entry.response && <div style={{ color: COLORS.complete }}>← {entry.response}</div>}
                {entry.error && <div style={{ color: COLORS.error }}>✕ {entry.error}</div>}
                {entry.durationMs != null && (
                  <div style={{ color: COLORS.textMuted }}>{(entry.durationMs / 1000).toFixed(2)}s</div>
                )}
              </div>
            ))}
          </Section>
        )}

        {/* ── Structured logs ── */}
        {node.logs.length > 0 && (
          <Section title={`Log (${node.logs.length})`}>
            {node.logs.map((log, i) => <LogEntry key={i} log={log} />)}
          </Section>
        )}

        {/* ── Raw ── */}
        <button
          onClick={() => setShowRaw(v => !v)}
          className="mt-2 text-[9px] font-mono"
          style={{ color: COLORS.textMuted }}
        >
          {showRaw ? '▾' : '▸'} node id
        </button>
        {showRaw && (
          <div className="mt-1 text-[9px] font-mono break-all" style={{ color: COLORS.textMuted }}>
            {node.id}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Structured log entry ────────────────────────────────────────────────────

/**
 * Renders the explainable-log fields.
 *
 * Field order follows how the step actually unfolded — why, what it did, what
 * it saw, what came of it — so an entry reads as a narrative rather than a
 * bag of keys.
 */
export function LogEntry({ log, showPhase = true }: { log: StructuredLog; showPhase?: boolean }) {
  const levelColor =
    log.level === 'error' ? COLORS.error :
    log.level === 'warn' ? COLORS.tool :
    COLORS.holoBase

  return (
    <div className="mb-2 pl-2" style={{ borderLeft: `1px solid ${COLORS.holoBorder12}` }}>
      {showPhase && (
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono" style={{ color: levelColor }}>{log.phase}</span>
          {log.confidence != null && (
            <span className="text-[8px] font-mono" style={{ color: COLORS.textMuted }}>
              confidence {Math.round(log.confidence * 100)}%
            </span>
          )}
        </div>
      )}
      <div className="text-[10px] font-mono" style={{ color: COLORS.textPrimary }}>{log.summary}</div>
      {log.reason && <LogField label="reason" value={log.reason} />}
      {log.action && <LogField label="action" value={log.action} color={COLORS.tool} />}
      {log.observation && <LogField label="observed" value={log.observation} />}
      {log.result && <LogField label="result" value={log.result} color={COLORS.complete} />}
      {log.next_step && <LogField label="next" value={log.next_step} color={COLORS.dispatch} />}
    </div>
  )
}

function LogField({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-[9px] font-mono flex gap-1.5">
      <span style={{ color: COLORS.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ color: color ?? COLORS.textDim }}>{value}</span>
    </div>
  )
}

// ─── Layout helpers ──────────────────────────────────────────────────────────

function Section({ title, accent, children }: { title?: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 pb-2" style={{ borderBottom: `1px solid ${COLORS.panelSeparator}` }}>
      {title && (
        <div className="text-[9px] font-mono mb-1 tracking-wider" style={{ color: accent ?? COLORS.panelLabelDim }}>
          {title.toUpperCase()}
        </div>
      )}
      {children}
    </div>
  )
}

function Field({ label, value, wrap }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className="flex gap-2 text-[10px] font-mono">
      <span style={{ color: COLORS.textMuted, minWidth: 58, flexShrink: 0 }}>{label}</span>
      <span style={{ color: COLORS.textDim, wordBreak: wrap ? 'break-word' : 'normal' }}>{value}</span>
    </div>
  )
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-mono"
      style={{ background: color + '18', border: `1px solid ${color}40`, color }}
    >
      {children}
    </span>
  )
}

// ─── Timing ──────────────────────────────────────────────────────────────────

/**
 * Wall-clock and elapsed timings.
 *
 * `elapsed` is always end-minus-start, so it agrees with the timestamps shown
 * beside it. A producer-reported `durationMs` is shown separately rather than
 * replacing it — on a retried node the two legitimately differ, because the
 * report covers the successful attempt while the span covers every attempt.
 */
function describeTiming(
  node: FlowNode,
  runTime: number,
  runStartedAtMs?: number,
): { started: string; elapsed: string; ended?: string; reported?: string } {
  if (node.startedAt == null) {
    return { started: '—', elapsed: node.status === 'queued' ? 'queued' : 'not started' }
  }

  // Both clocks matter: run-relative for reading the trace, wall clock because
  // a trading run has to be lined up against market events.
  const wall = (offset: number) =>
    runStartedAtMs != null
      ? new Date(runStartedAtMs + offset * 1000).toISOString().slice(11, 23) + 'Z'
      : null

  const stamp = (offset: number) => {
    const clock = wall(offset)
    return `+${offset.toFixed(2)}s${clock ? `  (${clock})` : ''}`
  }

  const running = node.endedAt == null && (node.status === 'running' || node.status === 'waiting')
  const span = Math.max(0, (node.endedAt ?? runTime) - node.startedAt)
  const elapsed = `${span.toFixed(2)}s${running ? ` (${node.status})` : ''}`

  const reportedSeconds = node.durationMs != null ? node.durationMs / 1000 : null
  const reported = reportedSeconds != null && Math.abs(reportedSeconds - span) > 0.01
    ? `${reportedSeconds.toFixed(2)}s${node.attempt > 1 ? ' (successful attempt)' : ''}`
    : undefined

  return {
    started: stamp(node.startedAt),
    elapsed,
    ...(node.endedAt != null ? { ended: stamp(node.endedAt) } : {}),
    ...(reported ? { reported } : {}),
  }
}
