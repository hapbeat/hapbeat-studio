# Studio: font_scale (1x / 2x) UI 露出

**作成日:** 2026-05-08
**起点セッション:** workspace `studio + helper` worktree
**優先度:** 中 (使い道は限定的だが実装コスト小・device 側は既対応で導通テストもすぐ可能)
**関連型:** `DisplayElement.font_scale: 1 | 2` (types/display.ts)

---

## 背景

`font_scale=2` を指定すると要素の文字が縦横 2 倍 (8x16 → 16x32) で描画される。
1 ページ全体が 1 行 × 8 文字に変わるイメージで、「バッテリー残量だけ大きく見せたい」
等のシングル情報フォーカス用途に有用。

- **device 側 (`hapbeat-device-firmware/src/display_manager.cpp:175`)**: 既に対応済。
  `s_textsize = elem.font_scale`、clip 範囲も `elem.width * CELL_W * s_textsize` で
  計算しているので Studio が `font_scale: 2` を JSON に含めるだけで実機が倍角描画する。
- **Studio I/O (`displayLayoutIO.ts`)**: serialize / deserialize 既対応。
- **Studio UI**: 露出されていない (パレット/配置済みカードに 1x/2x 切替が無い)。

→ Studio 側で UI を追加するだけで完結する。

---

## 仕様

### UI 配置案

**A. 配置済みカードの inline トグル** (推奨):
- OLED シミュレータ上に配置されたカードに小さな `1x / 2x` トグル
- カード hover 時のみ表示 (常時だと邪魔)
- クリックで切替 → setLayout で element.font_scale 更新

**B. パレット側の variant picker と統合**:
- 数字ボタン (現状 `4 / 8 / 16` 等) と並べて `1x / 2x` ボタンを配置
- 短所: ドラッグ前に決定する必要がある (配置後の変更ができない)

**A 案推奨** — 配置済みの状態を見ながら font_scale を切替えたいニーズが高いため。
B 案も併用可能だが必須ではない。

### 制約 / バリデーション

font_scale=2 のとき:
- 1 cell = 16x32px → 8 文字/行 × 1 行
- 要素の必要セル数も 2 倍になる (例: 8 文字要素 → 16 セル占有 = 行全体)
- **異要素との並置が不可能**になるケースが多い → 配置時に他要素との衝突チェック必要
- 既存の `canPlace()` (DisplayEditor.tsx:211) を `font_scale` 反映で再計算

### Element 制約

`font_scale=2` を許可するかは要素単位で判断:
- ✅ 単純数値系 (battery, volume, player_number, group_id, page_indicator, position)
- ✅ 短い文字 (volume_mode, connection_status)
- ❌ wide variant (16 文字) — font_scale=2 で 32 文字幅になりはみ出す
- ⚠️ 全 wide variant 要素は `font_scale: 2` ボタンを disabled にする

### 永続化

`displayLayoutIO.ts` で既に `out.font_scale` を JSON に書き出しているので追加対応不要。

---

## 実装ファイル候補

1. **`src/components/display/DisplayEditor.tsx`**:
   - `OledSimulator` 内の placed-card 描画箇所に hover toggle 追加
   - シミュレータ側の `buildGridRows` / `getElementSize` で `font_scale` を反映 (現状は 1 倍前提のはず — 要確認 / 修正)
   - `canPlace()` を font_scale 込みで判定
2. **`src/utils/displayPreview.ts`** または **`displayLayoutIO.ts`**:
   - 必要に応じてプレビュー側のセル幅計算を font_scale 対応
3. (オプション) **`src/components/common/ElementPalette.tsx`**:
   - 各要素のメタに `allowsFontScale: boolean` を追加し、wide variant では false に

---

## 完了条件

- 配置済みカードで `font_scale: 1 / 2` を切替可能
- font_scale=2 の要素を配置するとシミュレータで倍角描画される
- 衝突する場所への font_scale=2 切替は warning or rejected
- export JSON に `font_scale: 2` が反映される
- 既存 layout (font_scale 無し) は backward-compat で表示変化無し

## 検証手順

1. battery_bar を 1 つだけ配置 → 1x/2x トグルで切替 → シミュレータが倍角になる
2. 隣に他要素を配置している状態で 1→2x → 衝突 warning 表示
3. export → JSON に `"font_scale": 2` が出る
4. 実機 deploy → OLED で倍角描画される (device 側既対応)

## 関連参照

- `hapbeat-studio/src/types/display.ts` (font_scale 型定義)
- `hapbeat-studio/src/utils/displayLayoutIO.ts` (シリアライズ既存)
- `hapbeat-device-firmware/src/display_manager.cpp:175` (renderer 既対応)
