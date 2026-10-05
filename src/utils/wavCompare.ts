/**
 * Whether two WAVs hold the same sound: the same rate and channel count, lengths within 1 %, and a
 * residual energy below 0.1 % of the signal (re-encoding / resampling the same material stays well
 * under it; a gain change of 1 dB or another take does not). Only 16-bit PCM is compared; anything
 * else counts as different.
 */
interface Pcm { rate: number; channels: number; samples: Int16Array }

export function readPcm16(wav: ArrayBuffer): Pcm | null {
  const dv = new DataView(wav)
  if (wav.byteLength < 12 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null
  let fmt: { rate: number; channels: number; bits: number; format: number } | null = null
  for (let o = 12; o + 8 <= wav.byteLength;) {
    const id = dv.getUint32(o, false), size = dv.getUint32(o + 4, true), body = o + 8
    if (id === 0x666d7420 && body + 16 <= wav.byteLength) fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    if (id === 0x64617461) {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return null
      const bytes = Math.min(size, wav.byteLength - body) & ~1
      return { rate: fmt.rate, channels: fmt.channels, samples: new Int16Array(wav.slice(body, body + bytes)) }
    }
    o = body + size + (size & 1)
  }
  return null
}

export function sameSound(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = readPcm16(a), y = readPcm16(b)
  if (!x || !y || x.rate !== y.rate || x.channels !== y.channels) return false
  const n = Math.min(x.samples.length, y.samples.length), longer = Math.max(x.samples.length, y.samples.length)
  if (!n || (longer - n) / longer > 0.01) return false
  let signal = 0, residual = 0
  for (let i = 0; i < n; i++) { const d = x.samples[i] - y.samples[i]; signal += x.samples[i] * x.samples[i]; residual += d * d }
  for (let i = n; i < longer; i++) { const v = (x.samples[i] ?? y.samples[i]) ?? 0; residual += v * v }
  return signal > 0 ? residual / signal < 1e-3 : residual === 0
}
