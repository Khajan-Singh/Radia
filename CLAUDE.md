# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Radia: ambient rim lighting on the edges of a Windows display, colored from the
current track's album art and animated by system audio. Windows-only by design —
it depends on WinRT's media session (now playing) and WASAPI loopback (audio).

## Commands

```bash
npm run dev            # electron-vite dev server + Electron
npm run typecheck      # tsc --noEmit — the only static check; there is no linter
npm run build          # main/preload/renderers -> out/
npm run build:bridge   # dotnet publish the C# helper -> resources/bridge/RadiaBridge.exe
npm run package        # build + build:bridge + electron-builder NSIS installer -> dist/
```

The .NET 9 SDK lives at `C:\Program Files\dotnet` but is not on `PATH` in a fresh
shell: `$env:Path = "C:\Program Files\dotnet;$env:Path"` first. A running
`RadiaBridge.exe` locks the published exe, so kill it before `build:bridge`.

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which packages
on `windows-latest` and attaches `dist/Radia-*-setup.exe` to a GitHub release.
Exe signing is disabled (`signAndEditExecutable: false`).

There are no automated tests. This is a real-time, visual project; verification is
running the app and the probe scripts below.

### Restarting during development

`electron-vite dev` hot-reloads renderers but does not reliably restart the main
process. Edits under `src/main`, `src/preload` or `native/` need a restart, and a
stale instance holds the single-instance lock so a new one exits silently:

```powershell
powershell -File scripts/restart-dev.ps1 [logPath]   # kills electron + RadiaBridge, relaunches, logs to dev.log
```

### Probe scripts (isolate one layer)

```bash
node scripts/probe-bridge.mjs 12            # run the helper like Electron does: frame rate, bands, onsets, BPM, track
node scripts/probe-sessions.mjs 30          # every media-session switch / art publish, timestamped (kill the app first)
node scripts/probe-transport.mjs seek 30000 # send one command to the helper, report whether the session reacted
node scripts/probe-artwork.mjs "<title>" "<artist>" ["<album>"]   # ranked cover candidates + winner, via the real match.ts
npx electron scripts/preview-rim.mjs out.png [mode thickness colors phase amp head intensity]  # render rim.frag offscreen
npx electron scripts/preview-player.mjs out.png window|fullscreen|compact|appearance [art scroll hoverSels clickSel]  # render a renderer to PNG (hoverSels e.g. .design,.titlebar)
npx electron scripts/probe-layers.mjs - compact   # which compositor layers repaint, and on what
node scripts/make-icons.mjs                 # regenerate resources/tray.png and icon.png (no binary assets are hand-made)
```

Use `preview-player.mjs` rather than screenshotting the desktop — a capture grabs
whatever the user has open. Its one blind spot is DWM acrylic (composited outside
Chromium), so the compact card's frost must be judged on screen.
`preview-rim.mjs` imports `src/renderer/overlay/geometry.mjs`, the same module the
overlay uses, so it cannot render a geometry the app never shows.

## Architecture

One Electron process, three window types, one child process.

```
Electron main ──spawn──> RadiaBridge.exe (C# / .NET 9, self-contained, native/RadiaBridge)
     │                     MediaSession.cs  WinRT media session -> track / artwork
     │   <──NDJSON stdio── AudioCapture.cs  WASAPI loopback + Analysis.cs FFT/onsets -> audio frames
     │   ──commands──>     playpause / next / prev / seek ; window-border toggle (WindowBorder.cs)
     │
     ├── overlay     transparent, click-through, topmost — the rim (WebGL2, overlay/main.ts + rim.frag)
     ├── player      now-playing: window | fullscreen | compact (React, player/App.tsx)
     └── appearance  the settings panel (React, appearance/App.tsx)
```

- `src/shared/types.ts` is the contract for everything crossing a process
  boundary: `Settings`, `Track`, `Artwork`, `AudioFrame`, `Palette`, the `CH`
  IPC channel names, `InitialState`. Start there.
- `src/main/index.ts` holds the live state (settings, track, artwork, palette,
  bridge status), wires the helper via `bridge.ts` (spawn + exponential-backoff
  restart), and owns the tray and the single `shutdown()` path.
- `src/main/windows.ts` creates/places the three windows, pins them topmost, and
  `broadcast()`s state to renderers. Audio frames are the hot path and go only
  to visible windows, not through the general broadcast.
- `src/main/artwork.ts` + `match.ts`: replace the small Windows thumbnail with a
  high-res cover from iTunes then Deezer (keyless, text-matched, pooled and
  scored). `palette.ts`: k-means in Lab over the cover -> rim colors.
- `src/main/settings.ts`: `settings.json` in userData; `reconcile()` migrates by
  deep-merging over `DEFAULT_SETTINGS` and sniffing values, not by version number.
- `src/preload/index.ts` exposes `window.radia`; renderers mirror main's state
  with `useRadia()` and never talk to the helper directly.
- `src/renderer/shared/` holds everything both React windows use: `tokens.css`
  (design tokens + the `.titlebar` drag rules, declared once), `SeekBar`,
  `ColorWheel`, `Icons`, `usePlaybackPosition`, `usePlayPauseHotkey`. Vite alias
  `@shared` -> `src/renderer/shared`.
- `src/renderer/overlay/geometry.mjs` is plain ESM on purpose (the preview
  harness runs unbundled); its types are in `geometry.d.mts`.

## Constraints that are easy to break

Each of these has been a real bug. The source comments explain them in depth;
this is the short list.

**Helper (C#)**
- All WinRT session calls run on one dedicated MTA thread (`SessionWorker.cs`).
  Touching a session object from any other thread fails with
  `RPC_E_WRONG_THREAD` *permanently*. A single `await` inside session code is
  enough to poison it — post to the worker instead.
- stdout is the protocol channel; nothing else may print to it. stdin EOF means
  Electron exited and the helper shuts itself down.
- Position and duration are rebased so 0 is the start of the media
  (`StartTime` is not always zero); seeks add it back.
- `SwitchGrace` in `MediaSession.cs` makes a *non-playing* candidate session
  prove itself before adoption (~1.2s), because Windows briefly promotes parked
  sessions on every track skip. A playing source is still adopted instantly.
- Beat detection is self-tuning (median + k·MAD spectral flux, tempo-derived
  refractory) and has no settings. `onset` is raw evidence; the rim moves on
  `beat`, which a phase-locked loop in `Analysis.cs` snaps to the tempo grid,
  ignores when off-grid once locked, and fills in softly when an expected
  onset never arrives. Frames arrive at ~43–47Hz in bursts.

**Windows / Electron**
- The overlay needs `backgroundThrottling: false`: it is `focusable: false`, so
  Chromium would otherwise throttle its rAF to ~1fps.
- Transparency cannot change on a live window; anything altering overlay
  geometry semantics (display, taskbar-safe) destroys and recreates it.
- Topmost: windows are pinned at the `screen-saver` level (the `floating` level
  loses `WS_EX_TOPMOST` behind a maximised window and never gets it back) and
  re-asserted on a heartbeat by cycling the flag false -> true -> `moveTop()`,
  since setting `alwaysOnTop` to its current value is a no-op.
- Full screen covers `display.bounds` and sets topmost rather than calling
  `setFullScreen`; the overlay sits in a higher band so it still frames the player.
- The player window is **not** transparent. The compact card's frost is
  `backgroundMaterial: 'acrylic'` (DWM, outside Chromium); a transparent window
  has no backdrop for `backdrop-filter` to sample. `setBackgroundMaterial` is
  guarded because it throws before Windows 11 22H2.
- Mode changes are two-phase: `applyPlayerMode` prepares the hidden window,
  the renderer sends `CH.playerModeReady` once painted, `onPlayerModeReady`
  reveals it (with a fallback timer). Over acrylic, every raster tile is a
  visible lighter box, so the compact card must not repaint at rest: no
  `filter` layers, glow written directly from the rAF loop, progress bar as a
  whole-pixel `translateX` on its own layer. `probe-layers.mjs` is the pass bar.
- Closing the player quits the app. Every exit funnels through the idempotent
  `shutdown()` in `index.ts` (also wired to `before-quit`/`will-quit`): flush
  settings, kill helper, destroy windows, remove tray.
- `-webkit-app-region: drag` is an OS hit test; it swallows clicks regardless of
  DOM stacking and `elementFromPoint` does not model it. Drag lives on
  `.titlebar` / `.app.compact` with `no-drag` on interactive descendants. Never
  add a full-bleed drag overlay. Test clicks with `webContents.sendInputEvent`.
- `broadcast()` takes an `exceptId`; `patchSettings` passes the sender so a
  dragged slider is not fought by late echoes.

**Renderers**
- The Snake glides at a tempo-scaled pace and coasts to a stop in silence;
  beats surge on top through the cascaded `releaseSurge`. Never move it by a
  step on the beat frame - that is the stop-and-go it replaced.
- `usePlaybackPosition` keeps its own clock and only *corrects* toward reports;
  a source that never advances (Chrome reports a frozen position) is ignored
  until it really moves. Do not tighten the resync threshold — that brings back
  the sawtooth.
- `usePlayPauseHotkey` calls `preventDefault()` only after deciding to handle
  Space; doing it unconditionally breaks focused buttons and double-toggles.
- Full screen recentres by translating the stage; `useRecenterOffset` measures
  real heights (toolbar + transport block incl. margin and flex gap).
- `.slider` in the appearance panel declares a local `--fill: 50%` that shadows
  the global `--fill` token in that subtree; glass tokens are `--glass-*` for
  that reason.
- Never rename with a blind substring replace: `radia` is a substring of
  `radial-gradient` (and the old name `Lumn` was inside `column`).

**Rim shader (`rim.frag`)** — these look wrong but are deliberate:
- Perimeter position comes from a centre-cast ray, not nearest edge (seam at corners).
- Depth is a rounded-rect distance field, not `min()` over edges (mitre line).
- Gradient blend is inverse-distance (Shepard) weighted, so no zero-weight dead zone.
- Every multiplier on a wrapping coordinate (`along`, `uWavePhase`) is an integer;
  phases are wrapped to `[0,1)` every frame, not accumulated.
- Beats change brightness and thickness, never hue. Corner radius and halo are
  derived from thickness in `geometry.mjs`; there is no glow setting.
- `swell()` troughs sit at the bare core and `STATIC_SWELL` is its mean at the
  resting amplitude; change one and re-derive the other or Static and Sync
  stop matching. The snake's ripple is in body coordinates (`swell(u)`).
- The spill must reach zero at finite distance or it tints the whole screen.

## Known behaviour, not bugs

- Exclusive-fullscreen (DirectX) games cover the overlay; nothing can sit above them.
- Prev/next no-op for sources that report no neighbours (e.g. a YouTube tab).
- Loopback capture hears everything, including notification sounds.
- When no artwork candidate agrees with the reported album, the Windows
  thumbnail is kept — often the correct answer. Artwork is capped at 1000px.
- A Spotify Web API provider was removed on purpose: it 403s for non-Premium
  owners after a successful OAuth, covered only Spotify, and capped at 640px.
  Do not reintroduce it without a reason that survives those facts.
