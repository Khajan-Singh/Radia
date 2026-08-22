import vertSource from './rim.vert?raw'
import fragSource from './rim.frag?raw'
import {
  GLOW_STRENGTH,
  MODE,
  SNAKE_FEATHER,
  SNAKE_LENGTH,
  cornerPx,
  spillPx,
  thicknessPx
} from './geometry.mjs'
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
const CROSSFADE_MS = 800

// ─── State ───────────────────────────────────────────────────────────────────

let settings: Settings = { ...DEFAULT_SETTINGS }
let audio: AudioFrame = { ...SILENT_FRAME }
/**
 * Onsets counted since the last frame. Audio frames arrive at ~43Hz in bursts
 * and the overlay only latches the newest one, so an onset flagged on a frame
 * that lands between two rAFs used to be overwritten before anyone saw it.
 */
let pendingOnsets = 0

/** Palette the shader is currently showing, and the one it is easing toward. */
let shown = { colors: padColors(DEFAULT_PALETTE.colors), centers: centersOf(DEFAULT_PALETTE), count: DEFAULT_PALETTE.colors.length }
let target = { ...shown }
let fadeStart = 0
let fading = false

/** Smoothed audio drivers - the raw frames are jittery. */
let bassEnv = 0
let rmsEnv = 0
let beatEnv = 0
let beatPeak = 0   // decaying ceiling beatEnv eases toward, so a beat is a curve not a step
let slowBass = 0   // heavily smoothed bass, the only bass reading geometry is allowed to use

// Every phase lives in [0, 1) and is wrapped each frame. Letting one grow
// without bound and taking `% 1` at the end spends the float's precision on the
// integer part, and the animation gets visibly steppy a few hours in.
let driftPhase = 0   // gradient rotation (Sync)
let wavePhase = 0    // travelling wave (Sync, snake ripple)
let snakeHead = 0    // Snake head, clockwise from the top-left
let waveAmpEnv = 0   // smoothed wave height, so beats swell rather than snap
let intensityEnv = 1 // smoothed brightness, so beats glow up rather than pop

/**
 * Motion owed from recent beats, released through two cascaded exponentials.
 * One exponential starts at full speed and decays, which reads as a jolt; the
 * cascade ramps the velocity up over `tauIn` and back down over `tauOut`, so a
 * beat becomes a smooth surge with no step in velocity anywhere.
 */
interface Surge {
  pending: number
  moving: number
}
const snakeLurch: Surge = { pending: 0, moving: 0 }
const waveKick: Surge = { pending: 0, moving: 0 }

function releaseSurge(s: Surge, dt: number, tauIn: number, tauOut: number): number {
  const admitted = s.pending * (1 - Math.exp(-dt / tauIn))
  s.pending -= admitted
  s.moving += admitted
  const step = s.moving * (1 - Math.exp(-dt / tauOut))
  s.moving -= step
  return step
}
let quietSince = 0

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
  colors: gl.getUniformLocation(program, 'uColors'),
  centers: gl.getUniformLocation(program, 'uCenters'),
  count: gl.getUniformLocation(program, 'uCount'),
  thickness: gl.getUniformLocation(program, 'uThickness'),
  spill: gl.getUniformLocation(program, 'uSpill'),
  glowStrength: gl.getUniformLocation(program, 'uGlowStrength'),
  corner: gl.getUniformLocation(program, 'uCorner'),
  offset: gl.getUniformLocation(program, 'uOffset'),
  intensity: gl.getUniformLocation(program, 'uIntensity'),
  mode: gl.getUniformLocation(program, 'uMode'),
  wavePhase: gl.getUniformLocation(program, 'uWavePhase'),
  waveAmp: gl.getUniformLocation(program, 'uWaveAmp'),
  snakeHead: gl.getUniformLocation(program, 'uSnakeHead'),
  snakeLength: gl.getUniformLocation(program, 'uSnakeLength'),
  snakeFeather: gl.getUniformLocation(program, 'uSnakeFeather')
}

const colorBuffer = new Float32Array(MAX_COLORS * 3)
const centerBuffer = new Float32Array(MAX_COLORS)

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
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const wrap = (x: number): number => x - Math.floor(x)

/**
 * Asymmetric envelope: snap up on transients, ease down afterwards. A symmetric
 * filter either smears the attack or makes the decay twitchy.
 */
function envelope(current: number, input: number, attack: number, release: number): number {
  return input > current ? lerp(current, input, attack) : lerp(current, input, release)
}

/**
 * Time-based asymmetric easing: moves toward `target` with time constant
 * `tauUp` when rising and `tauDown` when falling, independent of frame rate.
 * Everything the wave is drawn from goes through this rather than the
 * per-frame envelopes above, because the shader multiplies wave height by up
 * to 4x the rim thickness - any wobble in the driver becomes a visible hop.
 */
function ease(current: number, target: number, dt: number, tauUp: number, tauDown: number): number {
  const tau = target > current ? tauUp : tauDown
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

// ─── Render loop ─────────────────────────────────────────────────────────────

let rafHandle = 0

function render(now: number): void {
  rafHandle = requestAnimationFrame(render)

  const dt = Math.min(0.1, (now - lastFrameTime) / 1000) || 0.016
  lastFrameTime = now
  resize()

  const onsets = pendingOnsets
  pendingOnsets = 0

  const { sensitivity, smoothing } = settings.audio
  const release = lerp(0.25, 0.03, clamp01(smoothing))

  bassEnv = envelope(bassEnv, clamp01((audio.bass + audio.sub * 0.6) * sensitivity), 0.5, release)
  rmsEnv = envelope(rmsEnv, clamp01(audio.rms * sensitivity), 0.4, release)
  // A beat is an impulse that rises over ~60ms and decays over 0.4-1.2s, the
  // Smoothing slider choosing the tail. It must not reach its peak on the
  // onset frame itself, or every beat is a step.
  const beatTarget = onsets > 0 ? clamp01(0.7 + bassEnv * 0.3) : 0
  beatPeak = Math.max(beatPeak * Math.exp(-dt / lerp(0.4, 1.2, clamp01(smoothing))), beatTarget)
  beatEnv = ease(beatEnv, beatPeak, dt, 0.06, 0.25)
  // A slow reading of the bass for motion drivers: the raw envelope tracks
  // the bursty ~43Hz frames and is far too twitchy to scale geometry with.
  slowBass = ease(slowBass, bassEnv, dt, 0.2, 0.45)

  // Tempo ratio against 120 BPM, used to pace every motion so fast tracks
  // visibly move faster than slow ones. Unknown tempo reads as 120.
  const tempo = audio.bpm > 0 ? Math.min(2, Math.max(0.5, audio.bpm / 120)) : 1

  let intensity = 1
  let waveAmp = 0

  /**
   * Shared by both music modes. The wave rolls on its own (one cycle
   * every ~5s, so it never looks frozen) and each beat adds a surge of a
   * tenth of a cycle that ramps in over ~180ms and tails off over ~600ms - a
   * push that flows through, not a shove. Faster or larger reads as a stutter. The
   * height follows its own slow envelope rather than the raw bass, so a beat
   * swells the crests instead of snapping them.
   */
  const driveWave = (): void => {
    if (onsets > 0) waveKick.pending += 0.1
    const kick = releaseSurge(waveKick, dt, 0.18, 0.6)
    wavePhase = wrap(wavePhase + dt * (0.14 + 0.08 * tempo) + kick)
    waveAmpEnv = ease(waveAmpEnv, 0.6 + 0.4 * Math.max(beatEnv, slowBass), dt, 0.12, 0.5)
    waveAmp = waveAmpEnv
  }

  switch (settings.animation) {
    case 'static':
      break

    case 'music': {
      // Brightness never drops below 0.7 so the rim never "goes out" between beats.
      driveWave()
      driftPhase = wrap(driftPhase + (dt * tempo) / 120)
      intensity = 0.7 + 0.3 * Math.max(beatEnv, slowBass * 0.8)
      break
    }

    case 'snake': {
      // Entirely beat-driven: no idle glide at all. Every onset is a push that
      // ramps over ~30ms and settles in ~120ms - a step, not a slide - sized by
      // the bass so kicks move it further than hi-hats. Between beats it holds
      // still, which is what makes the motion read as being on the beat. After
      // 1.5s of silence it parks where it is and stays lit.
      if (rmsEnv >= 0.02) quietSince = 0
      else if (!quietSince) quietSince = now
      const parked = quietSince > 0 && now - quietSince > 1500

      if (!parked && onsets > 0) snakeLurch.pending += 0.025 + 0.035 * bassEnv
      const step = releaseSurge(snakeLurch, dt, 0.03, 0.11)
      snakeHead = wrap(snakeHead + step)
      driveWave()
      intensity = 0.8 + 0.2 * beatEnv
      break
    }
  }

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
  const corePx = thicknessPx(settings.thickness, dpr)

  gl!.uniform2f(u.res, canvas.width, canvas.height)
  gl!.uniform3fv(u.colors, colorBuffer)
  gl!.uniform1fv(u.centers, centerBuffer)
  gl!.uniform1i(u.count, blend.count)
  gl!.uniform1f(u.thickness, corePx)
  gl!.uniform1f(u.spill, spillPx(corePx, dpr))
  gl!.uniform1f(u.glowStrength, GLOW_STRENGTH)
  gl!.uniform1f(u.corner, cornerPx(corePx, dpr))
  gl!.uniform1f(u.offset, driftPhase)
  // Brightness eases toward its target so a beat glows up over a few frames
  // instead of popping on the exact frame the onset lands.
  intensityEnv = ease(intensityEnv, intensity, dt, 0.08, 0.35)
  gl!.uniform1f(u.intensity, intensityEnv)
  gl!.uniform1i(u.mode, MODE[settings.animation] ?? MODE.static)
  gl!.uniform1f(u.wavePhase, wavePhase)
  gl!.uniform1f(u.waveAmp, waveAmp)
  gl!.uniform1f(u.snakeHead, snakeHead)
  gl!.uniform1f(u.snakeLength, SNAKE_LENGTH)
  gl!.uniform1f(u.snakeFeather, SNAKE_FEATHER)

  gl!.clearColor(0, 0, 0, 0)
  gl!.clear(gl!.COLOR_BUFFER_BIT)
  gl!.drawArrays(gl!.TRIANGLES, 0, 3)

  maybePark(now)
}

/**
 * A still gradient does not need 60fps. Static parks after a second and lets a
 * settings or palette change wake it. The music modes never park: they used
 * to park on a quiet envelope, which froze the rim mid-track on soft passages.
 */
function maybePark(now: number): void {
  if (settings.animation !== 'static' || fading) {
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
  if (frame.onset) pendingOnsets += 1
  if (frame.rms > 0.001 || frame.onset) wake()
})

window.addEventListener('resize', () => {
  resize()
  wake()
})

rafHandle = requestAnimationFrame(render)
