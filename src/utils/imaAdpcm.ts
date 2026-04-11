/**
 * IMA ADPCM encoder — TypeScript port of firmware's ima_adpcm.h
 *
 * Compression: 4:1 (16-bit PCM → 4-bit ADPCM nibbles)
 * Stereo: each byte = L nibble (low) | R nibble (high)
 * Mono: each byte = 2 consecutive samples (low nibble first)
 */

const STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]

const INDEX_TABLE: readonly number[] = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]

export interface AdpcmState {
  predictor: number // int16
  stepIndex: number // uint8
}

export function createAdpcmState(): AdpcmState {
  return { predictor: 0, stepIndex: 0 }
}

export function encodeSample(state: AdpcmState, sample: number): number {
  let diff = sample - state.predictor
  let nibble = 0
  if (diff < 0) {
    nibble = 8
    diff = -diff
  }

  let step = STEP_TABLE[state.stepIndex]
  let diffq = step >> 3
  if (diff >= step) { nibble |= 4; diff -= step; diffq += step }
  step >>= 1
  if (diff >= step) { nibble |= 2; diff -= step; diffq += step }
  step >>= 1
  if (diff >= step) { nibble |= 1; diffq += step }

  let pred = state.predictor + ((nibble & 8) ? -diffq : diffq)
  if (pred > 32767) pred = 32767
  if (pred < -32768) pred = -32768
  state.predictor = pred

  let idx = state.stepIndex + INDEX_TABLE[nibble]
  if (idx < 0) idx = 0
  if (idx > 88) idx = 88
  state.stepIndex = idx

  return nibble & 0x0F
}

/**
 * Encode stereo PCM16 interleaved data to ADPCM.
 * Input: Int16Array of [L0, R0, L1, R1, ...]
 * Output: Uint8Array where each byte = L nibble | (R nibble << 4)
 */
export function encodeStereo(
  pcm: Int16Array,
  numFrames: number,
  stateL: AdpcmState,
  stateR: AdpcmState,
): Uint8Array {
  const out = new Uint8Array(numFrames)
  for (let i = 0; i < numFrames; i++) {
    const nL = encodeSample(stateL, pcm[i * 2])
    const nR = encodeSample(stateR, pcm[i * 2 + 1])
    out[i] = nL | (nR << 4)
  }
  return out
}

/**
 * Encode mono PCM16 data to ADPCM.
 * Input: Int16Array of samples
 * Output: Uint8Array where each byte = 2 consecutive nibbles (low first, high second)
 */
export function encodeMono(
  pcm: Int16Array,
  state: AdpcmState,
): Uint8Array {
  const numSamples = pcm.length
  const outLen = Math.ceil(numSamples / 2)
  const out = new Uint8Array(outLen)
  for (let i = 0; i < numSamples; i += 2) {
    const n0 = encodeSample(state, pcm[i])
    const n1 = (i + 1 < numSamples) ? encodeSample(state, pcm[i + 1]) : 0
    out[i >> 1] = n0 | (n1 << 4)
  }
  return out
}
