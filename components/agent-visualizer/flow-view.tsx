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
  { id: 'run', label: '01 / TOPOLOGY' },
  { id: 'timeline', label: '02 / TIMING' },
  { id: 'logs', label: '03 / TELEMETRY' },
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
    <div className="af-shell h-screen w-screen relative overflow-hidden" style={{ background: COLORS.void }}>
      <div className="af-scanlines" aria-hidden="true" />
      {/* The canvas stays mounted across view switches — remounting would
          discard the settled layout and replay every spawn animation. */}
      <div
        className="absolute bottom-0 transition-[left,right] duration-200"
        style={{
          top: 96,
          left: filtersOpen && view === 'run' ? 248 : 0,
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
        <div className="af-viewport-label left-7 top-5 text-[8px]">runtime topology / live field</div>
        <div className="af-viewport-label right-7 top-5 text-[8px]">grid ref. af–01</div>
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
        className="absolute top-0 left-0 right-0 h-[52px] flex items-center gap-4 px-4 font-mono"
        style={{
          background: 'linear-gradient(90deg, rgba(8,16,12,.99), rgba(5,10,7,.97))',
          borderBottom: `1px solid ${COLORS.glassBorder}`,
          boxShadow: '0 8px 30px rgba(0,0,0,.32)',
          zIndex: 50,
        }}
      >
        <div className="flex items-center gap-3 min-w-[218px]">
          <div
            className="relative w-8 h-8 flex items-center justify-center text-[10px] font-semibold tracking-widest"
            style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.holoBase}`, color: COLORS.holoBase, boxShadow: `inset 0 0 16px ${COLORS.toggleActive}` }}
          >
            AF
            <span className="absolute -right-1 -top-1 w-1.5 h-1.5" style={{ background: COLORS.holoBase }} />
          </div>
          <div className="leading-tight">
            <div className="text-[12px] font-semibold tracking-[0.14em] af-readout" style={{ color: COLORS.textPrimary }}>AGENTFLOW</div>
            <div className="text-[8px] tracking-[0.2em]" style={{ color: COLORS.holoBase }}>RUNTIME INSTRUMENT</div>
          </div>
        </div>

        <div className="flex items-center gap-px p-px" style={{ background: COLORS.toggleBorder }}>
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className="af-button px-3 py-2 text-[9px]"
              style={{
                background: view === v.id ? COLORS.toggleActive : COLORS.panelBg,
                border: 'none',
                boxShadow: view === v.id ? `inset 0 -1px ${COLORS.holoBase}` : 'none',
                color: view === v.id ? COLORS.holoBright : COLORS.textMuted,
              }}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="af-run-summary min-w-0 flex-1 border-l pl-4" style={{ borderColor: COLORS.panelSeparator }}>
          <div className="flex items-center gap-2">
            <span className="text-[8px] af-kicker" style={{ color: COLORS.textMuted }}>active run</span>
            <span className="truncate text-[11px] af-readout" style={{ color: COLORS.textPrimary, maxWidth: 260 }}>
              {run?.label ?? 'Waiting for workflow'}
            </span>
            <span
              className="af-button px-1.5 py-0.5 text-[8px] uppercase tracking-wider"
              style={{
                background: getStatusColor((run?.status === 'completed' ? 'success' : run?.status ?? 'idle') as never) + '18',
                color: run?.status === 'failed' ? COLORS.error : run?.status === 'completed' ? COLORS.complete : COLORS.holoBase,
              }}
            >
              {run?.status ?? 'idle'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[8px] af-readout" style={{ color: COLORS.textMuted }}>
            <span>N {String(nodes.size).padStart(2, '0')}</span>
            <span>EVT {String(eventLog.length).padStart(3, '0')}</span>
            <span>T+{timelineMax.toFixed(1)}s</span>
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
            className="af-button px-2.5 py-1.5"
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textDim }}
          >
            [ ] Active
          </button>
          <button
            onClick={() => setFocusPath(v => !v)}
            title="Dim everything outside the selected node's path"
            className="af-button px-2.5 py-1.5"
            style={{
              background: focusPath ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: focusPath ? COLORS.holoBase : COLORS.textDim,
              opacity: selectedNodeId ? 1 : 0.45,
            }}
          >
            → Path
          </button>
          <button
            onClick={() => setFiltersOpen(v => !v)}
            title="Open display filters"
            className="af-button px-2.5 py-1.5"
            style={{
              background: filtersOpen ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: filtersOpen ? COLORS.textPrimary : COLORS.textDim,
            }}
          >
            ≡ Layers
          </button>
        </div>
      </div>

      {/* ── Display filters ── */}
      {filtersOpen && view === 'run' && (
        <aside
          className="af-panel absolute left-3 top-[108px] w-[222px] p-3 font-mono"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}`, zIndex: 48, backdropFilter: 'blur(18px)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9px] tracking-[0.18em]" style={{ color: COLORS.holoBase }}>LAYER CONTROL / 01</span>
            <button onClick={() => setFiltersOpen(false)} className="text-[11px]" style={{ color: COLORS.textMuted }}>✕</button>
          </div>
          <button
            onClick={() => setShowGrid(g => !g)}
            className="af-button w-full flex items-center justify-between px-2.5 py-2 text-[10px] mb-3"
            style={{ background: COLORS.holoBg05, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textDim }}
          >
            <span>GRID / CALIBRATION</span>
            <span style={{ color: showGrid ? COLORS.complete : COLORS.textMuted }}>{showGrid ? '01' : '00'}</span>
          </button>
          <div className="text-[8px] mb-1.5 tracking-[0.18em]" style={{ color: COLORS.textMuted }}>SIGNAL CLASSES</div>
          <div className="grid grid-cols-1 gap-1">
            {allNodeSpecs().map(spec => {
              const hidden = hiddenTypes.has(spec.type)
              return (
                <button
                  key={spec.type}
                  onClick={() => toggleType(spec.type)}
                  className="af-button flex items-center justify-between px-2.5 py-1.5 text-[9px]"
                  style={{ background: hidden ? 'transparent' : COLORS.holoBg05, color: hidden ? COLORS.textMuted : COLORS.textPrimary, opacity: hidden ? 0.55 : 1 }}
                >
                  <span className="flex items-center gap-2"><span className="w-4 text-center" style={{ color: spec.accent }}>{spec.glyph}</span>{spec.displayName}</span>
                  <span style={{ color: hidden ? COLORS.textMuted : COLORS.complete }}>{hidden ? '00' : '01'}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-3 pt-3 text-[9px] leading-relaxed" style={{ borderTop: `1px solid ${COLORS.panelSeparator}`, color: COLORS.textMuted }}>
            WHEEL / SCALE&nbsp;&nbsp; DRAG / PAN<br />F / ACTIVE&nbsp;&nbsp; ESC / CLEAR
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
        className="af-panel absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-center gap-3 px-3 py-2 text-[10px] font-mono"
        style={{
          width: 'min(760px, calc(100vw - 32px))',
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.glassBorder}`,
          zIndex: 50,
          backdropFilter: 'blur(18px)',
        }}
      >
        <span className="hidden lg:inline text-[8px] af-kicker" style={{ color: COLORS.textMuted }}>transport</span>
        <button className="af-button w-7 h-7" onClick={isPlaying ? pause : play} title="Play / pause (Space)" style={{ color: COLORS.holoBase, background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}` }}>
          {isPlaying ? 'Ⅱ' : '▶'}
        </button>
        <button onClick={restart} title="Restart" style={{ color: COLORS.textDim }}>⟲</button>

        <span
          className="af-button px-1.5 py-0.5"
          aria-hidden={isPlaying}
          style={{
            background: COLORS.liveResumeBg,
            border: `1px solid ${COLORS.liveResumeBorder}`,
            color: COLORS.liveText,
            visibility: isPlaying ? 'hidden' : 'visible',
          }}
        >
          PAUSED
        </span>

        <span className="af-readout" style={{ color: COLORS.textDim, minWidth: 74 }}>
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
        <button className="af-button px-2 py-1" onClick={() => setZoomTrigger(n => n + 1)} title="Zoom to fit" style={{ color: COLORS.textDim, background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}` }}>Fit</button>
      </div>
    </div>
  )
}
