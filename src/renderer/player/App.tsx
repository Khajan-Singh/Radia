import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { formatTime, useAudioRef, useRadia, usePaletteCss } from '../shared/useRadia'
import { usePlaybackPosition } from '../shared/usePlaybackPosition'
import { SeekBar } from '../shared/SeekBar'
import { usePlayPauseHotkey } from '../shared/usePlayPauseHotkey'
import {
  BulbIcon,
  CardIcon,
  CloseIcon,
  ExitFullscreenIcon,
  ExpandIcon,
  FullscreenIcon,
  MinimizeIcon,
  NextIcon,
  PaletteIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  SkipIcon
} from '../shared/Icons'

const api = window.radia

/**
 * How long the pointer must rest before full screen hides its chrome and the
 * artwork settles to centre.
 *
 * Short enough that it feels responsive rather than like a timeout, long enough
 * that crossing the window on the way to a control does not trigger it. The one
 * knob for this - the fade and the settle animation have their own durations in
 * the stylesheet.
 */
const IDLE_MS = 1000

export default function App(): JSX.Element {
  const state = useRadia()
  const audio = useAudioRef()
  const playback = usePlaybackPosition(state.track)
  const colors = usePaletteCss(state.palette)
  const haloRef = useRef<HTMLDivElement>(null)
  const transportRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLElement>(null)

  const track = state.track
  const playing = track?.status === 'playing'
  const mode = state.settings.playerMode
  const fullscreen = mode === 'fullscreen'

  const idle = useIdle(fullscreen, IDLE_MS)
  const recenter = useRecenterOffset(fullscreen, transportRef, toolbarRef)
  usePlayPauseHotkey()

  // The halo behind the artwork breathes with the bass. Driving it through a CSS
  // variable in an rAF loop keeps 60Hz audio out of React's render path.
  useEffect(() => {
    let handle = 0
    let level = 0
    const tick = (): void => {
      handle = requestAnimationFrame(tick)
      const target = Math.min(1, audio.current.bass + audio.current.sub * 0.5)
      level += (target - level) * (target > level ? 0.4 : 0.06)
      haloRef.current?.style.setProperty('--pulse', level.toFixed(3))
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [audio])

  // Escape is the reflex for leaving anything full screen, so honour it.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void api.setPlayerMode('window')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  if (mode === 'compact') {
    return (
      <div
        className="app compact"
        style={{ '--primary': colors.primary, '--secondary': colors.secondary } as React.CSSProperties}
      >
        <div className="compact-art" ref={haloRef}>
          {state.artwork ? (
            <img key={state.artwork.hash} src={state.artwork.dataUrl} decoding="async" alt="" />
          ) : (
            <div className="art-empty" />
          )}
        </div>
        <div className="compact-meta">
          <div className="compact-title">{track?.title ?? 'Nothing playing'}</div>
          <div className="compact-artist">{track?.artist ?? ' '}</div>
          <div className="compact-bar">
            <div className="compact-bar-fill" style={{ width: `${playback.progress * 100}%` }} />
          </div>
        </div>
        <div className="compact-controls">
          <button className="icon-button sm" onClick={() => api.transport({ kind: 'prev' })} title="Previous">
            <PrevIcon />
          </button>
          <button
            className="icon-button sm primary"
            onClick={() => api.transport({ kind: 'playpause' })}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="icon-button sm" onClick={() => api.transport({ kind: 'next' })} title="Next">
            <NextIcon />
          </button>
          <button className="icon-button sm" onClick={() => api.setPlayerMode('window')} title="Expand">
            <ExpandIcon />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`app ${fullscreen ? 'fullscreen' : ''} ${fullscreen && idle ? 'idle' : ''}`}
      style={
        {
          '--primary': colors.primary,
          '--secondary': colors.secondary,
          '--recenter': `${recenter}px`
        } as React.CSSProperties
      }
    >
      {!fullscreen && (
        <header className="titlebar">
          <span className="wordmark">Radia</span>
          <div className="window-controls">
            <button className="window-button" onClick={() => api.windowAction('minimize')} title="Minimize">
              <MinimizeIcon />
            </button>
            <button className="window-button close" onClick={() => api.windowAction('close')} title="Close Radia">
              <CloseIcon />
            </button>
          </div>
        </header>
      )}

      {fullscreen && (
        <button
          className="exit-fullscreen chrome"
          onClick={() => api.setPlayerMode('window')}
          title="Exit full screen (Esc)"
        >
          <ExitFullscreenIcon />
        </button>
      )}

      <main className="stage">
        <div className="art-frame" ref={haloRef}>
          <div className="art-halo" />
          <div className="art-bezel">
            {state.artwork ? (
              // Keyed on the hash so React remounts the image when the art
              // changes, which restarts the fade - otherwise the low-res
              // thumbnail swapping for the high-res upgrade is a visible pop.
              <img
                key={state.artwork.hash}
                className="art"
                src={state.artwork.dataUrl}
                decoding="async"
                alt={track ? `${track.album} cover` : ''}
              />
            ) : (
              <div className="art art-empty" />
            )}
          </div>
        </div>

        <h1 className="title">{track?.title ?? 'Nothing playing'}</h1>
        <p className="artist">{track?.artist ?? 'Start something playing'}</p>

        <div className="progress">
          <span className="time">{formatTime(playback.positionMs)}</span>
          <SeekBar
            playback={playback}
            durationMs={track?.durationMs ?? 0}
            seekable={track?.canSeek ?? false}
          />
          <span className="time">{formatTime(track?.durationMs ?? 0)}</span>
        </div>

        <div className="transport chrome" ref={transportRef}>
          <button
            className="icon-button"
            onClick={() => playback.nudge(-15000)}
            title="Back 15 seconds"
          >
            <SkipIcon seconds={15} back />
          </button>
          <button className="icon-button" onClick={() => api.transport({ kind: 'prev' })} title="Previous">
            <PrevIcon />
          </button>
          <button
            className="icon-button large"
            onClick={() => api.transport({ kind: 'playpause' })}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="icon-button" onClick={() => api.transport({ kind: 'next' })} title="Next">
            <NextIcon />
          </button>
          <button
            className="icon-button"
            onClick={() => playback.nudge(15000)}
            title="Forward 15 seconds"
          >
            <SkipIcon seconds={15} />
          </button>
        </div>
      </main>

      <footer className="toolbar chrome" ref={toolbarRef}>
        <button className="tool" onClick={() => api.openAppearance('color')} title="Colors">
          <PaletteIcon />
        </button>
        <button
          className={`tool ${state.settings.enabled ? 'on' : ''}`}
          onClick={() => api.toggleRim()}
          title={state.settings.enabled ? 'Turn rim lighting off' : 'Turn rim lighting on'}
        >
          <BulbIcon />
        </button>
        <button className="tool wide" onClick={() => api.openAppearance()}>
          Settings
        </button>
        <button
          className={`tool ${fullscreen ? 'on' : ''}`}
          onClick={() => api.setPlayerMode(fullscreen ? 'window' : 'fullscreen')}
          title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        <button className="tool" onClick={() => api.setPlayerMode('compact')} title="Mini player">
          <CardIcon />
        </button>
      </footer>

      {!state.bridge.running && state.ready && (
        <div className="notice" role="status">
          {state.bridge.lastError ?? 'Helper not running - track info and audio are unavailable.'}
        </div>
      )}
    </div>
  )
}

/**
 * How far the stage has to move down to sit centred once the chrome has faded.
 *
 * The faded chrome keeps its layout box - fading only changes opacity - so the
 * remaining content stays parked where it was, sitting visibly high on the
 * screen. Collapsing the boxes instead would reflow and cannot be animated
 * smoothly, so the stage is translated by the exact amount that recentres it.
 *
 * Derivation, with the app a flex column of [stage, toolbar]: the stage owns
 * `H - T` and centres its content `C` inside that, so the content top is
 * `(H - T - C) / 2`. After the transport block `M` fades, the visible height is
 * `C - M` and its centre sits at `(H - T - C) / 2 + (C - M) / 2`. Setting that
 * equal to `H / 2` collapses to `(T + M) / 2` - the window height and the rest
 * of the content drop out entirely.
 */
function useRecenterOffset(
  fullscreen: boolean,
  transport: React.RefObject<HTMLDivElement | null>,
  toolbar: React.RefObject<HTMLElement | null>
): number {
  const [offset, setOffset] = useState(0)

  useLayoutEffect(() => {
    if (!fullscreen) {
      setOffset(0)
      return
    }
    const measure = (): void => {
      const t = transport.current
      const b = toolbar.current
      if (!t || !b) return
      // Everything the transport row gives back: its own height, its margin,
      // and the stage's flex gap above it. Omitting the gap leaves the content
      // sitting half a gap high, which is small but visible on a large display.
      const style = getComputedStyle(t)
      const margin = parseFloat(style.marginTop) || 0
      const gap = t.parentElement ? parseFloat(getComputedStyle(t.parentElement).rowGap) || 0 : 0
      setOffset(Math.round((b.offsetHeight + t.offsetHeight + margin + gap) / 2))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [fullscreen, transport, toolbar])

  return offset
}

/**
 * Reports true once the pointer and keyboard have been quiet for `delay`.
 * Full screen uses it to fade its chrome away, so the artwork is genuinely the
 * only thing left on the display.
 */
function useIdle(active: boolean, delay: number): boolean {
  const [idle, setIdle] = useState(false)
  const timer = useRef<number>(0)

  const bump = useCallback(() => {
    setIdle(false)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setIdle(true), delay)
  }, [delay])

  useEffect(() => {
    if (!active) {
      setIdle(false)
      window.clearTimeout(timer.current)
      return
    }
    bump()
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, bump))
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump))
      window.clearTimeout(timer.current)
    }
  }, [active, bump])

  return idle
}
