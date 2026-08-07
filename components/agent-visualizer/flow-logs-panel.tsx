'use client'

/**
 * Logs view.
 *
 * The whole run as a chronological stream of structured log entries, filtered
 * by phase, node, or free text. This is the view you read when you want to
 * know *why* a run did what it did, as opposed to the graph, which shows what
 * ran and in what order.
 */

import { useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { CHROME_HEIGHT } from '@/lib/canvas-config'
import type { FlowLogEntry } from '@/lib/flow/graph'

interface FlowLogsPanelProps {
  logs: readonly FlowLogEntry[]
  /** Clicking an entry selects its node on the graph. */
  onSelectNode: (nodeId: string) => void
  selectedNodeId: string | null
}

export function FlowLogsPanel({ logs, onSelectNode, selectedNodeId }: FlowLogsPanelProps) {
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const [onlyIssues, setOnlyIssues] = useState(false)

  const phases = useMemo(() => {
    const seen = new Set<string>()
    for (const entry of logs) seen.add(entry.log.phase)
    return [...seen]
  }, [logs])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return logs.filter(entry => {
      if (phaseFilter && entry.log.phase !== phaseFilter) return false
      if (onlySelected && selectedNodeId && entry.nodeId !== selectedNodeId) return false
      if (onlyIssues && entry.log.level !== 'warn' && entry.log.level !== 'error') return false
      if (!needle) return true
      // Search across the narrative fields, not just the summary — "why did it
      // do that" is usually buried in `reason` or `observation`.
      const haystack = [
        entry.nodeLabel, entry.log.phase, entry.log.summary, entry.log.reason,
        entry.log.action, entry.log.observation, entry.log.result, entry.log.next_step,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [logs, phaseFilter, query, onlySelected, onlyIssues, selectedNodeId])

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ top: CHROME_HEIGHT, background: COLORS.void }}>
      {/* Filters */}
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${COLORS.glassBorder}`, background: COLORS.panelBg }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[12px] font-mono" style={{ color: COLORS.textPrimary }}>Structured execution log</div>
            <div className="text-[9px] font-mono mt-0.5" style={{ color: COLORS.textMuted }}>Producer-authored reasoning, observations, and outcomes</div>
          </div>
          <span className="af-button text-[10px] font-mono px-2.5 py-1" style={{ color: COLORS.textDim, background: COLORS.holoBg05 }}>
            {filtered.length} / {logs.length} entries
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search reason, action, observation…"
          className="px-3 py-2 text-[11px] font-mono outline-none"
          style={{
            background: COLORS.holoBg05,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: COLORS.textPrimary,
            width: 320,
          }}
        />
        <FilterChip active={phaseFilter === null} onClick={() => setPhaseFilter(null)}>
          all phases
        </FilterChip>
        {phases.map(phase => (
          <FilterChip key={phase} active={phaseFilter === phase} onClick={() => setPhaseFilter(phase)}>
            {phase}
          </FilterChip>
        ))}
        {selectedNodeId && (
          <FilterChip active={onlySelected} onClick={() => setOnlySelected(v => !v)}>
            selected node only
          </FilterChip>
        )}
        <FilterChip active={onlyIssues} onClick={() => setOnlyIssues(v => !v)}>warnings & errors</FilterChip>
        </div>
      </div>

      {/* Stream */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {filtered.length === 0 ? (
          <div className="text-[10px] font-mono mt-6 text-center" style={{ color: COLORS.textMuted }}>
            {logs.length === 0 ? 'No structured logs in this run yet' : 'No entries match the filter'}
          </div>
        ) : (
          <div className="max-w-[1100px] mx-auto grid gap-3">
          {filtered.map((entry, i) => {
            const levelColor = entry.log.level === 'error' ? COLORS.error : entry.log.level === 'warn' ? COLORS.waiting_permission : COLORS.holoBase
            return (
            <button
              key={`${entry.nodeId}-${entry.at}-${i}`}
              onClick={() => onSelectNode(entry.nodeId)}
              className="af-panel w-full text-left px-4 py-3"
              style={{
                background: entry.nodeId === selectedNodeId ? COLORS.toggleActive : COLORS.panelBg,
                border: `1px solid ${entry.nodeId === selectedNodeId ? COLORS.holoBase + '55' : COLORS.panelSeparator}`,
              }}
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ background: levelColor }} />
                <span className="text-[10px] font-mono" style={{ color: COLORS.textMuted, minWidth: 54 }}>
                  +{entry.at.toFixed(2)}s
                </span>
                <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.textPrimary }}>
                  {entry.nodeLabel}
                </span>
                <span className="af-button px-2 py-0.5 text-[9px] font-mono" style={{ color: levelColor, background: levelColor + '12' }}>{entry.log.phase}</span>
                {entry.log.confidence != null && <span className="ml-auto text-[9px] font-mono" style={{ color: COLORS.textMuted }}>confidence {Math.round(entry.log.confidence * 100)}%</span>}
              </div>
              <div className="text-[12px] font-mono mb-2" style={{ color: COLORS.textPrimary }}>{entry.log.summary}</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[10px] font-mono">
                {entry.log.observation && <LogCell label="OBSERVATION" value={entry.log.observation} />}
                {entry.log.result && <LogCell label="RESULT" value={entry.log.result} color={COLORS.complete} />}
                {entry.log.next_step && <LogCell label="NEXT" value={entry.log.next_step} color={COLORS.dispatch} />}
              </div>
            </button>
          )})}
          </div>
        )}
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="af-button px-2.5 py-1.5 text-[10px] font-mono"
      style={{
        background: active ? COLORS.toggleActive : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: active ? COLORS.holoBase : COLORS.textMuted,
      }}
    >
      {children}
    </button>
  )
}

function LogCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] tracking-wider mb-1" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="leading-relaxed" style={{ color: color ?? COLORS.textDim }}>{value}</div>
    </div>
  )
}
