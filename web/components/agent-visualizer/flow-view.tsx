'use client'

/**
 * Workflow visualizer shell.
 *
 * Three views over one run — the graph (Current Run), a Gantt (Timeline), and
 * the structured log stream (Logs). All three read the same state, so a node
 * selected in one is selected in all of them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { FlowNodeType } from '@/lib/flow/events'
import { allNodeSpecs, getStatusColor } from '@/lib/flow/node-registry'
import { MOCK_TRADING_WORKFLOW } from '@/lib/flow/mock-trading-workflow'
import { runningNodeIds } from '@/lib/flow/reducer'
import { useFlowRun } from '@/hooks/use-flow-run'
import { FlowCanvas } from './flow-canvas'
import { FlowLogsPanel } from './flow-logs-panel'
import { FlowNodePopup } from './flow-node-popup'
import { FlowTimelinePanel } from './flow-timeline-panel'

const SPEEDS = [0.5, 1, 2, 4]

type ViewMode = 'run' | 'timeline' | 'logs'

const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: 'run', label: 'Current Run' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
]

export function FlowView() {
  const [view, setView] = useState<ViewMode>('run')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [focusPath, setFocusPath] = useState(false)
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<FlowNodeType>>(new Set())
  const [showGrid, setShowGrid] = useState(true)
  const [zoomTrigger, setZoomTrigger] = useState(0)

  const scenario = useMemo(() => MOCK_TRADING_WORKFLOW, [])

  const {
    frameRef, layoutRef, focusSetRef,
    run, nodes, logs, currentTime, duration, isPlaying, speed,
    play, pause, setSpeed, seekTo, restart,
  } = useFlowRun({
    scenario,
    // Focus only dims the graph when the user asks for it; selecting a node to
    // read its details should not grey out everything else.
    focusNodeId: focusPath ? selectedNodeId : null,
  })

  const toggleType = useCallback((type: FlowNodeType) => {
    setHiddenTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  const selectedNode = selectedNodeId ? nodes.get(selectedNodeId) ?? null : null

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of nodes.values()) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
    return counts
  }, [nodes])

  /** Jump the selection to whatever is executing right now. */
  const focusActive = useCallback(() => {
    const active = runningNodeIds(frameRef.current)
    if (active.length === 0) return
    setSelectedNodeId(active[0])
    setView('run')
    setZoomTrigger(n => n + 1)
  }, [frameRef])

  const handleSeek = useCallback((time: number) => {
    pause()
    seekTo(time)
  }, [pause, seekTo])

  // Space toggles playback, F focuses the active node — both are things you
  // reach for constantly while watching a run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') { e.preventDefault(); isPlaying ? pause() : play() }
      else if (e.key === 'f') focusActive()
      else if (e.key === 'Escape') setSelectedNodeId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPlaying, play, pause, focusActive])

  const timelineMax = Math.max(duration, currentTime, 1)

  return (
    <div className="h-screen w-screen relative overflow-hidden" style={{ background: COLORS.void }}>
      {/* The canvas stays mounted across view switches — remounting would
          discard the settled layout and replay every spawn animation. */}
      <div className="absolute inset-0" style={{ visibility: view === 'run' ? 'visible' : 'hidden' }}>
        <FlowCanvas
          stateRef={frameRef}
          layoutRef={layoutRef}
          focusSetRef={focusSetRef}
          selectedNodeId={selectedNodeId}
          hiddenTypes={hiddenTypes as ReadonlySet<string>}
          showGrid={showGrid}
          zoomToFitTrigger={zoomTrigger}
          pauseAutoFit={selectedNodeId !== null}
          onSelectNode={setSelectedNodeId}
        />
      </div>

      {view === 'timeline' && (
        <FlowTimelinePanel
          nodes={nodes}
          currentTime={currentTime}
          duration={timelineMax}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onSeek={handleSeek}
        />
      )}

      {view === 'logs' && (
        <FlowLogsPanel
          logs={logs}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
      )}

      {/* ── Top bar ── */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center gap-3 px-3 py-1.5 text-[10px] font-mono"
        style={{ background: COLORS.panelBg, borderBottom: `1px solid ${COLORS.holoBorder06}`, zIndex: 50 }}
      >
        <div className="flex items-center gap-0.5">
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className="px-2 py-0.5 rounded"
              style={{
                background: view === v.id ? COLORS.toggleActive : 'transparent',
                border: `1px solid ${view === v.id ? COLORS.toggleBorder : 'transparent'}`,
                color: view === v.id ? COLORS.holoBase : COLORS.textMuted,
              }}
            >
              {v.label}
            </button>
          ))}
        </div>

        <span className="truncate" style={{ color: COLORS.textPrimary, maxWidth: 260 }}>
          {run?.label ?? 'WORKFLOW'}
        </span>
        <span style={{ color: run?.status === 'failed' ? COLORS.error : COLORS.textDim }}>
          {run?.status ?? 'idle'}
        </span>

        <div className="flex items-center gap-2">
          {[...statusCounts].map(([status, count]) => (
            <span key={status} className="flex items-center gap-1" title={status} style={{ color: COLORS.textMuted }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: getStatusColor(status as never) }} />
              {count}
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={focusActive}
            title="Focus the node executing right now (F)"
            className="px-1.5 py-0.5 rounded"
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textDim }}
          >
            ⦿ Active
          </button>
          <button
            onClick={() => setFocusPath(v => !v)}
            title="Dim everything outside the selected node's path"
            className="px-1.5 py-0.5 rounded"
            style={{
              background: focusPath ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: focusPath ? COLORS.holoBase : COLORS.textDim,
              opacity: selectedNodeId ? 1 : 0.45,
            }}
          >
            ⇄ Path
          </button>

          <span className="mx-1" style={{ color: COLORS.holoBorder12 }}>│</span>

          {allNodeSpecs().map(spec => {
            const hidden = hiddenTypes.has(spec.type)
            return (
              <button
                key={spec.type}
                onClick={() => toggleType(spec.type)}
                title={`Show/hide ${spec.displayName} nodes`}
                className="px-1.5 py-0.5 rounded"
                style={{
                  background: hidden ? COLORS.toggleInactive : COLORS.toggleActive,
                  border: `1px solid ${COLORS.toggleBorder}`,
                  color: hidden ? COLORS.textMuted : spec.accent,
                  opacity: hidden ? 0.4 : 1,
                }}
              >
                {spec.glyph} {spec.displayName}
              </button>
            )
          })}
          <button
            onClick={() => setShowGrid(g => !g)}
            title="Toggle the hex grid"
            className="px-1.5 py-0.5 rounded"
            style={{
              background: showGrid ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: COLORS.textDim,
            }}
          >
            ⬡
          </button>
        </div>
      </div>

      {/* ── Node inspector ── */}
      {selectedNode && (
        <FlowNodePopup
          node={selectedNode}
          runTime={currentTime}
          runStartedAtMs={run?.startedAtMs}
          isFocused={focusPath}
          onFocusPath={() => setFocusPath(v => !v)}
          onClose={() => setSelectedNodeId(null)}
        />
      )}

      {/* ── Playback ── */}
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-full text-[10px] font-mono"
        style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}`, zIndex: 50 }}
      >
        <button onClick={isPlaying ? pause : play} title="Play / pause (Space)" style={{ color: COLORS.holoBase }}>
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <button onClick={restart} title="Restart" style={{ color: COLORS.textDim }}>⟲</button>

        {!isPlaying && (
          <span
            className="px-1.5 py-0.5 rounded"
            style={{ background: COLORS.liveResumeBg, border: `1px solid ${COLORS.liveResumeBorder}`, color: COLORS.liveText }}
          >
            PAUSED
          </span>
        )}

        <span style={{ color: COLORS.textDim, minWidth: 74 }}>
          {currentTime.toFixed(1)}s / {timelineMax.toFixed(1)}s
        </span>
        <input
          type="range"
          min={0}
          max={timelineMax}
          step={0.1}
          value={Math.min(currentTime, timelineMax)}
          onChange={e => handleSeek(Number(e.target.value))}
          style={{ width: 220 }}
        />
        {SPEEDS.map(s => (
          <button key={s} onClick={() => setSpeed(s)} style={{ color: speed === s ? COLORS.holoBase : COLORS.textMuted }}>
            {s}×
          </button>
        ))}
        <button onClick={() => setZoomTrigger(n => n + 1)} title="Zoom to fit" style={{ color: COLORS.textDim }}>⤢</button>
      </div>
    </div>
  )
}
