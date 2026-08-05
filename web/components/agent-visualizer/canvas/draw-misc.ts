import { measureTextCached } from './render-cache'

/** Truncate text with ellipsis to fit within maxWidth pixels */
export function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (measureTextCached(ctx, text) <= maxWidth) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measureTextCached(ctx, text.slice(0, mid) + '…') <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '…'
}

/** Draw a regular hexagon centered at (x, y) */
export function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2
    const px = x + radius * Math.cos(angle)
    const py = y + radius * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}
