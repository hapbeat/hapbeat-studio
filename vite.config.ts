import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { basename, resolve, join } from 'path'
import { promises as fs, readFileSync } from 'fs'
import { execFile, execSync } from 'child_process'
import { promisify } from 'util'
import {
  mergeLocalBuilds, parseWorktreeList,
  type DevArtifact, type DevBuild, type DevVersionEntry,
} from './src/utils/firmwareDevList'

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
  /** Branch of the linked git worktree this root belongs to (absent = the
   *  main checkout). See firmwareWorktreeRoots. */
  origin?: string
}

interface DevVariantMeta {
  role?: string
  transport?: string
  transports?: string[]
  board?: string
  label?: string
  description?: string
  /** Haptic output stage ("pwm" = band_v4_pwm). Passed through verbatim;
   *  firmwareLibrary maps it to `hapticOutput`. */
  haptic_output?: string
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
//
// That persistence has a downside: an env can also be PERMANENTLY removed
// from the firmware repo (renamed / consolidated into another env — e.g.
// `duowl_v4_stream_espnow_hp48` was folded into `duowl_v4_stream_espnow`,
// 2026-07-16). Rebuilding can never bring such an env back, so the cache
// would otherwise keep serving a ghost "キャッシュ版" entry forever. We
// prune those against each repo's `platformio.ini` — the definitive,
// always-on-disk registry of envs the repo still defines — in the /list
// handler below (see readValidEnvNames / cache-only section).
const CACHE_ROOT = resolve(__dirname, 'node_modules/.cache/hapbeat-firmware-dev')
const BIN_STEMS = ['firmware_app_ota', 'firmware_full_serial', 'firmware'] as const

/** Production Studio origin whose /firmware/ tree holds the released firmware
 *  (manifest.json + bins). Proxied in dev under /firmware-releases/. */
const RELEASE_FIRMWARE_ORIGIN = 'https://studio.hapbeat.com'

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

/**
 * Read the set of env names a repo's `platformio.ini` still defines
 * (`[env:<name>]` sections). Unlike `.pio/build`/`dist` (which only
 * reflect what has been built locally and are routinely pruned by
 * PlatformIO), this file is the repo's permanent env registry — an env
 * absent here has been renamed/removed/consolidated and can never
 * become "live" again.
 *
 * Returns `null` when the file can't be read (repo not checked out at
 * this candidate path, etc.) so callers can tell "confirmed absent"
 * apart from "unknown" and skip pruning in the unknown case (fail safe
 * — never delete a cache snapshot just because a checkout is missing).
 */
async function readValidEnvNames(repoDir: string): Promise<Set<string> | null> {
  try {
    const ini = await fs.readFile(join(repoDir, 'platformio.ini'), 'utf-8')
    const names = new Set<string>()
    const re = /^\[env:([^\]]+)\]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(ini))) names.add(m[1].trim())
    return names
  } catch {
    return null
  }
}

/** Try each candidate repo dir (repos-firmware/ layout, then legacy flat
 *  sibling) in order and return the first one whose platformio.ini reads
 *  successfully. */
async function firstValidEnvNames(repoDirs: string[]): Promise<Set<string> | null> {
  for (const dir of repoDirs) {
    const names = await readValidEnvNames(dir)
    if (names) return names
  }
  return null
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

/** Repo tag + every candidate root dir (repos-firmware/ then legacy flat
 *  sibling) to check for `platformio.ini`, used by the cache-pruning pass
 *  and the worktree discovery. */
interface FirmwareRepoRoot {
  repo: string
  dirs: string[]
}

const execFileP = promisify(execFile)
const WORKTREE_TTL_MS = 5000
let worktreeRootsCache: { at: number; roots: FirmwareBuildRepo[] } | null = null

/**
 * `dist/` of every linked git worktree of the firmware repos (e.g.
 * repos-firmware/.claude/worktrees/band-v5-fw on feat/band-v5), so a build
 * made on a feature branch is flashable from Studio without copying it into
 * the main checkout. Only `dist/` (stable, archive-bearing), not the volatile
 * `.pio/build`. Found with `git worktree list` on the first checked-out
 * candidate dir per repo; cached briefly because /list and every bin request
 * ask for it.
 */
async function firmwareWorktreeRoots(repoRoots: FirmwareRepoRoot[]): Promise<FirmwareBuildRepo[]> {
  if (worktreeRootsCache && Date.now() - worktreeRootsCache.at < WORKTREE_TTL_MS) {
    return worktreeRootsCache.roots
  }
  const roots: FirmwareBuildRepo[] = []
  for (const { repo, dirs } of repoRoots) {
    for (const dir of dirs) {
      // platformio.ini first: a missing candidate dir inside another git repo
      // (the workspace) must not list THAT repo's worktrees.
      try { await fs.access(join(dir, 'platformio.ini')) } catch { continue }
      try {
        const { stdout } = await execFileP('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { timeout: 5000 })
        for (const wt of parseWorktreeList(stdout, dir)) {
          roots.push({ repo, root: join(wt.path, 'dist'), srcDir: join(wt.path, 'src'), origin: wt.label })
        }
      } catch { /* git unavailable — main checkout only */ }
      break
    }
  }
  worktreeRootsCache = { at: Date.now(), roots }
  return roots
}

/** Dev-plugin URL that serves exactly the local build `ver` of `env`. */
function devBuildUrl(env: string, ver: string, stem: string): string {
  return `/firmware-builds/${encodeURIComponent(env)}/version/${encodeURIComponent(ver)}/${stem}.bin`
}

function firmwareDevPlugin(buildRepos: FirmwareBuildRepo[], repoRoots: FirmwareRepoRoot[]): Plugin {
  return {
    name: 'hapbeat-firmware-dev',
    apply: 'serve',
    configureServer(server) {
      // Published releases: proxy the production manifest (built by CI with
      // scripts/aggregate-firmware-manifest.mjs) + its bins, so dev mode lists
      // the released versions alongside local builds. Server-side fetch avoids
      // CORS. Offline → 502; the client then falls back to local-only.
      server.middlewares.use('/firmware-releases', async (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0]
        if (!/^[A-Za-z0-9._-]+\.(json|bin)$/.test(name)) { next(); return }
        try {
          const r = await fetch(`${RELEASE_FIRMWARE_ORIGIN}/firmware/${name}`, {
            signal: AbortSignal.timeout(name.endsWith('.json') ? 8000 : 60000),
          })
          if (!r.ok) {
            res.statusCode = r.status
            res.end(`release ${name}: ${r.status} ${r.statusText}`)
            return
          }
          const data = Buffer.from(await r.arrayBuffer())
          res.setHeader('content-type', r.headers.get('content-type') ?? 'application/octet-stream')
          res.setHeader('cache-control', 'no-store')
          res.end(data)
        } catch (err) {
          res.statusCode = 502
          res.end(`release ${name} unreachable: ${String(err)}`)
        }
      })
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
              /** Worktree branch of the default build (absent = main checkout). */
              origin?: string
              /** The default build, then every other local build of the env
               *  (other roots' current builds + dist/<env>/archive/), one per
               *  fwVersion. Absent when there is only the one build. */
              versions?: DevVersionEntry[]
            }
            // 1) Live envs from every root: dist/ + .pio/build of the main
            //    checkout, then dist/ of each linked worktree. The NEWEST
            //    current build becomes the default; the others stay
            //    selectable through `versions`.
            interface LiveCandidate { item: ListItem; root: string; origin?: string }
            const candidates = new Map<string, LiveCandidate[]>()
            const otherBuilds = new Map<string, DevBuild[]>()
            const itemMtime = (i: ListItem): number =>
              Math.max(i.appOta?.mtime ?? 0, i.fullSerial?.mtime ?? 0)
            const roots = [...buildRepos, ...await firmwareWorktreeRoots(repoRoots)]
            for (const { repo, root, srcDir, origin } of roots) {
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
                // Per-env fwVersion from variant.json = the ACTUAL version baked
                // into THIS build's binary. Show it verbatim (honest: the dev
                // list must match what get_info will report after flashing —
                // never a "release-intended" version the local .bin doesn't
                // actually carry). Falls back to the repo-global build_version.h.
                const fwVersion = variant.fwVersion
                  ?? await readFirmwareVersion(srcDir)
                // Worktree builds are addressed by version (devBuildUrl).
                if (origin && !fwVersion) continue
                const item: ListItem = {
                  env, repo, fwVersion, appOta, fullSerial, ...variant, source: 'live',
                }
                candidates.set(env, [...(candidates.get(env) ?? []), { item, root, origin }])
                otherBuilds.set(env, [
                  ...(otherBuilds.get(env) ?? []),
                  ...(fwVersion ? [{ fwVersion, ...withVersionUrls(env, fwVersion, appOta, fullSerial), origin }] : []),
                  ...(await readArchivedBuilds(root, env)).map((b) => ({ ...b, origin })),
                ])
              }
            }
            const items: ListItem[] = []
            const live = new Set<string>()
            for (const [env, cands] of candidates) {
              const top = [...cands].sort((a, b) => itemMtime(b.item) - itemMtime(a.item))[0]
              const ver = top.item.fwVersion ?? ''
              // A worktree build is fetched by its exact URL: the plain
              // /firmware-builds/<env>/<stem>.bin route serves the main checkout.
              const item: ListItem = top.origin
                ? { ...top.item, ...withVersionUrls(env, ver, top.item.appOta, top.item.fullSerial), origin: top.origin }
                : top.item
              const versions = mergeLocalBuilds(
                { fwVersion: ver, appOta: item.appOta, fullSerial: item.fullSerial, origin: top.origin },
                otherBuilds.get(env) ?? [],
              )
              if (versions.length > 1) item.versions = versions
              items.push(item)
              live.add(env)
              await snapshotEnvToCache(env, item.repo ?? '?', top.root, item.fwVersion, item as DevVariantMeta)
            }
            // 2) Cache-only envs — previously seen but pruned everywhere.
            //    Before serving them, drop any whose source repo no longer
            //    DEFINES the env at all (platformio.ini has no [env:<name>]
            //    section for it) — those are permanently stale (renamed /
            //    removed / consolidated into another env) and a rebuild can
            //    never refresh them, so keeping them around just shows a
            //    ghost "キャッシュ版" entry forever. Envs that still exist
            //    but simply lack a current local build are unaffected —
            //    they keep serving from the cache as before.
            const validEnvsByRepo = new Map<string, Set<string>>()
            for (const { repo, dirs } of repoRoots) {
              const names = await firstValidEnvNames(dirs)
              if (names) validEnvsByRepo.set(repo, names)
            }
            const cached = await readCachedEnvs()
            for (const [env, { meta, appOta, fullSerial }] of cached) {
              if (live.has(env)) continue   // live wins
              // meta.repo unset (older cache entries) or a repo whose
              // platformio.ini we couldn't read ⇒ unknown, not "removed" —
              // don't prune (fail safe).
              const validSet = meta.repo ? validEnvsByRepo.get(meta.repo) : undefined
              if (validSet && !validSet.has(env)) {
                await fs.rm(join(CACHE_ROOT, env), { recursive: true, force: true }).catch(() => {})
                continue
              }
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

          // /firmware-builds/<env>/version/<fwVersion>/<stem>.bin — one exact
          // local build (devBuildUrl): a worktree's current build or an
          // archived one, from any root.
          const vm = url.match(/^\/([^/]+)\/version\/([^/]+)\/(firmware_app_ota|firmware_full_serial|firmware)\.bin$/)
          if (vm) {
            const env = decodeURIComponent(vm[1])
            const ver = decodeURIComponent(vm[2])
            const stem = vm[3]
            if ([env, ver].some((s) => s.includes('..') || s.includes('/') || s.includes('\\'))) {
              res.statusCode = 400
              res.end('bad env / version')
              return
            }
            const roots = [...buildRepos, ...await firmwareWorktreeRoots(repoRoots)]
            const binPath = await findBuildByVersion(roots, env, ver, stem)
            if (!binPath) {
              res.statusCode = 404
              res.end(`${stem}.bin not found for env="${env}" version "${ver}"`)
              return
            }
            const st = await fs.stat(binPath)
            const data = await fs.readFile(binPath)
            res.setHeader('content-type', 'application/octet-stream')
            res.setHeader('cache-control', 'no-store, max-age=0')
            res.setHeader('x-firmware-mtime', String(st.mtimeMs))
            res.setHeader('x-firmware-size', String(st.size))
            res.setHeader('x-firmware-path', binPath)
            res.end(data)
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

/** Point a build's artifacts at its devBuildUrl (size / mtime kept), so the
 *  client fetches exactly that build. */
function withVersionUrls(env: string, ver: string, appOta?: DevArtifact, fullSerial?: DevArtifact) {
  const url = (a: DevArtifact) => ({ ...a, path: devBuildUrl(env, ver, basename(a.path, '.bin')) })
  return {
    appOta: appOta ? url(appOta) : undefined,
    fullSerial: fullSerial ? url(fullSerial) : undefined,
  }
}

/** Earlier dev builds of `env` kept under `<root>/<env>/archive/<fwVersion>/`
 *  (merge_firmware.py), with devBuildUrl artifact paths. */
async function readArchivedBuilds(root: string, env: string): Promise<DevBuild[]> {
  const out: DevBuild[] = []
  const archiveRoot = join(root, env, 'archive')
  for (const ver of await safeReaddir(archiveRoot)) {
    const appOta = await statArtifact(archiveRoot, ver, 'firmware_app_ota.bin')
    const fullSerial = await statArtifact(archiveRoot, ver, 'firmware_full_serial.bin')
    if (!appOta && !fullSerial) continue
    const meta = await readVariantMeta(archiveRoot, ver)
    out.push({ fwVersion: meta.fwVersion ?? ver, ...withVersionUrls(env, ver, appOta, fullSerial), archived: true })
  }
  return out
}

/** Newest non-empty `<stem>.bin` of `env` whose build is version `ver`, across
 *  every root's current build and `archive/<ver>/` (serves devBuildUrl). */
async function findBuildByVersion(
  roots: FirmwareBuildRepo[], env: string, ver: string, stem: string,
): Promise<string | null> {
  const paths: string[] = []
  for (const { root, srcDir } of roots) {
    const current = (await readVariantMeta(root, env)).fwVersion ?? await readFirmwareVersion(srcDir)
    if (current === ver) paths.push(join(root, env, `${stem}.bin`))
    paths.push(join(root, env, 'archive', ver, `${stem}.bin`))
  }
  let best: string | null = null
  let bestMtime = -1
  for (const p of paths) {
    try {
      const st = await fs.stat(p)
      if (st.isFile() && st.size > 0 && st.mtimeMs > bestMtime) {
        best = p
        bestMtime = st.mtimeMs
      }
    } catch { /* absent */ }
  }
  return best
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
 * Workspace firmware repos whose dist/ + .pio/build dirs are served in dev.
 * Non-existent roots are simply skipped (safeReaddir → []), so a checkout
 * without every firmware repo still works.
 *
 * Repos live under `repos-firmware/` after the workspace repos-* reorg
 * (2026-06-18). The legacy FLAT sibling layout (`../hapbeat-*`) is kept as a
 * fallback base so an older flat checkout still resolves — a non-existent
 * path costs nothing (skipped). Before this fix the ONLY paths were the flat
 * ones, so post-reorg the live list was empty and Studio served a frozen
 * snapshot cache with stale versions (user 2026-07-01).
 *
 * Per DEC-033/034 the node-firmware homes are:
 *   - hapbeat-device-firmware      → receiver (wifi_udp/mqtt) + broker + sensor
 *   - hapbeat-transmitter-firmware → transmitter (ESP-NOW audio source)
 */
const FIRMWARE_REPO_DIRS: Array<{ repo: string; dir: string }> = [
  { repo: 'dev', dir: 'hapbeat-device-firmware' },
  { repo: 'tx', dir: 'hapbeat-transmitter-firmware' },
]
// repos-firmware/ (current) is listed first; the flat sibling is a fallback.
//
// Both `dist/` and `.pio/build/` are scanned; the mtime comparison below keeps
// the NEWEST per env. `dist/` persists across PlatformIO pruning (`.pio/build/
// <env>` is deleted when another env builds or platformio.ini changes), so a
// built env stays in the Studio library without needing a Studio visit to
// snapshot it into CACHE_ROOT.
//
// The "local version ahead of published" bug (2026-07-04) was fixed at the
// SOURCE — firmware-versions.json now registers every env (so no build falls
// back to NEXT_RELEASE_VERSION) and NEXT_RELEASE_VERSION was aligned to the
// release line. A fresh build therefore writes the CORRECT version into dist/.
// If an env ever shows a stale version, rebuild that env → merge_firmware.py
// refreshes dist/<env>/variant.json. (Removing dist/ entirely was tried but it
// broke persistence: building one env then made the others vanish.)
// A Studio git worktree (repos-tools/.claude/worktrees/<name>) sits two
// levels deeper, so its workspace root is ../../../../ — without this
// base a dev server started from a worktree listed no local builds at all.
const FIRMWARE_BASES = ['../../repos-firmware', '../../../../repos-firmware', '..']

const FIRMWARE_BUILD_REPOS = FIRMWARE_REPO_DIRS.flatMap(({ repo, dir }) =>
  FIRMWARE_BASES.flatMap((base) => {
    const srcDir = resolve(__dirname, `${base}/${dir}/src`)
    return [
      { repo, root: resolve(__dirname, `${base}/${dir}/dist`), srcDir },
      { repo, root: resolve(__dirname, `${base}/${dir}/.pio/build`), srcDir },
    ]
  }),
)

// Bare repo dirs (not dist/.pio/build) — used only to read platformio.ini
// for the snapshot-cache pruning pass (see readValidEnvNames).
const FIRMWARE_REPO_ROOTS: FirmwareRepoRoot[] = FIRMWARE_REPO_DIRS.map(({ repo, dir }) => ({
  repo,
  dirs: FIRMWARE_BASES.map((base) => resolve(__dirname, `${base}/${dir}`)),
}))

export default defineConfig(() => {
  const meta = buildMeta()
  // Expose as VITE_-prefixed env so `import.meta.env.VITE_BUILD_*`
  // resolves at both dev (per-request transform) and build time.
  process.env.VITE_BUILD_SHA = meta.sha
  process.env.VITE_BUILD_DATE = meta.date
  process.env.VITE_APP_VERSION = appVersion()
  // STUDIO_BASE: CI がデプロイ先に応じて base を渡す。
  //   studio.hapbeat.com (Cloudflare / 新オリジン): "/"（最新）/ "/vX.Y/"（凍結版）
  //   devtools.hapbeat.com/studio/ (Xserver FTP / 旧オリジン・移行期間のみ並走):
  //                                  "/studio/"（最新）/ "/studio/vX.Y/"（凍結版）
  // 未指定（ローカル dev / preview / Cloudflare 既定ビルド）は "/"。新しいホームが
  // root オリジンになったので既定を "/" にする（旧 FTP 経路は STUDIO_BASE を明示）。
  const base = process.env.STUDIO_BASE || '/'
  return {
    base,
    plugins: [react(), firmwareDevPlugin(FIRMWARE_BUILD_REPOS, FIRMWARE_REPO_ROOTS)],
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
