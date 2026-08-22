import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PALETTE,
  DEFAULT_SETTINGS,
  SILENT_FRAME,
  type Artwork,
  type AudioFrame,
  type BridgeStatus,
  type DisplayInfo,
  type Palette,
  type Settings,
  type Track
} from '../../shared/types'

export interface RadiaState {
  ready: boolean
  settings: Settings
  track: Track | null
  artwork: Artwork | null
  palette: Palette
  displays: DisplayInfo[]
  bridge: BridgeStatus
}

const INITIAL: RadiaState = {
  ready: false,
  settings: DEFAULT_SETTINGS,
  track: null,
  artwork: null,
  palette: DEFAULT_PALETTE,
  displays: [],
  bridge: { running: false, media: false, audio: false, lastError: null },
}

/** Subscribes to every broadcast channel and mirrors main's state locally. */
export function useRadia(): RadiaState {
  const [state, setState] = useState<RadiaState>(INITIAL)

  useEffect(() => {
    const api = window.radia
    let live = true

    void api.getState().then((initial) => {
      if (live) setState({ ...initial, ready: true })
    })

    const unsubscribe = [
      api.onSettings((settings) => setState((s) => ({ ...s, settings }))),
      api.onTrack((track) => setState((s) => ({ ...s, track }))),
      api.onArtwork((artwork) => setState((s) => ({ ...s, artwork }))),
      api.onPalette((palette) => setState((s) => ({ ...s, palette }))),
      api.onDisplays((displays) => setState((s) => ({ ...s, displays }))),
      api.onBridge((bridge) => setState((s) => ({ ...s, bridge }))),
    ]

    return () => {
      live = false
      unsubscribe.forEach((fn) => fn())
    }
  }, [])

  return state
}

/**
 * Audio frames arrive at 60Hz. Putting them through React state would rerender
 * the whole tree every frame, so callers get a ref they can read from their own
 * animation loop instead.
 */
export function useAudioRef(): React.MutableRefObject<AudioFrame> {
  const ref = useRef<AudioFrame>({ ...SILENT_FRAME })
  useEffect(() => window.radia.onAudio((frame) => { ref.current = frame }), [])
  return ref
}

/** CSS color strings derived from the live palette, for tinting the UI. */
export function usePaletteCss(palette: Palette): { primary: string; secondary: string } {
  return useMemo(() => {
    const css = (i: number): string => {
      const c = palette.colors[Math.min(i, palette.colors.length - 1)] ?? [1, 1, 1]
      return `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`
    }
    return { primary: css(0), secondary: css(1) }
  }, [palette])
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
