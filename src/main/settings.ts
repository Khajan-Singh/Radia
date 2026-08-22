import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { ANIMATION_MODES, DEFAULT_SETTINGS, SETTINGS_VERSION, type AnimationMode, type Settings } from '../shared/types'

let cache: Settings | null = null
let flushTimer: NodeJS.Timeout | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Deep-merges stored values over the defaults so a settings file written by an
 * older build never loses keys added since. Unknown keys are dropped.
 */
function reconcile(stored: unknown): Settings {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS }
  const s = stored as Record<string, unknown>

  // v1 stored presentation as a boolean. Carry it across rather than silently
  // dropping the user back to windowed.
  if (s.playerMode === undefined && typeof s.compactPlayer === 'boolean') {
    s.playerMode = s.compactPlayer ? 'compact' : 'window'
  }
  // Removed or unknown rim animations (Flow and Breathe once existed) land on
  // Sync rather than a mode nothing renders. `glow` (dropped in v4) falls
  // out naturally: the merge below only carries keys present in the defaults.
  if (!ANIMATION_MODES.includes(s.animation as AnimationMode)) s.animation = 'music'

  const merged = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>

  for (const key of Object.keys(defaults)) {
    const value = s[key]
    if (value === undefined || value === null) continue
    const fallback = defaults[key]
    if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)) {
      if (typeof value === 'object') merged[key] = { ...(fallback as object), ...(value as object) }
    } else if (typeof value === typeof fallback) {
      merged[key] = value
    }
  }
  const result = merged as unknown as Settings
  const modes = ['window', 'fullscreen', 'compact']
  if (typeof s.playerMode === 'string' && modes.includes(s.playerMode)) {
    result.playerMode = s.playerMode as Settings['playerMode']
  }
  // displayId is the one nullable scalar, so the typeof check above rejects it.
  if (typeof s.displayId === 'number') result.displayId = s.displayId
  result.version = SETTINGS_VERSION
  return result
}

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    // Strip a BOM: JSON.parse rejects one outright, and some editors add it.
    const raw = readFileSync(file(), 'utf8').replace(/^﻿/, '')
    cache = reconcile(JSON.parse(raw))
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    if (!missing) {
      // Falling back silently would drop every setting the user had chosen.
      console.error('[settings] unreadable, using defaults:', err)
    }
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function getSettings(): Settings {
  return loadSettings()
}

/** Applies a partial update and schedules a debounced write. Returns the new settings. */
export function patchSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  cache = next
  scheduleFlush()
  return next
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  // Sliders fire continuously while dragging; no reason to hit disk each frame.
  flushTimer = setTimeout(flushSettings, 400)
}

export function flushSettings(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!cache) return
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] write failed:', err)
  }
}
