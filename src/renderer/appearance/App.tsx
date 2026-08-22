import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useRadia } from '../shared/useRadia'
import { usePlayPauseHotkey } from '../shared/usePlayPauseHotkey'
import { ColorWheel } from '../shared/ColorWheel'
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  MinimizeIcon,
  MonitorIcon,
  SunIcon
} from '../shared/Icons'
import type { AnimationMode, ColorOverride, GradientMode, Settings } from '../../shared/types'

const api = window.radia

const ANIMATIONS: { value: AnimationMode; label: string }[] = [
  { value: 'music', label: 'Music Sync' },
  { value: 'flow', label: 'Flow' },
  { value: 'breathe', label: 'Breathe' },
  { value: 'static', label: 'Static' }
]

const GRADIENTS: { value: GradientMode; label: string }[] = [
  { value: 1, label: '1 Color' },
  { value: 2, label: '2 Colors' },
  { value: 3, label: '3 Colors' }
]

export default function App(): JSX.Element {
  const state = useRadia()
  usePlayPauseHotkey()
  /** Local mirror so sliders stay responsive rather than waiting on a round trip. */
  const [draft, setDraft] = useState<Settings>(state.settings)

  useEffect(() => setDraft(state.settings), [state.settings])

  // The player's dock opens this panel aimed at a particular section; scroll it
  // into view and flash it, otherwise the jump is invisible on a short list.
  useEffect(() => {
    return api.onRevealSection((section) => {
      const el = document.getElementById(`section-${section}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.remove('revealed')
      // Reading offsetWidth forces a reflow so re-adding the class restarts the
      // animation rather than being coalesced into a no-op.
      void el.offsetWidth
      el.classList.add('revealed')
    })
  }, [])

  const patch = (next: Partial<Settings>): void => {
    setDraft((current) => ({ ...current, ...next }))
    void api.patchSettings(next)
  }

  const overriding = draft.overrideAlbumColor
  const showSecondary = draft.gradientMode >= 2
  const showTertiary = draft.gradientMode >= 3

  return (
    <div className="panel">
      {/* Same title bar as the player - the markup and styling are shared
          (see tokens.css) so the two windows cannot drift apart. */}
      <header className="titlebar">
        <span className="wordmark">Appearance</span>
        <div className="window-controls">
          <button
            className="window-button"
            onClick={() => api.windowAction('minimize')}
            title="Minimize"
          >
            <MinimizeIcon />
          </button>
          {/* Unlike the player, closing this window really closes it. */}
          <button
            className="window-button close"
            onClick={() => api.windowAction('close')}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="panel-body">
        <div className="panel-heading">
          <h1 className="panel-title">Radia</h1>
          <span className={`pill ${draft.enabled ? 'active' : ''}`}>
            {draft.enabled ? 'Active' : 'Off'}
          </span>
        </div>

        <Row label="Gradient">
          <Select
            value={String(draft.gradientMode)}
            onChange={(v) => patch({ gradientMode: Number(v) as GradientMode })}
            options={GRADIENTS.map((g) => ({ value: String(g.value), label: g.label }))}
          />
        </Row>

        <Row label="Animation">
          <Select
            value={draft.animation}
            onChange={(v) => patch({ animation: v as AnimationMode })}
            options={ANIMATIONS.map((a) => ({ value: a.value, label: a.label }))}
          />
        </Row>

        <Row label="Taskbar compatibility" hint="Keep the glow clear of the taskbar">
          <Toggle checked={draft.taskbarSafe} onChange={(v) => patch({ taskbarSafe: v })} label="Taskbar compatibility" />
        </Row>

        <Slider
          label="Thickness"
          value={draft.thickness}
          onChange={(v) => patch({ thickness: v })}
        />
        <Slider label="Glow" value={draft.glow} onChange={(v) => patch({ glow: v })} />

        <Row label="Override album color" id="section-color">
          <Toggle
            checked={overriding}
            onChange={(v) => patch({ overrideAlbumColor: v })}
            label="Override album color"
          />
        </Row>

        {overriding && (
          <section className="wheels">
            <Wheel
              title="Primary"
              percent={showSecondary ? Math.round(draft.primaryWeight * 100) : 100}
              value={draft.primary}
              onChange={(c) => patch({ primary: c })}
            />
            {showSecondary && (
              <Wheel
                title="Secondary"
                percent={Math.round(draft.secondaryWeight * 100)}
                value={draft.secondary}
                onChange={(c) => patch({ secondary: c })}
              />
            )}
            {showTertiary && (
              <Wheel
                title="Tertiary"
                percent={Math.max(
                  0,
                  100 - Math.round(draft.primaryWeight * 100) - Math.round(draft.secondaryWeight * 100)
                )}
                value={draft.tertiary}
                onChange={(c) => patch({ tertiary: c })}
              />
            )}
          </section>
        )}

        {overriding && showSecondary && (
          <Slider
            label="Color balance"
            value={draft.primaryWeight}
            onChange={(v) =>
              patch({
                primaryWeight: v,
                secondaryWeight: showTertiary ? draft.secondaryWeight : 1 - v
              })
            }
          />
        )}

        <h2 className="section">Audio reactivity</h2>
        <Slider
          label="Sensitivity"
          value={draft.audio.sensitivity / 2}
          onChange={(v) => patch({ audio: { ...draft.audio, sensitivity: v * 2 } })}
        />
        <Slider
          label="Beat threshold"
          value={(draft.audio.beatThreshold - 0.5) / 2.5}
          onChange={(v) => patch({ audio: { ...draft.audio, beatThreshold: 0.5 + v * 2.5 } })}
        />
        <Slider
          label="Smoothing"
          value={draft.audio.smoothing}
          onChange={(v) => patch({ audio: { ...draft.audio, smoothing: v } })}
        />

        <h2 className="section" id="section-display">Display</h2>
        <div className="displays">
          {state.displays.map((display) => {
            const selected =
              draft.displayId === display.id || (draft.displayId === null && display.isPrimary)
            return (
              <button
                key={display.id}
                className={`display ${selected ? 'selected' : ''}`}
                onClick={() => patch({ displayId: display.id })}
              >
                <MonitorIcon />
                <span className="display-name">{display.label}</span>
                <span className="display-size">
                  {display.width}x{display.height}
                </span>
                {selected && <CheckIcon className="display-check" />}
              </button>
            )
          })}
        </div>

        <div className={`status ${state.bridge.running ? 'ok' : 'warn'}`}>
          {state.bridge.running
            ? `Helper running - media ${state.bridge.media ? 'ok' : 'waiting'}, audio ${state.bridge.audio ? 'ok' : 'waiting'}`
            : state.bridge.lastError ?? 'Helper not running'}
        </div>
      </div>
    </div>
  )
}

/* ─── Primitives ─────────────────────────────────────────────────────────── */

function Row({
  label,
  hint,
  children,
  id
}: {
  label: string
  hint?: string
  children: ReactNode
  id?: string
}): JSX.Element {
  return (
    <div className="row" id={id}>
      <div className="row-label">
        <span>{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Select({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}): JSX.Element {
  return (
    <div className="select">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronIcon className="select-chevron" />
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}): JSX.Element {
  return (
    <button
      className={`toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

function Slider({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (value: number) => void
}): JSX.Element {
  const clamped = Math.min(1, Math.max(0, value))
  return (
    <div className="slider-block">
      <label className="slider-label" htmlFor={`slider-${label}`}>
        {label}
      </label>
      <input
        id={`slider-${label}`}
        className="slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={clamped}
        style={{ '--fill': `${clamped * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function Wheel({
  title,
  percent,
  value,
  onChange
}: {
  title: string
  percent: number
  value: ColorOverride
  onChange: (next: ColorOverride) => void
}): JSX.Element {
  return (
    <div className="wheel-block">
      <div className="wheel-title">
        {title} <span className="wheel-percent">{percent}%</span>
      </div>
      <ColorWheel value={value} onChange={onChange} label={`${title} color`} size={140} />
      <div className="wheel-brightness">
        <SunIcon className="sun sm" />
        <input
          className="slider"
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={value.v}
          style={{ '--fill': `${((value.v - 0.1) / 0.9) * 100}%` } as React.CSSProperties}
          aria-label={`${title} brightness`}
          onChange={(e) => onChange({ ...value, v: Number(e.target.value) })}
        />
        <SunIcon className="sun" />
      </div>
    </div>
  )
}
