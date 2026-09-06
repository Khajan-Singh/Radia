import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { formatTime, useAudioRef, useRadia, usePaletteCss } from '../shared/useRadia'
import { usePlaybackPosition } from '../shared/usePlaybackPosition'
import { SeekBar } from '../shared/SeekBar'
import { usePlayPauseHotkey } from '../shared/usePlayPauseHotkey'
import { useDecodedImage } from './useDecodedImage'
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
import { ANIMATIONS, type AnimationMode } from '../../shared/types'

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
  const glowRef = useRef<HTMLDivElement>(null)
  const transportRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLElement>(null)

  const track = state.track
  const playing = track?.status === 'playing'
  const mode = state.settings.playerMode
  const fullscreen = mode === 'fullscreen'

  const idle = useIdle(fullscreen, IDLE_MS)
  const recenter = useRecenterOffset(fullscreen, transportRef, toolbarRef)
  usePlayPauseHotkey()
  const compactArt = useDecodedImage(mode === 'compact' ? state.artwork?.dataUrl ?? null : null)

  // The card's progress bar is moved by whole pixels. Chromium re-rasters a
  // composited layer whenever its sub-pixel offset changes, so a percentage
  // translate repainted the bar on every position tick; an integer one only
  // produces a new value when the bar actually advances a pixel (~1/s).
  const barRef = useRef<HTMLDivElement>(null)
  const [barWidth, setBarWidth] = useState(0)
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const measure = (): void => setBarWidth(el.offsetWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mode])
  const barOffset = barWidth ? Math.round(playback.progress * barWidth) - barWidth : null

  // Tell the main process once this mode is actually on screen. The window is
  // kept hidden across a mode change until then, so the user never sees the
  // old layout at the new size. Two frames: the first commits layout, the
  // second guarantees the paint has happened. The card also waits for its
  // cover to decode, so the art is part of the first frame rather than the
  // last thing to arrive; the main process has a fallback if that never comes.
  const compactArtPending = mode === 'compact' && !!state.artwork && !compactArt
  useLayoutEffect(() => {
    if (compactArtPending) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => api.playerModeReady(mode))
    })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
  }, [mode, compactArtPending])

  // The halo behind the artwork breathes with the bass. Driving it from an rAF
  // loop keeps 60Hz audio out of React's render path. The full window goes
  // through a CSS variable; the compact glow is written as opacity/transform
  // directly, because an unregistered custom property inside calc() forces a
  // style recalc every frame, and over acrylic that repaint is visible.
  useEffect(() => {
    let handle = 0
    let level = 0
    const tick = (): void => {
      handle = requestAnimationFrame(tick)
      const target = Math.min(1, audio.current.bass + audio.current.sub * 0.5)
      level += (target - level) * (target > level ? 0.4 : 0.06)
      haloRef.current?.style.setProperty('--pulse', level.toFixed(3))
      const glow = glowRef.current
      if (glow) {
        glow.style.opacity = (0.3 + level * 0.45).toFixed(3)
        glow.style.transform = `translateY(3px) scale(${(0.9 + level * 0.2).toFixed(3)})`
      }
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
        <div className="compact-cover">
          <div className="compact-glow" ref={glowRef} />
          <div className="compact-art">
            {compactArt ? (
              <img src={compactArt} decoding="sync" alt="" />
            ) : (
              <div className="art-empty" />
            )}
          </div>
        </div>
        <div className="compact-meta">
          <div className="compact-title">{track?.title ?? 'Nothing playing'}</div>
          <div className="compact-artist">{track?.artist ?? ' '}</div>
          <div className="compact-bar" ref={barRef}>
            <div
              className="compact-bar-fill"
              style={{ transform: barOffset === null ? 'translateX(-100%)' : `translateX(${barOffset}px)` }}
            />
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
          <button
            className="icon-button sm expand"
            onClick={() => api.setPlayerMode('window')}
            title="Expand"
          >
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
        <DesignDock animation={state.settings.animation} idle={idle} />
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

/** Grace after the pointer leaves the dock before the pill closes. Just enough
 *  to survive crossing the gap between icon and pill; leaving should feel
 *  immediate. */
const CLOSE_GRACE_MS = 80

/**
 * The Design dock: the palette button plus the animation picker that slides
 * out of it on hover.
 *
 * Open state is driven from JS rather than :hover / :focus-within. Each of
 * these was a real bug: a clicked option keeps focus, so :focus-within held the
 * pill open until a click elsewhere; the toolbar re-centres as the pill grows,
 * so elements move under a stationary pointer and Chromium does not reliably
 * re-fire boundary events for that; and nothing closed it when the window lost
 * focus or full screen went idle. So: open on enter, close after a short grace
 * on leave, re-check the last pointer position whenever the layout settles, and
 * close outright on blur / pointer leaving the window / idle / Escape.
 */
function DesignDock({ animation, idle }: { animation: AnimationMode; idle: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef(0)
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), [])
  const show = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])
  const hide = useCallback(() => {
    cancelClose()
    setOpen(false)
  }, [cancelClose])
  const hideSoon = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }, [cancelClose])

  /** Whether the last known pointer position is still over the dock (with slack). */
  const pointerInside = useCallback((): boolean => {
    const p = pointer.current
    const el = dockRef.current
    if (!p || !el) return false
    const r = el.getBoundingClientRect()
    const slack = 8
    return (
      p.x >= r.left - slack && p.x <= r.right + slack && p.y >= r.top - slack && p.y <= r.bottom + slack
    )
  }, [])

  // While open: track the pointer, and close the moment it is provably gone.
  // A move that lands outside the dock closes at once - the grace is only for
  // leave events, and re-arming it on every move would keep the pill open for
  // as long as the pointer kept moving.
  useEffect(() => {
    if (!open) return
    const onMove = (e: PointerEvent): void => {
      pointer.current = { x: e.clientX, y: e.clientY }
      if (pointerInside()) cancelClose()
      else hide()
    }
    const onLeaveWindow = (): void => hide()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('blur', onLeaveWindow)
    window.addEventListener('pointercancel', onLeaveWindow)
    document.documentElement.addEventListener('mouseleave', onLeaveWindow)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('blur', onLeaveWindow)
      window.removeEventListener('pointercancel', onLeaveWindow)
      document.documentElement.removeEventListener('mouseleave', onLeaveWindow)
    }
  }, [open, pointerInside, cancelClose, hide])

  // Full-screen chrome is fading out; take the pill with it.
  useEffect(() => {
    if (idle) hide()
  }, [idle, hide])

  useEffect(() => cancelClose, [cancelClose])

  // The slot finished growing or shrinking, i.e. the toolbar just re-centred.
  // If the pointer is no longer over the moved dock, close - this is the case
  // :hover misses.
  const onSettled = (e: React.TransitionEvent): void => {
    if (e.propertyName !== 'grid-template-columns') return
    if (open && pointer.current && !pointerInside()) hideSoon()
  }

  return (
    <div
      className={`design ${open ? 'open' : ''}`}
      ref={dockRef}
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return
        pointer.current = { x: e.clientX, y: e.clientY }
        show()
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch') return
        hideSoon()
      }}
      onFocus={show}
      onBlur={(e) => {
        if (!dockRef.current?.contains(e.relatedTarget as Node | null)) hide()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          hide()
        }
      }}
      onTransitionEnd={onSettled}
    >
      <button className="tool" onClick={() => api.openAppearance('color')} aria-label="Design">
        <PaletteIcon />
      </button>
      <div className="anim-slot">
        <SegmentedPicker
          label="Animation"
          value={animation}
          options={ANIMATIONS}
          open={open}
          onChoose={(value) => void api.patchSettings({ animation: value })}
        />
      </div>
    </div>
  )
}

type ChipGeom = { x: number; w: number }

/**
 * A segmented control: an album-tinted chip sits on the selected option and
 * glides when the selection changes; hovering an option only brightens its
 * label. Generic so the dock can grow another one without a copy.
 *
 * Positions are measured because the labels are not equal widths. The pill's
 * padding is constant in both states so an offset measured while collapsed is
 * still right when open; measuring is repeated on open and on resize anyway.
 *
 * `patchSettings` broadcasts to every window except the sender, so the player
 * never hears its own change echoed back; the choice is held locally until the
 * next broadcast (from anywhere) supersedes it.
 */
function SegmentedPicker<T extends string>({
  label,
  value,
  options: choices,
  open,
  onChoose
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  open: boolean
  onChoose: (value: T) => void
}): JSX.Element {
  const [current, setCurrent] = useState(value)
  useEffect(() => setCurrent(value), [value])

  const pillRef = useRef<HTMLDivElement>(null)
  const options = useRef(new Map<T, HTMLButtonElement>())
  const [geom, setGeom] = useState<Partial<Record<T, ChipGeom>>>({})

  useLayoutEffect(() => {
    const pill = pillRef.current
    if (!pill) return
    const measure = (): void => {
      const next: Partial<Record<T, ChipGeom>> = {}
      options.current.forEach((el, key) => {
        next[key] = { x: el.offsetLeft, w: el.offsetWidth }
      })
      setGeom(next)
    }
    measure()
    // Labels reflow when the window changes mode (font size) or fonts load.
    const observer = new ResizeObserver(measure)
    observer.observe(pill)
    options.current.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [open])

  const choose = (next: T): void => {
    setCurrent(next)
    onChoose(next)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const order = choices.map((c) => c.value)
    const i = order.indexOf(current)
    let next: T | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(i + 1) % order.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = order[(i - 1 + order.length) % order.length]
    else if (e.key === 'Home') next = order[0]
    else if (e.key === 'End') next = order[order.length - 1]
    if (!next) return
    e.preventDefault()
    choose(next)
    options.current.get(next)?.focus()
  }

  const g = geom[current]
  const chipStyle = { '--x': `${g?.x ?? 0}px`, '--w': `${g?.w ?? 0}px` } as React.CSSProperties

  return (
    <div className="anim-pill" role="radiogroup" aria-label={label} ref={pillRef} onKeyDown={onKeyDown}>
      <span className="anim-chip" aria-hidden style={chipStyle} />
      {choices.map(({ value: option, label: text }) => {
        const selected = current === option
        return (
          <button
            key={option}
            ref={(el) => {
              if (el) options.current.set(option, el)
              else options.current.delete(option)
            }}
            className={`anim-option ${selected ? 'selected' : ''}`}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            // No focus on mouse click: focus is for the keyboard, and a
            // focused option must not hold the pill open.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(option)}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
