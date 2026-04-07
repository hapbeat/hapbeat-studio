# 指示書: Kit Export（Pack 形式出力）および Display/LED デプロイ実装

- **作成日**: 2026-04-07
- **作成元**: hapbeat-sdk-workspace マイルストーン計画セッション
- **対象リポジトリ**: hapbeat-studio
- **目的**: ユーザーが Studio で Kit を作成し、Manager 経由でデバイスに書き込めるようにする

---

## 背景

現在 Studio には Kit 管理 UI（KitManager コンポーネント）が実装済みだが、以下が未実装（"Coming soon" スタブ）:

1. **Kit Export** — Kit を Pack 形式（manifest.json + clips/）でエクスポートする機能
2. **Kit Deploy** — Manager（WebSocket localhost:7703）経由で Pack をデバイスに転送する機能
3. **Display Deploy** — DisplayEditor から Manager 経由でレイアウトをデバイスに書き込む機能

WebSocket クライアント（useManagerConnection フック）と Manager 側の受信ハンドラ（deploy_pack, write_ui_config）は既に実装済み。Studio 側の「送信トリガー」部分を繋ぐ作業が中心。

---

## タスク一覧

### タスク 1: Kit Export — Pack 形式ディレクトリの生成

**対象ファイル**: `src/components/kit/KitManager.tsx`, 新規 `src/utils/kitExporter.ts`

**仕様**:
- Kit の内容を hapbeat-contracts の Pack 形式に変換してダウンロードさせる
- 出力形式: ZIP ファイル（JSZip は既に依存に含まれている）
- ZIP 内構造:
  ```
  <pack-id>/
    manifest.json
    clips/
      <clip-file-1>.wav
      <clip-file-2>.wav
  ```

**manifest.json の生成ルール**（hapbeat-contracts/specs/pack-format.md 準拠）:
```json
{
  "schema_version": "1.0.0",
  "pack_id": "<kit の ID を kebab-case に変換>",
  "version": "<kit の version、デフォルト '1.0.0'>",
  "name": "<kit の名前>",
  "description": "<kit の説明>",
  "author": "",
  "created_at": "<ISO 8601>",
  "target_device": {
    "firmware_version_min": "0.1.0"
  },
  "events": {
    "<event_id>": {
      "clip": "clips/<filename>.wav",
      "description": "",
      "tags": [],
      "parameters": {
        "gain": <KitEvent の gain, デフォルト 1.0>,
        "loop": <KitEvent の loop, デフォルト false>
      }
    }
  },
  "clips": {
    "clips/<filename>.wav": {
      "duration_ms": <clip メタデータから>,
      "sample_rate": <clip メタデータから>,
      "channels": <clip メタデータから>,
      "format": "pcm"
    }
  }
}
```

**実装手順**:
1. `src/utils/kitExporter.ts` を新規作成
   - `exportKitAsPack(kit: KitDefinition, clips: LibraryClip[]): Promise<Blob>` 関数を実装
   - IndexedDB から該当クリップの audio blob を取得
   - manifest.json を生成
   - JSZip で ZIP 化して Blob を返す
2. `KitManager.tsx` の「Export Kit」ボタン（現在 "Coming soon"）を実装に差し替え
   - `exportKitAsPack()` を呼び、結果を `<a download>` でダウンロードさせる
3. Event ID のバリデーション — contracts の正規表現 `^([a-z][a-z0-9_-]{0,63}/)?[a-z][a-z0-9_-]{0,63}(\.[a-z][a-z0-9_-]{0,63}){1,3}$` に合致しないイベントがあれば、エクスポート前に警告を表示

**pack_id の生成ルール**:
- Kit 名を lowercase にし、スペースをハイフンに置換
- `^[a-z][a-z0-9-]*$` に合致するように正規化
- 合致しない文字は除去

---

### タスク 2: Kit Deploy — Manager 経由の Pack 転送

**対象ファイル**: `KitManager.tsx`, `src/hooks/useManagerConnection.ts`

**仕様**:
- 「Write to Device」ボタンを実装する
- Manager が接続されていない場合はボタンを disabled にし、ツールチップで「Manager に接続してください」と表示
- Manager 接続中は、Kit を Pack 形式に変換し `deploy_pack` メッセージで Manager に送信

**問題点と対応**:
- 現在の Manager の `deploy_pack` は `pack_dir`（ファイルパス）を期待する
- Studio は Web アプリなのでローカルファイルパスを直接指定できない
- **解決策**: Studio は Pack の内容を ZIP blob として Manager に送信するのではなく、**まずユーザーに ZIP をダウンロードさせ、Manager の Content ページから転送してもらう**ワークフローとする
- 将来的に Manager 側に WebSocket 経由のバイナリ受信を追加すれば直接転送が可能になるが、現段階ではファイル経由の2ステップで十分

**実装**:
1. 「Write to Device」ボタンのラベルを「Export & Transfer」に変更
2. ボタン押下時:
   - Kit を ZIP エクスポート（タスク1 の関数を使用）
   - ダウンロードダイアログを表示
   - 「Manager の Content ページから転送してください」のインフォメーションを表示
3. Manager 接続中の場合は、追加で「Manager で転送可能なデバイスが N 台あります」を表示

---

### タスク 3: Display Layout Deploy — Manager 経由書き込み

**対象ファイル**: `src/components/display/DisplayEditor.tsx`, `src/hooks/useManagerConnection.ts`

**仕様**:
- DisplayEditor の「Deploy」ボタンを実装する
- Manager 接続時に、現在のレイアウト設定を `write_ui_config` メッセージで Manager に送信
- Manager 未接続時はボタンを disabled にし、「Manager に接続してください」と表示

**送信データ形式**（Manager の ws_server.py の write_ui_config ハンドラに合致させる）:
```json
{
  "type": "write_ui_config",
  "payload": {
    "config": {
      "display": {
        "grid": [16, 2],
        "pages": [...],
        "button_actions": {...},
        "orientation": "normal",
        "device_model": "duo_wl"
      },
      "led": {
        "rules": [...]
      },
      "volume": {
        "steps": 24,
        "direction": "ascending",
        "default_level": 12
      }
    }
  }
}
```

**実装手順**:
1. `displayLayoutIO.ts` の既存変換ロジック（Studio 内部形式 → firmware 形式）を利用して config オブジェクトを構築
2. LED rules も含めて config に統合
3. `useManagerConnection` の `send()` で送信
4. Manager からの `write_result` レスポンスを受信してユーザーに結果を表示（成功 / 失敗）
5. 送信中はボタンにローディング表示

**レスポンスハンドリング**:
- `useManagerConnection.ts` に `write_result` メッセージのハンドラを追加
- 成功時: トースト通知「デバイスに書き込みました」
- 失敗時: エラーメッセージを表示

---

### タスク 4: LED Config Deploy（Display Deploy に統合）

**対象**: タスク 3 に含める

- Display Deploy の config オブジェクトに LED rules を含める
- 単独の LED Deploy ボタンは不要（Display + LED + Volume は1つの `write_ui_config` で一括送信）

---

## 実装上の注意

1. **contracts 準拠**: manifest.json の構造、Event ID の形式は hapbeat-contracts に厳密に従うこと
2. **エラーハンドリング**: IndexedDB からのクリップ取得失敗、WebSocket 送信失敗は適切にユーザーに通知すること
3. **既存コード優先**: 新規ファイルは `kitExporter.ts` のみ。他は既存ファイルの修正で対応する
4. **Manager 側の変更は不要**: 現在の Manager WebSocket ハンドラ（write_ui_config, deploy_pack）はそのまま使用可能
5. **テスト**: Manager 未接続でも Kit Export（ZIP ダウンロード）は単独で動作すること

---

## 完了条件

- [ ] Kit Export ボタンで Pack 形式の ZIP がダウンロードできる
- [ ] manifest.json が contracts の pack-manifest.schema.json に準拠している
- [ ] Event ID バリデーションが動作する
- [ ] Display Deploy ボタンで Manager 経由のレイアウト書き込みが動作する
- [ ] Manager 未接続時は Deploy ボタンが適切に disabled になる
- [ ] write_result レスポンスの成功/失敗がユーザーに通知される
