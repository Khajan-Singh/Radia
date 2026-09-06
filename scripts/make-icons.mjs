/**
 * Generates the tray and app icons so the repo carries no binary assets.
 *
 * Radia's mark is the product shot: an opaque dark plate - a screen - with the
 * light living only on its rim. The plate has to be opaque, not a transparent
 * interior, or the icon has no silhouette against a light wallpaper and reads
 * as a coloured fringe around nothing.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
      raw[o++] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Rounded-rect signed distance, negative inside. */
function roundedRect(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius
  const qy = Math.abs(py) - half + radius
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))

function hsv(h, s, v) {
  const c = v * s
  const hh = ((((h % 360) + 360) % 360) / 60) % 6
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  const seg = table[Math.floor(hh)]
  return [seg[0] + m, seg[1] + m, seg[2] + m]
}

// The plate's own colour, matching --bg in src/renderer/shared/tokens.css.
const BODY = [0x0c / 255, 0x0c / 255, 0x0e / 255]

// Everything below is in a 32-unit square, scaled to whatever size is asked
// for, so the proportions are identical at 16px and at 256px.
const HALF = 13.2      // leaves ~9% padding, which Windows expects around an icon
const RADIUS = 7.5
const RIM = 3.0        // core band depth
const HUE_A = 275      // violet
const HUE_B = 165      // cyan-green

const mark = (x, y, size) => {
  const s = size / 32
  const cx = (x + 0.5 - size / 2) / s
  const cy = (y + 0.5 - size / 2) / s
  const d = roundedRect(cx, cy, HALF, RADIUS)
  const aa = 1 / s

  const plate = clamp01(0.5 - d / aa)
  if (plate <= 0.002) return [0, 0, 0, 0]

  // Perimeter position from a centre-cast ray, as in rim.frag - nearest-edge
  // arc length differs by a screen width along a corner diagonal and puts a
  // hard seam out of every corner.
  const along = (Math.atan2(cy, cx) / (Math.PI * 2) + 1.25) % 1

  // A core band hugging the outline plus a wider, softer spill inward. One
  // falloff alone either reads as a hard stripe or washes out the whole plate.
  const inside = d < 0 ? 1 : 0
  const core = Math.pow(1 - clamp01(-d / RIM), 1.5) * inside
  const spill = Math.pow(1 - clamp01(-d / (RIM * 2.6)), 2.4) * inside * 0.5

  // A two-stop gradient rather than a full hue sweep: closer to what an album
  // cover actually yields, and it survives 16px where a rainbow turns to mud.
  // cos() is exactly periodic across the wrap at 1 -> 0, so there is no seam.
  // Violet at the top-right sweeping to cyan at the bottom-left ("aurora"):
  // the earlier magenta-to-yellow washed out against light wallpapers.
  const sweep = 0.5 + 0.5 * Math.cos(along * Math.PI * 2)
  const hue = HUE_A + (HUE_B - HUE_A) * sweep
  const gain = 0.8 + 0.2 * (0.5 + 0.5 * Math.cos(along * Math.PI * 2 - 1.0))
  const lum = clamp01((core + spill) * 1.35 * gain)

  const [hr, hg, hb] = hsv(hue, 0.9, 1)
  return [
    Math.round(clamp01(BODY[0] + hr * lum) * 255),
    Math.round(clamp01(BODY[1] + hg * lum) * 255),
    Math.round(clamp01(BODY[2] + hb * lum) * 255),
    Math.round(plate * 255)
  ]
}

mkdirSync(join(root, 'resources'), { recursive: true })
writeFileSync(join(root, 'resources', 'tray.png'), png(32, mark))
writeFileSync(join(root, 'resources', 'icon.png'), png(256, mark))
console.log('wrote resources/tray.png and resources/icon.png')
