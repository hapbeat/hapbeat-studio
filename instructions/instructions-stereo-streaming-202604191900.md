# 指示書: Studio オーディオストリーミングのステレオ対応

**作成日時**: 2026-04-19 19:00
**依頼元**: hapbeat-sdk-workspace ルートセッション
**対象**: hapbeat-studio
**関連**: hapbeat-manager に新機能「Hapbeat Live Audio」を追加中（PC 音声キャプチャ → UDP 送信）。その設計確認中に、Studio の `audioStreamer.ts` が**強制モノラル化**していることが発覚。仕様上はもともとステレオ対応済み（contracts / manager / firmware すべて stereo OK）のため、Studio 側だけ修正する。

## 背景と方針

### 現状
`src/utils/audioStreamer.ts` の実装：

- `resampleToMono()` — 強制的に 1ch の `OfflineAudioContext` にレンダリング
- `audioBufferToPcm16Mono()` — `buffer.getChannelData(0)` のみ取り出して PCM16 化
- `stream_begin` payload に `channels: 1` をハードコード
- `offset` 計算も `sampleOffset * 2`（= モノラル PCM16 前提）

### 仕様（contracts message-format.md）
- `0x30 STREAM_BEGIN`: `channels: uint8 (1=mono, 2=stereo)`
- `0x31 STREAM_DATA` PCM16 payload: **raw interleaved 16-bit LE samples**（ステレオなら L, R, L, R, ...）

### 他 repo の現状
- **contracts**: ステレオ定義済み（`1=mono, 2=stereo`）
- **hapbeat-manager** `protocol.py:build_stream_begin(..., channels=1, ...)` — 任意 channels を受け付ける
- **hapbeat-manager** `ws_server.py` — Studio から来た `channels` をそのまま protocol に渡す
- **hapbeat-device-firmware** `audio_stream.h` — `audioStreamBegin(sample_rate, channels, format, gain)`、内部アキュムレータは `acc_l/acc_r` のステレオ、PCM16 interleaved 処理済み
- **Studio** ← ここだけモノラル固定でボトルネックになっている

### 結論
Studio の `audioStreamer.ts` を改修して**入力のチャンネル数を保持**したまま interleaved PCM16 で送る。他層はすでに対応済みなので Studio 修正のみでフル経路ステレオになる。

## 作業内容

### 1. `src/utils/audioStreamer.ts` の改修

下記 4 点を修正する。

#### A. `resampleToMono` を `resample` に置換

```ts
// BEFORE
async function resampleToMono(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.length * targetRate / buffer.sampleRate)
  const offCtx = new OfflineAudioContext(1, length, targetRate)
  // ...
}

// AFTER
async function resample(buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
  const length = Math.ceil(buffer.length * targetRate / buffer.sampleRate)
  const offCtx = new OfflineAudioContext(buffer.numberOfChannels, length, targetRate)
  const src = offCtx.createBufferSource()
  src.buffer = buffer
  src.connect(offCtx.destination)
  src.start()
  return offCtx.startRendering()
}
```

ポイント: `OfflineAudioContext` の第1引数に `buffer.numberOfChannels` を渡し、元の ch 数を維持する。

#### B. `audioBufferToPcm16Mono` を `audioBufferToPcm16Interleaved` に置換

```ts
// BEFORE
function audioBufferToPcm16Mono(buffer: AudioBuffer): Int16Array {
  const data = buffer.getChannelData(0)
  const pcm = new Int16Array(data.length)
  for (let i = 0; i < data.length; i++) {
    let val = Math.round(data[i] * 32767)
    if (val > 32767) val = 32767
    if (val < -32768) val = -32768
    pcm[i] = val
  }
  return pcm
}

// AFTER
function audioBufferToPcm16Interleaved(buffer: AudioBuffer): Int16Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const pcm = new Int16Array(frames * channels)

  // getChannelData(ch) returns Float32Array for channel ch (planar).
  // We need to interleave: frame0_L, frame0_R, frame1_L, frame1_R, ...
  const channelData: Float32Array[] = []
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c))

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let val = Math.round(channelData[c][f] * 32767)
      if (val > 32767) val = 32767
      if (val < -32768) val = -32768
      pcm[f * channels + c] = val
    }
  }
  return pcm
}
```

#### C. `streamClipToDevice` の呼び出し部分を更新

```ts
// BEFORE
const resampled = await resampleToMono(decoded, targetRate)
const pcm16 = audioBufferToPcm16Mono(resampled)
// ...
const totalSamples = pcm16.length
// ...
send({
  type: 'stream_begin',
  payload: {
    target: targetDevice,
    sample_rate: targetRate,
    channels: 1,
    format: 'pcm16',
    total_samples: totalSamples,
  },
})
// ...
for (let sampleOffset = 0; sampleOffset < totalSamples; sampleOffset += CHUNK_SAMPLES) {
  // ...
  const byteOffset = sampleOffset * 2 // 2 bytes per sample
}

// AFTER
const resampled = await resample(decoded, targetRate)
const pcm16 = audioBufferToPcm16Interleaved(resampled)
const channels = resampled.numberOfChannels
const totalFrames = Math.floor(pcm16.length / channels)  // frames, not samples
// ...
send({
  type: 'stream_begin',
  payload: {
    target: targetDevice,
    sample_rate: targetRate,
    channels: channels,   // ← 実チャンネル数
    format: 'pcm16',
    total_samples: totalFrames,
  },
})
// ...
// chunk を frame 単位で切る
const chunkFrames = CHUNK_SAMPLES  // 名前はそのままでも、意味は 1ch あたりのフレーム数
for (let frameOffset = 0; frameOffset < totalFrames; frameOffset += chunkFrames) {
  if (signal?.aborted) { /* ... */ }

  const endFrame = Math.min(frameOffset + chunkFrames, totalFrames)
  // slice は interleaved の Int16 インデックス単位
  const chunk = pcm16.slice(frameOffset * channels, endFrame * channels)

  const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const base64 = uint8ArrayToBase64(bytes)

  // byte offset は「これまで送ったバイト総数」
  const byteOffset = frameOffset * channels * 2  // 2 bytes/sample × channels
  send({
    type: 'stream_data',
    payload: {
      target: targetDevice,
      offset: byteOffset,
      data: base64,
    },
  })

  const chunkIndex = frameOffset / chunkFrames
  const chunkDurationMs = (chunkFrames / targetRate) * 1000
  const expectedTime = startTime + (chunkIndex + 1) * chunkDurationMs
  const now = performance.now()
  if (expectedTime > now) await delay(expectedTime - now)
}
```

#### D. `intensity` 適用の修正

既存の intensity 適用ループは PCM16 全サンプルに掛けるため、interleaved でも正しく動作する（`pcm16.length` は `frames * channels`）。このブロックは**そのまま**でよい：

```ts
if (intensity !== 1.0) {
  for (let i = 0; i < pcm16.length; i++) {
    let val = Math.round(pcm16[i] * intensity)
    if (val > 32767) val = 32767
    if (val < -32768) val = -32768
    pcm16[i] = val
  }
}
```

### 2. 検証手順

1. **ビルド**: `npm run build` が通る
2. **型チェック**: TypeScript エラーがない
3. **実機動作確認**（可能なら）:
   - Studio でステレオ音源（L/R で別音の WAV）を読み込む
   - Manager 経由で Hapbeat デバイスに stream
   - デバイス側の 2ch 出力（L 駆動系 / R 駆動系）が別々に鳴るか確認
4. **モノラル音源の後方互換**:
   - モノラル音源を読み込んだ時、`buffer.numberOfChannels === 1` のまま動作する
   - `stream_begin` に `channels: 1` が送られ、PCM16 は非 interleaved（1ch のみ）
   - これまで通り動く

### 3. 補足 — チャンネル数強制の是非

将来的に「強制モノラル送信」を UI オプションとして欲しいなら、`StreamOptions` に `forceMono?: boolean` を追加し、有効時のみ旧ロジックにフォールバックする、という形が考えられる。今は不要。シンプルに元ソースのチャンネル数を保持するだけでよい。

### 4. 無関係な修正を混ぜない

この指示書の対象は `src/utils/audioStreamer.ts` のみ。他のコンポーネントやストア、UI の変更は**入れない**。

## 完了後の処理

1. コミット（粒度: 「audioStreamer: ステレオ対応」1 つで OK）
2. push はセッション終了時のみ
3. この指示書を `instructions/completed/` に移動
4. 完了報告をワークスペースルートセッションに返す必要はない（次回連携時に自動的に反映される）

## 関連ファイル

- 本指示書: `hapbeat-studio/instructions/instructions-stereo-streaming-202604191900.md`
- 修正対象: `hapbeat-studio/src/utils/audioStreamer.ts`
- 参照仕様: `hapbeat-contracts/specs/message-format.md` の 0x30 / 0x31 セクション
- 参照実装（ステレオ既対応の例）: `hapbeat-manager/src/hapbeat_manager/protocol.py` の `build_stream_begin`
- 参照実装（デバイス側）: `hapbeat-device-firmware/src/audio_stream.h`
