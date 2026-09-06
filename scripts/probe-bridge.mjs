/**
 * Runs RadiaBridge.exe the way Electron does and reports what comes back:
 * frame rate, band levels, beats detected, and the current track.
 *
 * Play something first, then:  node scripts/probe-bridge.mjs [seconds]
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const seconds = Number(process.argv[2] ?? 10)
const exe = join(root, 'resources', 'bridge', 'RadiaBridge.exe')

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
const started = Date.now()

let frames = 0
let onsets = 0
let beats = 0
let predicted = 0
let confidence = 0
let peakBass = 0
let peakRms = 0
let bpm = 0
let track = null
let artBytes = 0

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    console.error('unparseable:', line.slice(0, 120))
    return
  }

  if (msg.t === 'audio') {
    frames++
    if (msg.frame.onset) onsets++
    if (msg.frame.beat) {
      beats++
      if (!msg.frame.onset) predicted++
    }
    confidence = msg.frame.beatConfidence ?? 0
    peakBass = Math.max(peakBass, msg.frame.bass)
    peakRms = Math.max(peakRms, msg.frame.rms)
    if (msg.frame.bpm) bpm = msg.frame.bpm
  } else if (msg.t === 'track') {
    track = msg.track
  } else if (msg.t === 'art') {
    artBytes = msg.dataUrl.length
  } else if (msg.t === 'error') {
    console.error('error:', msg.code, msg.message)
  }
})

child.stderr.on('data', (b) => process.stderr.write(`[stderr] ${b}`))

setTimeout(() => {
  const elapsed = (Date.now() - started) / 1000
  child.kill()

  console.log(`\nover ${elapsed.toFixed(1)}s:`)
  console.log(`  audio frames : ${frames}  (${(frames / elapsed).toFixed(1)}/s)`)
  console.log(`  onsets       : ${onsets}  (${(onsets / elapsed * 60).toFixed(0)}/min)`)
  console.log(`  beats        : ${beats}  (${(beats / elapsed * 60).toFixed(0)}/min, ${predicted} predicted)`)
  console.log(`  beat lock    : ${confidence.toFixed(2)}`)
  console.log(`  peak bass    : ${peakBass.toFixed(3)}`)
  console.log(`  peak rms     : ${peakRms.toFixed(3)}`)
  console.log(`  bpm estimate : ${bpm || 'none'}`)
  console.log(`  artwork      : ${artBytes ? `${(artBytes / 1024).toFixed(0)}KB data url` : 'none'}`)
  console.log(
    track
      ? `  track        : ${track.title} - ${track.artist} [${track.appId}] ${track.status}`
      : '  track        : none'
  )
  process.exit(0)
}, seconds * 1000)
