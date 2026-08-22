# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Radia for Windows: ambient rim lighting on the edges of a display, colored from the
current track's album art and animated by system audio. A Windows rebuild of the
macOS app Lumn (trylumn.xyz). Windows-only by design — it depends on WinRT's media
session and WASAPI loopback.

## Commands

```bash
npm run dev            # electron-vite dev server + Electron
npm run typecheck      # tsc --noEmit  (the only static check; there is no linter)
npm run build          # build main/preload/renderers into out/
npm run build:bridge   # dotnet publish the C# helper into resources/bridge
npm run package        # build + build:bridge + electron-builder NSIS installer
```

The .NET SDK is not on `PATH` in a fresh shell. Prefix dotnet commands with:
`$env:Path = "C:\Program Files\dotnet;$env:Path"`

There are no automated tests. Verification is done by running the app and by the
probe scripts below — this is a real-time, visual project and the interesting
failures (shader compile errors, COM threading, drag regions) do not show up in
unit tests.

### Restarting during development

**`electron-vite dev` does not reliably restart the main process on change.**
Renderer edits hot-reload; anything in `src/main` or `src/preload` needs a
restart. A stale instance also holds the single-instance lock, so a new one exits
silently and it looks like nothing happened. Use:

```powershell
powershell -File scripts/restart-dev.ps1 [logPath]
```

It kills stray `electron`/`RadiaBridge` processes first. A running `RadiaBridge.exe`
also locks the published exe and makes `build:bridge` fail with a file-in-use
error, so kill it before rebuilding the helper.

### Probe scripts

These isolate a layer so you can tell where a problem actually is:

```bash
node scripts/probe-bridge.mjs 12       # 12s of sensor output: frame rate, onsets, BPM, track
node scripts/probe-sessions.mjs 30     # every media-session switch and art publish, timestamped
node scripts/probe-transport.mjs seek 30000   # send one command, report whether the session reacted
npx electron scripts/preview-rim.mjs out.png 0.32 0.85 2   # render the real shader offscreen to a PNG
npx electron scripts/preview-player.mjs out.png window     # render a renderer offscreen to a PNG
node scripts/make-icons.mjs            # regenerate resources/tray.png and icon.png
```

`preview-rim.mjs` is the right tool for shader work — it renders `rim.frag` with
known uniforms against a black backdrop, so you can see the rim without putting an
overlay on the user's desktop.

`preview-player.mjs` does the same for the React windows: it takes
`window | fullscreen | compact | appearance`, stubs `window.radia` with static
state, and writes a PNG. **Use it instead of screenshotting the desktop** — a
full-screen capture grabs whatever the user happens to have in front, which is
both useless for review and a privacy problem. Its one blind spot is DWM acrylic,
which the OS composites outside Chromium and which therefore never shows up in the
capture; the mini player's frost has to be judged on screen.

`probe-sessions.mjs` prints one line per session switch. `probe-bridge.mjs` only
summarises, which averages away exactly the sub-second flips worth hunting.

## Architecture

One Electron process owns three window types plus one child process.

```
Electron main ──spawn──> RadiaBridge.exe (C# / .NET 9, self-contained)
     │                     WinRT media session  -> track / artwork
     │   <──NDJSON stdio── WASAPI loopback + FFT -> audio frames
     │   ──commands──>     playpause / next / prev / seek
     │
     ├── overlay     transparent, click-through, topmost — the rim (WebGL2)
     ├── player      now-playing: window | fullscreen | compact (React)
     └── appearance  the control panel (React)
```

`src/shared/types.ts` is the contract for everything crossing a process boundary:
settings, track, audio frames, palette, and the `CH` channel names. Start there.

**Why a helper process:** Node has no usable binding for WinRT's media session or
WASAPI loopback. Isolating it also means an audio-driver crash kills the helper,
not the app — `src/main/bridge.ts` supervises it with exponential backoff.

**Data flow:** helper → `bridge.ts` → `index.ts` (holds the live state) →
`broadcast()` in `windows.ts` → renderers via preload. Renderers never talk to
the helper directly. Audio frames are the hot path and bypass the general
broadcast — they go only to visible windows.

## Constraints that are easy to break

These each cost real debugging time. Changing the surrounding code without
knowing them will reintroduce the bug.

**All WinRT session calls must stay on one thread.** The session objects are
marshalled to their creating apartment; calling one from another thread fails with
`RPC_E_WRONG_THREAD` (0x8001010E) *permanently*, for that object and everything
reached through it. A single `await` resuming on a thread-pool thread is enough to
poison it. `SessionWorker.cs` exists solely to queue all session work onto one
dedicated MTA thread and run it synchronously. Do not add `await` inside code that
touches a session — post to the worker instead.

**`-webkit-app-region: drag` is an OS-level hit test, not a DOM one.** A drag
region swallows clicks regardless of stacking order, and `document.elementFromPoint`
does not model it — it will happily report the button underneath. Drag lives on the
containers (`.titlebar`, `.app.compact`) with `no-drag` on
interactive descendants. Both frameless windows use the same `.titlebar`, defined
once in `src/renderer/shared/tokens.css` along with the drag rules themselves. Never use a full-bleed `position: absolute; inset: 0`
drag overlay. To test clicks for real, use `webContents.sendInputEvent`.

**The overlay needs `backgroundThrottling: false`.** It is `focusable: false`, so
it never has focus, so Chromium would throttle its rAF to ~1fps forever.

**Full screen covers `display.bounds` rather than calling `setFullScreen`.** The
window is sized to the display and set topmost, which covers the taskbar too, and
the overlay sits in the higher `screen-saver` band so it still frames the player.

The original reason was that Electron cannot fullscreen a *transparent* window on
Windows — it fails silently, keeping its size while `isFullScreen()` reports
false. **That reason no longer applies to the player**, which is opaque now (see
below). The bounds approach is kept because it works and keeps the rim framing;
whether `setFullScreen` would now behave has not been tested.

**Re-asserting topmost requires cycling the flag.** Setting `alwaysOnTop` to the
value it already holds is a no-op, so `reassertTopmost()` sets false, then true,
then calls `moveTop()`. Without this the rim disappears behind anything else that
goes topmost.

**Closing the player quits the whole app.** It used to hide to tray and leave
the rim running, which read as the app refusing to shut down - the overlay stayed
lit and the settings panel stayed on screen with no window left to close them
from. Every exit now funnels through `shutdown()` in `index.ts`, which is
idempotent and wired to `before-quit` and `will-quit` as well, so a tray Quit, an
OS logoff and a window close all tear down the same way: settings flushed, helper
killed, all windows destroyed, tray icon removed. Destroy rather than close, so
nothing can veto it, and the overlay's 2s topmost interval dies with it.

The helper needs no special handling on a hard kill: `Program.cs` treats stdin
EOF as "Electron exited" and shuts itself down, which is verified behaviour, not
an assumption.

**Transparency cannot be changed on a live window.** Anything that alters overlay
geometry semantics (display, taskbar-safe) destroys and recreates it.

**The player window is deliberately NOT transparent; the overlay and panel are.**
The mini player is frosted glass over the desktop, and a transparent window cannot
do that: Electron documents that in a transparent window "the CSS `blur()` filter
will not affect applications behind the window", so `backdrop-filter` has no
backdrop to sample and the desktop shows through perfectly sharp. The frost comes
from `backgroundMaterial: 'acrylic'` instead, which DWM composites outside
Chromium; `applyPlayerMode` switches it on for compact and off otherwise. Setting
`transparent: true` here would silently kill the frost. Rounded corners survive
because DWM rounds the frameless window itself — verified by reading
`DWMWA_WINDOW_CORNER_PREFERENCE` back from the OS, not assumed.

**`backdrop-filter` only ever blurs the app's own painted content.** That is what
makes the button glass work — behind them sit the black field and the album halo.
It is also why the same technique can never work for anything over the desktop.

**Design tokens and window chrome live once, in `src/renderer/shared/tokens.css`.**
The player and panel stylesheets both import it. Before it existed they each
declared their own `:root` and disagreed (`--bg` was `#000` vs `#0c0c0e`), and the
drag rules were duplicated verbatim. One trap: `.slider` in the appearance panel
declares a local `--fill: 50%` for its gradient stop, which shadows the global
`--fill` colour token for that whole subtree. That is why the glass tokens are all
named `--glass-*`; a recipe built on `var(--fill)` would silently resolve to
`background: 50%` inside every slider.

**Full screen recentres by translating the stage, and the offset is measured.**
Fading the chrome does not reclaim its layout box, so what remains would sit
~110px high. `useRecenterOffset` in `player/App.tsx` measures the real rendered
heights: the offset is `(toolbarHeight + transportBlock) / 2`, where the block
includes the transport row's margin *and* the stage's flex `gap` — omitting the
gap leaves it a few px off at every window size. The move uses `translate` and
`scale` as *independent* CSS properties rather than one `transform`, which is what
lets the glide and the shrink run on different curves simultaneously.

**The Space hotkey must not steal native behaviour.** `usePlayPauseHotkey`
only calls `preventDefault()` once it has decided to handle the key. Preventing
default on Space unconditionally would stop a focused button from activating,
and handling it on a button would toggle twice - once natively, once via the
hook - which cancels out and looks like the shortcut is broken. Sliders are
deliberately *not* excluded, since Space does nothing to them natively.

**Some sources never advance the reported position.** Chrome publishes a
position only when a seek or track change moves it — it will report a frozen
`56ms` for an entire track it claims to be playing. A frozen report is worse
than none: an estimator that trusts it advances, gets contradicted, resyncs
backwards, and the bar saws visibly. `usePlaybackPosition` detects a source that
fails to advance and free-runs on its own clock until the source proves itself by
actually moving. Do not "fix" drift there by tightening the resync threshold —
that reintroduces the sawtooth.

**Position and duration must share a time frame.** `timeline.Position` is
absolute within the media and `StartTime` is not always zero, so the helper
rebases both, and `SeekAsync` adds `StartTime` back before calling the session.
Mixing the frames makes the progress ratio quietly wrong only for some sources.

**Settings changes are not echoed to their originator.** `broadcast()` takes an
`exceptId`; `patchSettings` passes `event.sender.id`. Prevents late echoes from
fighting a dragged control.

**Never rename the app with a blind substring replace.** The previous name
`Lumn` is a substring of `column`, and renaming to Radia silently turned six
`flex-direction: column` declarations into `flex-direction: coradia`, breaking
every flex layout in the player and the panel. The trap now runs the other way:
`radia` is a substring of `radial-gradient`, which the rim glow and the panel
both rely on. Rename by whole-word/identifier match, and grep the CSS afterwards.

## Rim shader notes (`src/renderer/overlay/rim.frag`)

Three things here look wrong but are deliberate:

- **Perimeter position comes from a centre-cast ray, not the nearest edge.**
  Nearest-edge arc lengths differ by a screen width along a corner diagonal, which
  renders as a hard seam out of every corner.
- **Depth uses a rounded-rect distance field, not `min()` over four edges.**
  `min()` is continuous but its gradient is not, giving a visible mitre line.
- **The gradient blend is inverse-distance (Shepard) weighted.** A falloff with
  finite reach leaves points opposite all centres with zero total weight, which
  forces an arbitrary fallback colour and shows up as a seam.

The spill must reach zero at a finite distance. An exponential tail never does,
and the residue tints the entire screen.

Renderer errors are forwarded to the main-process console (`forwardErrors` in
`windows.ts`) — without that, a shader that fails to compile just looks like the
feature silently not working.

## Known behaviour, not bugs

- Exclusive-fullscreen games (DirectX exclusive) cover the overlay. No Electron
  window can sit above them.
- Prev/next do nothing for sources like a YouTube tab, which report no next or
  previous track. Buttons stay enabled and no-op rather than being greyed out.
- Loopback capture hears everything, including notification sounds.
- Switching to a source that is not playing takes about 1.2s. Windows reorders
  the "current" session during playback-state transitions, so a track skip
  briefly promotes whatever else is loaded - a parked browser tab, usually - and
  adopting that immediately made the whole UI flicker over to it and back on
  every skip. `SwitchGrace` in `MediaSession.cs` makes a non-playing candidate
  prove it is still current before it is accepted. A source that is actually
  playing is still adopted instantly, so starting something never feels laggy.
- Album art is fetched by title/artist in `src/main/artwork.ts`: iTunes, then
  Deezer, then the Windows thumbnail as a fallback. Both providers are keyless
  and match on text, so they cover any player, not just one.
- **There was a Spotify Web API integration; it was removed deliberately.** The
  API returns HTTP 403 on every endpoint — `/v1/me` included — unless the app
  owner holds Spotify Premium, while OAuth itself succeeds. So it authenticated
  cleanly and then served nothing, which is a uniquely confusing failure. Even
  when it worked it only covered Spotify playback and capped at 640px, below
  what the keyless providers give for free. Do not reintroduce it without a
  reason that survives those three facts.
- Artwork is capped at 1000px on purpose. The cover is painted at most ~880
  device px (440 CSS px at 200% scaling), and iTunes' available 1400px roughly
  doubled the data-URL payload for pixels nothing can display.

## Other agent configs

A `~/.codex` directory exists on this machine. If you want its user-level items
(MCP servers, slash commands, subagents, skills, instructions) available in Claude
Code, reply `/import` to scan and list what's importable, then
`/import --yes=<digest>` with the digest from the scan output to apply them. If
`/import` is unavailable on this surface, run `claude import` from a terminal.
