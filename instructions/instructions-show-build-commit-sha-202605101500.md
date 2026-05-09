# Studio: Manage タブで `cmdGetInfo.build` (commit hash) を表示

**起票:** workspace session 2026-05-10 (firmware FIRMWARE_VERSION 自動生成化)
**優先度:** 中 (UX 改善 — 開発ビルドの識別が現状文字列だけで分かりにくい)
**関連 commit:** hapbeat-device-firmware `1be8711` (build: FIRMWARE_VERSION を git 自動生成化)

## 背景

device-firmware を「リリース直後に NEXT_RELEASE_VERSION を 1 回 bump、開発期間中は手動 bump 不要、`<base>d<N>` 形式の dev counter を git 自動生成」運用に変更した (firmware commit `1be8711`)。

新運用での FIRMWARE_VERSION 例:
- リリース commit: `0.1.1` (suffix なし)
- 開発 commit: `0.1.2d3` (NEXT_RELEASE_VERSION + dN, N = v* タグからの commit 数)

`cmdGetInfo` レスポンスに新フィールド `build` (BUILD_COMMIT_SHA, 7 char short hash) を追加した。Studio はこれを Manage タブに表示することで、同じ `0.1.2d3` でも別 commit のビルドを区別できるようにする。

## 現状

- `src/components/devices/DeviceDetail.tsx:137` 周辺で `get_info_result` を処理し、`fw` フィールドのみ抽出している (`p.fw as string | undefined`)
- カードヘッダーには `· fw {device.firmwareVersion}` が出ている (line 378 周辺)

## 修正内容

### 1. DeviceDetail.tsx の `get_info_result` ハンドラに `build` を追加

```ts
// 137 行目付近
if (t === 'get_info_result' && typeof p.device === 'string') {
  // ...既存処理...
  fw: p.fw as string | undefined,
  build: p.build as string | undefined,  // ← 追加
}
```

`device` ステート / `firmwareVersion` の sibling として `buildCommit` などを保持。

### 2. UI 表示

カードヘッダーの fw 表記を拡張:

```tsx
{device.firmwareVersion && (
  <>
    {' '}· fw {device.firmwareVersion}
    {device.buildCommit && (
      <span className="text-xs opacity-60"> ({device.buildCommit})</span>
    )}
  </>
)}
```

例: `· fw 0.1.2d3 (1be8711)`。リリースビルド (`0.1.1`) でも commit hash は出るが情報量を増やすだけなので問題なし。隠したい場合は `firmwareVersion` に `d` が含まれる場合のみ build を出す条件分岐でも可。

### 3. Helper 経由のフィールド転送

helper の `get_info_result` 中継処理 (`src/hapbeat_helper/server.py` 内 `cmdGetInfo` レスポンス整形) で `build` フィールドが落ちないか確認。helper 側で field allowlist を持っていれば `build` を追加。落とさず素通しなら追加作業不要。

→ 別途 `hapbeat-helper/instructions/` に確認 instruction を起票するか、Studio セッションで grep してみるかどちらかで対応。

## 完了条件

- [ ] DeviceDetail で `get_info_result.build` を取得・state 保持
- [ ] カードヘッダーに commit hash を併記表示 (リリースビルドでも一律 or `d` 含む時のみ)
- [ ] Helper 中継で `build` フィールドが落ちないこと確認
- [ ] firmware を v0.1.2d2 等にビルドして実機接続、Manage タブで `0.1.2d2 (xxxxxxx)` の表示を確認
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**: hapbeat-device-firmware `1be8711` 以降 (cmdGetInfo に `build` フィールド追加済)
- **Downstream**: なし
