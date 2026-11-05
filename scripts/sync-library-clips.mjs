#!/usr/bin/env node
/**
 * sync-library-clips.mjs
 *
 * Copies the template clips listed in scripts/library-clips.json from the SDK and
 * demo repos into public/library/clips/. Only listed clips are copied: adding a
 * clip means checking where it came from first (public/library/SOURCES.md).
 *
 * Usage:
 *   node scripts/sync-library-clips.mjs --workspace <hapbeat-sdk-workspace>
 *
 * Then, as usual:
 *   npm run strip:wav-meta
 *   npm run gen:library
 */

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIPS_DIR = join(here, '..', 'public', 'library', 'clips')

const args = process.argv.slice(2)
const workspaceAt = args.indexOf('--workspace')
const workspace = workspaceAt >= 0 ? args[workspaceAt + 1] : undefined
if (!workspace) {
  console.error('Usage: node scripts/sync-library-clips.mjs --workspace <hapbeat-sdk-workspace>')
  process.exit(2)
}

const list = JSON.parse(await readFile(join(here, 'library-clips.json'), 'utf-8'))

// Check every source first, so a missing clip leaves the library as it was.
const copies = []
const missing = []
for (const [folder, { from, clips }] of Object.entries(list)) {
  for (const clip of clips) {
    const source = join(workspace, from, `${clip}.wav`)
    const found = await stat(source).catch(() => null)
    if (!found) missing.push(source)
    copies.push({ source, target: join(CLIPS_DIR, folder, `${basename(clip)}.wav`) })
  }
}
if (missing.length > 0) {
  console.error(`Not found, nothing copied:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

for (const { source, target } of copies) {
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}
console.log(`Copied ${copies.length} clips into ${Object.keys(list).length} folders`)
