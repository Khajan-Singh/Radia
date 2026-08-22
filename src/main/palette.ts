import { nativeImage } from 'electron'
import type { ColorOverride, Palette, Rgb, Settings } from '../shared/types'

const SAMPLE = 64      // artwork is downscaled to this before clustering
const K = 5            // cluster count
const ITERATIONS = 12

// ─── Color space helpers ─────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB 0-1 -> CIE Lab. Clustering in Lab keeps distances perceptual. */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  let x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047
  let y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
  let z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  x = f(x)
  y = f(y)
  z = f(z)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const table: Rgb[] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  const seg = table[Math.floor(hh) % 6]
  return [seg[0] + m, seg[1] + m, seg[2] + m]
}

// ─── Extraction ──────────────────────────────────────────────────────────────

interface Cluster {
  lab: [number, number, number]
  rgb: Rgb
  count: number
}

interface Sample {
  rgb: Rgb
  lab: [number, number, number]
}

/**
 * Pulls a small set of vivid, well-separated colors out of album art.
 *
 * Plain dominant-color extraction on album art tends to return the background,
 * which is very often near-black or near-white and makes for a dull rim. So
 * greys and extremes are filtered out first, and what remains is ranked by
 * population *and* saturation rather than population alone.
 */
export function extractPalette(dataUrl: string, count: number, key: string): Palette | null {
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return null

  const small = image.resize({ width: SAMPLE, height: SAMPLE, quality: 'good' })
  const bitmap = small.getBitmap()          // BGRA
  const size = small.getSize()
  const pixels: Sample[] = []

  for (let i = 0; i < size.width * size.height; i++) {
    const o = i * 4
    if (bitmap[o + 3] < 128) continue
    const b = bitmap[o] / 255
    const g = bitmap[o + 1] / 255
    const r = bitmap[o + 2] / 255
    const hsv = rgbToHsv(r, g, b)
    // Drop muddy greys and near black/white - they never make good rim light.
    if (hsv[1] < 0.15 || hsv[2] < 0.12 || hsv[2] > 0.97) continue
    pixels.push({ rgb: [r, g, b], lab: rgbToLab(r, g, b) })
  }

  if (pixels.length < 16) return monochromeFallback(bitmap, size, count, key)

  const clusters = kmeans(pixels).filter((c) => c.count > 0)
  if (clusters.length === 0) return monochromeFallback(bitmap, size, count, key)

  const ranked = clusters
    .map((cluster) => ({ cluster, score: score(cluster) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.cluster)

  const picked = pickDistinct(ranked, count)
  const scores = picked.map(score)
  const total = scores.reduce((a, b) => a + b, 0) || 1

  return {
    colors: picked.map((c) => boost(c.rgb)),
    weights: scores.map((s) => s / total),
    key
  }
}

/**
 * Population alone favors backgrounds; the saturation term pulls the accent
 * color forward and the value term keeps it from being a dark smear.
 */
function score(c: Cluster): number {
  const hsv = rgbToHsv(c.rgb[0], c.rgb[1], c.rgb[2])
  return c.count * (0.35 + hsv[1]) * (0.4 + hsv[2])
}

function kmeans(pixels: Sample[]): Cluster[] {
  // Deterministic seeding by even stride - k-means++ is overkill at this size,
  // and a stable palette across restarts matters more than optimal clustering.
  const stride = Math.max(1, Math.floor(pixels.length / K))
  let centers = Array.from(
    { length: K },
    (_, i) => pixels[Math.min(i * stride, pixels.length - 1)].lab
  )

  const assign = new Array<number>(pixels.length).fill(-1)

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = false
    for (let i = 0; i < pixels.length; i++) {
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < centers.length; c++) {
        const dl = pixels[i].lab[0] - centers[c][0]
        const da = pixels[i].lab[1] - centers[c][1]
        const db = pixels[i].lab[2] - centers[c][2]
        const dist = dl * dl + da * da + db * db
        if (dist < bestDist) {
          bestDist = dist
          best = c
        }
      }
      if (assign[i] !== best) {
        assign[i] = best
        moved = true
      }
    }
    if (!moved) break

    const sums = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < pixels.length; i++) {
      const s = sums[assign[i]]
      s[0] += pixels[i].lab[0]
      s[1] += pixels[i].lab[1]
      s[2] += pixels[i].lab[2]
      s[3]++
    }
    centers = centers.map((c, i) =>
      sums[i][3] === 0
        ? c
        : [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]]
    )
  }

  const out: Cluster[] = centers.map((lab) => ({ lab, rgb: [0, 0, 0] as Rgb, count: 0 }))
  const rgbSums = centers.map(() => [0, 0, 0])
  for (let i = 0; i < pixels.length; i++) {
    const c = assign[i]
    out[c].count++
    rgbSums[c][0] += pixels[i].rgb[0]
    rgbSums[c][1] += pixels[i].rgb[1]
    rgbSums[c][2] += pixels[i].rgb[2]
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].count === 0) continue
    out[i].rgb = [
      rgbSums[i][0] / out[i].count,
      rgbSums[i][1] / out[i].count,
      rgbSums[i][2] / out[i].count
    ]
  }
  return out
}

/** Walks the ranked list taking colors that are not near-duplicates of earlier picks. */
function pickDistinct(ranked: Cluster[], count: number): Cluster[] {
  const MIN_HUE_GAP = 25
  const picked: Cluster[] = []

  for (const c of ranked) {
    if (picked.length >= count) break
    const h = rgbToHsv(c.rgb[0], c.rgb[1], c.rgb[2])[0]
    const clash = picked.some((p) => {
      const ph = rgbToHsv(p.rgb[0], p.rgb[1], p.rgb[2])[0]
      const d = Math.abs(h - ph)
      return Math.min(d, 360 - d) < MIN_HUE_GAP
    })
    if (!clash) picked.push(c)
  }

  // Artwork with a single dominant hue cannot fill the quota distinctly. Rather
  // than repeat a color, rotate the hue so the gradient has somewhere to go.
  let rotation = 1
  while (picked.length < count && ranked.length > 0) {
    const base = picked[0] ?? ranked[0]
    const hsv = rgbToHsv(base.rgb[0], base.rgb[1], base.rgb[2])
    picked.push({
      lab: base.lab,
      rgb: hsvToRgb(hsv[0] + rotation * 40, hsv[1], hsv[2]),
      count: Math.max(1, Math.round(base.count * 0.5))
    })
    rotation++
  }
  return picked.slice(0, count)
}

/** Lifts saturation and value so the rim reads as light rather than paint. */
function boost(rgb: Rgb): Rgb {
  const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2])
  return hsvToRgb(hsv[0], Math.min(1, hsv[1] * 1.15), Math.min(1, Math.max(hsv[2], 0.55) * 1.1))
}

/** Monochrome or near-empty artwork: derive something usable from the average hue. */
function monochromeFallback(
  bitmap: Buffer,
  size: { width: number; height: number },
  count: number,
  key: string
): Palette {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < size.width * size.height; i++) {
    const o = i * 4
    if (bitmap[o + 3] < 128) continue
    b += bitmap[o]
    g += bitmap[o + 1]
    r += bitmap[o + 2]
    n++
  }
  if (n === 0) return { colors: [[0.8, 0.8, 0.85]], weights: [1], key }

  const hsv = rgbToHsv(r / n / 255, g / n / 255, b / n / 255)
  const sat = Math.max(0.45, hsv[1])
  const colors: Rgb[] = []
  for (let i = 0; i < count; i++) colors.push(hsvToRgb(hsv[0] + i * 35, sat, 0.9))
  return { colors, weights: colors.map(() => 1 / count), key }
}

/** Builds the palette from the manual color wheels instead of the artwork. */
export function overridePalette(settings: Settings): Palette {
  const wheels: ColorOverride[] = [settings.primary, settings.secondary, settings.tertiary]
  const count = settings.gradientMode
  const chosen = wheels.slice(0, count)
  const colors = chosen.map((c) => hsvToRgb(c.h, c.s, c.v))

  const raw =
    count === 1
      ? [1]
      : count === 2
        ? [settings.primaryWeight, settings.secondaryWeight]
        : [
            settings.primaryWeight,
            settings.secondaryWeight,
            Math.max(0.05, 1 - settings.primaryWeight - settings.secondaryWeight)
          ]
  const total = raw.reduce((a, b) => a + b, 0) || 1

  return {
    colors,
    weights: raw.map((w) => w / total),
    key: `override:${JSON.stringify(chosen)}`
  }
}
