/**
 * The PC-sound lane of the waveform panel: during a haptic audition the event's sound (the candidate's companion
 * sound / the decided sound, and the scene's other sounds at their firings) drawn above the haptic on the same
 * time axis (the playback's seconds), where it is heard. The haptic lead (scene hapticLeadMs, > 0 = the haptic is
 * sent that much earlier than the PC sound) puts every sound that much later on the axis — the same shift the
 * editor applies when it plays them (useDecidedSoundSync), so what is drawn is what is played. The shown event's own
 * sound is moved further so that its sync point meets the haptic's (DEC-093, SyncView).
 */

export interface LaneBuffer { duration: number; sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }
/** One sound on the playback's time axis (seconds), × `gain`; `loop`: repeated (before and after `atSec`) over the whole axis. */
export interface LanePart { atSec: number; buffer: LaneBuffer; gain: number; loop?: boolean }

/**
 * One side of the sync points shown (DEC-093): its sync point `ms` (in its own file) — the saved one, else the detected
 * `autoMs` (`auto`); `ref`: the material it is saved on (null = it cannot be: an AI candidate); `durSec`: the file's length.
 */
export interface SyncSide { ms: number; autoMs: number; auto: boolean; ref: { target: 'sound' | 'haptic'; name: string } | null; durSec: number }
/** The sync points of the shown haptic and its event's sound, and where (drawn seconds) each copy of the haptic starts. */
export interface SyncView { sound: SyncSide; haptic: SyncSide; starts: number[] }
/** The playback shift (s) of the shown event's own sound: its sync point onto the haptic's. */
export const syncShiftSec = (sync: SyncView | null | undefined) => sync ? (sync.haptic.ms - sync.sound.ms) / 1000 : 0

/** The lane as drawn: mono samples at `rate` on the playback's axis; `leadMs` = the haptic lead applied (0 = none); `sync`: the sync points drawn over it. */
export interface SoundLane { data: Float32Array; rate: number; leadMs: number; sync?: SyncView | null }

/** Sample rate of the drawn lane: the rate of the materials, so the lane's line looks like the sound drawn alone. */
export const LANE_RATE = 48000

/** Firings `leadSec` later on the playback (the haptic lead applied to the PC sounds), the shown event's own ones `ownSec` more (syncShiftSec); the same list when both are 0. */
export function leadFirings<F extends { atSec: number; own?: boolean }>(firings: readonly F[], leadSec: number, ownSec = 0): F[] {
  return leadSec || ownSec ? firings.map(f => ({ ...f, atSec: f.atSec + leadSec + (f.own ? ownSec : 0) })) : [...firings]
}

/**
 * The sounds played with the playback (eventAudio useSceneSounds): the scene firings when there is a plan, else the
 * picked sound from 0 (CompanionSound) — each `leadSec` later on the axis, the own ones (the picked sound) `ownSec` more.
 */
export function soundLaneParts(sounds: { picked: { buffer: LaneBuffer; volume: number; loop?: boolean } | null; firings: readonly { atSec: number; buffer: LaneBuffer; gain: number; own?: boolean }[] | null }, leadSec: number, ownSec = 0): LanePart[] {
  if (sounds.firings) return leadFirings(sounds.firings, leadSec, ownSec).map(f => ({ atSec: f.atSec, buffer: f.buffer, gain: f.gain }))
  const p = sounds.picked
  return p ? [{ atSec: leadSec + ownSec, buffer: p.buffer, gain: p.volume, loop: !!p.loop }] : []
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
