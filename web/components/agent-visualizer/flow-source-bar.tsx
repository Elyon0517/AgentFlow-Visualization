'use client'

/**
 * Event source control.
 *
 * The visualizer accepts events from three places and this is where you pick:
 * the bundled demo, a live stream, or a saved `.jsonl` run. Switching source
 * is the only thing that resets the graph.
 */

import { useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { StreamStatus } from '@/lib/flow/stream'

export type SourceKind = 'mock' | 'live' | 'file'

const STATUS_COLOR: Record<StreamStatus, string> = {
  idle: COLORS.textMuted,
  connecting: COLORS.tool,
  open: COLORS.complete,
  reconnecting: COLORS.tool,
  closed: COLORS.error,
}

const STATUS_LABEL: Record<StreamStatus, string> = {
  idle: 'not connected',
  connecting: 'connecting',
  open: 'live',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
}

interface FlowSourceBarProps {
  source: SourceKind
  onSourceChange: (source: SourceKind) => void
  liveUrl: string
  onLiveUrlChange: (url: string) => void
  onConnect: () => void
  onDisconnect: () => void
  streamStatus: StreamStatus
  streamDetail?: string
  received: number
  rejected: number
  onLoadFile: (file: File) => void
  fileError?: string
  fileName?: string
  onExport: () => void
  canExport: boolean
}

export function FlowSourceBar({
  source, onSourceChange, liveUrl, onLiveUrlChange, onConnect, onDisconnect,
  streamStatus, streamDetail, received, rejected,
  onLoadFile, fileError, fileName, onExport, canExport,
}: FlowSourceBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState(true)

  const connected = streamStatus === 'open' || streamStatus === 'reconnecting' || streamStatus === 'connecting'

  return (
    <div
      className="absolute top-9 left-0 right-0 px-3 py-1.5 text-[10px] font-mono"
      style={{ background: COLORS.panelBg, borderBottom: `1px solid ${COLORS.holoBorder06}`, zIndex: 49 }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setCollapsed(c => !c)} style={{ color: COLORS.textMuted }}>
          {collapsed ? '▸' : '▾'} source
        </button>

        {(['mock', 'live', 'file'] as const).map(kind => (
          <button
            key={kind}
            onClick={() => onSourceChange(kind)}
            className="px-1.5 py-0.5 rounded"
            style={{
              background: source === kind ? COLORS.toggleActive : COLORS.toggleInactive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: source === kind ? COLORS.holoBase : COLORS.textMuted,
            }}
          >
            {kind === 'mock' ? 'Demo' : kind === 'live' ? 'Live' : 'File'}
          </button>
        ))}

        {source === 'live' && (
          <span className="flex items-center gap-1.5" style={{ color: STATUS_COLOR[streamStatus] }}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: STATUS_COLOR[streamStatus],
                // Only a genuinely open stream pulses; a reconnect loop that
                // animates identically would read as healthy.
                animation: streamStatus === 'open' ? 'none' : undefined,
              }}
            />
            {STATUS_LABEL[streamStatus]}
            {streamDetail && <span style={{ color: COLORS.textMuted }}>· {streamDetail}</span>}
          </span>
        )}

        {source === 'live' && received > 0 && (
          <span style={{ color: COLORS.textMuted }}>{received} events</span>
        )}
        {source === 'live' && rejected > 0 && (
          <span style={{ color: COLORS.error }} title="Events the producer sent that failed validation">
            {rejected} rejected
          </span>
        )}

        {source === 'file' && fileName && (
          <span style={{ color: COLORS.textMuted }}>{fileName}</span>
        )}
        {fileError && <span style={{ color: COLORS.error }}>{fileError}</span>}

        <button
          onClick={onExport}
          disabled={!canExport}
          title="Download the events received so far as JSONL"
          className="ml-auto px-1.5 py-0.5 rounded"
          style={{
            background: COLORS.toggleInactive,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: canExport ? COLORS.textDim : COLORS.textMuted,
            opacity: canExport ? 1 : 0.4,
          }}
        >
          ↓ Export .jsonl
        </button>
      </div>

      {!collapsed && source === 'live' && (
        <div className="flex items-center gap-2 mt-1.5">
          <input
            value={liveUrl}
            onChange={e => onLiveUrlChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !connected) onConnect() }}
            placeholder="http://127.0.0.1:8000/flow/stream"
            spellCheck={false}
            className="px-2 py-1 rounded outline-none flex-1"
            style={{
              background: COLORS.holoBg05,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: COLORS.textPrimary,
              maxWidth: 420,
            }}
          />
          <button
            onClick={connected ? onDisconnect : onConnect}
            className="px-2 py-1 rounded"
            style={{
              background: COLORS.toggleActive,
              border: `1px solid ${COLORS.toggleBorder}`,
              color: connected ? COLORS.error : COLORS.holoBase,
            }}
          >
            {connected ? 'Disconnect' : 'Connect'}
          </button>
        </div>
      )}

      {!collapsed && source === 'file' && (
        <div className="flex items-center gap-2 mt-1.5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-1 rounded"
            style={{ background: COLORS.toggleActive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.holoBase }}
          >
            Choose .jsonl…
          </button>
          <span style={{ color: COLORS.textMuted }}>or drop a file anywhere on the page</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jsonl,.ndjson,application/x-ndjson,text/plain"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) onLoadFile(file)
              e.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}
