# Instructions: Wi-Fi SSID 候補は毎回デバイス側スキャンに統一

**発行日:** 2026-04-30
**起票:** Onboarding 改善セッション末尾
**優先度:** 即着手

## 現状

`WifiProfilesForm.tsx` の SSID 入力には 2 つの候補ソースが混じっている:

```tsx
<datalist id={ssidHistory.historyId}>
  {ssidHistory.history.map(h => <option value={h}>履歴</option>)}
  {scanResults?.map(n => <option value={n.ssid}>{n.rssi} dBm…</option>)}
</datalist>
```

1. **`useInputHistory('wifi-ssid')` の localStorage 履歴**
2. **`scanResults`** (デバイスから `scan_wifi` で返ってきたもの)

## ユーザー要望

**SSID 候補は履歴ではなく、毎回デバイス側スキャン結果のみで表示する。**

理由:
- 履歴 SSID は古かったり別ロケーションで使ったものが残るので misleading
- デバイスは Studio の PC とは別の場所にあるので、デバイスが見えている
  SSID = ユーザーが設定したい SSID という対応関係
- 「保存されている SSID」(= プロファイル一覧) は別途 `profiles` で表示
  しているので履歴とは違う

## タスク

### `WifiProfilesForm.tsx`
1. `ssidHistory.history.map(...)` を `<datalist>` から削除
2. `useInputHistory('wifi-ssid')` 自体は **削除** (commit / persist もやめる)
3. `scanResults` のみが datalist の source
4. add 開時の auto-scan は維持
5. 手動「⟳ スキャン」ボタンは維持
6. scan 失敗時 (firmware 古い / 応答 timeout): 「スキャン結果なし。SSID を
   手動入力してください」と明示

### `SerialConfigSection.tsx` (前セッションで forms 撤去済 — 確認のみ)
- もう wifi forms を含まないので作業不要

### `IdentityForm.tsx` の name history は維持
- name は履歴があると便利 (5 台に同じ命名規則を付ける時の利便性)
- prefix も同様

## 完了条件

- [ ] SSID 入力欄の datalist は `scan_wifi` 応答のみ表示
- [ ] localStorage の `hapbeat-studio-history-wifi-ssid` は読み書きされない
- [ ] scan 失敗時のメッセージが分かりやすい
- [ ] 本ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**: firmware の `scan_wifi` cmd (適用済み instruction
  `instructions/applied/applied-scan-wifi-and-tcp-retry-202604301800.md`)
- **Downstream**: nvs_get_str ログスパム抑制 (firmware) が完了すると
  scan_wifi の応答時間が安定する
