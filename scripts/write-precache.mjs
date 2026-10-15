/**
 * List every file of this build in `dist/precache.json` for the Windows app
 * (hapbeat-studio-desktop, DEC-094). The app keeps one complete copy of the
 * latest Studio so it still opens without a network: after an online launch it
 * reads this list, downloads the files of a build it does not have yet, and
 * serves that copy when studio.hapbeat.com cannot be reached. The installer
 * ships the copy current at its build.
 *
 * `id` is a hash over the file list, so it changes only when a file changes.
 * Left out: source maps (not needed to run) and firmware/ (CI puts every
 * firmware binary there before the build, 100 MB and more). Frozen /vX.Y/
 * versions and versions.json are added to the deploy after this build. So
 * offline the app has no firmware list and no version switcher.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const distDir = process.argv[2] ?? 'dist'
const OUTPUT = 'precache.json'

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  }))
  return files.flat()
}

const files = []
for (const full of (await walk(distDir)).sort()) {
  const path = relative(distDir, full).split(sep).join('/')
  if (path === OUTPUT || path.endsWith('.map') || path.startsWith('firmware/')) continue
  const data = await readFile(full)
  files.push({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}

const id = createHash('sha256')
  .update(files.map((f) => `${f.path}\n${f.sha256}`).join('\n'))
  .digest('hex')
  .slice(0, 16)
const total = files.reduce((sum, f) => sum + f.size, 0)
await writeFile(
  join(distDir, OUTPUT),
  `${JSON.stringify({ schema: 1, id, builtAt: new Date().toISOString(), files }, null, 1)}\n`,
)
console.log(`[precache] ${files.length} files, ${(total / 1e6).toFixed(1)} MB, id ${id}`)
