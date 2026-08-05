/** Convert a 0–1 alpha value to a two-character hex string (e.g. 0.5 → '80') */
export function alphaHex(alpha: number): string {
  return Math.floor(alpha * 255).toString(16).padStart(2, '0')
}
