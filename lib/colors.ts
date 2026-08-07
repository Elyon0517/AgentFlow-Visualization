/**
 * Instrument-panel palette.
 *
 * Canvas and React chrome share the same phosphor / graphite vocabulary so
 * the interface reads as one engineered system instead of a collection of
 * floating cards.
 */

export const COLORS = {
  // Background
  void: '#050806',
  hexGrid: '#18352d',

  // Primary Hologram
  holoBase: '#79f2c0',
  holoBright: '#c4ffe5',
  holoHot: '#f1fff8',

  // Status
  complete: '#65f29d',
  error: '#ff5c5c',
  waiting_permission: '#ffb84d',

  // Edge/Particle Colors
  dispatch: '#8ec5ff',
  return: '#9cffca',
  tool: '#ffc35a',

  // UI Chrome
  nodeInterior: 'rgba(6, 15, 12, 0.94)',
  textPrimary: '#e6f2ec',
  textDim: '#9eb5a9',
  textMuted: '#60766b',

  // Glass card
  glassBorder: 'rgba(121, 242, 192, 0.24)',

  // Holo background/border opacities (avoids scattered rgba literals)
  holoBg03: 'rgba(121, 242, 192, 0.025)',
  holoBg05: 'rgba(121, 242, 192, 0.05)',
  holoBg10: 'rgba(121, 242, 192, 0.1)',
  holoBorder06: 'rgba(121, 242, 192, 0.06)',
  holoBorder08: 'rgba(121, 242, 192, 0.08)',
  holoBorder12: 'rgba(121, 242, 192, 0.14)',

  // Panel chrome
  panelBg: 'rgba(7, 12, 9, 0.96)',
  panelSeparator: 'rgba(121, 242, 192, 0.10)',
  panelLabelDim: '#719487',

  // Toggle button states
  toggleActive: 'rgba(121, 242, 192, 0.13)',
  toggleInactive: 'rgba(121, 242, 192, 0.035)',
  toggleBorder: 'rgba(121, 242, 192, 0.16)',

  // Live indicator
  liveText: '#ffb84d',
  liveResumeBg: 'rgba(255, 184, 77, 0.12)',
  liveResumeBorder: 'rgba(255, 184, 77, 0.34)',

  // Canvas drawing — card backgrounds
  cardBgDark: 'rgba(3, 9, 6, 0.92)',
} as const
