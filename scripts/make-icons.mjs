/**
 * Generates the tray and app icons so the repo carries no binary assets.
 * Draws Radia's mark: a rounded rim of light with a dark interior.
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

const mark = (x, y, size) => {
  const s = size / 32
  const cx = (x + 0.5 - size / 2) / s
  const cy = (y + 0.5 - size / 2) / s
  const d = roundedRect(cx, cy, 14, 5)

  // A bright band on the outline itself, spilling only slightly inward - the
  // interior has to stay dark or the mark reads as a blob at 16px.
  const band = Math.exp(-Math.abs(d) / 1.2)
  const inner = d < 0 ? Math.exp(d / 2.0) * 0.3 : 0
  const alpha = Math.min(1, band + inner)
  if (alpha < 0.02 || d > 1.5) return [0, 0, 0, 0]

  // Hue sweeps the full circle so it meets itself with no seam at the wrap.
  const angle = (Math.atan2(cy, cx) / (Math.PI * 2) + 1) % 1
  const hue = angle * 360 + 320
  const [r, g, b] = hsv(hue % 360, 0.8, 1)
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(alpha * 255)]
}

function hsv(h, s, v) {
  const c = v * s
  const hh = h / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  const seg = table[Math.floor(hh) % 6]
  return [seg[0] + m, seg[1] + m, seg[2] + m]
}

mkdirSync(join(root, 'resources'), { recursive: true })
writeFileSync(join(root, 'resources', 'tray.png'), png(32, mark))
writeFileSync(join(root, 'resources', 'icon.png'), png(256, mark))
console.log('wrote resources/tray.png and resources/icon.png')
