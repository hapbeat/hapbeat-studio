#!/usr/bin/env node
/**
 * Aggregate firmware artifacts from multiple firmware repos — and multiple
 * releases per repo — into a single v2 manifest for Studio
 * (contracts: firmware-distribution.md, DEC-034).
 *
 * Usage:
 *   node scripts/aggregate-firmware-manifest.mjs <stagingDir> <outDir>
 *
 * Layout expected under <stagingDir> (one subdir per firmware repo):
 *   <stagingDir>/<repo-name>/<tag>/        ← one subdir per GitHub Release
 *       manifest.fragment.json | manifest.json
 *       <env>_firmware_app_ota.bin
 *       <env>_firmware_full_serial.bin
 *   — or, flat (single version; dev / manual use):
 *   <stagingDir>/<repo-name>/
 *       manifest.fragment.json | manifest.json + bins
 *
 * Output:
 *   <outDir>/manifest.json    (schema_version 2, variants with `versions[]`
 *                              newest-first; top-level artifact fields = latest)
 *   <outDir>/<repoShort>_<env>_<fwVersion>_<stem>.bin
 *
 * Old releases are kept as archive entries so Studio users can roll back
 * (e.g. re-flash v0.1.3 after updating to v0.1.4).
 */
import { promises as fs } from 'fs'
import { join } from 'path'

const REPO_SHORT = {
  'hapbeat-device-firmware': 'dev',
  'hapbeat-transmitter-firmware': 'tx',
}

function repoShortFor(repoName) {
  if (REPO_SHORT[repoName]) return REPO_SHORT[repoName]
  const cleaned = repoName.replace(/^hapbeat-/, '').replace(/[^a-z0-9]+/gi, '').slice(0, 6)
  return cleaned || 'fw'
}

/** Mirror of firmwareLibrary.inferVariantFromEnv (keep in sync). */
function inferVariantFromEnv(env) {
  const e = env.toLowerCase()
  let role = 'receiver'
  let transport = 'udp'
  if (/broker/.test(e)) { role = 'broker'; transport = 'mqtt' }
  else if (/sensor/.test(e)) { role = 'sensor'; transport = 'mqtt' }
  else if (/(transmitter|sender|audio.*(tx|stream)|_tx\b)/.test(e)) { role = 'transmitter'; transport = 'espnow_stream' }
  else if (/stream/.test(e) && /espnow/.test(e)) { role = 'receiver'; transport = 'espnow_stream' }
  else if (/mqtt/.test(e)) { role = 'receiver'; transport = 'mqtt' }
  let board
  const m = e.match(/(necklace|duo|band)[_-]?(v\d+)/)
  if (m) {
    const family = m[1] === 'necklace' || m[1] === 'duo' ? 'duo' : 'band'
    board = `${family}_wl_${m[2]}`
  }
  return { role, transport, board }
}

/**
 * Compare two version strings ("0.1.10" / "v0.1.3d2") — newest first.
 *
 * Strips "v" prefix before comparing.  "dN" dev-counter suffix means the
 * version is a dev build BETWEEN two releases: "0.2.0d5" is a dev snapshot
 * taken 5 commits after the v0.2.0 tag, therefore it sorts AFTER "0.2.0"
 * (i.e. older in the archive picker) when normalised.  In practice only
 * tagged releases are pushed to GitHub Releases so dN should never appear
 * in the production manifest — but dev-mode (local dist/) can have them.
 */
function compareVersionsDesc(a, b) {
  // Normalize: strip "v" prefix and separate dN suffix as a minor tie-breaker.
  const normalize = (s) => String(s ?? '').replace(/^v/, '')
  const parseSemver = (s) => normalize(s).replace(/d\d+$/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const devCounter = (s) => { const m = normalize(s).match(/d(\d+)$/) ; return m ? parseInt(m[1], 10) : -1 }
  const pa = parseSemver(a), pb = parseSemver(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  // Same semver base: release (dN=-1) sorts BEFORE (newer than) a dev build (dN≥0)
  return devCounter(a) - devCounter(b)
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function copyBin(srcDir, srcName, outDir, outName) {
  const src = join(srcDir, srcName)
  if (!(await exists(src))) return null
  const dst = join(outDir, outName)
  await fs.copyFile(src, dst)
  const st = await fs.stat(dst)
  return { filename: outName, size: st.size, mtime: Math.round(st.mtimeMs) }
}

async function resolveV1Bin(srcDir, env, kind) {
  const candidates = kind === 'firmware_full_serial'
    ? [`${env}_firmware_full_serial.bin`, `${env}_firmware.bin`]
    : [`${env}_firmware_app_ota.bin`]
  for (const c of candidates) {
    if (await exists(join(srcDir, c))) return c
  }
  return null
}

/** Sanitize a version string for use inside a filename. */
function versionSlug(v) {
  return String(v ?? 'unknown').replace(/^v/, '').replace(/[^a-zA-Z0-9.\-]+/g, '-')
}

/**
 * Canonical fwVersion = strip a leading "v" only (keep any "dN" dev suffix).
 * Older firmware baked "v0.1.0" into FIRMWARE_VERSION before the prefix was
 * dropped; storing it verbatim makes Studio render "vv0.1.0" (it prepends a
 * "v"). The manifest is the boundary where we canonicalize: no leading "v".
 */
function canonicalFwVersion(v) {
  return String(v ?? 'unknown').replace(/^v/, '')
}

/** Read release-meta.json (written by the deploy workflow per tag) and return
 *  the release publish time as epoch ms, or undefined. */
async function readPublishedAt(srcDir) {
  const p = join(srcDir, 'release-meta.json')
  if (!(await exists(p))) return undefined
  try {
    const meta = JSON.parse(await fs.readFile(p, 'utf-8'))
    const ms = Date.parse(meta.publishedAt ?? '')
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one release dir (a manifest + bins) and return its variant rows:
 * [{ id, repo, env, role, transport, transports?, board?, label, description?,
 *    fwVersion, tag?, appOtaSrc?, fullSerialSrc? }]
 */
async function readReleaseDir(repoName, repoShort, srcDir, tag) {
  let manifest = null
  if (await exists(join(srcDir, 'manifest.fragment.json'))) {
    manifest = JSON.parse(await fs.readFile(join(srcDir, 'manifest.fragment.json'), 'utf-8'))
  } else if (await exists(join(srcDir, 'manifest.json'))) {
    manifest = JSON.parse(await fs.readFile(join(srcDir, 'manifest.json'), 'utf-8'))
  } else {
    return []
  }

  const publishedAt = await readPublishedAt(srcDir)

  const rows = []
  if (Array.isArray(manifest.variants)) {
    for (const v of manifest.variants) {
      rows.push({
        id: v.id ?? `${repoShort}/${v.env}`,
        repo: repoName, env: v.env,
        role: v.role, transport: v.transport, transports: v.transports,
        board: v.board, label: v.label ?? v.env, description: v.description,
        fwVersion: canonicalFwVersion(v.fwVersion ?? manifest.tag ?? 'unknown'),
        tag: tag ?? manifest.tag,
        publishedAt,
        appOtaSrc: v.appOta?.filename ?? null,
        fullSerialSrc: v.fullSerial?.filename ?? null,
        srcDir,
      })
    }
  } else if (Array.isArray(manifest.envs)) {
    for (const e of manifest.envs) {
      const inf = inferVariantFromEnv(e.env)
      rows.push({
        id: `${repoShort}/${e.env}`,
        repo: repoName, env: e.env,
        role: inf.role, transport: inf.transport, board: inf.board,
        label: e.env, description: undefined,
        fwVersion: canonicalFwVersion(e.fwVersion ?? manifest.tag ?? 'unknown'),
        tag: tag ?? manifest.tag,
        publishedAt,
        appOtaSrc: await resolveV1Bin(srcDir, e.env, 'firmware_app_ota'),
        fullSerialSrc: await resolveV1Bin(srcDir, e.env, 'firmware_full_serial'),
        srcDir,
      })
    }
  }
  return rows
}

async function main() {
  const [stagingDir, outDir] = process.argv.slice(2)
  if (!stagingDir || !outDir) {
    console.error('usage: aggregate-firmware-manifest.mjs <stagingDir> <outDir>')
    process.exit(2)
  }
  await fs.mkdir(outDir, { recursive: true })

  let repoDirs = []
  try {
    repoDirs = (await fs.readdir(stagingDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    console.error(`staging dir not found: ${stagingDir}`)
    process.exit(1)
  }

  // Collect all rows across repos + releases.
  const allRows = []
  for (const repoName of repoDirs) {
    const repoShort = repoShortFor(repoName)
    const repoDir = join(stagingDir, repoName)
    // Multi-release layout: tag subdirs. Flat layout: manifest at repo root.
    const subdirs = (await fs.readdir(repoDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    const hasFlatManifest =
      (await exists(join(repoDir, 'manifest.fragment.json')))
      || (await exists(join(repoDir, 'manifest.json')))

    if (hasFlatManifest) {
      allRows.push(...await readReleaseDir(repoName, repoShort, repoDir, undefined))
    }
    for (const tag of subdirs) {
      allRows.push(...await readReleaseDir(repoName, repoShort, join(repoDir, tag), tag))
    }
    if (!hasFlatManifest && subdirs.length === 0) {
      console.warn(`[aggregate] ${repoName}: no manifest found, skipping`)
    }
  }

  // Group rows by variant id → versions[] (newest first), copy bins.
  const byId = new Map()
  for (const row of allRows) {
    if (!byId.has(row.id)) byId.set(row.id, [])
    byId.get(row.id).push(row)
  }

  const variants = []
  for (const [id, rows] of byId) {
    rows.sort((a, b) => compareVersionsDesc(a.fwVersion, b.fwVersion))
    const repoShort = repoShortFor(rows[0].repo)
    const versions = []
    const seenVer = new Set()
    for (const row of rows) {
      const slug = versionSlug(row.fwVersion)
      if (seenVer.has(slug)) continue   // same version from overlapping sources
      seenVer.add(slug)
      const appName = `${repoShort}_${row.env}_${slug}_firmware_app_ota.bin`
      const serName = `${repoShort}_${row.env}_${slug}_firmware_full_serial.bin`
      const appOta = row.appOtaSrc
        ? await copyBin(row.srcDir, row.appOtaSrc, outDir, appName)
        : null
      const fullSerial = row.fullSerialSrc
        ? await copyBin(row.srcDir, row.fullSerialSrc, outDir, serName)
        : null
      if (!appOta && !fullSerial) continue
      versions.push({
        fwVersion: row.fwVersion,
        ...(row.tag ? { tag: row.tag } : {}),
        ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
        ...(appOta ? { appOta } : {}),
        ...(fullSerial ? { fullSerial } : {}),
      })
    }
    if (versions.length === 0) {
      console.warn(`[aggregate] ${id}: no bins copied, skipping`)
      continue
    }
    // Newest row wins the descriptive fields; top-level artifacts = latest.
    const head = rows[0]
    const latest = versions[0]
    variants.push({
      id, repo: head.repo, env: head.env,
      role: head.role, transport: head.transport,
      ...(head.transports ? { transports: head.transports } : {}),
      ...(head.board ? { board: head.board } : {}),
      label: head.label,
      ...(head.description ? { description: head.description } : {}),
      fwVersion: latest.fwVersion,
      ...(latest.appOta ? { appOta: latest.appOta } : {}),
      ...(latest.fullSerial ? { fullSerial: latest.fullSerial } : {}),
      versions,
    })
  }

  variants.sort((a, b) => (a.role + a.env).localeCompare(b.role + b.env))
  const manifest = {
    schema_version: 2,
    generated_at: Date.now(),
    variants,
  }
  await fs.writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[aggregate] wrote ${variants.length} variant(s) → ${join(outDir, 'manifest.json')}`)
  for (const v of variants) {
    const vers = v.versions.map((x) => x.fwVersion).join(', ')
    console.log(`  · [${v.role}/${v.transport}] ${v.id} versions=[${vers}]`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
