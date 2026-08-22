/**
 * Pixel mappings shared by the overlay driver and scripts/preview-rim.mjs.
 *
 * Plain ESM on purpose: the preview harness runs under Electron without a
 * bundler, and duplicating these numbers there is exactly how a rim bug once
 * survived review - the harness rendered a geometry the app never used.
 * Types live in geometry.d.mts.
 */

/**
 * Thickness slider (0-1) -> solid core depth in device px, 2..24.
 *
 * The range used to top out at 46px, but the wave swells the core up to 4.3x
 * and the halo reaches a further 2.5x past it, so the top of the slider put a
 * ~200px crest into the screen. 24px keeps the top end a bold rim, not a wall.
 */
export function thicknessPx(thickness, dpr) {
  return (2 + 22 * thickness) * dpr
}

/**
 * Corner radius follows the thickness, so a hairline rim meets the screen
 * corner crisply and a thick one rounds softly. A radius independent of
 * thickness (the old 5%-of-screen rule) put an 80px glowing arc on the end of
 * a 2px line, which read as a blob in every corner.
 */
export function cornerPx(corePx, dpr) {
  return Math.min(40 * dpr, Math.max(6 * dpr, corePx * 1.6))
}

/** How far the halo reaches past the core. Proportional, so thin rims glow subtly. */
export function spillPx(corePx, dpr) {
  return corePx * 2.5 + 10 * dpr
}

/** Halo brightness relative to the core. Fixed - there is no glow setting. */
export const GLOW_STRENGTH = 0.42

/** Snake: share of the perimeter the snake covers, and the taper at each end (share of its length). */
export const SNAKE_LENGTH = 0.5
export const SNAKE_FEATHER = 0.12

export const MODE = { static: 0, music: 1, snake: 2 }
