# Radia for Windows

Ambient rim lighting that follows your music. The edges of your display glow with
colors pulled from the current album art, and the motion follows the beat of
whatever is actually coming out of your speakers.

A Windows rebuild of the macOS app [Lumn](https://www.trylumn.xyz/).

## What it does

- **Rim lighting** — a transparent, click-through, always-on-top glow hugging the
  edges of a chosen monitor. Thickness, spill, gradient and animation are all
  adjustable, and it never intercepts a click.
- **Color from album art** — k-means clustering in CIE Lab, weighted toward
  saturated colors so the rim picks up an album's accent rather than its
  background. Crossfades between tracks.
- **Motion from audio** — WASAPI loopback capture, FFT, band energies and
  spectral-flux onset detection. Beat pulses travel around the perimeter.
- **Now-playing player** — three presentations, switchable from the toolbar or
  the tray: a **window**, **full screen** (fills the display over the taskbar,
  chrome fading away once the pointer rests, Esc to leave), and a **compact**
  floating card, frosted over the desktop with Windows 11 acrylic. Transport
  controls run through the Windows media session, so they drive Spotify, a
  browser tab, or anything else that's playing. **Space** toggles playback from
  anywhere in the app, except where it already means something — a focused
  button, a dropdown, a text field.
- **Closing means closing** — shutting the player window stops everything: the
  rim, the settings panel, the tray icon and the background helper. The tray menu
  is for switching presentation and toggling the rim while it runs, not a place
  the app hides itself.

## Requirements

- Windows 10 1809+ / Windows 11
- [Node.js](https://nodejs.org/) 20+
- [.NET SDK 9](https://dotnet.microsoft.com/download) — only needed to build the
  sensor helper (`winget install Microsoft.DotNet.SDK.9`)

## Running it

```bash
npm install
npm run build:bridge     # compiles the C# helper into resources/bridge
npm run dev
```

`npm run package` produces an NSIS installer in `dist/`.

## How it fits together

One Electron process owns three window types plus one child process:

| Piece | Role |
| --- | --- |
| `src/main` | Lifecycle, tray, settings, palette extraction, artwork lookup, display management |
| `src/renderer/overlay` | The rim itself — one WebGL2 fragment shader |
| `src/renderer/player` | Now-playing view: window, full screen, compact |
| `src/renderer/appearance` | The control panel |
| `native/RadiaBridge` | C# helper: media session + loopback audio |

Node can't reach WinRT's media session or WASAPI loopback, so those live in a
small .NET helper that streams newline-delimited JSON over stdio. Isolating it
also means an audio-driver crash takes down the helper, not the app — the main
process restarts it with backoff.

The rim is drawn by parameterising the screen perimeter: every pixel gets a
distance to the nearest edge and a position along the perimeter, and the two
agree at every corner, so the gradient wraps without a seam.

## Debugging

Run the helper on its own to see the raw sensor stream — the fastest way to tell
whether a problem is in capture or in the UI:

```bash
node scripts/probe-bridge.mjs 12
```

```
over 12.0s:
  audio frames : 502  (41.8/s)
  onsets       : 20  (100/min)
  peak bass    : 0.429
  bpm estimate : 115.1
  track        : Instant Crush - Daft Punk [Spotify] playing
```

## Album art

Windows only publishes a small media-session thumbnail (measured at 150x150),
which the player would otherwise upscale 2-3x. Radia looks the track up by title
and artist and fetches the real cover at 1000px instead.

Sources are tried in order, in `src/main/artwork.ts`:

1. **iTunes Search API** — no key, no account, serves up to 1400px.
2. **Deezer** — same idea, 1000px, better on non-English catalogues.

Both are keyless public endpoints, so there is nothing to configure, and because
they match on text they work for any player — Spotify, a browser tab, a local
file. If neither has a match the Windows thumbnail is kept.

Covers are cached per song, and the lookup is retried briefly on a miss so a
transient network failure does not leave one track blurry for its whole duration.

## Known limits

- **Exclusive-fullscreen games** (DirectX exclusive mode) will cover the overlay.
  No Electron window can sit above them; this is a platform limit.
- **Loopback hears everything**, not just music — a notification chime will pulse
  the rim.
- **Media session thumbnails** are modest resolution and occasionally missing.
  Radia works around this by fetching the real cover by title and artist; a track
  neither iTunes nor Deezer can match keeps the small thumbnail.
- **Prev/next do nothing for some sources.** A YouTube tab reports no next or
  previous track; the buttons stay enabled and simply no-op there.
- **Full screen is not `setFullScreen`.** The player is sized to the display and
  set topmost instead. Same result, taskbar included, and it keeps the rim
  framing the player.
