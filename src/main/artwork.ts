import { nativeImage } from 'electron'
import { artistsMatch, normalize, titlesMatch } from './match'
import type { Artwork, Track } from '../shared/types'

/**
 * Finding a cover better than the one Windows hands us.
 *
 * The media session thumbnail is a small cache image - measured at 150x150 from
 * a Chrome session - and the player paints it at 320-440 CSS px, so it is a
 * 2-3x upscale. Everything here exists to replace it with the real artwork.
 *
 * Providers are tried in order and the first acceptable result wins:
 *
 *   1. iTunes  - no key, no account, no rate limit worth worrying about at this
 *                volume, and serves any size up to 1400px. Works for any source
 *                - Spotify, a browser tab, a local file - because it matches on
 *                text rather than needing to be told what is playing.
 *   2. Deezer  - same idea, 1000px, as a second opinion when iTunes has no
 *                match (it is noticeably better on non-English catalogues).
 *
 * Falling through both simply leaves the Windows thumbnail in place.
 *
 * There was a Spotify Web API provider here. It was removed: the API returns
 * 403 to any app whose owner does not hold Premium, so for most people it
 * authenticated successfully and then served nothing at all - and even when it
 * did work it only covered Spotify playback and capped at 640px, below what
 * these two give for free.
 */

/** Below this the result is not an upgrade worth the swap. */
const MIN_WIDTH = 500
const TIMEOUT_MS = 6000
const CACHE_LIMIT = 32

interface Found {
  dataUrl: string
  width: number
  source: string
}

/** Resolved covers, keyed by song. The retry schedule would otherwise re-query
 *  the same track up to four times for one answer. */
const cache = new Map<string, Found>()
/** In-flight lookups, so overlapping retries share one request. */
const inFlight = new Map<string, Promise<Found | null>>()

function songKey(track: Track): string {
  return `${normalize(track.title)}::${normalize(track.artist)}`
}

function remember(key: string, found: Found): void {
  cache.set(key, found)
  // Plain FIFO trim; these are a few hundred KB each and the order covers are
  // played in is a good enough proxy for what is worth keeping.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Downloads a candidate and accepts it only if it is genuinely large enough to
 * be an improvement. Providers happily return a placeholder or a small cover
 * for obscure releases, and swapping a 150px thumbnail for a 160px one would
 * be churn with nothing to show for it.
 */
async function fetchImage(url: string, source: string): Promise<Found | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const { width } = nativeImage.createFromBuffer(buffer).getSize()
    if (width < MIN_WIDTH) return null
    const mime = res.headers.get('content-type') ?? 'image/jpeg'
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, width, source }
  } catch {
    return null
  }
}

// ─── iTunes ──────────────────────────────────────────────────────────────────

interface ItunesResult {
  results: { trackName: string; artistName: string; artworkUrl100?: string }[]
}

async function fromItunes(track: Track): Promise<Found | null> {
  const term = encodeURIComponent(`${track.artist} ${track.title}`)
  const json = await getJson<ItunesResult>(
    `https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=8`
  )
  if (!json?.results?.length) return null

  const hit = json.results.find(
    (r) =>
      r.artworkUrl100 && titlesMatch(r.trackName, track.title) && artistsMatch(track.artist, [r.artistName])
  )
  if (!hit?.artworkUrl100) return null

  // The API only ever returns the 100px URL, but the path segment is just a
  // resize instruction, so any size can be asked for. 1000 rather than the
  // available 1400: the largest the cover is ever painted is ~880 device px
  // (440 CSS px at 200% scaling), and 1400 roughly doubled the payload for
  // pixels nothing can display.
  const big = hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/1000x1000bb.')
  return (await fetchImage(big, 'iTunes')) ?? (await fetchImage(hit.artworkUrl100, 'iTunes'))
}

// ─── Deezer ──────────────────────────────────────────────────────────────────

interface DeezerResult {
  data: { title: string; artist?: { name: string }; album?: { cover_xl?: string; cover_big?: string } }[]
}

async function fromDeezer(track: Track): Promise<Found | null> {
  // Free text, not Deezer's `artist:"..." track:"..."` field syntax. The field
  // form demands an exact artist match, and the media session reports the whole
  // credit list ("Daft Punk, Julian Casablancas") where Deezer indexes only the
  // primary artist - so the strict query returned zero results for essentially
  // everything, making this fallback dead code. Filtering the loose results
  // through the shared matcher is both more forgiving and just as safe.
  const q = encodeURIComponent(`${track.artist} ${track.title}`)
  const json = await getJson<DeezerResult>(`https://api.deezer.com/search?q=${q}&limit=8`)
  if (!json?.data?.length) return null

  const hit = json.data.find(
    (d) =>
      (d.album?.cover_xl || d.album?.cover_big) &&
      titlesMatch(d.title, track.title) &&
      artistsMatch(track.artist, [d.artist?.name ?? ''])
  )
  const url = hit?.album?.cover_xl ?? hit?.album?.cover_big
  return url ? fetchImage(url, 'Deezer') : null
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function lookup(track: Track): Promise<Found | null> {
  for (const provider of [fromItunes, fromDeezer]) {
    const found = await provider(track)
    if (found) return found
  }
  return null
}

/**
 * Replaces the thumbnail with real artwork if any provider can supply it.
 * Resolves true once something has been applied, so the caller can stop
 * retrying. Never throws - a missing cover is not an error worth surfacing.
 */
export async function upgradeArtwork(
  track: Track,
  apply: (art: Artwork) => void
): Promise<boolean> {
  if (!track.title || !track.artist) return false
  const key = songKey(track)

  const cached = cache.get(key)
  if (cached) {
    applyFound(track, cached, apply)
    return true
  }

  let pending = inFlight.get(key)
  if (!pending) {
    pending = lookup(track).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
  }

  const found = await pending
  if (!found) return false
  remember(key, found)
  applyFound(track, found, apply)
  return true
}

function applyFound(track: Track, found: Found, apply: (art: Artwork) => void): void {
  console.log(`[artwork] ${found.source} ${found.width}px for "${track.title}"`)
  apply({
    // Deliberately the same hash the thumbnail carried. applyArtwork uses hash
    // equality to stop a later low-res publish overwriting this one, and a
    // distinct hash would defeat that guard.
    hash: track.artHash ?? songKey(track),
    dataUrl: found.dataUrl,
    highRes: true
  })
}
