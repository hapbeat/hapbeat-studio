import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import { promises as fs } from 'fs'

/**
 * Dev-server proxy for hapbeat-device-firmware build artifacts.
 *
 * Maps GET /firmware-builds/list                         → JSON {envs:[{env,size,mtime,path}]}
 *      GET /firmware-builds/<env>/firmware.bin    → raw bytes (no-store)
 *
 * Reads `../hapbeat-device-firmware/.pio/build/<env>/firmware.bin`
 * directly off disk on every request, so a PlatformIO rebuild becomes
 * visible to Studio on the next fetch — no cache, no Vite asset
 * pipeline involved.
 *
 * Production note: only registers in dev (`apply: 'serve'`). For
 * deployed devtools.hapbeat.com, replace with a CDN URL once CI
 * publishes builds; the Studio code only needs `firmwareBaseUrl()`
 * swapped to point at it.
 */
function firmwareDevPlugin(firmwareBuildRoot: string): Plugin {
  return {
    name: 'hapbeat-firmware-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/firmware-builds', async (req, res, next) => {
        try {
          const url = req.url ?? ''
          // /firmware-builds/list — enumerate every <env>/firmware.bin and
          // also report whether a sibling bootloader.bin / partitions.bin
          // exists. PlatformIO emits all three for ESP32 builds; Studio
          // mirrors PlatformIO's flash layout so iterative app updates AND
          // first-time provisioning (post chip-erase) both work.
          if (url === '/list' || url === '/list/') {
            const envs = await safeReaddir(firmwareBuildRoot)
            // Each env may emit two artifacts (DEC 2026-05-02):
            //   - firmware_app_ota.bin    : app-only, for Wi-Fi OTA
            //   - firmware_full_serial.bin: bootloader+partitions+app
            //                                merged image, for USB
            //                                Serial download mode
            // We also accept the legacy `firmware.bin` filename as
            // full_serial (back-compat for builds that haven't yet
            // adopted the dual-output convention).
            const items: Array<{
              env: string
              fwVersion?: string
              appOta?: { size: number; mtime: number; path: string }
              fullSerial?: { size: number; mtime: number; path: string }
            }> = []
            for (const env of envs) {
              const fwVersion = await readFirmwareVersion(firmwareBuildRoot)
              const appOta = await statArtifact(
                firmwareBuildRoot, env, 'firmware_app_ota.bin',
              )
              let fullSerial = await statArtifact(
                firmwareBuildRoot, env, 'firmware_full_serial.bin',
              )
              if (!fullSerial) {
                // Back-compat: older builds emit just `firmware.bin`
                // (the merged image) without the `_full_serial` suffix.
                fullSerial = await statArtifact(
                  firmwareBuildRoot, env, 'firmware.bin',
                )
              }
              if (appOta || fullSerial) {
                items.push({ env, fwVersion, appOta, fullSerial })
              }
            }
            items.sort((a, b) => a.env.localeCompare(b.env))
            res.setHeader('content-type', 'application/json')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify({ envs: items, root: firmwareBuildRoot }))
            return
          }

          // /firmware-builds/<env>/<filename>.bin
          // Allow firmware_app_ota.bin / firmware_full_serial.bin /
          // firmware.bin (legacy alias for full_serial).
          const m = url.match(/^\/([^/]+)\/(firmware_app_ota|firmware_full_serial|firmware)\.bin$/)
          if (m) {
            const env = m[1]
            const stem = m[2]
            if (env.includes('..') || env.includes('/') || env.includes('\\')) {
              res.statusCode = 400
              res.end('bad env name')
              return
            }
            const binPath = join(firmwareBuildRoot, env, `${stem}.bin`)
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
              res.statusCode = 404
              res.end(`${stem}.bin not found for env="${env}"`)
              return
            }
          }

          next()
        } catch (err) {
          // Surface fs errors so devs can spot misconfigured paths.
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

/** Sole source of truth for the human-readable firmware version —
 *  parsed out of `src/hapbeat_config.h` so OTA verify can compare
 *  Studio-side metadata against the device's `get_info` reply. */
async function readFirmwareVersion(buildRoot: string): Promise<string | undefined> {
  try {
    const header = await fs.readFile(
      resolve(buildRoot, '../../src/hapbeat_config.h'),
      'utf-8',
    )
    const m = header.match(/#define\s+FIRMWARE_VERSION\s+"([^"]+)"/)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}


const FIRMWARE_BUILD_ROOT = resolve(
  __dirname,
  '../hapbeat-device-firmware/.pio/build',
)

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/studio/' : '/',
  plugins: [react(), firmwareDevPlugin(FIRMWARE_BUILD_ROOT)],
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
}))
