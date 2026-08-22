/**
 * Deciding whether a search result is actually the song that is playing.
 *
 * Shared by every artwork provider so they cannot disagree: a provider that
 * matches more loosely than the others would quietly put the wrong album on
 * screen, which is worse than leaving the small thumbnail alone.
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

/** True when two titles agree either exactly or once qualifiers are dropped. */
export function titlesMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b) || core(a) === core(b)
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
