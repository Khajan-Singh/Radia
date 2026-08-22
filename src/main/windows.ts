import { app, BrowserWindow, screen, shell, type Display } from 'electron'
import { join } from 'path'
import { getSettings } from './settings'
import { CH, type PanelSection, type PlayerMode } from '../shared/types'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const preload = join(__dirname, '../preload/index.js')

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

// ─── Overlay ─────────────────────────────────────────────────────────────────

let overlay: BrowserWindow | null = null
let topmostTimer: NodeJS.Timeout | null = null

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
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.once('ready-to-show', () => overlay?.showInactive())
  forwardErrors(overlay, 'overlay')
  load(overlay, 'overlay')

  if (topmostTimer) clearInterval(topmostTimer)
  topmostTimer = setInterval(reassertTopmost, 2000)

  return overlay
}

/**
 * Anything else that goes topmost - a maximised video, another always-on-top
 * utility - lands above the rim and stays there. Setting alwaysOnTop to the
 * value it already holds is a no-op, so the flag has to be cycled and the
 * window explicitly raised to actually get back on top.
 */
function reassertTopmost(): void {
  const win = getOverlay()
  if (!win?.isVisible()) return
  win.setAlwaysOnTop(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
}

export function destroyOverlay(): void {
  if (topmostTimer) { clearInterval(topmostTimer); topmostTimer = null }
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
  if (existing) { existing.show(); existing.focus(); return existing }

  const mode = getSettings().playerMode
  player = new BrowserWindow({
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

  player.once('ready-to-show', () => player?.show())
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

  load(player, 'player')
  return player
}

/** Moves the player between windowed, fullscreen and the floating mini card. */
export function applyPlayerMode(mode: PlayerMode): void {
  const win = getPlayer()
  if (!win) return

  // Only the mini player floats over the desktop, so it is the only mode that
  // wants the system backdrop; the other two paint opaque black over it anyway
  // and leaving it on would just cost a needless DWM blur pass.
  setMaterial(win, mode === 'compact' ? 'acrylic' : 'none')

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
    win.focus()
    return
  }

  // Leaving fullscreen has to clear topmost; passing false here does that.
  win.setAlwaysOnTop(mode === 'compact', mode === 'compact' ? 'floating' : 'normal')
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
    // Topmost is not the same as raised. The flag was set above, but setting it
    // does not pull the window over whatever currently owns the foreground, so
    // the card arrived in the floating band and still behind the app you
    // switched from - it took a taskbar click to bring it forward, which is not
    // how a mini player is supposed to behave.
    //
    // Cycling the flag is what makes the raise actually take effect (the same
    // no-op rule reassertTopmost exists for), and show()/focus() hand it the
    // foreground. show() also covers the case where the window was minimised.
    win.setAlwaysOnTop(false)
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.moveTop()
    win.focus()
  } else {
    win.setSize(FULL_SIZE.width, FULL_SIZE.height)
    win.center()
  }
}

/**
 * Guards setBackgroundMaterial, which throws on Windows builds older than
 * 11 22H2. A machine that cannot do acrylic should lose the frost, not the
 * player window.
 */
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
    width: 400,
    height: 820,
    minWidth: 400,
    maxWidth: 520,
    minHeight: 560,
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
