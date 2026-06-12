# Studio 依頼書: dev モードで「他の env のファームが都度消える」問題

- 起票元セッション: workspace 統括（hapbeat-device-firmware 作業中）
- 日付: 2026-06-11
- 関連 repo: hapbeat-studio（本体）/ hapbeat-device-firmware（成果物提供側）
- 関連 DEC: DEC-034（firmware-distribution v2 / role・transport・board）

## 症状（訂正版）

Studio（dev モード）の Firmware リストから、**今ビルドしている env 以外の
ファームが都度消える**。例: `band_v2` を作業中にビルドすると、それまで一覧に
あった `necklace_v3` / `band_v3` / role 系 / transmitter 系などが消える。
（当初「band_v2 が消える」と誤報告したが、逆。消えるのは "その他" の env。）

## 根本原因（device-firmware 側で実機確認済み）

Studio dev plugin（`vite.config.ts` の `firmwareDevPlugin`）は
`<repo>/.pio/build/<env>/` を `/firmware-builds/list` で**毎回ライブ走査**し、
`firmware_full_serial.bin` / `firmware_app_ota.bin` が存在する env だけ列挙する。

問題は **`.pio/build` が揮発的で、env サブディレクトリが頻繁に「最後にビルドした
ものだけ」に間引かれる**こと。確認した事実:

- いま `.pio/build/` には `necklace_v3` と `atom_lite_sensor` の 2 つしか無い。
  直前にビルドした `band_v2` / `band_v3` は**消えている**。
- `atom_lite_sensor` は本セッションが触っていない env（= **別セッションが同じ
  workspace の `.pio/build` で並行ビルドしている**）。
- つまり複数セッション / 複数 `-e` 指定 / `platformio.ini` 編集が絡み、
  PlatformIO がビルドツリーを無効化 → **その回にビルドした env の成果物だけが
  残り、他は消える**。

これは clean を明示実行していなくても起きる（`platformio.ini` の `[env]` 変更で
project checksum が変わると関連ビルドが無効化される / 複数セッションが同じ
`.pio` を奪い合う）。**`.pio/build` を信頼できる永続ストアとして読むのが間違い**で、
ここが Studio 側で堅牢化すべきポイント。

> device-firmware 側は `.pio` の明示 clean はしていない。成果物
> （`firmware_full_serial.bin` / `firmware_app_ota.bin` / `firmware.bin` /
> `variant.json`）は `pio run` でその場上書き再生成されるが、**ビルド対象に
> 含めなかった env のディレクトリごと消える**のが今回の本質。

## お願いしたいこと（Studio dev plugin の堅牢化）

`.pio/build` の揮発に負けないよう、**dev plugin にスナップショットキャッシュ**を
入れてほしい。方針:

1. **キャッシュ層を追加**（`.pio` の外、例: `node_modules/.cache/hapbeat-firmware-dev/<repoShort>/<env>/`）。
   - `/firmware-builds/list` や bin 取得で `.pio/build/<env>/` の bin を見るたび、
     `size>0` のものを **mtime / fwVersion 付きでキャッシュへコピー**する。
2. **`/list` は live と cache の和集合**を返す:
   - live（`.pio/build` に現存）→ そのまま、`source:"live"`。
   - live に無いが cache にある env → cache から `source:"cache"` + 取得時刻 +
     fwVersion を付けて列挙（「最後にビルドした版」）。
   - 同 env が両方 → **live 優先**（mtime が新しい方）。
3. **bin 取得**（`/<env>/<stem>.bin`）も同様に live 優先・無ければ cache fallback。
4. **UI 表示**:
   - cache 由来は「キャッシュ（YYYY-MM-DD HH:mm 時点 / fwVersion）」と明示し、
     古い版を掴むリスクをユーザーに見せる。
   - live が復活したら自動で live に戻す。
5. **0byte / 生成途中ガード**: `statArtifact` は `size>0` を要求。書き込み前に
   merged 判定（`isMergedImage`）が既にあるならそれも維持。

これで「band_v2 をビルド中でも、直前にビルドした necklace_v3 等が一覧から
消えない（cache から提示される）」状態になる。

## 受け入れ条件

- `band_v2` を連続ビルドしても、直前に一度でも見えた他 env（necklace_v3 等）が
  Studio dev の Firmware 一覧から**消えない**（cache 由来として残る）。
- live が存在する env は常に live（最新）を優先して提示・書き込みする。
- 生成途中の 0byte を掴んで壊れた bin を書き込まない。
- cache 由来か live 由来かが UI で区別できる。

## device-firmware 側の代替案（Studio で対応しない / 併用する場合）

Studio 側キャッシュの代わり（または併用）に、device-firmware の post script
（`merge_firmware.py`）で **`.pio` の外の永続ステージへ成果物をコピー**し、
dev plugin の `buildRepos` ルートをそこに向ける案もある:

- 例: `<repo>/.firmware-dev/<env>/{firmware_full_serial.bin, firmware_app_ota.bin, variant.json}`
  へ毎ビルド後コピー（このディレクトリは PlatformIO が消さない）。
- この場合 Studio 側は `buildRoot` を `.pio/build` →（または併せて）
  `.firmware-dev` に向けるだけ。
- 望ましい方を選んでもらい、device-firmware 側対応が要るなら逆方向の指示書を
  起票してください（post script 追加は軽微）。

## 補足 / 注意

- 並行セッションが同じ `.pio/build` を共有している点も背景にある。根本的には
  ビルドの作業ディレクトリ分離も検討余地があるが、まずは Studio 側 cache で
  「消えて見える」UX を解消するのが費用対効果が高い。
- band_v2 自体の Studio 正式 UI 対応は不要（予定なし）。dev で拾えれば十分。
