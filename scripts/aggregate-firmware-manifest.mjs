#!/usr/bin/env node
/**
 * Aggregate firmware artifacts from multiple firmware repos into a
 * single v2 manifest for Studio (contracts: firmware-distribution.md,
 * DEC-034).
 *
 * Usage:
 *   node scripts/aggregate-firmware-manifest.mjs <stagingDir> <outDir>
 *
 * Layout expected under <stagingDir> (one subdir per firmware repo,
 * e.g. populated by `gh release download` in CI):
 *   <stagingDir>/<repo-name>/
 *       manifest.fragment.json   (v2: { variants: [...] })   — preferred
 *       manifest.json            (v1: { envs: [...] })        — legacy fallback
 *       <env>_firmware_app_ota.bin
 *       <env>_firmware_full_serial.bin
 *
 * Output:
 *   <outDir>/manifest.json       (schema_version 2)
 *   <outDir>/<repoShort>_<env>_<stem>.bin   (copied, collision-free names)
 *
 * A v1 fragment's envs are mapped to receiver/udp variants with
 * role/transport inferred from the env name. The same inference Studio
 * uses (firmwareLibrary.inferVariantFromEnv) is mirrored here.
 */
import { promises as fs } from 'fs'
import { join, basename } from 'path'

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

/** Resolve a v1 env's bin source name (release artifacts are env-prefixed). */
async function resolveV1Bin(srcDir, env, kind) {
  // kind: 'firmware_app_ota' | 'firmware_full_serial'
  const candidates = kind === 'firmware_full_serial'
    ? [`${env}_firmware_full_serial.bin`, `${env}_firmware.bin`]
    : [`${env}_firmware_app_ota.bin`]
  for (const c of candidates) {
    if (await exists(join(srcDir, c))) return c
  }
  return null
}

async function main() {
  const [stagingDir, outDir] = process.argv.slice(2)
  if (!stagingDir || !outDir) {
    console.error('usage: aggregate-firmware-manifest.mjs <stagingDir> <outDir>')
    process.exit(2)
  }
  await fs.mkdir(outDir, { recursive: true })

  const variants = []
  let repoDirs = []
  try {
    repoDirs = (await fs.readdir(stagingDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    console.error(`staging dir not found: ${stagingDir}`)
    process.exit(1)
  }

  for (const repoName of repoDirs) {
    const repoShort = repoShortFor(repoName)
    const srcDir = join(stagingDir, repoName)

    let fragment = null
    if (await exists(join(srcDir, 'manifest.fragment.json'))) {
      fragment = JSON.parse(await fs.readFile(join(srcDir, 'manifest.fragment.json'), 'utf-8'))
    } else if (await exists(join(srcDir, 'manifest.json'))) {
      fragment = JSON.parse(await fs.readFile(join(srcDir, 'manifest.json'), 'utf-8'))
    } else {
      console.warn(`[aggregate] ${repoName}: no manifest found, skipping`)
      continue
    }

    if (Array.isArray(fragment.variants)) {
      // v2 fragment — explicit role/transport/board/label/filenames.
      for (const v of fragment.variants) {
        const env = v.env
        const id = v.id ?? `${repoShort}/${env}`
        const appName = `${repoShort}_${env}_firmware_app_ota.bin`
        const serName = `${repoShort}_${env}_firmware_full_serial.bin`
        const appOta = v.appOta?.filename
          ? await copyBin(srcDir, v.appOta.filename, outDir, appName)
          : null
        const fullSerial = v.fullSerial?.filename
          ? await copyBin(srcDir, v.fullSerial.filename, outDir, serName)
          : null
        if (!fullSerial && !appOta) {
          console.warn(`[aggregate] ${repoName}/${env}: no bins copied, skipping`)
          continue
        }
        variants.push({
          id, repo: repoName, env,
          role: v.role, transport: v.transport, transports: v.transports,
          board: v.board, label: v.label ?? env, description: v.description,
          fwVersion: v.fwVersion,
          ...(appOta ? { appOta } : {}),
          ...(fullSerial ? { fullSerial } : {}),
        })
      }
    } else if (Array.isArray(fragment.envs)) {
      // v1 manifest — infer role/transport from env name.
      for (const e of fragment.envs) {
        const env = e.env
        const inf = inferVariantFromEnv(env)
        const appSrc = await resolveV1Bin(srcDir, env, 'firmware_app_ota')
        const serSrc = await resolveV1Bin(srcDir, env, 'firmware_full_serial')
        const appOta = appSrc
          ? await copyBin(srcDir, appSrc, outDir, `${repoShort}_${env}_firmware_app_ota.bin`)
          : null
        const fullSerial = serSrc
          ? await copyBin(srcDir, serSrc, outDir, `${repoShort}_${env}_firmware_full_serial.bin`)
          : null
        if (!fullSerial && !appOta) {
          console.warn(`[aggregate] ${repoName}/${env}: no bins copied, skipping`)
          continue
        }
        variants.push({
          id: `${repoShort}/${env}`, repo: repoName, env,
          role: inf.role, transport: inf.transport, board: inf.board,
          label: env, fwVersion: e.fwVersion,
          ...(appOta ? { appOta } : {}),
          ...(fullSerial ? { fullSerial } : {}),
        })
      }
    } else {
      console.warn(`[aggregate] ${repoName}: manifest has neither variants nor envs`)
    }
  }

  variants.sort((a, b) => (a.role + a.env).localeCompare(b.role + b.env))
  const manifest = {
    schema_version: 2,
    generated_at: Date.now(),
    variants,
  }
  await fs.writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[aggregate] wrote ${variants.length} variant(s) from ${repoDirs.length} repo(s) → ${join(outDir, 'manifest.json')}`)
  for (const v of variants) {
    console.log(`  · [${v.role}/${v.transport}] ${v.id} ${basename(v.fullSerial?.filename ?? v.appOta?.filename ?? '?')}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
