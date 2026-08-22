/**
 * Shows which cover the artwork lookup would choose for a track, and why.
 *
 *   node scripts/probe-artwork.mjs "<title>" "<artist>" ["<album>"]
 *
 * Queries both providers exactly as src/main/artwork.ts does and scores every
 * result with the real src/main/match.ts (bundled on the fly with esbuild, so
 * this can never drift from the app). Prints the ranked candidates and the
 * winner, or "keep Windows thumbnail" when nothing agrees with the reported
 * album - which is the correct answer more often than it looks.
 *
 * Use it when the cover on screen is wrong: if the winner here is wrong, the
 * scorer needs work; if the winner here is right, the problem is upstream
 * (what the session reports, or a stale publish).
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [title, artist, album = ''] = process.argv.slice(2)
if (!title || !artist) {
  console.error('usage: node scripts/probe-artwork.mjs "<title>" "<artist>" ["<album>"]')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'radia-match-'))
const bundle = join(dir, 'match.mjs')
// esbuild is a .cmd shim on Windows, so it has to go through a shell; one
// quoted string avoids Node's warning about concatenating an args array.
execSync(
  `"${resolve(root, 'node_modules/.bin/esbuild')}" src/main/match.ts --format=esm --outfile="${bundle}" --log-level=error`,
  { cwd: root, stdio: 'inherit' }
)
const { scoreCandidate } = await import(pathToFileURL(bundle).href)
rmSync(dir, { recursive: true, force: true })

const track = { title, artist, album }
const term = encodeURIComponent(`${artist} ${title}`)
const [it, dz] = await Promise.all([
  fetch(`https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=10`).then((r) => r.json()),
  fetch(`https://api.deezer.com/search?q=${term}&limit=10`).then((r) => r.json())
])

const options = [
  ...(it.results ?? [])
    .filter((r) => r.artworkUrl100)
    .map((r) => ({ title: r.trackName, artist: r.artistName, album: r.collectionName ?? '', source: 'iTunes' })),
  ...(dz.data ?? [])
    .filter((d) => d.album?.cover_xl || d.album?.cover_big)
    .map((d) => ({ title: d.title, artist: d.artist?.name ?? '', album: d.album?.title ?? '', source: 'Deezer' }))
]

console.log(`${title} / ${artist} / album "${album}"  (${options.length} results)\n`)
const ranked = options
  .map((o) => ({ o, s: scoreCandidate(track, o) }))
  .sort((a, b) => (b.s ?? -1) - (a.s ?? -1))
for (const { o, s } of ranked) {
  const score = s === null ? '  --' : String(s).padStart(4)
  console.log(`  ${score}  ${o.source.padEnd(6)} ${o.title}  [${o.album}]  - ${o.artist}`)
}

const best = ranked.find((r) => r.s !== null)
const winner = best && !(album && best.s < 100) ? best.o : null
console.log(`\nWINNER: ${winner ? `${winner.source}  ${winner.title}  [${winner.album}]` : 'none -> keep Windows thumbnail'}`)
console.log('(-- = not this song: artist, title or a recording qualifier such as remix/live/karaoke disagrees)')
