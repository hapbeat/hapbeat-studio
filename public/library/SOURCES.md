# テンプレートのクリップの出どころ

Studio が作業フォルダの `clips/template/` に入れるクリップの一覧です。出どころを確かめられたものだけを入れています。

- Hapbeat が作成したクリップは、このリポジトリの [MIT License](../../LICENSE) で使えます。
- CC0 の素材は CC0 のままです。表記は不要ですが、出どころとしてここに記録します。
- 権利についてお気づきの点があれば、Issue または GitHub の連絡先までお知らせください。確認のうえ、差し替え・削除・クレジットの追記を行います。

## 分類

| フォルダ | 中身 |
|---|---|
| `sine-tones/` | 手元で試す汎用のトーン。20〜200 Hz の正弦波 |
| `sdk-samples/basic-example/` | SDK の Basic Example の 2 本 |
| `sdk-samples/showcase/` | SDK の Showcase のうち、正弦波のループ |
| `hapbeat-demos/<デモ>/` | 各デモの触覚のうち、出どころを確かめられたクリップ |

## 出どころ

| フォルダ | クリップ | 出どころ |
|---|---|---|
| `sine-tones/` | すべて | Hapbeat が生成（`scripts/gen-sine-tones.py`） |
| `sdk-samples/basic-example/` | すべて | Hapbeat が生成した正弦波 |
| `sdk-samples/showcase/` | すべて | Hapbeat が生成した正弦波 |
| `hapbeat-demos/boxing/` | `guard_arm_hard_t138_e` | Hapbeat が生成した矩形波 |
| 〃 | `punch_glove_hard_t145_b` | [aidansamuel, Punching Bag](https://freesound.org/people/aidansamuel/sounds/540131/)（CC0）の強弱を、60 Hz に載せたもの |
| `hapbeat-demos/energy-duel/` | `BodySoft` `GloveHard` | Hapbeat が生成 |
| 〃 | `charge_sweep` `charge_hold` `shield_block` `shield_break` `shield_break_neck` | [Kenney, Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)（CC0）を加工 |
| `hapbeat-demos/fps/` | すべて | Hapbeat が生成 |
| `hapbeat-demos/hand-demo/` | すべて | Hapbeat が生成した正弦波 |
| `hapbeat-demos/safety-mill/` | すべて | Hapbeat が生成 |
| `hapbeat-demos/trex-encounter/` | `bite_t48_a` `bite_t51_a` | [ProductionNow, Eating Juicy Meat](https://freesound.org/people/ProductionNow/sounds/234237/)（CC0）を加工 |
| 〃 | `breath_*` `rub_t57_d` | Hapbeat が生成 |

## クリップを足すとき

出どころを確かめてから `scripts/library-clips.json` に足し、次を順に実行します。

```bash
node scripts/sync-library-clips.mjs --workspace <hapbeat-sdk-workspace>
```

```bash
npm run strip:wav-meta
```

```bash
npm run gen:library
```

次のものは入れません。

- 単体での配布を禁じている素材（ElevenLabs Sound Effects、Pixabay、効果音ラボ、音人など）と、それを加工したもの
- 配布の許可が無いもの
- 元の素材の記録が無く、出どころを確かめられないもの
