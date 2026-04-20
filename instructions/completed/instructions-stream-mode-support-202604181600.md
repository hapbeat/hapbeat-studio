# Instructions: Studio に stream mode event サポートと kit scaffold 自動生成を追加

**発行日:** 2026-04-18
**起票:** hapbeat-unity-sdk セッション
**根拠:** workspace `docs/decision-log.md` DEC-023 / DEC-024
**前提:** hapbeat-contracts 側の mode フィールド追加 (`instructions-kit-mode-field-202604181600.md`) が完了済みであること

## 背景

Kit を全モードの single source of truth にする方針 (DEC-023)。現在 Studio は Command mode の event のみを前提にしており、stream_clip / stream_source mode の event を author できない。また Kit の working directory は各 SDK 側が用意し (DEC-024)、Studio はそこに kit ひな型を自動生成する流れにする。

## タスク

### 1. Event 編集 UI に mode 選択を追加

event ごとに以下の 3 モードを選択できる UI を追加:

| Mode | UI 表記 (提案) | clip 必須 | 説明 |
|---|---|---|---|
| `command` | "Command (device plays clip)" | 必須 | 従来モード。device に焼き込まれる wav |
| `stream_clip` | "Stream Clip (SDK streams WAV)" | Optional | Unity などが AudioClip として import する wav。device には焼き込まれない |
| `stream_source` | "Stream Source (SDK captures live AudioSource)" | 不要 | SDK 側が live audio を capture して送る。Kit には audio ファイル不要 |

- 既定値: `command`（既存 kit の読み込み時に mode フィールドが無いものは `command` として扱う、contracts の後方互換と整合）
- mode 選択に応じて clip フィールドの必須性・表示有無を切替
- stream_source mode では clip field 自体を hide

### 2. Stream event の音源ファイル配置

- `stream_clip` mode で clip が指定された場合、wav ファイルは Kit 内の `stream-clips/` サブディレクトリに配置する（Command の `clips/` とは別ディレクトリ）
- 理由: Pack builder が device binary を生成する際に command 音源のみを拾えるようディレクトリレベルで分離しておく
- manifest.json 内の clip パスは `stream-clips/foo.wav` のように記述

### 3. Pack export 時のフィルタ

Studio が `.pack` (device 向けバイナリ) を export する際:

- `mode != "command"` の event は manifest.json には含めるが、device binary の clips/ には対応音源を含めない
- `stream_clips/` ディレクトリは device binary には同梱しない
- device 側 firmware は mode != command の event をスキップする (firmware 側指示書で対応)

または、device 向け manifest.json は command event のみに絞り、Kit 全体 manifest とは別に生成する方法もあり得る（contracts 側の決定に従う）。

### 4. Intensity UI の全モード対応

現在は Command event の intensity スライダがあると想定。これを **stream mode でも同じスライダを表示**する。意味は変わらず `WAV振幅 × intensity × SDK_gain × デバイス音量` の 2 layer 目。

- stream_source mode でも intensity を設定可能にする（SDK が実行時に乗算する基準値）
- intensity 0-1 の範囲、default 1.0

### 5. Working Directory 指定時の kit scaffold 自動生成

ユーザーが Studio 上で working directory を指定した際、そこが空（または manifest.json が存在しない）なら以下を自動生成:

```
<working-dir>/
└── <kit-id>/                    (ユーザーが kit 名を入力、命名規則は pack-format.md §4)
    ├── manifest.json            (skeleton)
    ├── clips/                   (空ディレクトリ、command 用)
    └── stream-clips/            (空ディレクトリ、stream_clip 用)
```

manifest.json skeleton 例:

```json
{
  "schema_version": "1.0.0",
  "pack_id": "<kit-id>",
  "version": "0.1.0",
  "name": "<kit-id>",
  "description": "",
  "author": "",
  "created_at": "<ISO 8601 now>",
  "target_device": { "firmware_version_min": "0.1.0" },
  "events": {},
  "clips": {}
}
```

### 6. Unity Assets 配下の working directory 対応

SDK 側 (Unity 等) が `Assets/HapbeatKits/` を作成する導線 (DEC-024) に合わせて、Studio が working directory としてそのパスを許容できるようにする。現在許容しているなら何もしなくて良いが、以下を確認:

- 特殊文字を含むパス (Windows の日本語ユーザー名パスなど) でも正しく書き込めること
- AssetDatabase が即座に反映するため、manifest.json 書き込み後にブラウザ側が余計な delay なく次アクションに進めること

### 7. README への SDK 導線案内（任意）

Studio の UI 上で「SDK 使用者向けには各 SDK が提供する `HapbeatKits/` フォルダを working directory に指定することを推奨」という注記を表示すると親切。特に Unity ユーザーには「Unity で `Hapbeat > Setup > Create HapbeatKits Folder` を実行すると、README 付きの空ディレクトリが作成されます」と案内。

## 完了条件

- [ ] Event 編集 UI に mode 選択 (command / stream_clip / stream_source) を追加
- [ ] mode に応じた clip 必須性の切替
- [ ] stream_clip wav の保存先を `stream-clips/` に分離
- [ ] Pack export で mode=command のみを device binary に含めるフィルタ
- [ ] Stream mode でも intensity スライダが機能
- [ ] Working directory 指定時に kit scaffold 自動生成
- [ ] manifest.json に mode フィールドを書き出す (contracts の mode 追加に追従)
- [ ] 後方互換: mode フィールドが無い既存 manifest を読み込むと command として扱う
- [ ] 本 instructions ファイルを `instructions/completed/` に移動

## 依存関係

- **Required**: hapbeat-contracts の `instructions-kit-mode-field-202604181600.md` が完了していること（manifest schema に mode が入っている状態）
- **Parallel**: hapbeat-pack-tools, hapbeat-device-firmware 側の対応が並行して進む
- **Downstream**: hapbeat-unity-sdk 側の HapbeatKitAsset / HapbeatEventMap.linkedKit 実装は Studio の stream event 書き出しが動いてから着手

## 検証

- 既存 `hand-demo-kit/manifest.json` (mode 無し) を読み込むと全 event が command 扱いになる
- 新規 stream_source event を作成 → manifest.json に `"mode": "stream_source"` + `clip` 無しで書き出される
- 新規 stream_clip event で wav を drop → `stream-clips/` に保存され、manifest の clip パスが `stream-clips/foo.wav` になる
- pack export で device binary の clips/ に stream_clips 配下の wav が含まれない
- kit scaffold 自動生成が空ディレクトリで動作し、`clips/` と `stream-clips/` を両方作る
