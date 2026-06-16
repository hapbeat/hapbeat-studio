#!/usr/bin/env node
/**
 * Generate `/studio/versions.json` from git release tags (`v*`).
 *
 * Each release is deployed (immutably) to `/studio/<tag>/` by the Deploy
 * workflow. This manifest lists every release so the in-app VersionSwitcher
 * can offer rollback to a known-good frozen build.
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

function releaseTags() {
  try {
    const raw = execSync('git tag -l "v*" --sort=-v:refname', { encoding: 'utf8' })
    return raw.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// tag `v0.2.0` → { version: "0.2.0", path: "/studio/v0.2.0/" }
const versions = releaseTags().map((tag) => ({
  version: tag.replace(/^v/, ''),
  path: `/studio/${tag}/`,
}))
const latest = versions[0]?.version ?? null

const payload = { latest, versions, generated: new Date().toISOString() }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
console.log(`[versions] wrote ${out}: latest=${latest}, ${versions.length} version(s)`)
