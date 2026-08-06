/**
 * Holographic color palette.
 *
 * Single source of colour for both canvas drawing and React panels — every
 * literal lives here so the two can never drift apart.
 */

export const COLORS = {
  // Background
  void: '#070a12',
  hexGrid: '#142033',

  // Primary Hologram
  holoBase: '#55c8ff',
  holoBright: '#b8e9ff',
  holoHot: '#ffffff',

  // Status
  complete: '#45d483',
  error: '#ff667a',
  waiting_permission: '#f5b84b',

  // Edge/Particle Colors
  dispatch: '#cc88ff',
  return: '#66ffaa',
  tool: '#ffbb44',

  // UI Chrome
  nodeInterior: 'rgba(13, 20, 35, 0.88)',
  textPrimary: '#e8edf7',
  textDim: '#a6b4c8',
  textMuted: '#708198',

  // Glass card
  glassBorder: 'rgba(118, 163, 205, 0.22)',

  // Holo background/border opacities (avoids scattered rgba literals)
  holoBg03: 'rgba(100, 200, 255, 0.03)',
  holoBg05: 'rgba(100, 200, 255, 0.05)',
  holoBg10: 'rgba(100, 200, 255, 0.1)',
  holoBorder06: 'rgba(100, 200, 255, 0.06)',
  holoBorder08: 'rgba(100, 200, 255, 0.08)',
  holoBorder12: 'rgba(100, 200, 255, 0.12)',

  // Panel chrome
  panelBg: 'rgba(10, 15, 26, 0.94)',
  panelSeparator: 'rgba(135, 168, 200, 0.10)',
  panelLabelDim: '#8496ad',

  // Toggle button states
  toggleActive: 'rgba(100, 200, 255, 0.15)',
  toggleInactive: 'rgba(100, 200, 255, 0.05)',
  toggleBorder: 'rgba(100, 200, 255, 0.1)',

  // Live indicator
  liveText: '#ff6666',
  liveResumeBg: 'rgba(255, 68, 68, 0.15)',
  liveResumeBorder: 'rgba(255, 68, 68, 0.35)',

  // Canvas drawing — card backgrounds
  cardBgDark: 'rgba(5, 5, 16, 0.8)',
} as const
