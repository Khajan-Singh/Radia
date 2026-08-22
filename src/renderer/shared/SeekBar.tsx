import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { PlaybackPosition } from './usePlaybackPosition'

interface Props {
  playback: PlaybackPosition
  durationMs: number
  /** False when the source cannot seek; the bar still shows progress. */
  seekable: boolean
}

/**
 * A real drag-to-scrub bar. Pointer capture means the drag keeps following the
 * pointer after it leaves the element - without it, dragging off the end of the
 * bar silently drops the gesture and the position snaps back to wherever
 * playback had reached.
 */
export function SeekBar({ playback, durationMs, seekable }: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)

  const fractionAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return (clientX - rect.left) / rect.width
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!seekable || !durationMs) return
    e.currentTarget.setPointerCapture(e.pointerId)
    playback.beginScrub(fractionAt(e.clientX))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!playback.scrubbing) return
    playback.moveScrub(fractionAt(e.clientX))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!playback.scrubbing) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    playback.endScrub(fractionAt(e.clientX))
  }

  const percent = playback.progress * 100

  return (
    <div
      ref={trackRef}
      className={`track ${playback.scrubbing ? 'scrubbing' : ''} ${seekable ? '' : 'locked'}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={Math.round(playback.positionMs)}
      aria-disabled={!seekable}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => {
        if (!seekable) return
        const step = e.shiftKey ? 30_000 : 5_000
        if (e.key === 'ArrowLeft') playback.nudge(-step)
        else if (e.key === 'ArrowRight') playback.nudge(step)
        else if (e.key === 'Home') playback.nudge(-Number.MAX_SAFE_INTEGER)
        else if (e.key === 'End' && durationMs) playback.nudge(durationMs)
        else return
        e.preventDefault()
      }}
    >
      <div className="track-fill" style={{ width: `${percent}%` }} />
      <div className="track-knob" style={{ left: `${percent}%` }} />
    </div>
  )
}
