#!/usr/bin/env node
/**
 * generate-library-index.mjs
 *
 * Scans public/library/clips/ for WAV files, reads their headers,
 * and generates public/library/index.json.
 *
 * Usage:
 *   node scripts/generate-library-index.mjs
 *   node scripts/generate-library-index.mjs --meta metadata.tsv
 *
 * The optional --meta flag accepts a TSV file with columns:
 *   filename\tname\tdescription\ttags (comma-separated)\tevent_id
 * Rows are matched by filename (relative to clips/).
 */

import { readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { join, relative, basename, dirname, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIPS_DIR = join(__dirname, '..', 'public', 'library', 'clips')
const OUTPUT_PATH = join(__dirname, '..', 'public', 'library', 'index.json')

// Parse WAV header to extract metadata
function parseWavHeader(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (riff !== 'RIFF') throw new Error('Not a WAV file')

  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))
  if (wave !== 'WAVE') throw new Error('Not a WAVE file')

  // Find fmt chunk
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataSize = 0

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    )
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 'fmt ') {
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
    }

    offset += 8 + chunkSize
    // Chunks are word-aligned
    if (chunkSize % 2 !== 0) offset++
  }

  if (sampleRate === 0) throw new Error('Could not parse WAV header')

  const durationMs = Math.round((dataSize / (channels * (bitsPerSample / 8) * sampleRate)) * 1000)

  return { channels, sampleRate, bitsPerSample, durationMs }
}

// Recursively find WAV files
async function findWavFiles(dir) {
  const results = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await findWavFiles(fullPath))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.wav') {
      results.push(fullPath)
    }
  }
  return results
}

// Generate event_id from filename: "impact/hit-soft.wav" -> "impact.hit-soft"
// Contracts require at least category.name (one dot). Flat files get "clip." prefix.
function filenameToEventId(relPath) {
  const withoutExt = relPath.replace(/\.wav$/i, '')
  const dotted = withoutExt.replace(/\//g, '.').replace(/\\/g, '.').toLowerCase()
  if (!dotted.includes('.')) return `clip.${dotted}`
  return dotted
}

// Generate display name from filename: "hit-soft" -> "Hit Soft"
function filenameToDisplayName(filename) {
  const name = basename(filename, extname(filename))
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Load optional TSV metadata
async function loadMetaTsv(tsvPath) {
  const meta = new Map()
  if (!tsvPath || !existsSync(tsvPath)) return meta

  const content = await readFile(tsvPath, 'utf-8')
  const lines = content.trim().split('\n')
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 2) continue
    const [filename, name, description, tags, eventId] = cols
    meta.set(filename.trim(), {
      name: name?.trim() || undefined,
      description: description?.trim() || undefined,
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      event_id: eventId?.trim() || undefined,
    })
  }
  return meta
}

async function main() {
  // Parse args
  const args = process.argv.slice(2)
  let metaPath = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--meta' && args[i + 1]) {
      metaPath = args[i + 1]
      i++
    }
  }

  if (!existsSync(CLIPS_DIR)) {
    console.log(`clips directory not found: ${CLIPS_DIR}`)
    console.log('Creating empty index.json')
    await writeFile(OUTPUT_PATH, JSON.stringify({
      schema_version: '1.0.0',
      generated_at: new Date().toISOString(),
      clips: [],
    }, null, 2))
    return
  }

  const metaMap = await loadMetaTsv(metaPath)
  const wavFiles = await findWavFiles(CLIPS_DIR)

  console.log(`Found ${wavFiles.length} WAV files`)

  const clips = []
  for (const fullPath of wavFiles) {
    const relPath = relative(CLIPS_DIR, fullPath).replace(/\\/g, '/')
    const category = dirname(relPath) === '.' ? 'uncategorized' : dirname(relPath).split('/')[0]
    const fileInfo = await stat(fullPath)
    const fileBuffer = await readFile(fullPath)

    try {
      const wav = parseWavHeader(fileBuffer)
      const metaOverride = metaMap.get(relPath) || {}

      const clip = {
        id: `builtin/${filenameToEventId(relPath)}`,
        name: metaOverride.name || filenameToDisplayName(relPath),
        category,
        tags: metaOverride.tags || [category],
        event_id: metaOverride.event_id || filenameToEventId(relPath),
        description: metaOverride.description || '',
        filename: relPath,
        duration_ms: wav.durationMs,
        sample_rate: wav.sampleRate,
        channels: wav.channels,
        filesize_bytes: fileInfo.size,
      }
      clips.push(clip)
      console.log(`  ${relPath} (${wav.durationMs}ms, ${wav.sampleRate}Hz, ${wav.channels}ch)`)
    } catch (err) {
      console.error(`  SKIP ${relPath}: ${err.message}`)
    }
  }

  // Sort by category then name
  clips.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))

  const index = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    clips,
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(index, null, 2))
  console.log(`\nGenerated ${OUTPUT_PATH} with ${clips.length} clips`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
