import type { CueTable } from './sceneCueTable'

/**
 * Sync points (DEC-093): per material, the moment in its file where the sound and the haptic are put together
 * (`clips.<clip>.syncMs` / `sounds.<name>.syncMs`, ms from the file start; absent = 0 for the game). Studio detects one
 * (detectSyncMs) and the user moves it in the waveform panel; a sound and a haptic play so that their sync points meet:
 * the haptic `syncMs(sound) − syncMs(clip)` ms after the sound (when negative, the sound waits instead; nothing is cut).
 */

/** Level (dB re the file's absolute peak) a sample must first reach to be the detected start. */
export const SYNC_THRESHOLD_DB = -20
/** Upper bound of a saved sync point (ms): far past any material, only to reject nonsense. */
export const SYNC_MAX_MS = 600_000

export interface SyncBuffer { sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }

const detected = new WeakMap<object, number>()
/** Where `buffer` starts (ms): the first sample, on any channel, at SYNC_THRESHOLD_DB of its absolute peak; 0 for silence. */
export function detectSyncMs(buffer: SyncBuffer): number {
  const cached = detected.get(buffer)
  if (cached !== undefined) return cached
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  let peak = 0
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
  let first = 0
  if (peak > 0) {
    const level = peak * 10 ** (SYNC_THRESHOLD_DB / 20), length = Math.max(...channels.map(ch => ch.length))
    first = length
    for (const ch of channels) for (let i = 0; i < Math.min(first, ch.length); i++) if (Math.abs(ch[i]) >= level) { first = i; break }
  }
  const ms = Math.round(first / buffer.sampleRate * 1000)
  detected.set(buffer, ms)
  return ms
}

export type SyncTarget = 'sound' | 'haptic'
/** The saved sync point of a material (ms), undefined when it has none. */
export function savedSyncMs(table: CueTable, target: SyncTarget, name: string): number | undefined {
  const value = target === 'haptic' ? table.clips[name]?.syncMs : table.sounds?.[name]?.syncMs
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
/** Sets (ms, rounded to 1 ms, ≥ 0) or removes (null: back to the detected one) a material's sync point; a clip the table does not have is left alone. */
export function setSyncMs(table: CueTable, target: SyncTarget, name: string, ms: number | null): CueTable {
  const value = ms === null ? null : Math.max(0, Math.min(SYNC_MAX_MS, Math.round(ms)))
  const put = <E extends Record<string, unknown>>(entry: E): E => {
    const { syncMs: _old, ...rest } = entry
    return (value === null ? rest : { ...rest, syncMs: value }) as unknown as E
  }
  if (target === 'haptic') return table.clips[name] ? { ...table, clips: { ...table.clips, [name]: put(table.clips[name]) } } : table
  const entry = table.sounds?.[name]
  if (!entry && value === null) return table
  return { ...table, sounds: { ...(table.sounds ?? {}), [name]: put(entry ?? { intensity: 1 }) } }
}

/**
 * How long (s) before `startSec` the sounds must start so that none starting before it is cut: the earliest start among
 * the sounds still sounding at `startSec`, at most `maxSec` back; 0 when nothing is cut.
 */
export function soundLeadInSec(sounds: readonly { atSec: number; durSec: number; loop?: boolean }[], startSec: number, maxSec = 1): number {
  let lead = 0
  for (const s of sounds) if (!s.loop && s.atSec < startSec && s.atSec + s.durSec > startSec) lead = Math.max(lead, startSec - s.atSec)
  return Math.min(maxSec, lead)
}
