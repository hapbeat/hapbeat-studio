import { effectiveEvent, resolveEventName, updateOwnRoute, type EventRef } from './cueEvents'
import { isLoopCue, type CueTable } from './sceneCueTable'
import { isTick, type SceneEvent } from './sceneData'
import { occurrenceKeys, recordingFiringStrength } from './sceneFiringGain'

/**
 * The Scene tab's strength panel (DEC-102 r3), pure parts: the app gain is edited in two places only —
 * an event's route gain (cue table, 0..2) and a firing's own gain (viewer-data `events[].gain`, ≥ 0). The clip
 * clip_gain (material) and this PC's overall multiplier are never part of these edits.
 */

/** Gains are written with 3 decimals (the recording's precision). */
export const round3 = (x: number) => Math.round(x * 1000) / 1000
/** A route gain's range (cue table). */
export const ROUTE_GAIN_MAX = 2
/** One ▲ / ▼ / ↑ / ↓ step: ×1.12 ≈ +1 dB; with Shift ×1.41 ≈ +3 dB. */
export const strengthStep = (shift: boolean) => shift ? Math.SQRT2 : 10 ** (1 / 20)

/** A gain made by Studio (scaled or set): 4 significant digits, so a ratio ≠ 1 always moves a small gain too. */
export const roundGain = (x: number) => x > 0 ? Number(x.toPrecision(4)) : 0
/** The smallest firing gain a ratio leaves (a gain at 0 could never be raised by a ratio again). */
export const MIN_FIRING_GAIN = 0.001
/**
 * A firing's own gain × `ratio`, 4 significant digits: a gain above 0 never reaches 0 — it stops at MIN_FIRING_GAIN,
 * or where it already is when it is below that (a step down never raises it); 0 stays 0.
 */
export const scaleFiringGain = (gain: number, ratio: number) => gain > 0 ? Math.max(Math.min(gain, MIN_FIRING_GAIN), roundGain(gain * ratio)) : 0
/** A firing's own gain set to `gain`: 0, or at least MIN_FIRING_GAIN (4 significant digits). */
export const setFiringGain = (gain: number) => gain > 0 ? Math.max(MIN_FIRING_GAIN, roundGain(gain)) : 0

/**
 * The ratio a vertical drag on a haptic bar gives (timeline): the bar is drawn `shown` = min(1, gain) of the lane
 * height `laneH` (an over-cap bar clamped at the top), and its top follows the pointer, `dy` px down. The ratio is the
 * pointer's height over the drawn height (1 at the press point, continuous across the lane top), floored at
 * MIN_FIRING_GAIN; a bar too short to scale from (≤ 2 px) goes ×2 per 40 px.
 */
export function barDragRatio(gain: number, dy: number, laneH: number): number {
  const shown = Math.min(1, Math.max(0, gain)), h0 = shown * laneH
  return h0 > 2 ? Math.max(MIN_FIRING_GAIN, (h0 - dy) / h0) : 2 ** (-dy / 40)
}
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

/** `variation.gainJitterDb`'s range in the cue table (contract: 0..12 dB). */
export const JITTER_DB_MAX = 12
/** `variation.gainJitterDb` (stored as dB, contract unchanged) shown as %: (10^(dB/20) − 1) · 100. */
export const jitterDbToPct = (db: number) => (10 ** (db / 20) - 1) * 100
/** The % input's top: 12 dB (≈ 298 %). */
export const JITTER_PCT_MAX = Math.floor(jitterDbToPct(JITTER_DB_MAX))
/** % entered → dB: 20 · log10(1 + pct / 100), clamped to 0..12 dB. */
export const jitterPctToDb = (pct: number) => Math.min(JITTER_DB_MAX, 20 * Math.log10(1 + Math.max(0, pct) / 100))
/** The multipliers a gain jitter of `db` gives: ×10^(−dB/20) .. ×10^(dB/20) (not symmetric in %: ×1/(1+p) .. ×(1+p)). */
export const jitterRange = (db: number): [number, number] => [10 ** (-db / 20), 10 ** (db / 20)]

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
 * Index of each recorded firing (viewer-data `events[i]`) by its occurrenceKeys key; a shown firing maps back through
 * occurrenceKeys(shown, recordedName) (Studio keeps the recorded order of firings at one time). Emitted firings
 * (sceneEmit) are not recorded: their keys find nothing unless a recorded firing of that cue has the same time.
 */
export function recordedIndexMap(events: readonly SceneEvent[]): Map<string, number> {
  return new Map(occurrenceKeys(events).map((key, i) => [key, i]))
}

/** Whether event `name`'s haptics are sent under the session's mute / solo (any solo: only the soloed ones). */
export const hapticAllowed = (name: string, muted: ReadonlySet<string>, soloed: ReadonlySet<string>) => soloed.size ? soloed.has(name) : !muted.has(name)

/**
 * Recorded indices of the haptic one-shot firings (not ticks) between two replay times that the timeline's haptic lane
 * draws: `shown` = the firings Studio plays (data.full.events), `recorded` = viewer-data's, `stretch` = a moment's
 * stretch (its lane draws only those; null = the full replay). Keys run over the whole lists, so they stay aligned.
 */
export function selectableFirings(table: CueTable, shown: readonly SceneEvent[], recorded: readonly SceneEvent[], ticks: readonly string[],
  a: number, b: number, stretch: readonly [number, number] | null): number[] {
  const lo = Math.max(Math.min(a, b), stretch?.[0] ?? -Infinity), hi = Math.min(Math.max(a, b), stretch?.[1] ?? Infinity)
  const strength = recordingFiringStrength(table, shown), indexOf = recordedIndexMap(recorded)
  const shownKeys = occurrenceKeys(shown), recordedKeys = occurrenceKeys(shown, recordedName)
  return shown.flatMap((ev, k) => {
    const i = ev.t >= lo && ev.t <= hi && !isTick(ticks as string[], ev.name) && strength.get(shownKeys[k]) ? indexOf.get(recordedKeys[k]) : undefined
    return i === undefined ? [] : [i]
  })
}
