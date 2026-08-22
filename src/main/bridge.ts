import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createInterface, type Interface } from 'readline'
import type { AudioFrame, BridgeStatus, Track } from '../shared/types'

type Handlers = {
  onTrack: (track: Track) => void
  onArtwork: (hash: string, dataUrl: string) => void
  onAudio: (frame: AudioFrame) => void
  onStatus: (status: BridgeStatus) => void
  onAck: (cmd: string, ok: boolean) => void
}

const MAX_BACKOFF_MS = 15_000

let child: ChildProcessWithoutNullStreams | null = null
let reader: Interface | null = null
let handlers: Handlers | null = null
let retries = 0
let restartTimer: NodeJS.Timeout | null = null
let stopped = false

const status: BridgeStatus = { running: false, media: false, audio: false, lastError: null }

/** Where RadiaBridge.exe lives in dev vs. inside a packaged app. */
function bridgePath(): string {
  const packaged = join(process.resourcesPath, 'bridge', 'RadiaBridge.exe')
  if (app.isPackaged) return packaged
  return join(app.getAppPath(), 'resources', 'bridge', 'RadiaBridge.exe')
}

function publish(patch: Partial<BridgeStatus>): void {
  Object.assign(status, patch)
  handlers?.onStatus({ ...status })
}

export function getBridgeStatus(): BridgeStatus {
  return { ...status }
}

export function startBridge(h: Handlers): void {
  handlers = h
  stopped = false
  spawnBridge()
}

function spawnBridge(): void {
  if (stopped) return
  const exe = bridgePath()

  if (!existsSync(exe)) {
    publish({
      running: false,
      media: false,
      audio: false,
      lastError: `Helper not built. Run "npm run build:bridge" (needs the .NET 9 SDK). Looked in ${exe}`
    })
    // Poll slowly rather than giving up, so building the helper while the app
    // is running picks it up without a restart.
    if (!restartTimer && !stopped) {
      restartTimer = setTimeout(() => { restartTimer = null; spawnBridge() }, 10_000)
    }
    return
  }

  try {
    child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (err) {
    publish({ running: false, lastError: String(err) })
    scheduleRestart()
    return
  }

  publish({ running: true, lastError: null })

  reader = createInterface({ input: child.stdout })
  reader.on('line', handleLine)

  child.stderr.on('data', (buf: Buffer) => {
    const text = buf.toString().trim()
    if (text) console.error('[bridge]', text)
  })

  child.on('exit', (code, signal) => {
    publish({
      running: false,
      media: false,
      audio: false,
      lastError: `Helper exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`
    })
    cleanup()
    scheduleRestart()
  })

  child.on('error', (err) => {
    publish({ running: false, lastError: err.message })
  })

  // A clean run for a few seconds means the process is healthy; reset backoff
  // so a later one-off crash restarts promptly instead of waiting 15s.
  setTimeout(() => { if (child) retries = 0 }, 5000)
}

function handleLine(line: string): void {
  if (!line.trim()) return
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    console.error('[bridge] unparseable line:', line.slice(0, 200))
    return
  }

  switch (msg.t) {
    case 'hello':
      publish({ media: true })
      break
    case 'track':
      handlers?.onTrack(msg.track as Track)
      publish({ media: true })
      break
    case 'art':
      handlers?.onArtwork(msg.hash as string, msg.dataUrl as string)
      break
    case 'ack':
      handlers?.onAck(msg.cmd as string, msg.ok as boolean)
      break
    case 'audio':
      handlers?.onAudio(msg.frame as AudioFrame)
      if (!status.audio) publish({ audio: true })
      break
    case 'error':
      console.error('[bridge] error:', msg.code, msg.message)
      publish({ lastError: `${msg.code}: ${msg.message}` })
      break
  }
}

function cleanup(): void {
  reader?.close()
  reader = null
  child = null
}

function scheduleRestart(): void {
  if (stopped || restartTimer) return
  retries += 1
  const delay = Math.min(500 * 2 ** (retries - 1), MAX_BACKOFF_MS)
  console.warn(`[bridge] restarting in ${delay}ms (attempt ${retries})`)
  restartTimer = setTimeout(() => { restartTimer = null; spawnBridge() }, delay)
}

/** Sends a command to the helper. Silently no-ops when it isn't running. */
export function sendBridge(command: Record<string, unknown>): void {
  if (!child || child.killed) return
  try {
    child.stdin.write(JSON.stringify(command) + '\n')
  } catch (err) {
    console.error('[bridge] write failed:', err)
  }
}

export function stopBridge(): void {
  stopped = true
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (child && !child.killed) child.kill()
  cleanup()
}
