import { effectiveEvent, resolveEventName, updateOwnRoute, type EventRef } from './cueEvents'
import { isLoopCue, type CueTable } from './sceneCueTable'
import type { SceneEvent } from './sceneData'
import { firingKey } from './sceneFiringGain'

/**
 * The Scene tab's strength panel (DEC-102 r3), pure parts: the software multiplier is edited in two places only —
 * an event's route gain (cue table, 0..2) and a firing's own gain (viewer-data `events[].gain`, ≥ 0). The clip
 * intensity (material) and this PC's overall multiplier are never part of these edits.
 */

/** Gains are written with 3 decimals (the recording's precision). */
export const round3 = (x: number) => Math.round(x * 1000) / 1000
/** A route gain's range (cue table). */
export const ROUTE_GAIN_MAX = 2
/** One ▲ / ▼ / ↑ / ↓ step: ×1.12 ≈ +1 dB; with Shift ×1.41 ≈ +3 dB. */
export const strengthStep = (shift: boolean) => shift ? Math.SQRT2 : 10 ** (1 / 20)
/** The relative fader's range (×0.25..×4) in log2 units. */
export const RELATIVE_RANGE = 2

/** A firing's own gain × `ratio` (≥ 0, 3 decimals). */
export const scaleFiringGain = (gain: number, ratio: number) => round3(Math.max(0, gain * ratio))
/** A route gain × `ratio` (0..2, 3 decimals). */
export const scaleRouteGain = (gain: number, ratio: number) => round3(Math.max(0, Math.min(ROUTE_GAIN_MAX, gain * ratio)))
/** A ratio in dB (`+3 dB`). */
export const ratioDb = (ratio: number) => 20 * Math.log10(ratio)

/** The middle value (the mean of the two middle ones for an even count); 1 for none. */
export function median(values: readonly number[]): number {
  if (!values.length) return 1
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** `variation.gainJitterDb` (stored as dB, contract unchanged) shown as ±%: (10^(dB/20) − 1) · 100. */
export const jitterDbToPct = (db: number) => (10 ** (db / 20) - 1) * 100
/** ±% entered → dB: 20 · log10(1 + pct / 100), pct 0..100. */
export const jitterPctToDb = (pct: number) => 20 * Math.log10(1 + Math.max(0, Math.min(100, pct)) / 100)

/**
 * The routes that set event `name`'s haptic strength: who holds them (a variant sharing its cue's haptics: the cue,
 * so its fader moves its siblings too) and their gains. null: not a haptic one-shot event.
 */
export function eventRoutes(table: CueTable, name: string): { owner: EventRef; gains: number[] } | null {
  const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
  if (!e || !e.haptics.length || isLoopCue(table, e.ref.cue)) return null
  const owner = e.ref.variant !== null && !e.own.haptics ? { cue: e.ref.cue, variant: null } : e.ref
  return { owner, gains: e.haptics.map(x => x.gain) }
}
/** Writes the owner's route gains (one per route, in order; clamped 0..2 by updateOwnRoute). */
export function setRouteGains(table: CueTable, owner: EventRef, gains: readonly number[]): CueTable {
  return gains.reduce((tb, gain, i) => updateOwnRoute(tb, owner, i, { gain }), table)
}
/** An event fader's value: its largest route gain. */
export const faderValue = (gains: readonly number[]) => Math.max(0, ...gains)
/** The route gains for fader value `value`: every route scaled by the same ratio (all at `value` when they are all 0). */
export function gainsAtFader(gains: readonly number[], value: number): number[] {
  const max = faderValue(gains)
  return max > 0 ? gains.map(g => scaleRouteGain(g, value / max)) : gains.map(() => scaleRouteGain(value, 1))
}

/** The name a firing has in the recording (an overridden firing keeps it in `from`, sceneOverrides). */
export const recordedName = (ev: SceneEvent & { from?: string }) => ev.from ?? ev.name
/**
 * Index of each recorded firing (viewer-data `events[i]`) by firingKey of its recorded name and time; the firings
 * the Scene tab shows map back through recordedName. Emitted firings (sceneEmit) are not in it: they are not recorded.
 */
export function recordedIndexMap(events: readonly SceneEvent[]): Map<string, number> {
  const out = new Map<string, number>()
  events.forEach((ev, i) => { const key = firingKey(ev.name, ev.t); if (!out.has(key)) out.set(key, i) })
  return out
}

/** Whether event `name`'s haptics are sent under the session's mute / solo (any solo: only the soloed ones). */
export const hapticAllowed = (name: string, muted: ReadonlySet<string>, soloed: ReadonlySet<string>) => soloed.size ? soloed.has(name) : !muted.has(name)
