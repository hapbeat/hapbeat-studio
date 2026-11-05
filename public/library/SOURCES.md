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
| `sdk-samples/showcase/` | SDK の Showcase のうち、出どころを確かめられたクリップ |
| `hapbeat-demos/<デモ>/` | 各デモの触覚のうち、出どころを確かめられたクリップ |

## 出どころ

| フォルダ | クリップ | 出どころ |
|---|---|---|
| `sine-tones/` | すべて | Hapbeat が生成（`scripts/gen-sine-tones.py`） |
| `sdk-samples/basic-example/` | すべて | Hapbeat が生成した正弦波 |
| `sdk-samples/showcase/` | `z3_hook_loop` `z4_stream_loop` `z5_charge_loop` | Hapbeat が生成した正弦波 |
| 〃 | `z1_pin_hit` `z4_slider_tick` `z5_charge_thd` `z5_tar_hit_light` | Hapbeat が作成した短いパルス |
| 〃 | `z2_door_close` `z2_door_open` | [Rubberduck, 100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) の `door_01` `door_02`（CC0）を加工 |
| `hapbeat-demos/boxing/` | `punch_glove_hard_t145_b` 以外 | Hapbeat が作成 |
| 〃 | `punch_glove_hard_t145_b` | [aidansamuel, Punching Bag](https://freesound.org/people/aidansamuel/sounds/540131/)（CC0）の強弱を、60 Hz に載せたもの |
| `hapbeat-demos/energy-duel/` | 下の 2 行以外 | Hapbeat が作成 |
| 〃 | `charge_sweep` `charge_hold` `shield_block` `shield_break` `shield_break_neck` | [Kenney, Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)（CC0）を加工 |
| 〃 | `body_collide` | Hapbeat が作成したパルスに、[Kenney, Impact Sounds](https://kenney.nl/assets/impact-sounds)（CC0）を重ねたもの |
| `hapbeat-demos/fps/` | すべて | Hapbeat が作成 |
| `hapbeat-demos/hand-demo/` | すべて | Hapbeat が作成 |
| `hapbeat-demos/safety-mill/` | すべて | Hapbeat が作成 |
| `hapbeat-demos/trex-encounter/` | `bite_t48_a` `bite_t51_a` | [ProductionNow, Eating Juicy Meat](https://freesound.org/people/ProductionNow/sounds/234237/)（CC0）を加工 |
| 〃 | `breath_*` `grab_handdemo` `rub_t57_d` | Hapbeat が作成 |
| `hapbeat-demos/volley/` | すべて | Hapbeat が作成 |

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

CC BY の素材（OtoLogic、魔王魂など）は、上の表に作者とライセンスを書けば入れられます。

次のものは入れません。

- 単体での配布を禁じている素材（ElevenLabs Sound Effects、Pixabay、効果音ラボ、音人など）と、それを加工したもの
- 配布の許可が無いもの
- 元の素材の記録が無く、出どころを確かめられないもの
