import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { promises as fs } from 'fs'
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
  /** Absolute path to the repo's `.pio/build`. */
  root: string
}

interface DevVariantMeta {
  role?: string
  transport?: string
  transports?: string[]
  board?: string
  label?: string
  description?: string
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

function firmwareDevPlugin(buildRepos: FirmwareBuildRepo[]): Plugin {
  return {
    name: 'hapbeat-firmware-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/firmware-builds', async (req, res, next) => {
        try {
          const url = req.url ?? ''
          if (url === '/list' || url === '/list/') {
            const items: Array<{
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
            }> = []
            const seenEnv = new Set<string>()
            for (const { repo, root } of buildRepos) {
              const envs = await safeReaddir(root)
              for (const env of envs) {
                const appOta = await statArtifact(root, env, 'firmware_app_ota.bin')
                let fullSerial = await statArtifact(root, env, 'firmware_full_serial.bin')
                if (!fullSerial) {
                  // Back-compat: merged image as `firmware.bin`.
                  fullSerial = await statArtifact(root, env, 'firmware.bin')
                }
                if (!appOta && !fullSerial) continue
                // First repo to own an env name wins (env names rarely
                // collide across repos; warn if they do).
                if (seenEnv.has(env)) {
                  // eslint-disable-next-line no-console
                  console.warn(`[firmware-dev] env "${env}" exists in multiple repos; keeping first`)
                  continue
                }
                seenEnv.add(env)
                const fwVersion = await readFirmwareVersion(root)
                const variant = await readVariantMeta(root, env)
                items.push({ env, repo, fwVersion, appOta, fullSerial, ...variant })
              }
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
            for (const { root } of buildRepos) {
              const binPath = join(root, env, `${stem}.bin`)
              try {
                const data = await fs.readFile(binPath)
                const st = await fs.stat(binPath)
                res.setHeader('content-type', 'application/octet-stream')
                res.setHeader('cache-control', 'no-store, max-age=0')
                res.setHeader('x-firmware-mtime', String(st.mtimeMs))
                res.setHeader('x-firmware-size', String(st.size))
                res.setHeader('x-firmware-path', binPath)
                res.end(data)
                return
              } catch {
                /* try next repo root */
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
async function readFirmwareVersion(buildRoot: string): Promise<string | undefined> {
  const firmwareSrc = resolve(buildRoot, '../../src')
  // 1. Primary: build_version.h (auto-generated, contains dev suffix
  //    like "0.1.2d1" for non-tagged commits).
  try {
    const header = await fs.readFile(
      resolve(firmwareSrc, 'build_version.h'),
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
      resolve(firmwareSrc, 'hapbeat_config.h'),
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
  { repo: 'dev', root: resolve(__dirname, '../hapbeat-device-firmware/.pio/build') },
  { repo: 'tx', root: resolve(__dirname, '../hapbeat-transmitter-firmware/.pio/build') },
]

export default defineConfig(({ command }) => {
  const meta = buildMeta()
  // Expose as VITE_-prefixed env so `import.meta.env.VITE_BUILD_*`
  // resolves at both dev (per-request transform) and build time.
  process.env.VITE_BUILD_SHA = meta.sha
  process.env.VITE_BUILD_DATE = meta.date
  return {
    base: command === 'build' ? '/studio/' : '/',
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
