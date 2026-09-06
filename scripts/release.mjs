/**
 * Cuts a release from a clean checkout of main:
 *
 *   npm run release            # patch
 *   npm run release -- minor   # or major
 *
 * Moves the CHANGELOG's Unreleased section under the new version, bumps
 * package.json / package-lock.json, commits, tags `vX.Y.Z` and pushes both.
 * The tag push triggers .github/workflows/release.yml, which builds, signs
 * (when SignPath secrets are configured) and publishes the GitHub release.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelogPath = join(root, 'CHANGELOG.md')

const bump = process.argv[2] ?? 'patch'
if (!['major', 'minor', 'patch'].includes(bump)) fail(`usage: npm run release [-- major|minor|patch] (got "${bump}")`)

const git = (...args) =>
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()

/**
 * Bumps the version in package.json and package-lock.json in place. Not
 * `npm version`: on Windows npm is a .cmd shim that Node 24 refuses to spawn
 * without a shell, and a shell is exactly what this script avoids.
 */
function bumpVersion(kind) {
  const pkgPath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  const next =
    kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
  const setVersion = (path, edit) => {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    edit(json)
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  }
  setVersion(pkgPath, (json) => { json.version = next })
  setVersion(lockPath, (json) => {
    json.version = next
    if (json.packages?.['']) json.packages[''].version = next
  })
  return next
}

if (git('status', '--porcelain', '--untracked-files=no')) fail('working tree has uncommitted changes')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('release from main')
git('fetch', 'origin', 'main')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('main is behind origin; pull first')

const changelog = readFileSync(changelogPath, 'utf8')
const unreleased = /^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(changelog)
if (!unreleased) fail('CHANGELOG.md has no "## [Unreleased]" section')
if (!unreleased[1].trim()) fail('the Unreleased section is empty; write the notes first')

const version = bumpVersion(bump)
const date = new Date().toISOString().slice(0, 10)
const rolled = changelog.replace(
  /^## \[Unreleased\]\s*\n/m,
  `## [Unreleased]\n\n## [${version}] - ${date}\n\n`
)
writeFileSync(changelogPath, rolled)

git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md')
git('commit', '-q', '-m', `Release v${version}`)
git('tag', `v${version}`)
git('push', '-q', 'origin', 'main')
git('push', '-q', 'origin', `v${version}`)

console.log(`released v${version}; the Release workflow is building it: ${git('remote', 'get-url', 'origin').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')}/actions`)

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}
