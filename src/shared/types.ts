/**
 * The contract shared by the main process, the preload bridge and all three
 * renderers. Everything that crosses a process boundary is defined here.
 */

// ─── Settings ────────────────────────────────────────────────────────────────

export type GradientMode = 1 | 2 | 3
/**
 * - `static` still gradient
 * - `music`  Sync: a travelling wave on the inner edge, brightness swells on beats
 * - `snake`  Snake: a lit segment half the perimeter long that crawls and lurches on beats
 */
export type AnimationMode = 'static' | 'music' | 'snake'
export const ANIMATION_MODES: readonly AnimationMode[] = ['static', 'music', 'snake']

/**
 * How the now-playing view presents itself.
 * - `window`     ordinary resizable window
 * - `fullscreen` fills the display, chrome hidden, controls fade when idle
 * - `compact`    small always-on-top card
 */
export type PlayerMode = 'window' | 'fullscreen' | 'compact'

export interface ColorOverride {
  /** HSV hue, 0-360 */
  h: number
  /** HSV saturation, 0-1 */
  s: number
  /** HSV value / brightness, 0-1 */
  v: number
}

export interface Settings {
  version: number
  /** Master on/off for the rim overlay. */
  enabled: boolean
  gradientMode: GradientMode
  animation: AnimationMode
  /** Hug the work area instead of full display bounds, so the taskbar stays clear. */
  taskbarSafe: boolean
  /**
   * Solid core of the rim, 0-1 (mapped to px by the overlay). The halo and the
   * corner radius are derived from it; there is no separate glow setting.
   */
  thickness: number
  /** Ignore album art colors and use the manual wheels below. */
  overrideAlbumColor: boolean
  primary: ColorOverride
  secondary: ColorOverride
  tertiary: ColorOverride
  /** Share of the rim each color occupies. Normalized at use, not on write. */
  primaryWeight: number
  secondaryWeight: number
  /** Electron display id, or null for primary. */
  displayId: number | null
  /** Player window presentation. */
  playerMode: PlayerMode
  audio: AudioSettings
}

export interface AudioSettings {
  /** Overall reactivity multiplier, 0-2. */
  sensitivity: number
  /** Spectral-flux threshold multiplier for onset detection, 0.5-3. */
  beatThreshold: number
  /** Envelope release smoothing, 0-1. Higher = laggier, calmer. */
  smoothing: number
}

/** Informational only: reconcile() migrates by sniffing values, not by version. v4 dropped `glow`. */
export const SETTINGS_VERSION = 4

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  enabled: true,
  gradientMode: 2,
  animation: 'music',
  taskbarSafe: false,
  thickness: 0.6,
  overrideAlbumColor: false,
  primary: { h: 340, s: 0.85, v: 0.95 },
  secondary: { h: 150, s: 0.85, v: 0.95 },
  tertiary: { h: 220, s: 0.85, v: 0.95 },
  primaryWeight: 0.6,
  secondaryWeight: 0.4,
  displayId: null,
  playerMode: 'window',
  audio: { sensitivity: 1, beatThreshold: 1.4, smoothing: 0.5 }
}

// ─── Now playing ─────────────────────────────────────────────────────────────

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'unknown'

export interface Track {
  title: string
  artist: string
  album: string
  /** AUMID of the app that owns the session, e.g. "Spotify.exe". */
  appId: string
  status: PlaybackStatus
  positionMs: number
  durationMs: number
  /** Hash of the album art bytes; null when the session exposes no art. */
  artHash: string | null
  /** Wall-clock ms when positionMs was sampled, for smooth interpolation. */
  sampledAt: number
  canNext: boolean
  canPrev: boolean
  canSeek: boolean
}

/** Album art as a data URL, delivered separately from the Track payload. */
export interface Artwork {
  hash: string
  dataUrl: string
  /** True once a fetched high-resolution cover has replaced the thumbnail. */
  highRes: boolean
}

// ─── Audio analysis ──────────────────────────────────────────────────────────

export interface AudioFrame {
  /** Helper-side timestamp, ms. */
  ts: number
  /** Broadband loudness, 0-1. */
  rms: number
  /** Band energies, 0-1, already envelope-followed. */
  sub: number
  bass: number
  mid: number
  treble: number
  /** Raw spectral flux, for debugging the beat detector. */
  flux: number
  /** True on the frame an onset was detected. */
  onset: boolean
  /** Estimated tempo, or 0 when unknown. */
  bpm: number
}

export const SILENT_FRAME: AudioFrame = {
  ts: 0, rms: 0, sub: 0, bass: 0, mid: 0, treble: 0, flux: 0, onset: false, bpm: 0
}

// ─── Palette ─────────────────────────────────────────────────────────────────

/** Linear-space RGB triple, each channel 0-1. */
export type Rgb = [number, number, number]

export interface Palette {
  colors: Rgb[]
  /** Population-and-saturation weights, parallel to colors, summing to 1. */
  weights: number[]
  /** Source identity so the renderer knows when to crossfade. */
  key: string
}

export const DEFAULT_PALETTE: Palette = {
  colors: [[0.85, 0.13, 0.35], [0.13, 0.75, 0.5]],
  weights: [0.6, 0.4],
  key: 'default'
}

/** A part of the appearance panel the player's dock can jump straight to. */
export type PanelSection = 'color' | 'display'

// ─── Displays ────────────────────────────────────────────────────────────────

export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  isPrimary: boolean
  scaleFactor: number
}

// ─── Bridge health ───────────────────────────────────────────────────────────

export interface BridgeStatus {
  running: boolean
  /** Media session subscription is live. */
  media: boolean
  /** Loopback capture is delivering frames. */
  audio: boolean
  lastError: string | null
}

// ─── Transport ───────────────────────────────────────────────────────────────

export type TransportCommand =
  | { kind: 'playpause' }
  | { kind: 'next' }
  | { kind: 'prev' }
  /** Absolute position, rebased so 0 is the start of the media. Relative moves
   *  are resolved in the renderer, which is the only place that knows the
   *  currently displayed position. */
  | { kind: 'seek'; positionMs: number }

// ─── IPC channels ────────────────────────────────────────────────────────────

export const CH = {
  // main -> renderer (broadcast)
  settings: 'radia:settings',
  track: 'radia:track',
  artwork: 'radia:artwork',
  audio: 'radia:audio',
  palette: 'radia:palette',
  displays: 'radia:displays',
  bridge: 'radia:bridge',
  revealSection: 'radia:revealSection',
  // renderer -> main (invoke)
  getState: 'radia:getState',
  patchSettings: 'radia:patchSettings',
  transport: 'radia:transport',
  openAppearance: 'radia:openAppearance',
  openPrefs: 'radia:openPrefs',
  toggleRim: 'radia:toggleRim',
  setPlayerMode: 'radia:setPlayerMode',
  windowAction: 'radia:windowAction'
} as const

/** Everything a renderer needs to paint itself on first load. */
export interface InitialState {
  settings: Settings
  track: Track | null
  artwork: Artwork | null
  palette: Palette
  displays: DisplayInfo[]
  bridge: BridgeStatus
}
