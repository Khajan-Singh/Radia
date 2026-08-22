/**
 * Deciding whether a search result is actually the song that is playing.
 *
 * Shared by every artwork provider so they cannot disagree: a provider that
 * matches more loosely than the others would quietly put the wrong album on
 * screen, which is worse than leaving the small thumbnail alone.
 *
 * Results are SCORED, not first-matched. The first version took the first
 * result whose title and artist looked right, and "looked right" was too
 * loose in two ways that compounded: qualifiers were stripped from the result
 * as well as from the playing title, so "EARFQUAKE (wev Remix) [Mixed]" on a
 * DJ-mix compilation counted as an exact match for "EARFQUAKE"; and the album
 * was never consulted, though the session reports it and the providers return
 * it. iTunes ran first and won, so Deezer's correct answer was never compared.
 */

/** Strips everything but letters and digits, so punctuation and case stop mattering. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Normalizes after dropping the trailing qualifier that only one side usually
 * carries - "- Remastered 2011", "(feat. X)", "- Live". Comparing full titles
 * alone rejects a correct match often enough to look broken.
 */
export function core(text: string): string {
  return normalize(text.replace(/\s*[-–(\[].*$/, '')) || normalize(text)
}

/** The qualifier part that core() drops, normalized. Empty when there is none. */
function qualifier(text: string): string {
  const m = text.match(/\s*[-–(\[](.*)$/)
  return m ? normalize(m[1]) : ''
}

/**
 * Words in a result's qualifier that mean "a different recording of this
 * song". If the playing title does not carry the same word, the result is not
 * what is playing, however well the core title matches.
 */
const RECORDING_QUALIFIERS = [
  'remix', 'mix', 'mixed', 'edit', 'live', 'instrumental', 'karaoke', 'acoustic',
  'acapella', 'cover', 'tribute', 'lullaby', 'version', 'sped', 'slowed', 'reverb',
  'demo', 'radio', 'extended', 'dub', 'bootleg', 'mashup', 'medley', 'rework', 'flip'
]

/** True when two titles agree either exactly or once qualifiers are dropped. */
export function titlesMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b) || core(a) === core(b)
}

/**
 * True when the result's qualifier names a different recording that the
 * playing title does not also name. Asymmetric on purpose: dropping "(feat.
 * X)" from what is playing is safe, dropping "(Remix)" from a result is how a
 * remix compilation ends up on screen.
 */
export function isDifferentRecording(resultTitle: string, playingTitle: string): boolean {
  const q = qualifier(resultTitle)
  if (!q) return false
  const playing = normalize(playingTitle)
  return RECORDING_QUALIFIERS.some((word) => q.includes(word) && !playing.includes(word))
}

/**
 * Containment rather than equality: the media session reports the full credit
 * list ("Daft Punk, Julian Casablancas") where a search result often names only
 * the primary artist, and vice versa.
 */
export function artistsMatch(reported: string, candidates: string[]): boolean {
  const mine = normalize(reported)
  if (!mine) return false
  return candidates.some((c) => {
    const theirs = normalize(c)
    return !!theirs && (mine.includes(theirs) || theirs.includes(mine))
  })
}

/** Loose album agreement: "IGOR" should accept "IGOR (Deluxe)" and vice versa. */
export function albumsMatch(reported: string, candidate: string): boolean {
  const a = core(reported)
  const b = core(candidate)
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a))
}

export interface Candidate {
  title: string
  artist: string
  album: string
}

/**
 * How well a result fits the playing track, or null when it is not the song
 * at all. Higher is better. Album agreement dominates, because it is the one
 * signal that separates the right release from a remix, a compilation or a
 * tribute album carrying the same title.
 */
export function scoreCandidate(track: Candidate, result: Candidate): number | null {
  if (!artistsMatch(track.artist, [result.artist])) return null
  if (!titlesMatch(result.title, track.title)) return null
  if (isDifferentRecording(result.title, track.title)) return null

  let score = 0
  if (normalize(result.title) === normalize(track.title)) score += 10
  if (track.album && albumsMatch(track.album, result.album)) score += 100
  // An exact artist string beats a containment match ("Tyler, The Creator"
  // over "Tyler, The Creator & Kali Uchis").
  if (normalize(result.artist) === normalize(track.artist)) score += 5
  return score
}
