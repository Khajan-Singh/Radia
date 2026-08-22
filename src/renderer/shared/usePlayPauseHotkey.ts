import { useEffect } from 'react'

/**
 * Space toggles playback from anywhere in the window.
 *
 * Space already means something on a focused control - it activates a button,
 * opens a select, types into a field - so those are left alone rather than
 * hijacked. Getting this wrong is worse than not having the shortcut: pressing
 * space on the focused play button would fire the button *and* this handler,
 * toggling twice and appearing to do nothing at all.
 */
export function usePlayPauseHotkey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      // Let real shortcuts through, and ignore key-repeat from a held key.
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (isInteractive(e.target)) return

      // Only prevented once we know we're handling it - preventing default on
      // Space is what would stop a focused button from activating.
      e.preventDefault()
      void window.radia.transport({ kind: 'playpause' })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/**
 * True when the element has its own meaning for Space.
 *
 * Sliders are deliberately absent: neither a range input nor our seek bar does
 * anything with Space, so claiming it there costs nothing and avoids a dead spot
 * where the shortcut mysteriously stops working because a slider holds focus.
 */
function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true

  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true
  if (tag === 'INPUT') {
    // Space types into text fields and toggles checkboxes, but does nothing to a
    // range - and every input in this app is a range.
    return (target as HTMLInputElement).type !== 'range'
  }

  const role = target.getAttribute('role')
  return role === 'button' || role === 'switch'
}
