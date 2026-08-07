import { DepthParticle } from '@/lib/canvas-config'
import { COLORS } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'

const NUM_PARTICLES = 44
const GRID_SIZE = 24
const MAJOR_GRID_EVERY = 5

export function createDepthParticles(width: number, height: number): DepthParticle[] {
  const particles: DepthParticle[] = []
  for (let i = 0; i < NUM_PARTICLES; i++) {
    particles.push({
      x: Math.random() * width * 2 - width * 0.5,
      y: Math.random() * height * 2 - height * 0.5,
      size: Math.random() * 1.1 + 0.35,
      brightness: Math.random() * 0.22 + 0.04,
      speed: Math.random() * 0.09 + 0.02,
      depth: Math.random(),
    })
  }
  return particles
}

export function updateDepthParticles(
  particles: DepthParticle[],
  deltaTime: number,
  width: number,
  height: number,
): void {
  for (const p of particles) {
    p.x += p.speed * deltaTime * 10 * (1 - p.depth * 0.5)
    p.y -= p.speed * deltaTime * 5 * (1 - p.depth * 0.3)

    // Wrap around
    if (p.x > width * 1.5) p.x = -width * 0.5
    if (p.y < -height * 0.5) p.y = height * 1.5
  }
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: DepthParticle[],
  transform: { x: number; y: number; scale: number },
  showHexGrid: boolean,
  time: number,
  activeAgentPos?: { x: number; y: number; color: string },
): void {
  // Graphite instrument bed.
  ctx.fillStyle = COLORS.void
  ctx.fillRect(0, 0, width, height)

  const wash = ctx.createRadialGradient(width * 0.55, height * 0.44, 0, width * 0.55, height * 0.44, Math.max(width, height) * 0.78)
  wash.addColorStop(0, 'rgba(19, 48, 37, 0.25)')
  wash.addColorStop(0.52, 'rgba(5, 12, 8, 0.08)')
  wash.addColorStop(1, 'rgba(2, 5, 3, 0.5)')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, width, height)

  // Ambient spotlight following active agent
  if (activeAgentPos) {
    const screenX = activeAgentPos.x * transform.scale + transform.x
    const screenY = activeAgentPos.y * transform.scale + transform.y
    const gradient = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, 340)
    gradient.addColorStop(0, activeAgentPos.color + '10')
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }

  // Sparse drifting telemetry dust. Tiny square marks read as samples, not stars.
  for (const p of particles) {
    const parallaxFactor = 0.3 + p.depth * 0.7
    const px = p.x + transform.x * parallaxFactor * 0.1
    const py = p.y + transform.y * parallaxFactor * 0.1
    const size = p.size * (0.5 + p.depth * 0.5)
    const alpha = p.brightness * (0.5 + p.depth * 0.5)

    ctx.fillStyle = COLORS.holoBase + alphaHex(alpha)
    ctx.fillRect(Math.round(px), Math.round(py), size * 1.7, size * 0.65)
  }

  // Drafting grid (optional)
  if (showHexGrid) {
    drawEngineeringGrid(ctx, width, height, transform, time)
  }


  // Fixed screen reticle and calibration ticks keep the viewport feeling like
  // an instrument even while the world underneath pans and zooms.
  drawScreenCalibration(ctx, width, height, time)
}

function drawEngineeringGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: { x: number; y: number; scale: number },
  time: number,
): void {
  const scale = Math.max(transform.scale, 0.2)
  const minor = GRID_SIZE * scale
  const major = minor * MAJOR_GRID_EVERY
  const offsetX = ((transform.x % major) + major) % major
  const offsetY = ((transform.y % major) + major) % major

  ctx.save()
  ctx.lineWidth = 1

  if (minor >= 6) {
    ctx.strokeStyle = 'rgba(121, 242, 192, 0.035)'
    ctx.beginPath()
    for (let x = offsetX % minor; x < width; x += minor) { ctx.moveTo(x, 0); ctx.lineTo(x, height) }
    for (let y = offsetY % minor; y < height; y += minor) { ctx.moveTo(0, y); ctx.lineTo(width, y) }
    ctx.stroke()
  }

  ctx.strokeStyle = 'rgba(121, 242, 192, 0.10)'
  ctx.beginPath()
  for (let x = offsetX; x < width; x += major) { ctx.moveTo(x, 0); ctx.lineTo(x, height) }
  for (let y = offsetY; y < height; y += major) { ctx.moveTo(0, y); ctx.lineTo(width, y) }
  ctx.stroke()

  // A faint signal sweep makes the grid feel live without hiding the graph.
  const sweepX = ((time * 42) % (width + 240)) - 120
  const sweep = ctx.createLinearGradient(sweepX - 80, 0, sweepX + 80, 0)
  sweep.addColorStop(0, 'rgba(121, 242, 192, 0)')
  sweep.addColorStop(0.5, 'rgba(121, 242, 192, 0.035)')
  sweep.addColorStop(1, 'rgba(121, 242, 192, 0)')
  ctx.fillStyle = sweep
  ctx.fillRect(sweepX - 80, 0, 160, height)
  ctx.restore()
}

function drawScreenCalibration(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
): void {
  ctx.save()
  ctx.strokeStyle = 'rgba(121, 242, 192, 0.17)'
  ctx.fillStyle = 'rgba(121, 242, 192, 0.32)'
  ctx.lineWidth = 1

  const cx = width / 2
  const cy = height / 2
  ctx.beginPath()
  ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 4, cy)
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 14, cy)
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 4)
  ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 14)
  ctx.stroke()

  for (let x = 24; x < width - 24; x += 48) {
    const tall = x % 192 === 24
    ctx.fillRect(x, 0, 1, tall ? 8 : 4)
    ctx.fillRect(x, height - (tall ? 8 : 4), 1, tall ? 8 : 4)
  }
  for (let y = 24; y < height - 24; y += 48) {
    const tall = y % 192 === 24
    ctx.fillRect(0, y, tall ? 8 : 4, 1)
    ctx.fillRect(width - (tall ? 8 : 4), y, tall ? 8 : 4, 1)
  }

  const pulse = 0.12 + (Math.sin(time * 1.2) + 1) * 0.025
  ctx.strokeStyle = `rgba(121, 242, 192, ${pulse})`
  ctx.strokeRect(12.5, 12.5, width - 25, height - 25)
  ctx.restore()
}
