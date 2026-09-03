/**
 * Publish a concrete English entry point for static hosting.
 *
 * Studio's locale is selected from the URL. Cloudflare Static Assets does not
 * use SPA fallback, so `/en/` needs its own `index.html`; otherwise it is a
 * 404 even though the root bundle can render English. Copying the Vite entry
 * preserves the build base for both latest (`/en/`) and frozen builds
 * (`/vX.Y/en/`).
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const distDir = process.argv[2] ?? 'dist'
const source = join(distDir, 'index.html')
const destination = join(distDir, 'en', 'index.html')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
console.log(`[locale-entry] ${destination}`)
