import { app, BrowserWindow, screen, shell, type Display } from 'electron'
import { join } from 'path'
import { getSettings } from './settings'
import { sendBridge } from './bridge'
import { CH, type PanelSection, type PlayerMode } from '../shared/types'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const preload = join(__dirname, '../preload/index.js')

/*
 * electron-builder stamps the icon onto the packaged exe, so the taskbar and
 * Alt-Tab are correct there whatever the window says. Unpackaged - which is
 * every dev run - they fall back to Electron's own atom unless the window
 * carries an icon itself, so set it explicitly on both visible windows. The
 * overlay is skipTaskbar and needs none.
 */
const appIcon = join(__dirname, '../../resources/icon.png')

function pageUrl(name: 'overlay' | 'player' | 'appearance'): { url?: string; file?: string } {
  return isDev
    ? { url: `${process.env['ELECTRON_RENDERER_URL']}/${name}/index.html` }
    : { file: join(__dirname, `../renderer/${name}/index.html`) }
}

/**
 * Surfaces renderer failures on the main process console. Without this a broken
 * renderer is silent - the overlay has no chrome to show an error in, and a
 * React crash in the other windows just leaves them blank.
 */
function forwardErrors(win: BrowserWindow, name: string): void {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[${name}]`, message)
  })
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error(`[${name}] renderer gone:`, details.reason)
  )
  win.webContents.on('preload-error', (_e, path, error) =>
    console.error(`[${name}] preload failed:`, path, error.message)
  )
}

function load(win: BrowserWindow, name: 'overlay' | 'player' | 'appearance'): void {
  const target = pageUrl(name)
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!)
}

/** Resolves the display the rim should live on, falling back to primary. */
export function targetDisplay(): Display {
  const { displayId } = getSettings()
  const all = screen.getAllDisplays()
  return all.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
}

function overlayBounds(display: Display): Electron.Rectangle {
  // Full bounds covers the taskbar; workArea leaves it clear.
  return getSettings().taskbarSafe ? display.workArea : display.bounds
}

// ─── Staying on top ─────────────────────────────────────────────────

/*
 * Windows demotes ordinary topmost windows while a window covering the whole
 * monitor is in front. With the taskbar set to auto-hide the work area *is* the
 * display, so every maximised window qualifies - which is why the card kept
 * sinking behind a maximised browser and had to be fished back off the taskbar.
 *
 * Measured, not assumed: pinned at the 'floating' level the card lost
 * WS_EX_TOPMOST the instant a maximised window was activated, and re-asserting
 * it on a timer never took - Chromium had already recorded the demotion, so
 * every later setAlwaysOnTop was a no-op. Pinned at 'screen-saver' it survives
 * the same test untouched.
 *
 * The rim has always used 'screen-saver', which is why the rim never had this
 * problem. Both windows now go through one helper. A true exclusive-fullscreen
 * app still covers everything, and nothing can change that.
 *
 * The heartbeat stays because the band is not a guarantee of order: anything
 * else that goes topmost lands above ours and Windows will not put it back.
 * Pins are re-asserted in rank order, so the rim ends up above the card rather
 * than the two trading places on every tick.
 */
const RANK_PLAYER = 0
const RANK_OVERLAY = 1

const pinned = new Map<BrowserWindow, number>()
let pinTimer: NodeJS.Timeout | null = null

function repin(): void {
  // Deliberately not filtered on isVisible(): the overlay is pinned while it is
  // still hidden, waiting for ready-to-show, and skipping it there left the rim
  // un-pinned until the next tick.
  const live = [...pinned].filter(([win]) => !win.isDestroyed())
  for (const [win] of live.sort((a, b) => a[1] - b[1])) {
    win.setAlwaysOnTop(true, 'screen-saver')
  }
}

/** Keeps `win` above everything else until it is unpinned or closed. */
function pinOnTop(win: BrowserWindow, rank: number): void {
  if (!pinned.has(win)) win.once('closed', () => unpin(win))
  pinned.set(win, rank)
  if (!pinTimer) pinTimer = setInterval(repin, 2000)
  repin()
}

/*
 * Clears topmost whether or not the window was pinned here. Fullscreen sets the
 * flag directly rather than pinning, so an early return on "not in the map"
 * would leave the player stuck on top of everything after leaving fullscreen.
 */
function unpin(win: BrowserWindow): void {
  pinned.delete(win)
  if (!win.isDestroyed()) win.setAlwaysOnTop(false)
  if (pinned.size === 0 && pinTimer) {
    clearInterval(pinTimer)
    pinTimer = null
  }
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

let overlay: BrowserWindow | null = null

export function getOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export function createOverlay(): BrowserWindow {
  destroyOverlay()
  const display = targetDisplay()
  const bounds = overlayBounds(display)

  overlay = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload,
      sandbox: false,
      // Without this Chromium throttles rAF to ~1fps once the window loses
      // focus - which for a window that can never be focused means always.
      backgroundThrottling: false
    }
  })

  overlay.setIgnoreMouseEvents(true)
  pinOnTop(overlay, RANK_OVERLAY)
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.once('ready-to-show', () => overlay?.showInactive())
  forwardErrors(overlay, 'overlay')
  load(overlay, 'overlay')

  return overlay
}

export function destroyOverlay(): void {
  if (overlay) unpin(overlay)
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
}

/** Re-places the existing overlay, recreating it only when it doesn't exist. */
export function syncOverlay(): void {
  const settings = getSettings()
  if (!settings.enabled) { destroyOverlay(); return }
  const win = getOverlay()
  if (!win) { createOverlay(); return }
  win.setBounds(overlayBounds(targetDisplay()))
  win.setAlwaysOnTop(true, 'screen-saver')
}

// ─── Player ──────────────────────────────────────────────────────────────────

const FULL_SIZE = { width: 1180, height: 820 }
const COMPACT_SIZE = { width: 420, height: 96 }
/* The creation minimums belong to the resizable window mode. The mini card is
   shorter than they allow, and Windows clamps setBounds to the minimum, so the
   two have to be swapped per mode or the card comes back 132px tall with a band
   of empty backdrop under its contents. */
const WINDOW_MIN = { width: 340, height: 120 }

let player: BrowserWindow | null = null
let quitting = false

export function markQuitting(): void {
  quitting = true
}

/**
 * Tears down everything this module owns. Windows are destroyed rather than
 * closed so nothing can veto or defer it, and the overlay's re-assert interval
 * is cleared with it - otherwise a 2s timer keeps firing at a window that is on
 * its way out.
 */
export function destroyAllWindows(): void {
  quitting = true
  destroyOverlay()
  for (const win of [player, appearance]) {
    if (win && !win.isDestroyed()) win.destroy()
  }
  player = null
  appearance = null
}

export function getPlayer(): BrowserWindow | null {
  return player && !player.isDestroyed() ? player : null
}

export function createPlayer(): BrowserWindow {
  const existing = getPlayer()
  if (existing) {
    // A pending mode change reveals the window itself once the renderer has
    // painted it; showing here would expose the half-built layout it is hiding.
    if (pendingMode === null) { existing.show(); existing.focus() }
    return existing
  }

  const mode = getSettings().playerMode
  player = new BrowserWindow({
    icon: appIcon,
    ...(mode === 'compact' ? COMPACT_SIZE : FULL_SIZE),
    ...(mode === 'compact'
      ? { minWidth: COMPACT_SIZE.width, minHeight: COMPACT_SIZE.height }
      : { minWidth: WINDOW_MIN.width, minHeight: WINDOW_MIN.height }),
    frame: false,
    /*
     * Deliberately NOT transparent, unlike the overlay and the panel.
     *
     * The mini player is supposed to be frosted glass over the desktop, and a
     * transparent window cannot do that: Electron documents that in a
     * transparent window "the CSS blur() filter will not affect applications
     * behind the window", so `backdrop-filter` has nothing to sample and the
     * desktop shows through perfectly sharp. The card looked translucent and
     * was never actually glass.
     *
     * `backgroundMaterial` hands the blur to DWM instead, which composites it
     * outside Chromium and therefore does reach the desktop. It needs
     * Windows 11 22H2+; on anything older it is simply ignored and the card
     * falls back to its own translucent fill.
     *
     * The material is switched per mode in applyPlayerMode - window and full
     * screen paint opaque black over it, so only compact ever shows it.
     */
    transparent: false,
    backgroundMaterial: mode === 'compact' ? 'acrylic' : 'none',
    backgroundColor: '#00000000',
    show: false,
    title: 'Radia',
    webPreferences: { preload, sandbox: false, backgroundThrottling: false }
  })

  // No `ready-to-show` here. That event fires on the first paint of whatever
  // the renderer has at that moment, which for the mini card was an empty
  // acrylic rectangle that then filled in piecemeal. The window is revealed
  // only by onPlayerModeReady, once the renderer reports the mode painted.
  applyPlayerMode(mode)

  // Closing the player closes the app. It used to hide to tray and leave the
  // rim running, which read as the app refusing to shut down: the overlay stays
  // lit and the settings panel stays on screen with no window left to close
  // them from.
  player.on('close', () => {
    if (!quitting) app.quit()
  })

  forwardErrors(player, 'player')

  player.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A cold load (the dev server especially) can outlast the reveal fallback,
  // so restart the clock once the page is actually there; the renderer acks
  // within a couple of frames of that.
  player.webContents.once('did-finish-load', () => {
    if (pendingMode !== null) armRevealFallback(pendingMode)
  })
  load(player, 'player')
  return player
}

/*
 * Mode changes happen in two phases: prepare, then reveal.
 *
 * The settings broadcast that tells the renderer to re-layout is asynchronous,
 * while the material flip and setBounds below are immediate. Done in one go,
 * the window spent several frames at the new size and backdrop still painting
 * the *old* layout - a black box the size of the card, or a see-through card
 * the size of the full window - and over DWM acrylic every raster tile that
 * landed late showed up as a lighter box fading in. So applyPlayerMode only
 * prepares the window, hidden, and the renderer acks once the new mode has
 * actually been painted (playerModeReady); onPlayerModeReady then shows it.
 * A fallback timer reveals it regardless, so a renderer that never acks can't
 * leave the window hidden.
 */
const REVEAL_FALLBACK_MS = 600

let currentMode: PlayerMode | null = null
let pendingMode: PlayerMode | null = null
let revealTimer: NodeJS.Timeout | null = null

function armRevealFallback(mode: PlayerMode): void {
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => onPlayerModeReady(mode), REVEAL_FALLBACK_MS)
}

/** Prepares the player for a mode - size, backdrop, pin - without showing it. */
export function applyPlayerMode(mode: PlayerMode): void {
  const win = getPlayer()
  if (!win) return

  // Window <-> full screen keep their opaque black ground, so a live resize is
  // fine there. Anything involving the card swaps backdrop and layout at once
  // and has to go dark for the swap; a short hidden beat is invisible, a
  // half-painted card is not.
  const involvesCard = mode === 'compact' || currentMode === 'compact'
  if (involvesCard && win.isVisible()) win.hide()
  currentMode = mode
  pendingMode = mode
  armRevealFallback(mode)

  // Only the mini player floats over the desktop, so it is the only mode that
  // wants the system backdrop; the other two paint opaque black over it anyway
  // and leaving it on would just cost a needless DWM blur pass.
  setMaterial(win, mode === 'compact' ? 'acrylic' : 'none')

  // Only the card stays pinned; every other mode gives the flag up.
  if (mode !== 'compact') unpin(win)

  // Windows 11 paints a 1px border around every top-level window, which in full
  // screen is a white hairline along the screen edge over the black stage, and rounds
  // its corners so the desktop peeks through at each one. Electron
  // cannot touch either, so the helper sets the DWM attributes for this HWND.
  setBorderVisible(win, mode !== 'fullscreen')

  if (mode === 'fullscreen') {
    // Deliberately not setFullScreen(). Covering the display bounds explicitly
    // and going topmost gets the same result, taskbar included, and the rim
    // overlay sits in the higher 'screen-saver' band so it still frames the
    // player.
    //
    // This originally existed because Electron cannot fullscreen a transparent
    // window on Windows (it fails silently, keeping its size while
    // isFullScreen() reports false). That no longer applies - this window is
    // opaque now, for acrylic - but the approach is kept because it works and
    // preserves the overlay framing. Switching to setFullScreen is untested.
    const { bounds } = targetDisplay()
    win.setResizable(false)
    win.setBounds(bounds)
    win.setAlwaysOnTop(true, 'normal')
    return
  }

  win.setResizable(mode !== 'compact')
  const min = mode === 'compact' ? COMPACT_SIZE : WINDOW_MIN
  win.setMinimumSize(min.width, min.height)

  if (mode === 'compact') {
    // Park the card in the bottom-right of the active display's work area.
    const { workArea } = targetDisplay()
    win.setBounds({
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height,
      x: workArea.x + workArea.width - COMPACT_SIZE.width - 24,
      y: workArea.y + workArea.height - COMPACT_SIZE.height - 24
    })
    // Pinned after setResizable, which rewrites the window style and is exactly
    // the kind of call that drops the topmost bit. The show()/focus() that
    // bring it forward - being topmost is not the same as being in front -
    // happen in onPlayerModeReady.
    pinOnTop(win, RANK_PLAYER)
  } else {
    win.setSize(FULL_SIZE.width, FULL_SIZE.height)
    win.center()
  }
}

/** The renderer has painted `mode`: reveal the prepared window. */
export function onPlayerModeReady(mode: PlayerMode): void {
  if (mode !== pendingMode) return
  pendingMode = null
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = null
  const win = getPlayer()
  if (!win) return
  win.show()
  win.focus()
}

/**
 * Guards setBackgroundMaterial, which throws on Windows builds older than
 * 11 22H2. A machine that cannot do acrylic should lose the frost, not the
 * player window.
 */
/** Re-sends the border state for the current mode, e.g. after the helper restarts. */
export function syncPlayerBorder(): void {
  if (player && !player.isDestroyed()) setBorderVisible(player, getSettings().playerMode !== 'fullscreen')
}

function setBorderVisible(win: BrowserWindow, visible: boolean): void {
  const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE())
  sendBridge({ c: 'border', hwnd, visible })
}

function setMaterial(win: BrowserWindow, material: 'acrylic' | 'none'): void {
  try {
    win.setBackgroundMaterial(material)
  } catch (err) {
    console.warn('[windows] background material unsupported:', err)
  }
}

// ─── Appearance panel ────────────────────────────────────────────────────────

let appearance: BrowserWindow | null = null

export function getAppearance(): BrowserWindow | null {
  return appearance && !appearance.isDestroyed() ? appearance : null
}

export function createAppearance(section?: PanelSection): BrowserWindow {
  const existing = getAppearance()
  if (existing) {
    existing.show()
    existing.focus()
    if (section) existing.webContents.send(CH.revealSection, section)
    return existing
  }

  appearance = new BrowserWindow({
    icon: appIcon,
    width: 400,
    // Sized to the content at rest (no override wheels). The old 820px left a
    // third of the card as empty surface under the status line.
    height: 690,
    minWidth: 400,
    maxWidth: 520,
    minHeight: 520,
    useContentSize: true,
    frame: false,
    // Stays transparent, unlike the player: `.panel` draws its own rounded
    // outline and needs the corners cut. There is no acrylic to gain here.
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    // Distinct from the player's 'Radia' so the taskbar and Alt-Tab can tell
    // the two windows apart.
    title: 'Appearance',
    webPreferences: { preload, sandbox: false, backgroundThrottling: false }
  })

  appearance.once('ready-to-show', () => appearance?.show())
  // A freshly created window has no listeners yet, so the reveal has to wait
  // for the renderer to finish loading or it lands in the void.
  if (section) {
    appearance.webContents.once('did-finish-load', () => {
      appearance?.webContents.send(CH.revealSection, section)
    })
  }
  appearance.on('closed', () => { appearance = null })
  forwardErrors(appearance, 'appearance')
  load(appearance, 'appearance')
  return appearance
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Sends a channel payload to every live window that might care.
 *
 * `exceptId` skips one window's webContents. Settings changes use it to avoid
 * echoing a change back to the window that made it: a slider dragged quickly
 * emits many patches, and each late-arriving echo would reset the control to an
 * older value, so the knob visibly fights the pointer.
 */
export function broadcast(channel: string, payload: unknown, exceptId?: number): void {
  for (const win of [getOverlay(), getPlayer(), getAppearance()]) {
    if (!win || win.webContents.isDestroyed()) continue
    if (exceptId !== undefined && win.webContents.id === exceptId) continue
    win.webContents.send(channel, payload)
  }
}
