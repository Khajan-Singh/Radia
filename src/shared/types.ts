/**
 * The contract shared by the main process, the preload bridge and all three
 * renderers. Everything that crosses a process boundary is defined here.
 */

// ─── Settings ────────────────────────────────────────────────────────────────

export type GradientMode = 1 | 2 | 3
/**
 * - `static` still gradient
 * - `music`  Sync: a travelling wave on the inner edge, brightness swells on beats
 * - `snake`  Snake: a lit segment three quarters of the perimeter long that crawls and lurches on beats
 */
export type AnimationMode = 'static' | 'music' | 'snake'
export const ANIMATION_MODES: readonly AnimationMode[] = ['static', 'music', 'snake']
/** Display order and labels, shared by every picker so they agree. */
export const ANIMATIONS: readonly { value: AnimationMode; label: string }[] = [
  { value: 'music', label: 'Sync' },
  { value: 'snake', label: 'Snake' },
  { value: 'static', label: 'Static' }
]


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
  /**
   * Pace of Sync and Snake motion, 0-1 with 0.5 the reference pace. It is a
   * multiplier on every rate the beat driver moves things at (wave travel,
   * snake glide and beat surges) and nothing else, so a slow rim still lands
   * on the beat. See speedFactor().
   */
  speed: number
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
}

/** Informational only: reconcile() migrates by sniffing values, not by version. v4 dropped `glow`, v5 dropped `audio` (detection is self-tuning), v6 added `speed`. */
export const SETTINGS_VERSION = 6

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  enabled: true,
  gradientMode: 2,
  animation: 'music',
  speed: 0.5,
  taskbarSafe: false,
  thickness: 0.6,
  overrideAlbumColor: false,
  primary: { h: 340, s: 0.85, v: 0.95 },
  secondary: { h: 150, s: 0.85, v: 0.95 },
  tertiary: { h: 220, s: 0.85, v: 0.95 },
  primaryWeight: 0.6,
  secondaryWeight: 0.4,
  displayId: null,
  playerMode: 'window'
}

/** Speed slider (0-1) -> motion multiplier, 0.5x at the bottom, 1x in the middle, 2x at the top. */
export function speedFactor(speed: number): number {
  return Math.pow(4, Math.min(1, Math.max(0, speed)) - 0.5)
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
  /** True on the frame the flux detector fired. Raw evidence; the rim moves on `beat`. */
  onset: boolean
  /** Estimated tempo, or 0 when unknown. */
  bpm: number
  /**
   * True on a tempo-locked beat: an onset that landed on the predicted grid,
   * or a softer predicted fill when the expected onset never came.
   */
  beat: boolean
  /** How hard the beat hit, 0-1. Predicted beats are at most 0.5. */
  beatStrength: number
  /** Progress through the current beat, 0-1; 0 while there is no tempo lock. */
  beatPhase: number
  /** How sure the tracker is of its grid, 0-1. */
  beatConfidence: number
}

export const SILENT_FRAME: AudioFrame = {
  ts: 0, rms: 0, sub: 0, bass: 0, mid: 0, treble: 0, flux: 0, onset: false, bpm: 0,
  beat: false, beatStrength: 0, beatPhase: 0, beatConfidence: 0
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

// ─── Updates ─────────────────────────────────────────────────────────────────

/** What the background updater is doing. `ready` is the only state with UI. */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

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
  update: 'radia:update',
  // renderer -> main (invoke)
  getState: 'radia:getState',
  patchSettings: 'radia:patchSettings',
  transport: 'radia:transport',
  openAppearance: 'radia:openAppearance',
  openPrefs: 'radia:openPrefs',
  toggleRim: 'radia:toggleRim',
  installUpdate: 'radia:installUpdate',
  setPlayerMode: 'radia:setPlayerMode',
  windowAction: 'radia:windowAction',
  /** Renderer -> main: resize the sender's window so its content fits exactly. */
  fitWindow: 'radia:fitWindow',
  // renderer -> main (send): the player has painted the named mode and the
  // window can be revealed without showing a half-built layout.
  playerModeReady: 'radia:playerModeReady'
} as const

/** Everything a renderer needs to paint itself on first load. */
export interface InitialState {
  settings: Settings
  track: Track | null
  artwork: Artwork | null
  palette: Palette
  displays: DisplayInfo[]
  bridge: BridgeStatus
  update: UpdateState
}
