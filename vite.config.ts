import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { promises as fs, readFileSync } from 'fs'
import { execSync } from 'child_process'

/** Resolve build metadata: short git SHA (with -dirty suffix if working
 *  tree has uncommitted changes) + ISO build date. Inlined into the
 *  bundle via Vite `define` so Studio can self-report for debugging
 *  (Helper Manage modal). Never throws — falls back to 'unknown' if
 *  the working tree isn't a git checkout (e.g. CI tarball). */
function buildMeta(): { sha: string; date: string } {
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const dirty = execSync('git status --porcelain', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (dirty) sha += '-dirty'
  } catch {
    /* not a git checkout */
  }
  return { sha, date: new Date().toISOString() }
}

/** Human-facing app version (semver) shown in the UI + used by the version
 *  switcher to highlight "current". Priority: VITE_APP_VERSION passed by CI
 *  on a release tag → package.json version. Releases set this from the full
 *  `vX.Y.Z` tag so a frozen build (served from the minor dir `/studio/vX.Y/`)
 *  still self-reports its full patch version. */
function appVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Dev-server proxy for firmware build artifacts across the workspace
 * firmware repos (multi-repo, DEC-034).
 *
 * Maps GET /firmware-builds/list             → JSON {envs:[{env,role,transport,…}]}
 *      GET /firmware-builds/<env>/<stem>.bin  → raw bytes (no-store)
 *
 * Reads each repo's `<repo>/.pio/build/<env>/<stem>.bin` directly off
 * disk on every request, so a PlatformIO rebuild becomes visible to
 * Studio on the next fetch — no cache.
 *
 * Each env folder may carry an optional `variant.json`
 * ({role,transport,transports,board,label,description}) which the
 * plugin surfaces so Studio groups the build under the right node
 * role. When absent, Studio infers role/transport from the env name.
 *
 * Production note: only registers in dev (`apply: 'serve'`). Deployed
 * Studio reads an aggregated `public/firmware/manifest.json` (v2,
 * produced by scripts/aggregate-firmware-manifest.mjs at CI time).
 */
interface FirmwareBuildRepo {
  /** Short repo tag used in logs / collision tie-breaks. */
  repo: string
  /** Absolute path to an artifact root (`dist` or `.pio/build`). */
  root: string
  /** Absolute path to the repo's `src/` (for the build_version.h
   *  fallback when variant.json carries no fwVersion). */
  srcDir?: string
}

interface DevVariantMeta {
  role?: string
  transport?: string
  transports?: string[]
  board?: string
  label?: string
  description?: string
  /** Per-env firmware version (device-firmware variant.json ≥ 2026-06).
   *  Preferred over the repo-global build_version.h, which only reflects
   *  the LAST build and mislabels other envs after a partial rebuild. */
  fwVersion?: string
}

async function readVariantMeta(root: string, env: string): Promise<DevVariantMeta> {
  try {
    const raw = await fs.readFile(join(root, env, 'variant.json'), 'utf-8')
    const j = JSON.parse(raw) as DevVariantMeta
    return j ?? {}
  } catch {
    return {}
  }
}

// ---- dev snapshot cache ---------------------------------------------------
// `.pio/build/<env>/` is volatile: building one env (or editing platformio.ini,
// or a parallel session sharing `.pio`) prunes the other envs' subdirs, so the
// firmware list "loses" everything except the last-built env. We snapshot each
// live env's bins to a persistent cache outside `.pio` and serve the union
// (live preferred) so previously-seen envs stay flashable. See
// instructions-firmware-dev-list-disappears.
const CACHE_ROOT = resolve(__dirname, 'node_modules/.cache/hapbeat-firmware-dev')
const BIN_STEMS = ['firmware_app_ota', 'firmware_full_serial', 'firmware'] as const

interface CachedMeta {
  repo?: string
  fwVersion?: string
  cachedAt: number
  variant?: DevVariantMeta
}

/** Copy a live env's non-empty bins + meta into the cache (best-effort). */
async function snapshotEnvToCache(
  env: string, repo: string, root: string,
  fwVersion: string | undefined, variant: DevVariantMeta,
): Promise<void> {
  try {
    const cacheDir = join(CACHE_ROOT, env)
    let copied = false
    for (const stem of BIN_STEMS) {
      const src = join(root, env, `${stem}.bin`)
      try {
        const st = await fs.stat(src)
        if (!st.isFile() || st.size === 0) continue
        await fs.mkdir(cacheDir, { recursive: true })
        await fs.copyFile(src, join(cacheDir, `${stem}.bin`))
        copied = true
      } catch { /* missing stem */ }
    }
    if (copied) {
      const meta: CachedMeta = { repo, fwVersion, cachedAt: Date.now(), variant }
      await fs.writeFile(join(cacheDir, 'meta.json'), JSON.stringify(meta))
    }
  } catch { /* cache write is best-effort */ }
}

interface CacheEntry {
  meta: CachedMeta
  appOta?: { size: number; mtime: number; path: string }
  fullSerial?: { size: number; mtime: number; path: string }
}

/** Read all cached envs that still have at least one bin. */
async function readCachedEnvs(): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>()
  let envs: string[]
  try {
    envs = (await fs.readdir(CACHE_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return out
  }
  for (const env of envs) {
    let meta: CachedMeta
    try {
      meta = JSON.parse(await fs.readFile(join(CACHE_ROOT, env, 'meta.json'), 'utf-8'))
    } catch { continue }
    const appOta = await statArtifact(CACHE_ROOT, env, 'firmware_app_ota.bin')
    let fullSerial = await statArtifact(CACHE_ROOT, env, 'firmware_full_serial.bin')
    if (!fullSerial) fullSerial = await statArtifact(CACHE_ROOT, env, 'firmware.bin')
    if (!appOta && !fullSerial) continue
    out.set(env, { meta, appOta, fullSerial })
  }
  return out
}

function firmwareDevPlugin(buildRepos: FirmwareBuildRepo[]): Plugin {
  return {
    name: 'hapbeat-firmware-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/firmware-builds', async (req, res, next) => {
        try {
          const url = req.url ?? ''
          if (url === '/list' || url === '/list/') {
            interface ListItem {
              env: string
              repo?: string
              role?: string
              transport?: string
              transports?: string[]
              board?: string
              label?: string
              description?: string
              fwVersion?: string
              appOta?: { size: number; mtime: number; path: string }
              fullSerial?: { size: number; mtime: number; path: string }
              /** "live" = present in .pio/build now; "cache" = snapshot of a
               *  previously-built env that .pio has since pruned. */
              source?: 'live' | 'cache'
              /** Epoch ms when a cache entry was snapshotted (cache only). */
              cachedAt?: number
            }
            // 1) Live envs from every root (dist/ + .pio/build per repo).
            //    The same env can exist in both — keep the NEWEST artifacts
            //    (they're normally identical: the post-build copies into
            //    dist; mtime comparison guards against a stale leftover).
            const live = new Map<string, ListItem>()
            const itemMtime = (i: ListItem): number =>
              Math.max(i.appOta?.mtime ?? 0, i.fullSerial?.mtime ?? 0)
            for (const { repo, root, srcDir } of buildRepos) {
              const envs = await safeReaddir(root)
              for (const env of envs) {
                const appOta = await statArtifact(root, env, 'firmware_app_ota.bin')
                let fullSerial = await statArtifact(root, env, 'firmware_full_serial.bin')
                if (!fullSerial) {
                  // Back-compat: merged image as `firmware.bin`.
                  fullSerial = await statArtifact(root, env, 'firmware.bin')
                }
                if (!appOta && !fullSerial) continue
                const variant = await readVariantMeta(root, env)
                // Per-env fwVersion from variant.json beats the repo-global
                // build_version.h (which only reflects the LAST build).
                const fwVersion = variant.fwVersion
                  ?? await readFirmwareVersion(srcDir)
                const item: ListItem = {
                  env, repo, fwVersion, appOta, fullSerial, ...variant, source: 'live',
                }
                const prev = live.get(env)
                if (!prev || itemMtime(item) > itemMtime(prev)) {
                  live.set(env, item)
                }
              }
            }
            const items: ListItem[] = [...live.values()]
            for (const item of items) {
              await snapshotEnvToCache(
                item.env, item.repo ?? '?',
                // snapshot reads bins by path — reuse the artifact's own dir.
                resolve((item.fullSerial?.path ?? item.appOta?.path ?? '.'), '../..'),
                item.fwVersion,
                item as DevVariantMeta,
              )
            }
            // 2) Cache-only envs — previously seen but pruned everywhere.
            const cached = await readCachedEnvs()
            for (const [env, { meta, appOta, fullSerial }] of cached) {
              if (live.has(env)) continue   // live wins
              items.push({
                env, repo: meta.repo, fwVersion: meta.fwVersion,
                appOta, fullSerial, ...(meta.variant ?? {}),
                source: 'cache', cachedAt: meta.cachedAt,
              })
            }
            items.sort((a, b) => a.env.localeCompare(b.env))
            res.setHeader('content-type', 'application/json')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({ envs: items }))
            return
          }

          // /firmware-builds/<env>/<stem>.bin — search every repo root.
          const m = url.match(/^\/([^/]+)\/(firmware_app_ota|firmware_full_serial|firmware)\.bin$/)
          if (m) {
            const env = m[1]
            const stem = m[2]
            if (env.includes('..') || env.includes('/') || env.includes('\\')) {
              res.statusCode = 400
              res.end('bad env name')
              return
            }
            // Live roots first (always newest), then the snapshot cache so a
            // previously-built env stays flashable after .pio pruned it.
            const candidates = [
              ...buildRepos.map(({ root }) => join(root, env, `${stem}.bin`)),
              join(CACHE_ROOT, env, `${stem}.bin`),
            ]
            for (const binPath of candidates) {
              try {
                const data = await fs.readFile(binPath)
                const st = await fs.stat(binPath)
                if (st.size === 0) continue   // skip a half-written / empty bin
                res.setHeader('content-type', 'application/octet-stream')
                res.setHeader('cache-control', 'no-store, max-age=0')
                res.setHeader('x-firmware-mtime', String(st.mtimeMs))
                res.setHeader('x-firmware-size', String(st.size))
                res.setHeader('x-firmware-path', binPath)
                res.end(data)
                return
              } catch {
                /* try next candidate */
              }
            }
            res.statusCode = 404
            res.end(`${stem}.bin not found for env="${env}"`)
            return
          }

          next()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[firmware-dev plugin]', err)
          res.statusCode = 500
          res.end(String(err))
        }
      })
    },
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function statArtifact(
  buildRoot: string, env: string, filename: string,
): Promise<{ size: number; mtime: number; path: string } | undefined> {
  const p = join(buildRoot, env, filename)
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return undefined
    return { size: st.size, mtime: st.mtimeMs, path: p }
  } catch {
    return undefined
  }
}

/** Sole source of truth for the human-readable firmware version.
 *
 *  Source-of-truth migrated 2026-05-10 (firmware `1be8711`):
 *  `FIRMWARE_VERSION` is now generated per-build by
 *  `scripts/build_version.py` into `src/build_version.h`
 *  (gitignored, regenerated each build). Tag-exact commits produce
 *  e.g. `0.1.1`, dev commits produce e.g. `0.1.2d1` (where N counts
 *  commits since last `v*` tag).
 *
 *  Old location (`src/hapbeat_config.h`) kept as fallback because
 *  build_version.h only exists after at least one PlatformIO build.
 *  On a fresh checkout pre-build, fall through to undefined.
 */
async function readFirmwareVersion(srcDir: string | undefined): Promise<string | undefined> {
  if (!srcDir) return undefined
  // 1. Primary: build_version.h (auto-generated, contains dev suffix
  //    like "0.1.2d1" for non-tagged commits). NOTE: repo-global — only
  //    reflects the LAST pio run; per-env variant.json fwVersion is
  //    preferred upstream and this is just the legacy fallback.
  try {
    const header = await fs.readFile(
      resolve(srcDir, 'build_version.h'),
      'utf-8',
    )
    const m = header.match(/#define\s+FIRMWARE_VERSION\s+"([^"]+)"/)
    if (m) return m[1]
  } catch {
    // build_version.h not yet generated (no build run) — fall through.
  }
  // 2. Fallback: hapbeat_config.h (legacy, pre-1be8711). Some older
  //    branches may still define FIRMWARE_VERSION here.
  try {
    const header = await fs.readFile(
      resolve(srcDir, 'hapbeat_config.h'),
      'utf-8',
    )
    const m = header.match(/#define\s+FIRMWARE_VERSION\s+"([^"]+)"/)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}


/**
 * Workspace firmware repos whose `.pio/build` dirs are served in dev.
 * Non-existent roots are simply skipped (safeReaddir → []), so a
 * checkout without every firmware repo still works.
 *
 * Per DEC-033/034 the workspace homes for node firmware are:
 *   - hapbeat-device-firmware     → receiver (udp/mqtt) + broker + sensor envs
 *   - hapbeat-transmitter-firmware → transmitter (ESP-NOW audio source) env
 * (External hapbeat-wireless-firmware / wireless-sender-firmware are
 *  reference/port-source only.)
 */
const FIRMWARE_BUILD_REPOS = [
  // dist/ first: the post-build scripts copy distributables there and pio
  // never prunes it, so it's the stable primary. `.pio/build` stays as a
  // fallback for older checkouts whose post-build predates the dist copy.
  {
    repo: 'dev',
    root: resolve(__dirname, '../hapbeat-device-firmware/dist'),
    srcDir: resolve(__dirname, '../hapbeat-device-firmware/src'),
  },
  {
    repo: 'dev',
    root: resolve(__dirname, '../hapbeat-device-firmware/.pio/build'),
    srcDir: resolve(__dirname, '../hapbeat-device-firmware/src'),
  },
  {
    repo: 'tx',
    root: resolve(__dirname, '../hapbeat-transmitter-firmware/dist'),
    srcDir: resolve(__dirname, '../hapbeat-transmitter-firmware/src'),
  },
  {
    repo: 'tx',
    root: resolve(__dirname, '../hapbeat-transmitter-firmware/.pio/build'),
    srcDir: resolve(__dirname, '../hapbeat-transmitter-firmware/src'),
  },
]

export default defineConfig(({ command }) => {
  const meta = buildMeta()
  // Expose as VITE_-prefixed env so `import.meta.env.VITE_BUILD_*`
  // resolves at both dev (per-request transform) and build time.
  process.env.VITE_BUILD_SHA = meta.sha
  process.env.VITE_BUILD_DATE = meta.date
  process.env.VITE_APP_VERSION = appVersion()
  // STUDIO_BASE: CI がリリースタグ時に "/studio/v0.2/" (マイナー単位の凍結 dir) を
  // 渡す。パッチは同じマイナー dir を上書きするので dir が増えない。未指定の通常
  // ビルド(master)は "/studio/"、dev サーバは "/"。
  const base = process.env.STUDIO_BASE || (command === 'build' ? '/studio/' : '/')
  return {
    base,
    plugins: [react(), firmwareDevPlugin(FIRMWARE_BUILD_REPOS)],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      open: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  }
})
