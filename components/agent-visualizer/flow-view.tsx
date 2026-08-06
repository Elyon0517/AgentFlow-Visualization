'use client'

/**
 * Workflow visualizer shell.
 *
 * Three views over one run — the graph (Current Run), a Gantt (Timeline), and
 * the structured log stream (Logs). All three read the same state, so a node
 * selected in one is selected in all of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { FlowEvent, FlowNodeType } from '@/lib/flow/events'
import { allNodeSpecs, getStatusColor } from '@/lib/flow/node-registry'
import { MOCK_TRADING_WORKFLOW } from '@/lib/flow/mock-trading-workflow'
import { runningNodeIds } from '@/lib/flow/reducer'
import { downloadRunAsJsonl, loadRunFromFile, loadRunFromUrl } from '@/lib/flow/stream'
import { useFlowRun } from '@/hooks/use-flow-run'
import { useFlowStream } from '@/hooks/use-flow-stream'
import { FlowCanvas } from './flow-canvas'
import { FlowLogsPanel } from './flow-logs-panel'
import { FlowNodePopup } from './flow-node-popup'
import { FlowSourceBar, type SourceKind } from './flow-source-bar'
import { FlowTimelinePanel } from './flow-timeline-panel'

const SPEEDS = [0.5, 1, 2, 4]

type ViewMode = 'run' | 'timeline' | 'logs'

const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: 'run', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
]

/** `?stream=<url>` connects on load; `?replay=<url>` loads a saved run. */
function readUrlParams() {
  if (typeof window === 'undefined') return { stream: null, replay: null }
  const params = new URLSearchParams(window.location.search)
  return { stream: params.get('stream'), replay: params.get('replay') }
}

export function FlowView() {
  const [view, setView] = useState<ViewMode>('run')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [focusPath, setFocusPath] = useState(false)
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<FlowNodeType>>(new Set())
  const [showGrid, setShowGrid] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [zoomTrigger, setZoomTrigger] = useState(0)

  // ─── Event source ──────────────────────────────────────────────────────────

  const urlParams = useMemo(readUrlParams, [])
  const [source, setSource] = useState<SourceKind>(
    urlParams.stream ? 'live' : urlParams.replay ? 'file' : 'mock',
  )
  const [liveUrl, setLiveUrl] = useState(urlParams.stream ?? '')
  const [connectedUrl, setConnectedUrl] = useState<string | null>(urlParams.stream)
  const [loadedRun, setLoadedRun] = useState<FlowEvent[] | null>(null)
  const [fileName, setFileName] = useState<string | undefined>(undefined)
  const [fileError, setFileError] = useState<string | undefined>(undefined)

  const stream = useFlowStream(source === 'live' ? connectedUrl : null)

  // A live run has no pre-recorded script; a demo or a loaded file does.
  const scenario = useMemo(() => {
    if (source === 'mock') return MOCK_TRADING_WORKFLOW
    if (source === 'file') return loadedRun ?? undefined
    return undefined
  }, [source, loadedRun])

  const {
    frameRef, layoutRef, focusSetRef,
    run, nodes, logs, eventLog, currentTime, duration, isPlaying, speed,
    play, pause, setSpeed, seekTo, restart,
  } = useFlowRun({
    scenario,
    liveEvents: source === 'live' ? stream.pending : undefined,
    onLiveEventsConsumed: stream.consume,
    // Focus only dims the graph when the user asks for it; selecting a node to
    // read its details should not grey out everything else.
    focusNodeId: focusPath ? selectedNodeId : null,
  })

  // ─── Source actions ────────────────────────────────────────────────────────

  const openFile = useCallback(async (file: File) => {
    setFileError(undefined)
    try {
      const { events, errors } = await loadRunFromFile(file)
      if (events.length === 0) {
        setFileError(`no valid events in ${file.name}`)
        return
      }
      setLoadedRun(events)
      setFileName(file.name)
      setSource('file')
      // Malformed lines are surfaced, not swallowed — a producer writing bad
      // JSONL should hear about it rather than silently lose half a run.
      if (errors.length > 0) setFileError(`${errors.length} line(s) skipped (first: line ${errors[0].line})`)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : 'could not read file')
    }
  }, [])

  // `?replay=<url>` — load a saved run straight from a link.
  const replayUrl = urlParams.replay
  useEffect(() => {
    if (!replayUrl) return
    let cancelled = false
    loadRunFromUrl(replayUrl)
      .then(({ events }) => {
        if (cancelled || events.length === 0) return
        setLoadedRun(events)
        setFileName(replayUrl)
        setSource('file')
      })
      .catch(error => !cancelled && setFileError(String(error)))
    return () => { cancelled = true }
  }, [replayUrl])

  // Drag and drop anywhere on the page.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (file) void openFile(file)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openFile])

  const changeSource = useCallback((next: SourceKind) => {
    setSource(next)
    setSelectedNodeId(null)
    setFileError(undefined)
    if (next !== 'live') setConnectedUrl(null)
  }, [])

  const exportRun = useCallback(() => {
    downloadRunAsJsonl(eventLog, run?.runId)
  }, [eventLog, run?.runId])

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
      <div
        className="absolute bottom-0 transition-[left,right] duration-200"
        style={{
          top: 96,
          left: filtersOpen && view === 'run' ? 234 : 0,
          right: selectedNode && view === 'run' ? 404 : 0,
          visibility: view === 'run' ? 'visible' : 'hidden',
        }}
      >
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

      {/* Empty state — a live source that has not produced anything yet must
          say so, or a blank canvas reads as a broken page. */}
      {nodes.size === 0 && view === 'run' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center font-mono">
            <div className="text-[12px]" style={{ color: COLORS.textDim }}>
              {source === 'live'
                ? stream.status === 'open' ? 'CONNECTED — WAITING FOR EVENTS' : 'NO LIVE STREAM'
                : source === 'file' ? 'NO RUN LOADED' : 'NO EVENTS'}
            </div>
            <div className="mt-1.5 text-[10px]" style={{ color: COLORS.textMuted }}>
              {source === 'live'
                ? stream.status === 'open'
                  ? 'Your producer is connected but has not emitted anything'
                  : stream.detail ?? 'Enter a stream URL in the source bar and connect'
                : source === 'file'
                  ? 'Choose a .jsonl file, or drop one anywhere on the page'
                  : 'Switch the source to Demo to play the bundled workflow'}
            </div>
          </div>
        </div>
      )}

      <FlowSourceBar
        source={source}
        onSourceChange={changeSource}
        liveUrl={liveUrl}
        onLiveUrlChange={setLiveUrl}
        onConnect={() => setConnectedUrl(liveUrl.trim() || null)}
        onDisconnect={() => setConnectedUrl(null)}
        streamStatus={stream.status}
        streamDetail={stream.detail}
        received={stream.received}
        rejected={stream.rejected}
        onLoadFile={file => void openFile(file)}
        fileError={fileError}
        fileName={fileName}
        onExport={exportRun}
        canExport={eventLog.length > 0}
      />

      {/* ── Mission-control header ── */}
      <div
        className="absolute top-0 left-0 right-0 h-[52px] flex items-center gap-5 px-4 font-mono"
        style={{ background: COLORS.panelBg, borderBottom: `1px solid ${COLORS.glassBorder}`, zIndex: 50 }}
      >
        <div className="flex items-center gap-2 min-w-[210px]">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[15px]"
            style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.holoBase }}
          >
            ⬡
          </div>
          <div className="leading-tight">
            <div className="text-[12px] font-semibold tracking-[0.08em]" style={{ color: COLORS.textPrimary }}>AGENTFLOW</div>
            <div className="text-[9px] tracking-[0.12em]" style={{ color: COLORS.textMuted }}>MISSION CONTROL</div>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: COLORS.holoBg05 }}>
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className="px-3 py-1.5 rounded-md text-[11px]"
              style={{
                background: view === v.id ? COLORS.toggleActive : 'transparent',
                border: `1px solid ${view === v.id ? COLORS.toggleBorder : 'transparent'}`,
                color: view === v.id ? COLORS.textPrimary : COLORS.textMuted,
              }}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 border-l pl-5" style={{ borderColor: COLORS.panelSeparator }}>
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px]" style={{ color: COLORS.textPrimary, maxWidth: 320 }}>
              {run?.label ?? 'Waiting for workflow'}
            </span>
            <span
              className="px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider"
              style={{
                background: getStatusColor((run?.status === 'completed' ? 'success' : run?.status ?? 'idle') as never) + '18',
                color: run?.status === 'failed' ? COLORS.error : run?.status === 'completed' ? COLORS.complete : COLORS.holoBase,
              }}
            >
              {run?.status ?? 'idle'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[9px]" style={{ color: COLORS.textMuted }}>
            <span>{nodes.size} nodes</span>
            <span>{eventLog.length} events</span>
            <span>{timelineMax.toFixed(1)}s duration</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 text-[10px]">
          <div className="hidden xl:flex items-center gap-2 mr-2">
            {[...statusCounts].map(([status, count]) => (
              <span key={status} className="flex items-center gap-1" title={status} style={{ color: COLORS.textDim }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: getStatusColor(status as never) }} />
                {count}
              </span>
            ))}
          </div>
          <button
            onClick={focusActive}
            title="Focus the node executing right now (F)"
            className="px-2.5 py-1.5 rounded-md"
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textDim }}
          >
            ⦿ Active
          </button>
          <button
            onClick={() => setFocusPath(v => !v)}
            title="Dim everything outside the selected node's path"
            className="px-2.5 py-1.5 rounded-md"
            style={{
              background: focusPath ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: focusPath ? COLORS.holoBase : COLORS.textDim,
              opacity: selectedNodeId ? 1 : 0.45,
            }}
          >
            ⇄ Path
          </button>
          <button
            onClick={() => setFiltersOpen(v => !v)}
            title="Open display filters"
            className="px-2.5 py-1.5 rounded-md"
            style={{
              background: filtersOpen ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: filtersOpen ? COLORS.textPrimary : COLORS.textDim,
            }}
          >
            ☷ Display
          </button>
        </div>
      </div>

      {/* ── Display filters ── */}
      {filtersOpen && view === 'run' && (
        <aside
          className="absolute left-3 top-[108px] w-[210px] rounded-xl p-3 font-mono"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}`, zIndex: 48, backdropFilter: 'blur(18px)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] tracking-[0.12em]" style={{ color: COLORS.panelLabelDim }}>DISPLAY</span>
            <button onClick={() => setFiltersOpen(false)} className="text-[11px]" style={{ color: COLORS.textMuted }}>✕</button>
          </div>
          <button
            onClick={() => setShowGrid(g => !g)}
            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[11px] mb-2"
            style={{ background: COLORS.holoBg05, color: COLORS.textDim }}
          >
            <span>⬡ Background grid</span>
            <span style={{ color: showGrid ? COLORS.complete : COLORS.textMuted }}>{showGrid ? 'ON' : 'OFF'}</span>
          </button>
          <div className="text-[9px] mb-1.5 tracking-wider" style={{ color: COLORS.textMuted }}>NODE TYPES</div>
          <div className="grid grid-cols-1 gap-1">
            {allNodeSpecs().map(spec => {
              const hidden = hiddenTypes.has(spec.type)
              return (
                <button
                  key={spec.type}
                  onClick={() => toggleType(spec.type)}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded-md text-[10px]"
                  style={{ background: hidden ? 'transparent' : COLORS.holoBg05, color: hidden ? COLORS.textMuted : COLORS.textPrimary, opacity: hidden ? 0.55 : 1 }}
                >
                  <span className="flex items-center gap-2"><span style={{ color: spec.accent }}>{spec.glyph}</span>{spec.displayName}</span>
                  <span style={{ color: hidden ? COLORS.textMuted : COLORS.complete }}>{hidden ? '—' : '✓'}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-3 pt-3 text-[9px] leading-relaxed" style={{ borderTop: `1px solid ${COLORS.panelSeparator}`, color: COLORS.textMuted }}>
            Scroll to zoom · drag to pan<br />F focuses active · Esc clears selection
          </div>
        </aside>
      )}

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
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-xl text-[11px] font-mono shadow-2xl"
        style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}`, zIndex: 50, backdropFilter: 'blur(18px)' }}
      >
        <button className="w-7 h-7 rounded-md" onClick={isPlaying ? pause : play} title="Play / pause (Space)" style={{ color: COLORS.holoBase, background: COLORS.toggleActive }}>
          {isPlaying ? 'Ⅱ' : '▶'}
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
        <button className="px-2 py-1 rounded-md" onClick={() => setZoomTrigger(n => n + 1)} title="Zoom to fit" style={{ color: COLORS.textDim, background: COLORS.toggleInactive }}>Fit</button>
      </div>
    </div>
  )
}
