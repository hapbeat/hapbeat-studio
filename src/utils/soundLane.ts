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

/** Sample rate of the drawn lane (a shape to read timing from, not audio). */
export const LANE_RATE = 8000

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
    for (let i = 0; i < out.length; i++) {
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

/** Min / max of the lane per pixel column 0..width-1, from `viewStartSec` at `pxPerSec` (0, 0 outside the lane). */
export function laneColumns(data: Float32Array, rate: number, viewStartSec: number, pxPerSec: number, width: number): [number, number][] {
  const cols: [number, number][] = []
  for (let x = 0; x < width; x++) {
    const a = Math.max(0, Math.floor((viewStartSec + x / pxPerSec) * rate)), b = Math.min(data.length, Math.max(a + 1, Math.floor((viewStartSec + (x + 1) / pxPerSec) * rate)))
    let lo = 0, hi = 0
    for (let i = a; i < b; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v }
    cols.push([lo, hi])
  }
  return cols
}
