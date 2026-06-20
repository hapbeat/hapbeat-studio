# Instructions: USB Serial 複数同時接続 + Devices カード統合（multi-select 書き込み）

**発行日:** 2026-06-12
**起票:** workspace セッション（ATOM ノード bring-up 中のユーザー要望）
**優先度:** 中（次の Studio セッションで着手）

## ユーザー要望（原文要約)

> usb serial を複数同時に接続することは可能？複数台同時に書きこむなどのときに、ファーム未書き込みの状態でも devices に vid や port など読み取れる内容を表示→チェックで選択したものを対象に書きこむ（wifi 接続時と同じ UX）ようにできると嬉しい。

## 技術的事実（調査済み）

1. **Web Serial は複数ポート同時 open 可能**。`serialMaster.ts` 冒頭コメントの「ONE consumer per port」は「1 ポートにつき reader は 1 つ」の意味であり、ブラウザ全体で 1 ポートの制約ではない。
2. `navigator.serial.requestPort()` は **1 回のユーザージェスチャで 1 ポート**しか選べない（ピッカー UI 制約）。ただし一度許可したポートは `navigator.serial.getPorts()` で**プロンプトなしに再取得できる**（origin 単位で永続）。→「+ Serial デバイス追加」ボタンを台数分クリックしてもらう UX になる。
3. **Web Serial は COM ポート名を公開しない**。`port.getInfo()` で取れるのは `usbVendorId` / `usbProductId` のみ。カード表示は「ブリッジ種別 (FTDI / CP210x / native USB-CDC) + VID:PID」と、probe (get_info) が通れば name/fw/role/board/mac を出す。**ファーム未書き込み（probe 失敗）でも VID:PID カードは出す**のが要望の肝。
4. esptool-js は別ポートなら並列 flash も技術的に可能だが、**初版は直列**（1 台ずつ順次、進捗をカードごとに表示）で十分。失敗時の切り分けも直列の方が明快。

## 現状アーキテクチャ（変更対象）

- `src/stores/serialMaster.ts` — **シングルポート前提**の Zustand store（mode: idle/config/flashing、probe、deviceInfo を 1 つだけ保持）。617 行。
- 消費者: `OnboardingWizard.tsx` / `SerialConfigSection.tsx` / `FirmwareSubTab.tsx` / `DeviceList.tsx` / `DeviceDetail.tsx` / `useDeviceTransport.ts`。
- Wi-Fi 側の multi-select 書き込みは `selectedIps` → `targets[]`（FirmwareSubTab → helper OTA）が既存実装。これと同じ見た目に揃える。

## 設計案

### 1. serialMaster → serialRegistry への拡張

```ts
interface SerialPortEntry {
  id: string                  // 内部キー (vid:pid + 連番 or granted順 index)
  port: SerialPort
  bridge: 'ftdi' | 'cp210x' | 'ch340' | 'native' | 'unknown'   // VID から
  vid: number; pid: number
  mode: 'idle' | 'config' | 'flashing'
  probe: ProbeKind
  info?: SerialDeviceInfo     // get_info 成功時のみ
  flashProgress?: FlashProgress
}
// store: Map<string, SerialPortEntry> + selectedIds: Set<string>
```

- 起動時 + 「+ 追加」時に `getPorts()` を同期して granted ポートを全部 entry 化する。
- `disconnect` / `connect` イベント (`navigator.serial.addEventListener`) で物理抜き差しを反映。
- 既存の単一選択 API (`useSerialMaster`) は**互換 shim として残さない**。消費者 6 ファイルを registry ベースに書き換える（後方互換レイヤー禁止ルール）。

### 2. Devices リストへのカード統合

- `DeviceList.tsx` に Wi-Fi デバイスカードと並べて Serial エントリのカードを出す（既存の `serial:<mac>` pseudo-device 機構を `serial:<entryId>` に一般化）。
- probe 成功: 名前 + fw + role バッジ表示（Wi-Fi カードと同等の見た目）。
- probe 失敗（未書き込み etc.）: `FTDI (0403:6001)` のようなブリッジ表記のみのカード。**チェックボックスは出す**（書き込み対象に選べる）。
- カードにモード badge（config / flashing / idle）。

### 3. multi-select flash

- FirmwareSubTab の書き込み先选択に Serial カードの checkbox 群を追加（Wi-Fi の selectedIps と同じ UI パターン）。
- 実行は **直列**: 選択 entry を順に flash → 各カードに進捗バー。1 台失敗しても残りは継続し、最後にサマリ（成功 n / 失敗 m）。
- flash 中も他カードの表示は生きている（registry が per-entry state なので自然に実現）。

### 4. baud / reset は既存ロジックを per-entry に適用

- `configBaudForPort` / `flashBaudForPort` / `resetClassicEsp32IntoApp` は port 単位の関数なのでそのまま使える。

## 完了条件

- [ ] 2 台以上の USB serial デバイスを同時に「+ 追加」でき、Devices にカードが並ぶ。
- [ ] ファーム未書き込みデバイスも VID:PID カードとして表示され、選択できる。
- [ ] チェックした複数台に対し順次 flash が走り、per-card 進捗が出る。
- [ ] 既存の単独フロー（onboarding / 設定タブ / 単独 flash）が registry ベースで退行なく動く。
- [ ] `useSerialMaster` 単一ポート API の残骸が残っていない。

## 備考

- COM ポート番号が出せない点はユーザーに伝達済みの前提で UI 文言を作る（「ポート名は表示できないため、ブリッジ種別と probe 結果で識別します」）。
- 並列 flash 化は直列版の安定後に検討（esptool-js は別ポートなら原理上可能）。
