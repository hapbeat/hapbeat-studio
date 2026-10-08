import { describe, it, expect } from 'vitest'
import {
  HELPER_UPMIXES_INSTALL_CLIPS_TO_STEREO,
  deviceClipChannels,
  estimateKitStorageFromEvents,
  estimateKitStorageFromFiles,
  storedClipBytes,
} from './kitSizeEstimate'

/** Minimal PCM WAV: RIFF header + fmt + data of `frames` silent frames. */
function wavBlob(frames: number, channels: number, sampleRate = 16000, bits = 16): Blob {
  const dataBytes = frames * channels * (bits / 8)
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const tag = (off: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE')
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * bits / 8, true)
  v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true)
  tag(36, 'data'); v.setUint32(40, dataBytes, true)
  return new Blob([buf])
}

describe('storedClipBytes', () => {
  it('IMA ADPCM: mono = ceil(frames/2), stereo = frames, 4-byte aligned', () => {
    expect(storedClipBytes({ frames: 16000, channels: 1 }, 'ima_adpcm')).toBe(8000)
    expect(storedClipBytes({ frames: 16000, channels: 2 }, 'ima_adpcm')).toBe(16000)
    // 5 frames mono → 3 bytes → aligned to 4
    expect(storedClipBytes({ frames: 5, channels: 1 }, 'ima_adpcm')).toBe(4)
    // 7 frames stereo → 7 bytes → 8
    expect(storedClipBytes({ frames: 7, channels: 2 }, 'ima_adpcm')).toBe(8)
  })

  it('IMA ADPCM is a quarter of PCM16', () => {
    const pcm = storedClipBytes({ frames: 32000, channels: 2 }, 'pcm16')
    expect(pcm).toBe(128000)
    expect(storedClipBytes({ frames: 32000, channels: 2 }, 'ima_adpcm')).toBe(pcm / 4)
  })

  it('defaults to IMA ADPCM', () => {
    expect(storedClipBytes({ frames: 1000, channels: 1 })).toBe(500)
  })

  it('non-16-bit audio is stored raw', () => {
    expect(storedClipBytes({ frames: 10, channels: 1, bitsPerSample: 8 }, 'ima_adpcm')).toBe(12)
  })

  it('opus placeholder: bitrate/8 × duration + 1 B per 20 ms packet + 16 B header', () => {
    // 1 s at 24 kbit/s: 3000 B payload + 50 packets + 16 → 3066 → aligned 3068
    expect(storedClipBytes({ frames: 16000, channels: 2 }, 'opus')).toBe(3068)
    expect(storedClipBytes({ frames: 16000, channels: 1 }, 'opus', { opusBitrateBps: 16000 })).toBe(2068)
  })

  it('empty clip takes nothing', () => {
    expect(storedClipBytes({ frames: 0, channels: 2 })).toBe(0)
  })
})

describe('estimateKitStorageFromEvents', () => {
  const ev = (id: string, src: string, duration: number, channels: number, modes: ('command' | 'stream_clip')[] = ['command']) =>
    ({ id, clipSourceFilename: src, clipDuration: duration, clipChannels: channels, modes })

  it('counts each source once, FIRE events only, at 16 kHz device channels', () => {
    const est = estimateKitStorageFromEvents([
      ev('a', 'hit.wav', 1, 1),
      ev('b', 'hit.wav', 1, 1),            // same source → stored once
      ev('c', 'stream.wav', 5, 2, ['stream_clip']), // not stored on the device
      ev('d', 'boom.wav', 0.5, 2, ['command', 'stream_clip']),
    ])
    const ch = deviceClipChannels(1)
    expect(est.clipCount).toBe(2)
    expect(est.clipBytes).toBe(
      storedClipBytes({ frames: 16000, channels: ch }) + storedClipBytes({ frames: 8000, channels: 2 }),
    )
    expect(est.basis).toBe('metadata')
    expect(est.manifestBytes).toBeGreaterThan(0)
  })

  it('mono clips are counted as stereo while the helper up-mixes', () => {
    expect(deviceClipChannels(1)).toBe(HELPER_UPMIXES_INSTALL_CLIPS_TO_STEREO ? 2 : 1)
    expect(deviceClipChannels(2)).toBe(2)
  })

  it('empty or stream-only kit is zero', () => {
    expect(estimateKitStorageFromEvents([]).clipBytes).toBe(0)
    expect(estimateKitStorageFromEvents([ev('c', 's.wav', 3, 2, ['stream_clip'])]).clipCount).toBe(0)
  })
})

describe('estimateKitStorageFromFiles', () => {
  it('reads 16 kHz frames from install-clips, dedups by outputHash, ignores stream-clips', async () => {
    const manifest = new Blob(['{"name":"k"}'])
    const est = await estimateKitStorageFromFiles([
      { path: 'install-clips/a.wav', blob: wavBlob(16000, 2), outputHash: 'h1' },
      { path: 'install-clips/a-copy.wav', blob: wavBlob(16000, 2), outputHash: 'h1' },
      { path: 'install-clips/b.wav', blob: wavBlob(1601, 1), outputHash: 'h2' },
      { path: 'stream-clips/s.wav', blob: wavBlob(160000, 2), outputHash: 'h3' },
      { path: 'k-manifest.json', blob: manifest, outputHash: null },
    ])
    expect(est.basis).toBe('built')
    expect(est.clipCount).toBe(2)
    expect(est.clipBytes).toBe(
      storedClipBytes({ frames: 16000, channels: 2 }) + storedClipBytes({ frames: 1601, channels: deviceClipChannels(1) }),
    )
    expect(est.manifestBytes).toBe(manifest.size)
  })
})
