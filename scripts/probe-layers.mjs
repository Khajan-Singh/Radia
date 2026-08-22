/**
 * Reports which compositor layers of a renderer repaint, and when.
 *
 *   npx electron scripts/probe-layers.mjs - [window|fullscreen|compact]
 *
 * Loads the renderer offscreen with the same stubbed state as preview-player,
 * attaches the LayerTree devtools domain, then pokes the things that change at
 * runtime (glow, progress, text, palette, a button) and prints every layer
 * whose paint count moved. Two baseline steps come first: anything that paints
 * there is painting continuously with nothing happening.
 *
 * This exists because the mini player sits on DWM acrylic, where every raster
 * of a tile is visible as a lighter box. "No repaints" at rest and on glow and
 * progress is the pass condition; a change that shows the card's root layer
 * (the <> entry, window-sized) painting is a regression.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(process.defaultApp ? 2 : 1)
const out = resolve(args[0] ?? join(root, 'player-preview.png'))
const mode = args[1] ?? 'window'
const artPath = args[2] && args[2] !== '-' ? resolve(args[2]) : null
const scrollPx = Number(args[3] ?? 0)

const SIZES = {
  window: { width: 1180, height: 820 },
  fullscreen: { width: 1440, height: 900 },
  compact: { width: 420, height: 96 },
  appearance: { width: 400, height: 820 }
}
const size = SIZES[mode] ?? SIZES.window

/** A recognisable stand-in cover: coloured quadrants plus a fine grid, so both
 *  the palette extraction and any softness in scaling are obvious. */
function placeholderArt() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <rect width="640" height="640" fill="#2b0f1a"/>
    <circle cx="220" cy="220" r="200" fill="#c8324f"/>
    <circle cx="430" cy="400" r="180" fill="#e8894a" opacity="0.85"/>
    <circle cx="300" cy="480" r="130" fill="#3f6fb5" opacity="0.8"/>
    <g stroke="#ffffff" stroke-opacity="0.18">
      ${Array.from({ length: 16 }, (_, i) => {
        const p = i * 40
        return `<line x1="${p}" y1="0" x2="${p}" y2="640"/><line x1="0" y1="${p}" x2="640" y2="${p}"/>`
      }).join('')}
    </g>
  </svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

const artwork = {
  hash: 'preview',
  dataUrl:
    artPath && existsSync(artPath)
      ? `data:image/${artPath.endsWith('.png') ? 'png' : 'jpeg'};base64,` +
        readFileSync(artPath).toString('base64')
      : placeholderArt(),
  highRes: true
}

const state = {
  settings: {
    version: 4,
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
    playerMode: mode === 'appearance' ? 'window' : mode,
    spotifyClientId: '',
    audio: { sensitivity: 1, beatThreshold: 1.4, smoothing: 0.5 }
  },
  track: {
    title: 'Instant Crush',
    artist: 'Daft Punk, Julian Casablancas',
    album: 'Random Access Memories',
    appId: 'Preview',
    status: 'playing',
    positionMs: 96_000,
    durationMs: 337_000,
    artHash: 'preview',
    sampledAt: Date.now(),
    canNext: true,
    canPrev: true,
    canSeek: true
  },
  artwork,
  palette: {
    colors: [
      [0.78, 0.2, 0.32],
      [0.9, 0.55, 0.3]
    ],
    weights: [0.6, 0.4],
    key: 'preview'
  },
  displays: [
    { id: 1, label: 'Built-in Display', width: 1920, height: 1080, isPrimary: true, scaleFactor: 1.5 },
    { id: 2, label: 'DELL U2720Q', width: 3840, height: 2160, isPrimary: false, scaleFactor: 2 }
  ],
  bridge: { running: true, media: true, audio: true, lastError: null },
  spotify: { connected: false, displayName: null, configured: false }
}

// A preload that answers every call the renderer makes, statically.
const stub = `
const noop = () => () => {}
const state = ${JSON.stringify(state)}
require('electron').contextBridge.exposeInMainWorld('radia', {
  getState: () => Promise.resolve(state),
  patchSettings: (p) => Promise.resolve({ ...state.settings, ...p }),
  transport: () => Promise.resolve(true),
  openAppearance: () => Promise.resolve(),
  openPrefs: () => Promise.resolve(),
  openExternal: () => Promise.resolve(),
  toggleRim: () => Promise.resolve(),
  setPlayerMode: () => Promise.resolve(),
  windowAction: () => Promise.resolve(),
  playerModeReady: () => undefined,
  spotifyConnect: () => Promise.resolve(state.spotify),
  spotifyDisconnect: () => Promise.resolve(state.spotify),
  onSettings: noop, onTrack: noop, onArtwork: noop, onAudio: noop,
  onPalette: noop, onDisplays: noop, onBridge: noop, onSpotify: noop,
  onRevealSection: noop
})
`
const stubPath = join(app.getPath('temp'), 'radia-preview-preload.js')
writeFileSync(stubPath, stub, 'utf8')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    ...size,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: { preload: stubPath, sandbox: false, offscreen: true }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[preview]', message)
  })

  const page = mode === 'appearance' ? 'appearance' : 'player'
  const url = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/${page}/index.html`
    : join(root, `out/renderer/${page}/index.html`)
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(url)
  else await win.loadFile(url)

  await new Promise((r) => setTimeout(r, 1500))
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('DOM.enable')
  await dbg.sendCommand('DOM.getDocument', { depth: -1 })
  let layers = []
  dbg.on('message', (_e, method, params) => { if (method === 'LayerTree.layerTreeDidChange') layers = params.layers ?? [] })
  await dbg.sendCommand('LayerTree.enable')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const js = (code) => win.webContents.executeJavaScript(code)
  async function describe(l) {
    if (!l.backendNodeId) return '(no node)'
    try {
      const { node } = await dbg.sendCommand('DOM.describeNode', { backendNodeId: l.backendNodeId })
      const attrs = node.attributes ?? []; const i = attrs.indexOf('class')
      return `<${node.localName}${i >= 0 ? ' .' + attrs[i + 1].replace(/ /g, '.') : ''}>`
    } catch { return '?' }
  }
  async function snap() { const m = new Map(); for (const l of layers) m.set(l.layerId, l.paintCount); return m }
  async function step(name, code) {
    await wait(300); const before = await snap()
    await js(code); await wait(300)
    const lines = []
    for (const l of layers) {
      const b = before.get(l.layerId); if (b === undefined || b !== l.paintCount) lines.push(`    paint +${l.paintCount - (b ?? 0)}  ${await describe(l)}  ${l.width}x${l.height}`)
    }
    console.log(`== ${name}: ${lines.length ? '' : 'no repaints'}`); for (const x of lines) console.log(x)
  }
  console.log('layers at rest:'); for (const l of layers) console.log('   ', await describe(l), `${l.width}x${l.height} paints=${l.paintCount}`)
  await step('baseline (no change)', '0')
  await step('baseline again', '0')
  await step('glow opacity/transform', `(()=>{const g=document.querySelector('.compact-glow');g.style.opacity='0.7';g.style.transform='translateY(3px) scale(1.08)'})()`)
  await step('bar width', `document.querySelector('.compact-bar-fill').style.transform='translateX(-70px)'`)
  await step('title text', `document.querySelector('.compact-title').textContent='Something Else'`)
  await step('palette --primary', `document.querySelector('.app').style.setProperty('--primary','#3377ff')`)
  await step('primary button bg hover-ish', `document.querySelector('.icon-button.sm.primary').style.background='#555'`)
  app.quit()
})

ipcMain.handle('noop', () => null)
