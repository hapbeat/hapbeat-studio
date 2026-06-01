#!/usr/bin/env node
/**
 * extract-kit-template.mjs
 *
 * Save Folder で吐かれた kit フォルダから、配布用に「重複なしの音声
 * ファイルだけ」を抽出して別フォルダにコピーする。受け取り側ユーザー
 * は出力フォルダ内の WAV をそのまま Studio の Library workdir に
 * drop して clip テンプレートとして使える。
 *
 * 配布物に何を含めるかの判断:
 *
 *   - `install-clips/*.wav`  — source channel 数保持の canonical 版。
 *                              command (FIRE) モードの再生用。
 *   - `stream-clips/*.wav`   — 常に stereo 16 kHz。SDK 側ストリーミング
 *                              用。mono source なら install を duplicate
 *                              しただけの再 encode 物 = 中身ほぼ同じ。
 *
 *   → 同じファイル名が両方にあれば install を優先 (小さい/正規)。
 *     片方にしか無ければそれを採用。
 *
 *   テンプレ受け取り側 (= 別ユーザーが Studio で使う) は、その WAV を
 *   ベースに自由に kit を組み直す → Studio 側で install / stream を
 *   再生成するので、配布物には install 側だけあれば情報損失なし。
 *
 * Usage:
 *
 *   node scripts/extract-kit-template.mjs <input-kit-folder> [output-dir]
 *
 * Defaults:
 *   output-dir = `<CWD>/<kit-name>-template/`
 *
 * Examples:
 *
 *   # 既定の隣接出力
 *   node scripts/extract-kit-template.mjs ~/Hapbeat/library/showcase-kit
 *   # → ./showcase-kit-template/showcase-kit/*.wav
 *
 *   # 明示出力先
 *   node scripts/extract-kit-template.mjs ~/Hapbeat/library/showcase-kit ~/Desktop/share
 *   # → ~/Desktop/share/showcase-kit/*.wav
 */

import { readdir, stat, copyFile, mkdir } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { existsSync } from 'node:fs'

async function listWavFiles(dir) {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.wav'))
    .map((e) => e.name)
}

async function main() {
  const [inputArg, outputArg] = process.argv.slice(2)
  if (!inputArg) {
    console.error('Usage: node scripts/extract-kit-template.mjs <input-kit-folder> [output-dir]')
    process.exit(2)
  }

  const inputDir = resolve(inputArg)
  if (!existsSync(inputDir)) {
    console.error(`Input folder not found: ${inputDir}`)
    process.exit(1)
  }

  const inputStat = await stat(inputDir)
  if (!inputStat.isDirectory()) {
    console.error(`Input is not a directory: ${inputDir}`)
    process.exit(1)
  }

  const kitName = basename(inputDir)
  const outputBase = outputArg
    ? resolve(outputArg)
    : resolve(process.cwd(), `${kitName}-template`)
  const outputDir = join(outputBase, kitName)

  console.log(`[extract-kit-template]`)
  console.log(`  input : ${inputDir}`)
  console.log(`  output: ${outputDir}`)
  console.log('')

  const installDir = join(inputDir, 'install-clips')
  const streamDir = join(inputDir, 'stream-clips')
  const installFiles = await listWavFiles(installDir)
  const streamFiles = await listWavFiles(streamDir)

  if (installFiles.length === 0 && streamFiles.length === 0) {
    console.error('No WAVs found in install-clips/ or stream-clips/ — is this a kit folder?')
    process.exit(1)
  }

  await mkdir(outputDir, { recursive: true })

  // Dedupe by filename. install-clips wins because:
  //   - mono source: install is the canonical mono; stream is duplicated
  //     stereo (redundant on import side, Studio will re-derive).
  //   - stereo source: install also stereo; stream is bit-equivalent.
  // Either way, install carries the same information at smaller size.
  const installSet = new Set(installFiles)
  const copied = []
  const skipped = []

  for (const f of installFiles) {
    await copyFile(join(installDir, f), join(outputDir, f))
    copied.push({ from: 'install-clips', file: f })
  }
  for (const f of streamFiles) {
    if (installSet.has(f)) {
      skipped.push({ from: 'stream-clips', file: f, reason: 'duplicate of install' })
      continue
    }
    await copyFile(join(streamDir, f), join(outputDir, f))
    copied.push({ from: 'stream-clips', file: f })
  }

  // Report
  console.log(`Copied ${copied.length} file(s):`)
  for (const c of copied) console.log(`  ${c.from}/${c.file}`)
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} duplicate(s) from stream-clips:`)
    for (const s of skipped) console.log(`  ${s.file}`)
  }
  console.log(`\nDone. ${copied.length} WAV(s) at ${outputDir}`)
  console.log(`Recipient: drop the "${kitName}/" folder into their Studio Library workdir's clips/ directory to use as templates.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
