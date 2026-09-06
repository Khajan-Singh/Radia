# Radia

Ambient rim lighting for Windows that follows your music.

Radia draws a soft band of light around the edges of your display, colored from
the album art of whatever is playing and moving with the audio. It works with
any player Windows knows about (Spotify, a browser tab, a local file) and ships
with a small now-playing window and a settings panel.

## Features

- **Album-colored rim:** the palette is extracted from the current cover and
  crossfades when the track changes. Or pick up to three colors yourself.
- **Three animations:** *Sync* (a wave on the rim that swells on beats),
  *Snake* (a lit segment that crawls at tempo), and *Static*.
- **Works with anything:** uses the Windows media session for track info and
  system audio loopback for the beat, so no player integration or account is needed.
- **High-res covers:** the small thumbnail Windows provides is swapped for
  the real artwork, matched by title/artist/album.
- **Now-playing window:** a regular window, a full-screen view, or a compact
  frosted card that stays on top. Play/pause, skip and seek from it; Space
  toggles playback.
- **Display choice and taskbar-safe mode** for multi-monitor setups.

## Install

Download `Radia-<version>-setup.exe` from the
[latest release](../../releases/latest) and run it. Windows 10 or 11 (the
frosted compact card needs Windows 11 22H2 or newer; everything else works
without it).

Installers are code-signed through [SignPath Foundation](https://signpath.org)
(see [Code signing policy](#code-signing-policy)). SmartScreen may still warn
while a certificate is new; choose **More info → Run anyway**.

Radia lives in the tray. Closing the player window quits the app.

Radia keeps itself up to date: it checks GitHub Releases shortly after launch
and every few hours, downloads a new version in the background, and offers
**Restart to update** in the player and the tray menu. If you ignore it, the
update installs the next time Radia quits.

## Good to know

- Exclusive-fullscreen games cover the rim; nothing can draw above them.
- Prev/next do nothing for sources that don't report a queue (e.g. a YouTube tab).
- Audio is captured by loopback, so notification sounds move the rim too.
- If no cover confidently matches the track, the Windows thumbnail is kept.

## Building from source

Requirements: Node 22, the .NET 9 SDK, Windows.

```bash
npm ci
npm run build:bridge   # C# helper -> resources/bridge
npm run dev            # run in development
npm run package        # NSIS installer -> dist/
```

Radia is an Electron app (React renderers, a WebGL rim overlay) plus a small
self-contained C# helper, `RadiaBridge.exe`, which owns the two things Node
can't reach on Windows: the WinRT media session and WASAPI loopback capture.
Electron spawns it and talks to it over stdio.

See `CLAUDE.md` for the architecture, the probe scripts and the project's
hard-won constraints.

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

Release installers are built by the [Release workflow](.github/workflows/release.yml)
on GitHub-hosted runners from a tagged commit of this repository, and signed
from that workflow's artifacts. No binary is signed that was not built there.

**Team**

- Author, Reviewer and Approver: Khajan Singh ([@Khajan-Singh](https://github.com/Khajan-Singh))

Contributions from anyone else are reviewed by a Reviewer before merging, and
every signing request is approved by an Approver.

**Privacy**

Radia makes exactly these network requests, and no others: it sends the
current track's title, artist and album to the iTunes Search API and to Deezer
to find higher-resolution cover art, and it contacts GitHub Releases to check
for updates. It collects no telemetry, needs no account, and stores nothing
outside your own user profile.

## License

[MIT](LICENSE)
