# Changelog

All notable changes to Radia are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Add entries under **Unreleased** as you go. `npm run release` moves them under
the new version, and the release workflow uses that section as the GitHub
release notes.

## [Unreleased]

## [0.2.0] - 2026-09-06

### Added
- Speed slider in the Appearance panel, scaling how fast Sync and Snake move.
- Automatic updates: Radia checks GitHub Releases in the background and offers
  "Restart to update" in the player and the tray menu.

### Changed
- Beats are tempo-locked. The helper snaps onsets to a beat grid, ignores
  off-beat hits once locked, and fills in softly when a beat is missed, so the
  rim moves regularly instead of jittering.
- Snake glides at a tempo-scaled pace, surges on each beat, and coasts to a
  stop in silence. Its ripple travels with its body.
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
