# Changelog

All notable changes to Radia are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Add entries under **Unreleased** as you go. `npm run release` moves them under
the new version, and the release workflow uses that section as the GitHub
release notes.

## [Unreleased]

## [0.2.2] - 2026-09-06

### Changed
- New app icon colours: the rim sweeps from violet to cyan instead of magenta
  to yellow, which held up poorly on light wallpapers.

### Fixed
- The taskbar, Start menu and desktop shortcut showed Electron's default icon
  instead of Radia's. The icon is now stamped into the executable, and the app
  identifies itself to Windows so its window groups under the pinned shortcut.

## [0.2.1] - 2026-09-06

### Changed
- README states plainly that the installer is unsigned and that SmartScreen
  will warn on first run, and gains a Privacy section listing every network
  request Radia makes (cover art lookups and update checks, nothing else).

### Internal
- Code signing through SignPath was dropped before it shipped; the release
  workflow is a single build-and-publish job again.
- `npm run release` bumps the version itself instead of calling npm, and
  ignores untracked files when checking for a clean tree.

## [0.2.0] - 2026-09-06

### Added
- Animation picker on the player's Design button: hover it to switch between
  Sync, Snake and Static without opening the settings panel.
- Speed slider in the Appearance panel, scaling how fast Sync and Snake move.
- Automatic updates: Radia checks GitHub Releases in the background and offers
  "Restart to update" in the player and the tray menu.

### Changed
- Beats are tempo-locked. The helper snaps onsets to a beat grid, ignores
  off-beat hits once locked, and fills in softly when a beat is missed, so the
  rim moves regularly instead of jittering.
- Snake glides at a tempo-scaled pace, surges on each beat, and coasts to a
  stop in silence. Its ripple travels with its body, and it now covers three
  quarters of the rim instead of half.
- Waves are more distinct: troughs sit at the bare rim and crests are narrower
  and taller.

### Fixed
- The Design button sat slightly further from its neighbours than the other
  toolbar buttons.

## [0.1.0] - 2026-08-23

### Added
- First release: album-coloured rim lighting with Sync, Snake and Static
  animations, a now-playing window with full-screen and compact modes, and an
  appearance panel.
