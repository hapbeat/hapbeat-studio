# テンプレートのクリップの出どころ

Studio が作業フォルダの `clips/template/` に入れるクリップの一覧です。

- Hapbeat が作成・編集したクリップは、このリポジトリの [MIT License](../../LICENSE) で使えます。
- CC0 の素材は CC0 のままです。表記は不要ですが、出どころとしてここに記録します。
- 権利についてお気づきの点があれば、Issue または GitHub の連絡先までお知らせください。確認のうえ、差し替え・削除・クレジットの追記を行います。

## 分類

| フォルダ | 中身 |
|---|---|
| `sine-tones/` | 手元で試す汎用のトーン。20〜200 Hz の正弦波 |
| `sdk-samples/basic-example/` | SDK の Basic Example の 2 本 |
| `sdk-samples/showcase/` | SDK の Showcase のクリップ |
| `hapbeat-demos/<デモ>/` | 各デモの触覚で実際に使っているクリップ |

## 出どころ

| フォルダ | クリップ | 出どころ |
|---|---|---|
| `sine-tones/` | すべて | Hapbeat が生成（`scripts/gen-sine-tones.py`） |
| `sdk-samples/basic-example/` | すべて | Hapbeat が生成した正弦波 |
| `sdk-samples/showcase/` | `z3_hook_*` `z4_stream_loop` `z5_charge_loop` | Hapbeat が生成 |
| 〃 | `z2_door_close` `z2_door_open` | [rubberduck, 100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx)（CC0）を加工したものと見られます（長さの一致による推定） |
| 〃 | そのほか | Hapbeat が触覚向けに編集した波形。元の素材の記録はありません |
| `hapbeat-demos/boxing/` | `punch_glove_hard_t145_b` | [aidansamuel, Punching Bag](https://freesound.org/people/aidansamuel/sounds/540131/)（CC0）の強弱を低い周波数に載せたもの |
| 〃 | そのほか | Hapbeat が生成、または `hapbeat-demos/fps/` の `damage` などを編集 |
| `hapbeat-demos/energy-duel/` | `charge_sweep` `charge_hold` `shield_block` `shield_break` `shield_break_neck` | [Kenney, Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds)（CC0）を加工 |
| 〃 | `body_collide` | Hapbeat が編集した波形に [Kenney, Impact Sounds](https://kenney.nl/assets/impact-sounds)（CC0）を重ねたもの |
| 〃 | そのほか | Hapbeat が生成、または `hapbeat-demos/fps/` の `damage` を編集 |
| `hapbeat-demos/fps/` | `beat_pulse` `block_thud` `charge_loop` `ghost_*` `heartbeat` `hit_*` `jetpack_loop` `kill_confirm` `maze_loop` `notify_stereo` `reload_click` `shot_recoil` `slash` | Hapbeat が生成 |
| 〃 | そのほか | Hapbeat が触覚向けに編集した波形。元の素材の記録はありません |
| `hapbeat-demos/hand-demo/` | `hold_*` `push` `snap_fit` | Hapbeat が生成 |
| 〃 | そのほか | Hapbeat が触覚向けに編集した波形。元の素材の記録はありません（Unity SDK の XRI Hand Demo と同じクリップ） |
| `hapbeat-demos/safety-mill/` | すべて | Hapbeat が生成、または `hapbeat-demos/fps/` の `damage` `landing` と `sdk-samples/showcase/` の `z1_pin_hit` を編集 |
| `hapbeat-demos/trex-encounter/` | `bite_t48_a` `bite_t51_a` | [ProductionNow, Eating Juicy Meat](https://freesound.org/people/ProductionNow/sounds/234237/)（CC0）を加工 |
| 〃 | `breath_*` `rub_t57_d` | Hapbeat が生成 |
| 〃 | そのほか | `hapbeat-demos/hand-demo/` のクリップを編集 |
| `hapbeat-demos/volley/` | すべて | SDK の Showcase、`hapbeat-demos/fps/`、`hapbeat-demos/hand-demo/` のクリップと同じ波形、またはそれを編集したもの |

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

単体での配布を禁じている素材（ElevenLabs Sound Effects、Pixabay、効果音ラボ、音人など）と、それを加工したものは入れません。
