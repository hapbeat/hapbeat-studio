/**
 * The PC-sound lane of the waveform panel: during a haptic audition the event's sound (the candidate's companion
 * sound / the decided sound, and the scene's other sounds at their firings) drawn above the haptic on the same
 * time axis (the playback's seconds), where it is heard. The haptic lead (scene hapticLeadMs, > 0 = the haptic is
 * sent that much earlier than the PC sound) puts every sound that much later on the axis — the same shift the
 * editor applies when it plays them (useDecidedSoundSync), so what is drawn is what is played.
 */

export interface LaneBuffer { duration: number; sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }
/** One sound on the playback's time axis (seconds), × `gain`; `loop`: repeated (before and after `atSec`) over the whole axis. */
export interface LanePart { atSec: number; buffer: LaneBuffer; gain: number; loop?: boolean }

/** The lane as drawn: mono samples at `rate` on the playback's axis; `leadMs` = the haptic lead applied (0 = none). */
export interface SoundLane { data: Float32Array; rate: number; leadMs: number }

/** Sample rate of the drawn lane: the rate of the materials, so the lane's line looks like the sound drawn alone. */
export const LANE_RATE = 48000

/** Firings `leadSec` later on the playback (the haptic lead applied to the PC sounds; the same list when 0). */
export function leadFirings<F extends { atSec: number }>(firings: readonly F[], leadSec: number): F[] {
  return leadSec ? firings.map(f => ({ ...f, atSec: f.atSec + leadSec })) : [...firings]
}

/**
 * The sounds played with the playback (eventAudio useSceneSounds): the scene firings when there is a plan, else the
 * picked sound from 0 (CompanionSound) — each `leadSec` later on the axis.
 */
export function soundLaneParts(sounds: { picked: { buffer: LaneBuffer; volume: number; loop?: boolean } | null; firings: readonly { atSec: number; buffer: LaneBuffer; gain: number }[] | null }, leadSec: number): LanePart[] {
  if (sounds.firings) return leadFirings(sounds.firings, leadSec).map(f => ({ atSec: f.atSec, buffer: f.buffer, gain: f.gain }))
  const p = sounds.picked
  return p ? [{ atSec: leadSec, buffer: p.buffer, gain: p.volume, loop: !!p.loop }] : []
}

/** The parts summed (channels averaged) into one mono lane of `durationSec` at `rate`; what falls before 0 or after the end is cut. */
export function mixLane(parts: readonly LanePart[], durationSec: number, rate = LANE_RATE): Float32Array {
  const out = new Float32Array(Math.max(1, Math.ceil(durationSec * rate)))
  for (const p of parts) {
    const b = p.buffer, n = b.numberOfChannels, len = Math.floor(b.duration * b.sampleRate)
    if (!len || !n) continue
    const channels = Array.from({ length: n }, (_, c) => b.getChannelData(c))
    // Only the samples the part covers (a looped part: all of them); the edges are checked per sample below.
    const from = p.loop ? 0 : Math.max(0, Math.floor(p.atSec * rate) - 1)
    const to = p.loop ? out.length : Math.min(out.length, Math.ceil((p.atSec + len / b.sampleRate) * rate) + 1)
    for (let i = from; i < to; i++) {
      let k = Math.round((i / rate - p.atSec) * b.sampleRate)
      if (p.loop) k = ((k % len) + len) % len
      else if (k < 0 || k >= len) continue
      let v = 0
      for (const ch of channels) v += ch[k]
      out[i] += v / n * p.gain
    }
  }
  return out
}

/** Pixels per second as the haptic lane draws it (WaveSurfer stretches a short buffer to the width). */
export const lanePxPerSec = (zoom: number, width: number, durationSec: number) => Math.max(zoom, width / Math.max(1e-6, durationSec))

/** x (px) of time `sec` in a lane scrolled to `viewStartSec`. */
export const laneX = (sec: number, viewStartSec: number, pxPerSec: number) => (sec - viewStartSec) * pxPerSec

/**
 * The lane as a line over pixels 0..width, from `viewStartSec` at `pxPerSec` — drawn like the waveform of a file alone
 * (editorWaveform sampleLine): per pixel column the first, lowest, highest and last sample in time order, so brief
 * peaks of either sign stay; zoomed in to a few samples per pixel, every sample. Nothing before 0 or after the end.
 */
export function laneLine(data: Float32Array, rate: number, viewStartSec: number, pxPerSec: number, width: number): { x: number; value: number }[] {
  const points: { x: number; value: number }[] = []
  const first = Math.max(0, Math.floor(viewStartSec * rate)), last = Math.min(data.length - 1, Math.ceil((viewStartSec + width / pxPerSec) * rate))
  const x = (i: number) => (i / rate - viewStartSec) * pxPerSec
  if (last < first || width <= 0) return points
  if (rate / pxPerSec <= 4) {
    for (let i = first; i <= last; i++) points.push({ x: x(i), value: data[i] })
    return points
  }
  for (let col = Math.floor(x(first)); col <= Math.ceil(x(last)); col++) {
    const a = Math.max(first, Math.floor((viewStartSec + col / pxPerSec) * rate)), b = Math.min(last + 1, Math.floor((viewStartSec + (col + 1) / pxPerSec) * rate))
    if (b <= a) continue
    let min = a, max = a
    for (let i = a + 1; i < b; i++) { if (data[i] < data[min]) min = i; if (data[i] > data[max]) max = i }
    for (const i of [...new Set([a, min, max, b - 1])].sort((p, q) => p - q)) points.push({ x: x(i), value: data[i] })
  }
  return points
}
