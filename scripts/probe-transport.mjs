/**
 * Sends a transport command straight to the helper and reports whether the
 * media session actually reacted. Isolates the helper from the Electron side.
 *
 *   node scripts/probe-transport.mjs playpause
 *   node scripts/probe-transport.mjs next
 *   node scripts/probe-transport.mjs seek 30000
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2] ?? 'playpause'
const positionMs = Number(process.argv[3] ?? 0)

const child = spawn(join(root, 'resources', 'bridge', 'RadiaBridge.exe'), [], {
  stdio: ['pipe', 'pipe', 'pipe']
})

const seen = []
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.t === 'track') {
    seen.push({ at: Date.now(), status: msg.track.status, pos: msg.track.positionMs })
  } else if (msg.t === 'error') {
    console.error('ERROR from helper:', msg.code, msg.message)
  }
})

child.stderr.on('data', (b) => process.stderr.write(`[stderr] ${b}`))

setTimeout(() => {
  const before = seen.at(-1)
  console.log('before:', before ?? 'no track seen')

  const payload = command === 'seek' ? { c: 'seek', positionMs } : { c: command }
  console.log('sending:', JSON.stringify(payload))
  child.stdin.write(JSON.stringify(payload) + '\n')

  setTimeout(() => {
    const after = seen.at(-1)
    console.log('after :', after ?? 'no track seen')
    console.log(
      before && after && (before.status !== after.status || Math.abs(after.pos - before.pos) > 5000)
        ? 'CHANGED - the helper acted on it'
        : 'NO CHANGE - command had no effect'
    )
    child.kill()
    process.exit(0)
  }, 2500)
}, 3000)
