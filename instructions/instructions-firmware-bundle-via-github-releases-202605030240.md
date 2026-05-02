# Instructions: Studio production の firmware fetch を GitHub Releases 経由にする (B 案)

**発行日:** 2026-05-03
**起票:** mac 動作検証セッション (workspace)
**優先度:** 高（devtools.hapbeat.com 経由のオンボーディング体験で必須）
**対象 repo:** `hapbeat-studio` + `hapbeat-device-firmware`

## 背景

現在 `vite.config.ts` の `firmwareDevPlugin` は **`apply: 'serve'` (dev のみ)**
で、ローカル `../hapbeat-device-firmware/.pio/build/<env>/firmware_*.bin` を
直接読んで配信している。本番 build (npm run build) には何も埋め込まれず、
deployed Studio (https://devtools.hapbeat.com/studio/) から **firmware の
書き込みもファーム選択もできない**。

`firmwareLibrary.ts` のコメントにも明記:

> Production: when devtools.hapbeat.com gets a CDN of canonical firmware
> builds, replace `firmwareBaseUrl()` with that URL.

mac でクリーン環境のユーザーが onboarding する想定では production 側で
ファームが取れることが前提なので、この穴を埋める必要がある。

## 方針 (DEC候補): GitHub Releases から runtime fetch (B 案)

### 比較した代替案

- **A. Studio dist に bundle** (`public/firmware-builds/`)
  - 短所: dist が +2 MB / 更新ごとに studio repo に commit、git diff 肥大
- **C. CDN (Xserver `/firmware/`) に直 upload**
  - 短所: deploy workflow が複雑 (firmware artifact のフェッチ→アップロード)
  - Xserver の FTP deploy 自体が今 timeout で失敗中
- **B. GitHub Releases (本提案)**
  - 長所: Studio dist が小さい / firmware と Studio をデカップル / CORS 許可済 /
    public release は token 不要
  - 必要条件: `hapbeat-device-firmware` repo を public 化 (Helper 同様の流れで OK)

`hapbeat-helper` を TestPyPI/PyPI 公開する流れと同じく、firmware repo も
ユーザー向けの公開可能な箱に切り出すのが一貫性高い。

## 実装ステップ

### Step 1: hapbeat-device-firmware repo を public 化

- `hapbeat-helper` 公開時に行ったチェック観点を同じく適用:
  - secret/token/key/.env のコミット履歴チェック (`git log -p --all`)
  - 個人情報・絶対パス・固定 IP の漏洩
  - LICENSE と pyproject (or platformio.ini) author email
- secrets が無いことを確認したら `gh repo edit hapbeat/hapbeat-device-firmware
  --visibility public --accept-visibility-change-consequences`

### Step 2: hapbeat-device-firmware で release を切る

GitHub Actions で **tag push に応じて release artifact を作る** workflow:

```yaml
# .github/workflows/release.yml (案)
name: Firmware Release
on:
  push:
    tags:
      - 'v*'
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        env: [necklace_v3_claude, band_v3_claude]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install platformio
      - run: pio run -e ${{ matrix.env }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.env }}-fw
          path: |
            .pio/build/${{ matrix.env }}/firmware_app_ota.bin
            .pio/build/${{ matrix.env }}/firmware_full_serial.bin
  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - name: Generate manifest.json
        run: |
          # 各 env / 各 .bin から size, mtime, fwVersion を抽出して
          # manifest.json を生成する script (要実装)
          node ./.github/scripts/generate-manifest.mjs
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            **/firmware_app_ota.bin
            **/firmware_full_serial.bin
            manifest.json
```

(各 .bin はファイル名衝突を避けるため `<env>_firmware_app_ota.bin` のように
prefix リネームするのが現実的。後述の URL pattern と合わせる)

### Step 3: Studio の firmwareBaseUrl を切替

`src/utils/firmwareLibrary.ts` に環境分岐を追加:

```ts
const PROD_FIRMWARE_RELEASE = 'https://github.com/Hapbeat/hapbeat-device-firmware/releases/latest/download'

function firmwareBaseUrl(): string {
  // dev は Vite middleware (apply:'serve' で /firmware-builds/ を提供)
  if (import.meta.env.DEV) return '/firmware-builds'
  // prod は GitHub Releases
  return PROD_FIRMWARE_RELEASE
}
```

`listFirmwareBuilds()` の `/list` 呼び出しを以下に置換:

- prod: `${PROD_FIRMWARE_RELEASE}/manifest.json` を fetch して parse
  (release artifact に `manifest.json` を含める)
- dev: 既存の dev plugin が返す JSON

`fetchArtifact()` も以下のリネーム規約で動くように:

- dev: `/firmware-builds/<env>/<stem>.bin` (現状維持)
- prod: `${PROD_FIRMWARE_RELEASE}/<env>_<stem>.bin`

### Step 4: manifest.json の形

```json
{
  "envs": [
    {
      "env": "necklace_v3_claude",
      "fwVersion": "v0.5.1",
      "appOta": {
        "filename": "necklace_v3_claude_firmware_app_ota.bin",
        "size": 1234567,
        "mtime": 1714723200000
      },
      "fullSerial": {
        "filename": "necklace_v3_claude_firmware_full_serial.bin",
        "size": 1556789,
        "mtime": 1714723200000
      }
    }
  ]
}
```

`manifest.json` は GH Actions の release step で `.pio/build/` を走査して
自動生成する script を `.github/scripts/generate-manifest.mjs` に置く。

### Step 5: 動作確認

- ローカル dev: 従来通り動くこと (`apply:'serve'` plugin が変わらない)
- prod: `npm run build && npm run preview` で dist を web server 起動 →
  Studio が GH Releases から正しく fetch するか
- Mac クリーン環境: deployed Studio で USB Serial flash が完走するか
  (これが最終ゴール)

## 完了条件

- [ ] `hapbeat-device-firmware` repo を public 化
- [ ] `hapbeat-device-firmware/.github/workflows/release.yml` で tag push で
      release が切れる (tag を 1 つ手動で打って試す)
- [ ] `manifest.json` の生成スクリプト + Studio 側 fetcher が実装済
- [ ] mac クリーン環境で deployed Studio から USB Serial flash が完走する
- [ ] 本ファイルを `instructions/completed/` に移動

## 関連ファイル / 参照

- `hapbeat-studio/src/utils/firmwareLibrary.ts` (主対象)
- `hapbeat-studio/vite.config.ts:firmwareDevPlugin` (dev plugin、変更不要)
- `hapbeat-device-firmware/.github/workflows/` (新規 release.yml)
- 公開 repo 化チェックの参考: `hapbeat-helper` の TestPyPI 公開作業
  (workspace 2026-05-02〜03 セッション)

## 注意

1. **firmware repo を public 化する前** に、過去 commit の secret を全件
   洗うこと (Helper では grep で 0 ヒットだったが、firmware は WiFi
   credentials がコメントアウトで残っていないか要点検)。
2. **Release artifact のサイズ** は merged 1.5 MB + app-only 1 MB ×
   build env 数。月数十回 release を切ると GH の Releases ストレージは
   無制限だが、Actions 実行時間は注意。
3. **CORS**: GitHub Releases は default で `Access-Control-Allow-Origin: *`
   なので Studio (異なる origin) から fetch 可能。
4. **キャッシュ戦略**: ブラウザ側で `cache: 'no-store'` を保てば最新
   release が常に取れる。逆に CDN (Cloudflare 等) を挟むなら 5 分
   程度のキャッシュにする。
