#!/usr/bin/env node
/**
 * Cloudflare Pages 用: 凍結版バンドルを 1 つの出力ツリーへ組み立て、versions.json を書く。
 *
 * Cloudflare Pages は deploy 毎に root 全体を atomic 置換するため、FTP のように過去の
 * 凍結版を「積み増し」できない。各凍結版 (studio-site-vX.Y.Z.tar.gz) は tag 時に
 * build-once で GitHub Release アセットへ保存しておき、本番 deploy のたびに全部を
 * ここで out/vX.Y/ へ展開し直して 1 つのツリーにまとめる（最新 = master を root に、
 * 凍結版を /vX.Y/ に）。
 *
 * versions.json は「実在する凍結版」だけを列挙する（git tag からではなく実バンドル
 * から生成）。これにより、まだバンドル化していない過去タグへの版切替リンクが 404 に
 * ならない。マイナー線ごとに最新パッチを 1 つだけ採用する（VersionSwitcher の
 * ロールバック粒度 = マイナー）。
 *
 * Usage: node scripts/cf-assemble-versions.mjs <bundles-dir> <out-dir>
 *   <bundles-dir>: studio-site-vX.Y.Z.tar.gz を集めたディレクトリ
 *   <out-dir>:     wrangler に渡す出力ルート（master ビルド済み）。ここに vX.Y/ を作る。
 *
 * standalone build script（Workflow ツールのスクリプトではない）なので Date / execSync 可。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const bundlesDir = process.argv[2]
const outDir = process.argv[3]
if (!bundlesDir || !outDir) {
  console.error('usage: cf-assemble-versions.mjs <bundles-dir> <out-dir>')
  process.exit(1)
}

// バンドル名から version を拾う: studio-site-v0.2.1.tar.gz → {0,2,1}
const files = existsSync(bundlesDir) ? readdirSync(bundlesDir) : []
const parsed = []
for (const f of files) {
  const m = f.match(/^studio-site-v(\d+)\.(\d+)\.(\d+)\.tar\.gz$/)
  if (!m) continue
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  parsed.push({
    file: join(bundlesDir, f),
    major, minor, patch,
    version: `${major}.${minor}.${patch}`,
    minorKey: `${major}.${minor}`,
  })
}

// マイナー線ごとに最新パッチを採用。
const byMinor = new Map()
for (const p of parsed) {
  const cur = byMinor.get(p.minorKey)
  if (!cur || p.patch > cur.patch) byMinor.set(p.minorKey, p)
}

// 新しい順（major desc, minor desc）に並べる。
const chosen = [...byMinor.values()].sort((a, b) => b.major - a.major || b.minor - a.minor)

const versions = []
for (const p of chosen) {
  const dir = join(outDir, `v${p.minorKey}`)
  mkdirSync(dir, { recursive: true })
  // バンドルは `tar -czf asset -C dist .` で作るので root 直下に展開される。
  // execFileSync は shell を経由しないので、引数のクォート事故が無い。tar の -C には
  // forward-slash を渡す（Linux では無変換、Windows の bsdtar は backslash 相対 -C を
  // 開けないことがあるため）。
  const fwd = (s) => s.replace(/\\/g, '/')
  execFileSync('tar', ['-xzf', fwd(p.file), '-C', fwd(dir)], { stdio: 'inherit' })
  versions.push({ version: p.version, path: `/v${p.minorKey}/` })
  console.log(`[cf-assemble] /v${p.minorKey}/ ← ${p.version}`)
}

const latest = versions[0]?.version ?? null
writeFileSync(
  join(outDir, 'versions.json'),
  JSON.stringify({ latest, versions, generated: new Date().toISOString() }, null, 2) + '\n',
)
console.log(`[cf-assemble] wrote ${join(outDir, 'versions.json')}: ${versions.length} frozen minor line(s)`)
