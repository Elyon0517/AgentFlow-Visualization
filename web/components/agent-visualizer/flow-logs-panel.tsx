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
import { LogEntry } from './flow-node-popup'

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
      if (!needle) return true
      // Search across the narrative fields, not just the summary — "why did it
      // do that" is usually buried in `reason` or `observation`.
      const haystack = [
        entry.nodeLabel, entry.log.phase, entry.log.summary, entry.log.reason,
        entry.log.action, entry.log.observation, entry.log.result, entry.log.next_step,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [logs, phaseFilter, query, onlySelected, selectedNodeId])

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ top: CHROME_HEIGHT, background: COLORS.void }}>
      {/* Filters */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 flex-wrap"
        style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}
      >
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search reason, action, observation…"
          className="px-2 py-1 rounded text-[10px] font-mono outline-none"
          style={{
            background: COLORS.holoBg05,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: COLORS.textPrimary,
            width: 260,
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
        <span className="ml-auto text-[9px] font-mono" style={{ color: COLORS.textMuted }}>
          {filtered.length} / {logs.length}
        </span>
      </div>

      {/* Stream */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {filtered.length === 0 ? (
          <div className="text-[10px] font-mono mt-6 text-center" style={{ color: COLORS.textMuted }}>
            {logs.length === 0 ? 'No structured logs in this run yet' : 'No entries match the filter'}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <button
              key={`${entry.nodeId}-${entry.at}-${i}`}
              onClick={() => onSelectNode(entry.nodeId)}
              className="w-full text-left mb-2 px-2 py-1.5 rounded"
              style={{
                background: entry.nodeId === selectedNodeId ? COLORS.toggleActive : 'transparent',
                border: `1px solid ${entry.nodeId === selectedNodeId ? COLORS.toggleBorder : 'transparent'}`,
              }}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted, minWidth: 46 }}>
                  +{entry.at.toFixed(2)}s
                </span>
                <span className="text-[10px] font-mono" style={{ color: COLORS.textPrimary }}>
                  {entry.nodeLabel}
                </span>
              </div>
              <LogEntry log={entry.log} />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-1.5 py-0.5 rounded text-[9px] font-mono"
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
