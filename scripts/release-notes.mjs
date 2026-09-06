/**
 * Prints the CHANGELOG section for one version, for the release workflow:
 *
 *   node scripts/release-notes.mjs v0.2.0 > notes.md
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const section = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog)

if (!section || !section[1].trim()) {
  console.error(`release-notes: CHANGELOG.md has no entry for ${version}`)
  process.exit(1)
}
process.stdout.write(section[1].trim() + '\n')
