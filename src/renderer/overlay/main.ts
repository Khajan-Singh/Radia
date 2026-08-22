import vertSource from './rim.vert?raw'
import fragSource from './rim.frag?raw'
import {
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  SILENT_FRAME,
  type AudioFrame,
  type Palette,
  type Rgb,
  type Settings
} from '../../shared/types'

const MAX_COLORS = 3
const MAX_PULSES = 8
const CROSSFADE_MS = 800

// Slider ranges. Thickness and glow are stored 0-1 and mapped to pixels here so
// the shader never has to know about settings semantics.
const THICKNESS_PX = { min: 2, max: 46 }
const SPILL_PX = { min: 8, max: 190 }

// ─── State ───────────────────────────────────────────────────────────────────

let settings: Settings = { ...DEFAULT_SETTINGS }
let audio: AudioFrame = { ...SILENT_FRAME }

/** Palette the shader is currently showing, and the one it is easing toward. */
let shown = { colors: padColors(DEFAULT_PALETTE.colors), centers: centersOf(DEFAULT_PALETTE), count: DEFAULT_PALETTE.colors.length }
let target = { ...shown }
let fadeStart = 0
let fading = false

interface Pulse {
  position: number
  born: number
  strength: number
}
let pulses: Pulse[] = []

/** Smoothed audio drivers - the raw frames are jittery at 60Hz. */
let bassEnv = 0
let rmsEnv = 0
let flowPhase = 0
let lastFrameTime = 0
let idleSince = 0

// ─── Palette helpers ─────────────────────────────────────────────────────────

function padColors(colors: Rgb[]): Rgb[] {
  const out: Rgb[] = []
  for (let i = 0; i < MAX_COLORS; i++) out.push(colors[i] ?? colors[colors.length - 1] ?? [1, 1, 1])
  return out
}

/**
 * Turns weights into gradient center positions around the rim. A color with a
 * larger weight gets a wider arc, so its center sits further from its neighbour.
 */
function centersOf(palette: Palette): number[] {
  const count = Math.max(1, Math.min(MAX_COLORS, palette.colors.length))
  const weights = palette.weights.slice(0, count)
  const total = weights.reduce((a, b) => a + b, 0) || count
  const centers: number[] = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    const share = (weights[i] ?? 1 / count) / total
    centers.push(cursor + share / 2)
    cursor += share
  }
  while (centers.length < MAX_COLORS) centers.push(centers[centers.length - 1])
  return centers
}

function applyPalette(palette: Palette): void {
  const next = {
    colors: padColors(palette.colors),
    centers: centersOf(palette),
    count: Math.max(1, Math.min(MAX_COLORS, palette.colors.length))
  }
  // Ease from whatever is on screen right now, not from the previous target -
  // otherwise rapid track changes snap.
  shown = currentBlend()
  target = next
  fadeStart = performance.now()
  fading = true
}

function currentBlend(): typeof shown {
  if (!fading) return target
  const k = Math.min(1, (performance.now() - fadeStart) / CROSSFADE_MS)
  const ease = k * k * (3 - 2 * k)
  const colors: Rgb[] = []
  const centers: number[] = []
  for (let i = 0; i < MAX_COLORS; i++) {
    const a = shown.colors[i]
    const b = target.colors[i]
    colors.push([
      a[0] + (b[0] - a[0]) * ease,
      a[1] + (b[1] - a[1]) * ease,
      a[2] + (b[2] - a[2]) * ease
    ])
    centers.push(shown.centers[i] + (target.centers[i] - shown.centers[i]) * ease)
  }
  return { colors, centers, count: ease > 0.5 ? target.count : shown.count }
}

// ─── GL setup ────────────────────────────────────────────────────────────────

const canvas = document.getElementById('rim') as HTMLCanvasElement
const gl = canvas.getContext('webgl2', {
  alpha: true,
  premultipliedAlpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: 'low-power'
})

if (!gl) throw new Error('WebGL2 unavailable - the rim overlay cannot render')

function compile(type: number, source: string): WebGLShader {
  const shader = gl!.createShader(type)!
  gl!.shaderSource(shader, source)
  gl!.compileShader(shader)
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl!.getShaderInfoLog(shader)}`)
  }
  return shader
}

const program = gl.createProgram()!
gl.attachShader(program, compile(gl.VERTEX_SHADER, vertSource))
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragSource))
gl.linkProgram(program)
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
}
gl.useProgram(program)

// The vertex shader generates its own geometry from gl_VertexID, but WebGL2
// still requires a bound VAO to draw.
gl.bindVertexArray(gl.createVertexArray())

const u = {
  res: gl.getUniformLocation(program, 'uRes'),
  time: gl.getUniformLocation(program, 'uTime'),
  colors: gl.getUniformLocation(program, 'uColors'),
  centers: gl.getUniformLocation(program, 'uCenters'),
  count: gl.getUniformLocation(program, 'uCount'),
  thickness: gl.getUniformLocation(program, 'uThickness'),
  corner: gl.getUniformLocation(program, 'uCorner'),
  spill: gl.getUniformLocation(program, 'uSpill'),
  glowStrength: gl.getUniformLocation(program, 'uGlowStrength'),
  offset: gl.getUniformLocation(program, 'uOffset'),
  intensity: gl.getUniformLocation(program, 'uIntensity'),
  warp: gl.getUniformLocation(program, 'uWarp'),
  pulses: gl.getUniformLocation(program, 'uPulses'),
  pulseWidth: gl.getUniformLocation(program, 'uPulseWidth')
}

const colorBuffer = new Float32Array(MAX_COLORS * 3)
const centerBuffer = new Float32Array(MAX_COLORS)
const pulseBuffer = new Float32Array(MAX_PULSES * 2)

function resize(): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(window.innerWidth * dpr)
  const h = Math.round(window.innerHeight * dpr)
  if (canvas.width === w && canvas.height === h) return
  canvas.width = w
  canvas.height = h
  gl!.viewport(0, 0, w, h)
}

// ─── Animation drivers ───────────────────────────────────────────────────────

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k

/**
 * Asymmetric envelope: snap up on transients, ease down afterwards. A symmetric
 * filter either smears the attack or makes the decay twitchy.
 */
function envelope(current: number, input: number, attack: number, release: number): number {
  return input > current ? lerp(current, input, attack) : lerp(current, input, release)
}

function spawnPulse(now: number, strength: number): void {
  // Pulses live in gradient space, not screen space: the shader compares them
  // against `t`, which already has uOffset folded in. Storing the offset here
  // too cancelled it out - fract(along + uOffset) == uOffset solves to
  // along == 0 - so every pulse was in fact born at the top-left corner, the one
  // point where the perimeter coordinate wraps, which is the opposite of what
  // this comment used to claim. Spawning at the gradient origin instead lets the
  // entry point ride around the rim with the gradient, which is what leaving the
  // "front" of the animation was always meant to mean.
  pulses.push({ position: 0, born: now, strength })
  if (pulses.length > MAX_PULSES) pulses.shift()
}

function updatePulses(now: number): void {
  const LIFETIME = 1600
  pulses = pulses.filter((p) => now - p.born < LIFETIME)
  pulseBuffer.fill(0)
  pulses.forEach((p, i) => {
    if (i >= MAX_PULSES) return
    const age = (now - p.born) / LIFETIME
    // Travel most of the way round over the pulse's life, fading as it goes.
    const position = (p.position + age * 0.85) % 1
    pulseBuffer[i * 2] = position
    pulseBuffer[i * 2 + 1] = p.strength * (1 - age) ** 2
  })
}

// ─── Render loop ─────────────────────────────────────────────────────────────

const startedAt = performance.now()
let rafHandle = 0

function render(now: number): void {
  rafHandle = requestAnimationFrame(render)

  const dt = Math.min(0.1, (now - lastFrameTime) / 1000) || 0.016
  lastFrameTime = now
  resize()

  const { sensitivity, smoothing } = settings.audio
  const release = lerp(0.25, 0.03, Math.min(1, Math.max(0, smoothing)))

  bassEnv = envelope(bassEnv, Math.min(1, (audio.bass + audio.sub * 0.6) * sensitivity), 0.5, release)
  rmsEnv = envelope(rmsEnv, Math.min(1, audio.rms * sensitivity), 0.4, release)

  let intensity = 1
  let warp = 0
  let speed = 0

  switch (settings.animation) {
    case 'static':
      break

    case 'music': {
      // Bass drives brightness; the tempo (when known) sets the drift rate so
      // fast tracks visibly move faster than slow ones.
      const tempo = audio.bpm > 0 ? Math.min(2, audio.bpm / 120) : 1
      speed = 0.02 * tempo + bassEnv * 0.05
      warp = 0.03 + rmsEnv * 0.05
      intensity = 0.45 + 0.55 * Math.max(bassEnv, rmsEnv * 0.8)
      if (audio.onset) spawnPulse(now, Math.min(1, 0.5 + bassEnv))
      break
    }
  }

  flowPhase += speed * dt
  updatePulses(now)

  const blend = currentBlend()
  if (fading && now - fadeStart >= CROSSFADE_MS) {
    fading = false
    shown = target
  }

  for (let i = 0; i < MAX_COLORS; i++) {
    colorBuffer[i * 3] = blend.colors[i][0]
    colorBuffer[i * 3 + 1] = blend.colors[i][1]
    colorBuffer[i * 3 + 2] = blend.colors[i][2]
    centerBuffer[i] = blend.centers[i]
  }

  const dpr = window.devicePixelRatio || 1
  const thicknessPx =
    (THICKNESS_PX.min + (THICKNESS_PX.max - THICKNESS_PX.min) * settings.thickness) *
    dpr *
    (settings.animation === 'music' ? 1 + bassEnv * 0.35 : 1)
  const spillPx = (SPILL_PX.min + (SPILL_PX.max - SPILL_PX.min) * settings.glow) * dpr

  gl!.uniform2f(u.res, canvas.width, canvas.height)
  gl!.uniform1f(u.time, (now - startedAt) / 1000)
  gl!.uniform3fv(u.colors, colorBuffer)
  gl!.uniform1fv(u.centers, centerBuffer)
  gl!.uniform1i(u.count, blend.count)
  gl!.uniform1f(u.thickness, thicknessPx)
  // Round the frame in proportion to the display, so the corners read the same
  // on a laptop panel and an ultrawide.
  gl!.uniform1f(u.corner, Math.min(canvas.width, canvas.height) * 0.05)
  gl!.uniform1f(u.spill, spillPx)
  gl!.uniform1f(u.glowStrength, 0.28 + settings.glow * 0.34)
  gl!.uniform1f(u.offset, flowPhase % 1)
  gl!.uniform1f(u.intensity, intensity)
  gl!.uniform1f(u.warp, warp)
  gl!.uniform2fv(u.pulses, pulseBuffer)
  gl!.uniform1f(u.pulseWidth, 0.05)

  gl!.clearColor(0, 0, 0, 0)
  gl!.clear(gl!.COLOR_BUFFER_BIT)
  gl!.drawArrays(gl!.TRIANGLES, 0, 3)

  maybePark(now)
}

/**
 * A still gradient does not need 60fps. When nothing is moving, park the loop
 * and let a settings or palette change wake it back up.
 */
function maybePark(now: number): void {
  const moving =
    settings.animation !== 'static' || fading || pulses.length > 0 || bassEnv > 0.01
  if (moving) {
    idleSince = 0
    return
  }
  if (!idleSince) idleSince = now
  if (now - idleSince > 1000) {
    cancelAnimationFrame(rafHandle)
    rafHandle = 0
  }
}

function wake(): void {
  if (!rafHandle) {
    idleSince = 0
    lastFrameTime = performance.now()
    rafHandle = requestAnimationFrame(render)
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

const api = window.radia

void api.getState().then((state) => {
  settings = state.settings
  applyPalette(state.palette)
  wake()
})

api.onSettings((next) => {
  settings = next
  wake()
})

api.onPalette((next) => {
  applyPalette(next)
  wake()
})

api.onAudio((frame) => {
  audio = frame
  if (frame.rms > 0.001 || frame.onset) wake()
})

window.addEventListener('resize', () => {
  resize()
  wake()
})

rafHandle = requestAnimationFrame(render)
