/**
 * Logs every media-session switch and artwork publish with a timestamp, so a
 * sub-second session flip is visible. probe-bridge.mjs only prints a summary,
 * which averages away exactly the thing you would be hunting.
 *
 *   node scripts/probe-sessions.mjs 30
 *
 * Kill the app first - the bridge exe is single-instance per process spawn, and
 * two copies fighting over the session manager muddies the output.
 */
import { spawn } from 'child_process'
import { join } from 'path'

const exe = join(process.cwd(), 'resources/bridge/RadiaBridge.exe')
const secs = Number(process.argv[2] ?? 30)
const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6)

let buf = ''
let lastApp = null
const apps = new Map()
let flips = 0

p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let m
    try { m = JSON.parse(line) } catch { continue }

    if (m.track) {
      const app = m.track.appId || '(none)'
      apps.set(app, (apps.get(app) ?? 0) + 1)
      if (app !== lastApp) {
        flips++
        console.log(`${stamp()}s  SESSION -> ${app}   "${m.track.title}" [${m.track.status}]`)
        lastApp = app
      }
    } else if (m.dataUrl) {
      console.log(`${stamp()}s  ART      ${(m.dataUrl.length / 1366).toFixed(0)}KB  hash=${m.hash}`)
    }
  }
})

setTimeout(() => {
  console.log('\n--- summary ---')
  console.log('session switches :', flips - 1)
  for (const [a, n] of apps) console.log(`  ${a}: ${n} publishes`)
  p.kill()
  process.exit(0)
}, secs * 1000)
