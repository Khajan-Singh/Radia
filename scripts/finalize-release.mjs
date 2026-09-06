/**
 * Re-derives the auto-update metadata after the installer has been signed.
 *
 * electron-builder writes dist/latest.yml (with the installer's sha512 and
 * size) and the .blockmap for differential downloads while it packages.
 * Code signing then appends a signature to the installer, so both describe a
 * file that no longer exists and electron-updater would reject the download.
 * Run this after the signed installer has been copied back over dist/.
 *
 *   node scripts/finalize-release.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const installer = readdirSync(dist).find((f) => /^Radia-.*-setup\.exe$/.test(f))
if (!installer) {
  console.error('finalize-release: no Radia-*-setup.exe in dist/')
  process.exit(1)
}
const exe = join(dist, installer)
const sha512 = createHash('sha512').update(readFileSync(exe)).digest('base64')
const size = statSync(exe).size

const ymlPath = join(dist, 'latest.yml')
const yml = readFileSync(ymlPath, 'utf8')
  .replace(/^(\s*-?\s*sha512:\s*).*$/gm, `$1${sha512}`)
  .replace(/^(\s*size:\s*).*$/gm, `$1${size}`)
writeFileSync(ymlPath, yml)

// Same tool electron-builder uses, so the format matches what the updater expects.
const appBuilder = join(root, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')
execFileSync(appBuilder, ['blockmap', '--input', exe, '--output', `${exe}.blockmap`, '--compression', 'gzip'], {
  stdio: ['ignore', 'ignore', 'inherit']
})

console.log(`finalize-release: ${installer} ${size} bytes, latest.yml and blockmap refreshed`)
