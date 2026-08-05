/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  resize(width: number, height: number): void {
    // Bloom at half resolution for performance
    const scale = 0.5
    this.bloomCanvas.width = width * scale
    this.bloomCanvas.height = height * scale
    this.tempCanvas.width = width * scale
    this.tempCanvas.height = height * scale
  }

  /**
   * @param destWidth  Destination width in CSS pixels.
   * @param destHeight Destination height in CSS pixels.
   *
   * The size must be given in CSS pixels, not backing-store pixels: the target
   * context is already scaled by devicePixelRatio, so compositing at
   * `sourceCanvas.width` drew the glow at dpr× its correct size — a visible
   * ghost of the scene on any display where dpr !== 1.
   */
  apply(
    sourceCanvas: HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    destWidth: number,
    destHeight: number,
  ): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw source at half resolution
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)

    // Apply blur passes (box blur approximation of gaussian)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 8)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 6)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 4)

    // Composite bloom over the target with additive blending
    targetCtx.save()
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.bloomCanvas, 0, 0, destWidth, destHeight)
    targetCtx.restore()
  }

  private boxBlur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    // Use CSS filter for fast blur
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
