import { useEffect, useState } from 'react'

/**
 * Holds an image URL back until the browser has decoded it.
 *
 * Handing a data URL straight to an `<img>` paints the element a frame or two
 * before its pixels exist, so the cover pops in after the rest of the card -
 * and over the mini player's acrylic backdrop every late raster is a visible
 * lighter box. Decoding off-screen first means the swap is one complete paint,
 * and the previous cover stays up until the replacement is ready, which also
 * hides the thumbnail -> high-res upgrade.
 */
export function useDecodedImage(url: string | null): string | null {
  const [ready, setReady] = useState<string | null>(null)

  useEffect(() => {
    if (!url) { setReady(null); return }
    let live = true
    const img = new Image()
    img.src = url
    // decode() rejects for a malformed image; fall through and show it anyway
    // so a broken decode degrades to the old behaviour rather than to no art.
    img.decode().catch(() => undefined).then(() => { if (live) setReady(url) })
    return () => { live = false }
  }, [url])

  return ready
}
