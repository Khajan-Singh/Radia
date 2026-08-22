import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { join } from 'path'
import {
  CH,
  DEFAULT_PALETTE,
  type Artwork,
  type AudioFrame,
  type BridgeStatus,
  type DisplayInfo,
  type InitialState,
  type Palette,
  type PanelSection,
  type PlayerMode,
  type Settings,
  type Track,
  type TransportCommand
} from '../shared/types'
import { flushSettings, getSettings, patchSettings } from './settings'
import { extractPalette, overridePalette } from './palette'
import { getBridgeStatus, sendBridge, startBridge, stopBridge } from './bridge'
import {
  applyPlayerMode,
  broadcast,
  createAppearance,
  createPlayer,
  destroyOverlay,
  getAppearance,
  getOverlay,
  getPlayer,
  destroyAllWindows,
  markQuitting,
  syncOverlay
} from './windows'
import { upgradeArtwork } from './artwork'

// ─── Live state ──────────────────────────────────────────────────────────────

let track: Track | null = null
let artwork: Artwork | null = null
let palette: Palette = DEFAULT_PALETTE
let bridge: BridgeStatus = getBridgeStatus()
let tray: Tray | null = null

function displays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || (d.id === primaryId ? 'Built-in Display' : `Display ${d.id}`),
    width: d.bounds.width,
    height: d.bounds.height,
    isPrimary: d.id === primaryId,
    scaleFactor: d.scaleFactor
  }))
}

function initialState(): InitialState {
  return {
    settings: getSettings(),
    track,
    artwork,
    palette,
    displays: displays(),
    bridge
  }
}

// ─── Palette recomputation ───────────────────────────────────────────────────

/**
 * Recomputes the rim palette from whichever source is currently authoritative:
 * the manual color wheels when overriding, otherwise the album art.
 */
function refreshPalette(): void {
  const settings = getSettings()
  let next: Palette | null = null

  if (settings.overrideAlbumColor) {
    next = overridePalette(settings)
  } else if (artwork) {
    const key = `${artwork.hash}:${settings.gradientMode}:${artwork.highRes ? 'hi' : 'lo'}`
    next = key === palette.key ? palette : extractPalette(artwork.dataUrl, settings.gradientMode, key)
  }

  if (!next) {
    // Nothing playing and no override - keep whatever is on screen rather than
    // snapping to the default, which would read as a glitch mid-track-change.
    if (palette.key !== 'default') return
    next = DEFAULT_PALETTE
  }

  if (next.key === palette.key) return
  palette = next
  broadcast(CH.palette, palette)
}

// ─── Bridge wiring ───────────────────────────────────────────────────────────

/**
 * Artwork lookups are retried on a short schedule rather than attempted once.
 *
 * A provider can miss on a transient network blip, and a single failure used to
 * leave that song on the small Windows thumbnail for its whole duration, which
 * is indistinguishable from the feature being broken.
 *
 * Resolved covers are cached per song, so the retries cost nothing once one
 * attempt has succeeded.
 */
const UPGRADE_DELAYS = [0, 1500, 4000, 9000]

let upgradeTimers: NodeJS.Timeout[] = []

function cancelUpgrades(): void {
  upgradeTimers.forEach(clearTimeout)
  upgradeTimers = []
}

/**
 * Song identity, not object identity: `handleTrack` runs on every session
 * publish and hands over a fresh object each time, so comparing references
 * would treat an unchanged song as a track change and cancel every retry.
 */
function songKey(t: Track): string {
  return `${t.title} :: ${t.artist}`
}

function scheduleUpgrade(forTrack: Track): void {
  cancelUpgrades()
  const key = songKey(forTrack)
  const current = (): boolean => !!track && songKey(track) === key

  upgradeTimers = UPGRADE_DELAYS.map((delay) =>
    setTimeout(() => {
      // The track may have moved on between scheduling and firing; a late
      // response for a song that is no longer playing must not be applied.
      if (!current()) return
      void upgradeArtwork(forTrack, (art) => {
        if (current()) applyArtwork(art)
      }).then((ok) => {
        if (ok && current()) cancelUpgrades()
      })
    }, delay)
  )
}

function handleTrack(next: Track): void {
  const changed = !track || track.title !== next.title || track.artist !== next.artist
  track = next
  broadcast(CH.track, track)
  if (changed) scheduleUpgrade(next)
}

function applyArtwork(next: Artwork): void {
  // A late-arriving high-res image for a track that already moved on is stale.
  if (artwork && artwork.hash === next.hash && artwork.highRes && !next.highRes) return
  artwork = next
  broadcast(CH.artwork, artwork)
  refreshPalette()
}

function handleBridgeArtwork(hash: string, dataUrl: string): void {
  applyArtwork({ hash, dataUrl, highRes: false })
}

function handleAudio(frame: AudioFrame): void {
  // Audio is the hot path - only the overlay and the player need it, and only
  // when they are actually visible.
  const overlay = getOverlay()
  if (overlay?.isVisible()) overlay.webContents.send(CH.audio, frame)
  const player = getPlayer()
  if (player?.isVisible()) player.webContents.send(CH.audio, frame)
}

/**
 * Position we overwrote when optimistically applying a seek, kept so a seek the
 * player refuses can be undone. Without this the bar jumps to the requested
 * spot, then snaps back when the real position arrives - and on repeated
 * attempts that reads as the progress bar oscillating on its own.
 */
let seekRollback: { positionMs: number; sampledAt: number } | null = null

function handleAck(cmd: string, ok: boolean): void {
  if (cmd !== 'cmd-seek') return
  if (ok || !seekRollback || !track) {
    seekRollback = null
    return
  }
  track = { ...track, ...seekRollback }
  seekRollback = null
  broadcast(CH.track, track)
}

function handleBridgeStatus(status: BridgeStatus): void {
  bridge = status
  broadcast(CH.bridge, bridge)
  updateTrayMenu()
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function trayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  return icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 })
}

function updateTrayMenu(): void {
  if (!tray) return
  const settings = getSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: track ? `${track.title} - ${track.artist}` : 'Nothing playing', enabled: false },
      { type: 'separator' },
      {
        label: 'Rim lighting',
        type: 'checkbox',
        checked: settings.enabled,
        click: () => setEnabled(!getSettings().enabled)
      },
      { label: 'Open Radia', click: () => createPlayer() },
      {
        label: 'Player',
        submenu: (
          [
            ['window', 'Window'],
            ['fullscreen', 'Full screen'],
            ['compact', 'Mini player']
          ] as [PlayerMode, string][]
        ).map(([mode, label]) => ({
          label,
          type: 'radio' as const,
          checked: settings.playerMode === mode,
          click: () => setPlayerMode(mode)
        }))
      },
      { label: 'Appearance...', click: () => createAppearance() },
      { type: 'separator' },
      {
        label: bridge.running ? 'Helper: running' : 'Helper: not running',
        enabled: false
      },
      { type: 'separator' },
      { label: 'Quit Radia', click: () => quit() }
    ])
  )
  tray.setToolTip(track ? `Radia - ${track.title}` : 'Radia')
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.on('click', () => {
    const player = getPlayer()
    if (player?.isVisible()) player.focus()
    else createPlayer()
  })
  updateTrayMenu()
}

// ─── Settings application ────────────────────────────────────────────────────

function setEnabled(enabled: boolean): void {
  applySettings(patchSettings({ enabled }))
}

function setPlayerMode(mode: PlayerMode): void {
  applySettings(patchSettings({ playerMode: mode }))
  createPlayer()
  applyPlayerMode(mode)
}

/**
 * Pushes a settings change out to every surface that depends on it.
 * `originId` is the webContents that requested the change, if any; it already
 * shows the new value locally and must not be sent an echo.
 */
function applySettings(settings: Settings, originId?: number): void {
  broadcast(CH.settings, settings, originId)
  if (settings.enabled) syncOverlay()
  else destroyOverlay()
  refreshPalette()
  updateTrayMenu()
}

/**
 * The single shutdown path. Every route out of the app goes through this, and
 * it is safe to run more than once - `before-quit` calls it again for the exits
 * that do not start here (tray Quit, OS logoff, `app.quit()` from a window
 * close), so nothing is left running whichever way the app ends.
 */
let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  markQuitting()
  flushSettings()
  stopBridge()
  destroyAllWindows()
  // Without this the icon can linger in the notification area until something
  // hovers over it, which looks exactly like the app failing to exit.
  tray?.destroy()
  tray = null
}

function quit(): void {
  shutdown()
  app.quit()
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(CH.getState, () => initialState())

  ipcMain.handle(CH.patchSettings, (event, patch: Partial<Settings>) => {
    const before = getSettings()
    const next = patchSettings(patch)
    // Changing the display or the taskbar-safe flag changes window geometry,
    // and transparency cannot be re-negotiated on a live window, so rebuild.
    const geometryChanged =
      before.displayId !== next.displayId || before.taskbarSafe !== next.taskbarSafe
    if (geometryChanged) destroyOverlay()
    applySettings(next, event.sender.id)
    if (before.playerMode !== next.playerMode) applyPlayerMode(next.playerMode)
    return next
  })

  /**
   * Applies a seek locally before the session confirms it. Players report the
   * pre-seek position for a moment afterwards, so without this the next skip
   * computes from a stale base and repeated presses stop accumulating.
   */
  const optimisticSeek = (positionMs: number): void => {
    if (!track) return
    seekRollback = { positionMs: track.positionMs, sampledAt: track.sampledAt }
    track = { ...track, positionMs, sampledAt: Date.now() }
    broadcast(CH.track, track)
  }

  ipcMain.handle(CH.transport, (_e, command: TransportCommand) => {
    switch (command.kind) {
      case 'playpause':
        sendBridge({ c: 'playpause' })
        break
      case 'next':
        sendBridge({ c: 'next' })
        break
      case 'prev':
        sendBridge({ c: 'prev' })
        break
      case 'seek': {
        const target = Math.max(0, Math.round(command.positionMs))
        sendBridge({ c: 'seek', positionMs: target })
        optimisticSeek(target)
        break
      }
    }
  })

  ipcMain.handle(CH.openAppearance, (_event, section?: PanelSection) => {
    createAppearance(section)
  })
  ipcMain.handle(CH.openPrefs, () => { createAppearance() })
  ipcMain.handle(CH.toggleRim, () => { setEnabled(!getSettings().enabled) })
  ipcMain.handle(CH.setPlayerMode, (_e, mode: PlayerMode) => {
    setPlayerMode(mode)
  })

  ipcMain.handle(CH.windowAction, (event, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else win.close()
  })

}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createPlayer())

  app.whenReady().then(() => {
    registerIpc()
    createTray()

    if (getSettings().enabled) syncOverlay()
    createPlayer()

    startBridge({
      onTrack: handleTrack,
      onArtwork: handleBridgeArtwork,
      onAudio: handleAudio,
      onStatus: handleBridgeStatus,
      onAck: handleAck
    })

    const onDisplayChange = (): void => {
      const list = displays()
      broadcast(CH.displays, list)
      // The chosen monitor may be gone; fall back rather than render nowhere.
      if (getSettings().displayId !== null && !list.some((d) => d.id === getSettings().displayId)) {
        patchSettings({ displayId: null })
      }
      destroyOverlay()
      applySettings(getSettings())
    }

    screen.on('display-added', onDisplayChange)
    screen.on('display-removed', onDisplayChange)
    screen.on('display-metrics-changed', onDisplayChange)

    app.on('activate', () => createPlayer())
  })

  // Nothing left to show means nothing left to run.
  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', shutdown)

  // Belt and braces for a logoff or shutdown, where before-quit can be skipped.
  app.on('will-quit', shutdown)
}

export function currentAppearanceWindow(): BrowserWindow | null {
  return getAppearance()
}
