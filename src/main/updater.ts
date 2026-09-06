import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/**
 * Background updates from GitHub Releases via electron-updater.
 *
 * The release workflow attaches `latest.yml`, the installer and its blockmap
 * to every release; `app-update.yml` inside the packaged app (generated from
 * the `publish` block in package.json) says where to look. An update is
 * downloaded quietly and reported through `onState`; the player and the tray
 * offer a restart, and otherwise it installs on the next quit.
 *
 * Nothing runs in development: an unpackaged app has no `app-update.yml`
 * and electron-updater refuses to check anyway.
 */
const FIRST_CHECK_MS = 15_000
const RECHECK_MS = 4 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle' }
let listener: ((state: UpdateState) => void) | null = null

function set(next: UpdateState): void {
  state = next
  listener?.(state)
}

export function getUpdateState(): UpdateState {
  return state
}

export function startUpdater(onState: (state: UpdateState) => void): void {
  listener = onState
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  // Once an update is downloaded that is the state that matters; a later
  // check or a transient error must not hide the restart prompt.
  const unlessReady = (next: UpdateState): void => {
    if (state.status !== 'ready') set(next)
  }

  autoUpdater.on('checking-for-update', () => unlessReady({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    unlessReady({ status: 'downloading', version: info.version, percent: 0 })
  )
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }))
  autoUpdater.on('update-not-available', () => unlessReady({ status: 'idle' }))
  // Offline, rate-limited, a draft release: none of these are the user's
  // problem. Recorded for the state, shown nowhere, retried next interval.
  autoUpdater.on('error', (error) => unlessReady({ status: 'error', message: error.message }))

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }
  setTimeout(check, FIRST_CHECK_MS)
  setInterval(check, RECHECK_MS)
}

/**
 * Installs the downloaded update and relaunches. electron-updater quits the
 * app itself, which runs the normal `before-quit` shutdown path first.
 */
export function installUpdate(): void {
  if (state.status !== 'ready') return
  autoUpdater.quitAndInstall(true, true)
}
