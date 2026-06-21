#!/usr/bin/env node
/**
 * Generate `/studio/versions.json` from git release tags (`v*`).
 *
 * Releases are deployed by the Deploy workflow to a MINOR-versioned dir
 * (`/studio/vX.Y/`): patch releases overwrite the same minor dir rather than
 * creating a new `/studio/vX.Y.Z/` per patch. This manifest therefore lists
 * ONE entry per minor line — the newest patch of that line — so the in-app
 * VersionSwitcher can roll back to the latest build of any previous minor.
 *
 * Rollback granularity = minor line (e.g. v0.2 ⇄ v0.1), matching the policy
 * "凍結リリースは各マイナーバージョン単位、パッチまで追わない".
 *
 * Usage: node scripts/gen-versions-json.mjs <out-path>
 *   e.g. node scripts/gen-versions-json.mjs dist-versions/versions.json
 *
 * Note: a standalone build script (NOT a Workflow script), so Date/git here
 * are fine.
 */
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const out = process.argv[2] || 'versions.json'

// Deploy-root prefix the frozen version dirs live under. The VersionSwitcher
// navigates straight to these absolute paths, so they must match the host:
//   - studio.hapbeat.com (Cloudflare, new home): "/"        → /vX.Y/
//   - devtools.hapbeat.com/studio/ (legacy FTP): "/studio/" → /studio/vX.Y/
// Default keeps the legacy FTP pipeline (which doesn't set this) unchanged.
const basePrefix = process.env.STUDIO_VERSIONS_BASE || '/studio/'

function releaseTags() {
  try {
    const raw = execSync('git tag -l "v*" --sort=-v:refname', { encoding: 'utf8' })
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      // Any well-formed vX.Y.Z release tag (patches included now).
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  } catch {
    return []
  }
}

// Collapse tags to one entry per minor line, newest patch wins.
// `--sort=-v:refname` is descending, so the FIRST tag seen for a given
// minor is its newest patch.
//   tags [v0.2.1, v0.2.0, v0.1.0]
//     → [{ version: "0.2.1", path: "/studio/v0.2/" },
//        { version: "0.1.0", path: "/studio/v0.1/" }]
const seenMinor = new Set()
const versions = []
for (const tag of releaseTags()) {
  const version = tag.replace(/^v/, '')          // 0.2.1
  const minor = version.split('.').slice(0, 2).join('.') // 0.2
  if (seenMinor.has(minor)) continue             // keep only newest patch of this minor
  seenMinor.add(minor)
  versions.push({ version, path: `${basePrefix}v${minor}/` })
}
const latest = versions[0]?.version ?? null

const payload = { latest, versions, generated: new Date().toISOString() }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
console.log(`[versions] wrote ${out}: latest=${latest}, ${versions.length} minor line(s)`)
