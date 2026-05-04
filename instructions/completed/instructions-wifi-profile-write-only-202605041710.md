# Instructions: Wi-Fi プロファイル編集 UI を write-only 仕様に追従

**発行日:** 2026-05-04
**起票:** workspace (helper セキュリティ調査セッション)
**優先度:** 高（device-firmware の write-only 化に追従する必要がある）
**前提:** `hapbeat-device-firmware/instructions/instructions-list-wifi-profiles-redact-pass-202605041700.md` の実装後に着手

## 背景

device-firmware が `list_wifi_profiles` レスポンスから `pass` を削除し、代わりに `has_pass: boolean` を返すように変更される（API キー方式：パスワードは書き込みのみ可能で、読み出し不可）。

Studio の `WifiProfilesForm.tsx` は現状 `setPassword(p.pass ?? '')` で既存パスワードを編集 UI に復元しているが、firmware 修正後は `p.pass` が常に undefined になるため UX を変える必要がある。

## 期待する変更

### 1. `src/components/devices/WifiProfilesForm.tsx`

#### 1-a) `WifiProfile` 型に `has_pass?: boolean` を追加

`pass` フィールドは（contracts と合わせて）型から削除する。`has_pass` のみ持つ。

#### 1-b) 編集モード時に password 欄を空のまま開く

```ts
// 旧:
setPassword(p.pass ?? '')

// 新:
setPassword('')   // 編集時は常に空欄。上書きするには再入力必須。
```

#### 1-c) 一覧の各 row に「保存済み」表示を追加

`has_pass === true` の行に小さな鍵アイコンや `🔒` を表示し、ユーザーに「パスワードは保存されているが表示できない」ことを伝える。

#### 1-d) password フィールドのプレースホルダー文言

編集モード時:
```
（変更する場合のみ入力。空欄なら現在のパスワードを維持）
```

ただし firmware 仕様上、空欄送信時の動作は contracts で確認が必要:
- 空文字を送ると pass を空に上書きする → ユーザー入力ありの場合のみ更新する処理が必要
- 空送信を「変更なし」として扱う → そのまま空送信で OK

→ contracts ドキュメント（または実機確認）で挙動を決めてから実装。**安全側**として「password 入力欄が空の場合は payload に pass フィールド自体を含めない」を推奨。

### 2. `src/components/devices/WifiForm.tsx`（新規追加用フォーム）

このフォームは元々新規追加専用なのでパスワード必須のまま。変更不要だが、**プレースホルダー文言を「Wi-Fi パスワード（保存後は確認できなくなります）」** などに変えると親切。

## 完了条件

1. `WifiProfile` 型から `pass` が消え、`has_pass` のみ
2. 編集モードで開いた時、password フィールドが空欄のまま開く
3. 「保存済み」表示が一覧 row に出る
4. 空欄で submit 時の挙動が contracts/firmware と整合（空送信で破壊しない）
5. dev サーバーで Wi-Fi プロファイル一覧 → 編集 → 保存 → 再読込のサイクルが破綻しないこと

## 関連

- device-firmware: `instructions/instructions-list-wifi-profiles-redact-pass-202605041700.md`
- helper: `docs/security.md` の Wi-Fi セクションは write-only 化を反映済み
