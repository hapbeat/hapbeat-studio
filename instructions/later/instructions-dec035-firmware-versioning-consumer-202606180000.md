# DEC-035 (S3-fast hotfix + S5): firmware manifest consumer + 動的配信

**親指示書（全体設計・MUST-FIX 含む）**: workspace `docs/instructions-per-firmware-versioning-cloudflare-202606180000.md`
**決定記録**: workspace `docs/decision-log.md` DEC-035

## 🔥 先行 hotfix（S3-fast・schema 非依存・最優先・可逆）
`.github/workflows/deploy.yml:100` の `secrets.FIRMWARE_REPO_PAT` を **両 firmware repo に `contents:read` を持つ fine-grained PAT** に再スコープ。これだけで `gh release list --repo Hapbeat/hapbeat-transmitter-firmware`（`deploy.yml:78-97` の loop）が空→skip にならず、**送信機ファーム（M5Stack Bridge/ライブ）が即 Studio に出る**（2026-06-18 リリースで未反映だった根本原因）。※ PAT 付与はリポジトリオーナー操作。

## consumer タスク（S5・S1 schema merge 後）
- `src/utils/firmwareLibrary.ts`: `FirmwareArtifact` に `contentHash?` / `path?`、version に `buildSha?` 型追加。`normalizeVersion()` + `compareVersions()` を export し **`scripts/aggregate-firmware-manifest.mjs` の `compareVersionsDesc` のバグ（`0.2.0d5` を `0.2.0` より新しく並べる）を修正 + 共有実装に抽出**（親指示書 §9-3）。`toArtifact()`（288-295 行）を `a.path ?? ${PROD_FIRMWARE_BASE}/${filename}` + hash 透過に。
- `src/components/devices/FirmwareSubTab.tsx`: variant tile に version chip、detail panel に installed-vs-offered tri-state バッジ、archive picker title に hash8、`submit` にダウングレード/同一バイト非ブロッキング確認。
- `src/components/devices/OtaController.tsx`: verify（92 行）の両辺を `normalizeVersion` 通す（`v` prefix + `dN` 接尾辞）。hash は post-reboot verify に使わない旨コメント。
- S3-full（Cloudflare）切替後に `deploy.yml` の集約 2 ステップ（`:74-100` / `:111-112`）+ `repository_dispatch` trigger を削除（唯一の不可逆・production 稼働確認後）。

## 完了条件
- `npm run build` + vitest 通過。archive picker が `fwVersion (hash8)` 表示。OTA verify が同一イメージ再書込を success 報告。schema/型/API ingestion を触るので `/self-review` 必須。

> Cloudflare Pages Function（動的 manifest + private repo 用 asset proxy）は `hapbeat-devtools-site` 側の担当。親指示書 §3 / §9-1 参照。
