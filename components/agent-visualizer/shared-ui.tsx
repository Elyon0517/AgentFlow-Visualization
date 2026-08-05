'use client'

import type { ReactNode } from 'react'
import { COLORS } from '@/lib/colors'

// ─── Stop Propagation Handlers ──────────────────────────────────────────────
// Prevents canvas drag/click events from firing when interacting with panels

export const stopPropagationHandlers = {
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
} as const

// ─── Close Button ───────────────────────────────────────────────────────────

export function CloseButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs transition-colors ${className}`}
      style={{ color: COLORS.textMuted }}
    >
      ✕
    </button>
  )
}

// ─── Panel Header ───────────────────────────────────────────────────────────

interface PanelHeaderProps {
  children: ReactNode
  onClose: () => void
  className?: string
  actions?: ReactNode
}

export function PanelHeader({ children, onClose, className = 'mb-2', actions }: PanelHeaderProps) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2 min-w-0">
        {children}
      </div>
      <div className="flex items-center gap-1">
        {actions}
        <CloseButton onClick={onClose} />
      </div>
    </div>
  )
}
