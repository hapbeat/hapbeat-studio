import { effectiveEvent, eventKey, parseEventKey, resolveEventName, setOwnSfxVolume, setVariantScale, updateOwnRoute, type EventRef } from './cueEvents'
import { isLoopCue, type CueTable, type CueVariant } from './sceneCueTable'
import { roundGain } from './sceneStrength'

/**
 * A game project's Scene strength edits (DEC-114, contracts scene-recording §3.5): a bar moved up or down on the
 * timeline changes the cue table's multiplier for the firing's name — what the game plays too — instead of that one
 * firing. Which multiplier (GainTarget):
 * - haptic lane: a cue, or a variant with its own haptics → that entry's route `gain`s (the strength panel's fader);
 *   a variant sharing its cue's haptics → its `hapticsGain` (its cue and the other variants stay);
 * - sound lane: a cue, or a variant with its own sound → that entry's `sfx.volume`; a variant sharing it → `sfxVolume`.
 * Every bar of that name moves with it. Each multiplier keeps its range (0..2, contracts cue-table §4.4 / §5.3): a
 * ratio that would pass the top stops there (a route set keeps its proportions). Everything here is pure.
 */

export type Lane = 'haptics' | 'sound'
export type GainTarget =
  | { kind: 'routes'; ref: EventRef }
  | { kind: 'hapticsGain'; ref: EventRef }
  | { kind: 'sfx'; ref: EventRef }
  | { kind: 'sfxVolume'; ref: EventRef }
/** A multiplier's top (route gain, sfx volume, hapticsGain, sfxVolume: contracts cue-table §4.4, §5.3). */
export const GAIN_TARGET_MAX = 2
/** The smallest value a ratio leaves on a multiplier above 0 (one at 0 could never be raised by a ratio again). */
export const MIN_TARGET_GAIN = 0.001

/** A target's key: `<kind>:<event key>` (one per multiplier, so a selection scales each once). */
export const targetKey = (t: GainTarget) => `${t.kind}:${eventKey(t.ref)}`
/** The target of key `key` (targetKey). */
export function parseTargetKey(key: string): GainTarget {
  const i = key.indexOf(':')
  return { kind: key.slice(0, i) as GainTarget['kind'], ref: parseEventKey(key.slice(i + 1)) }
}

/**
 * The multiplier a bar of firing `name` in `lane` moves, or null: an unknown cue, a loop cue (its strength comes from
 * the game's input, levelMap), nothing in that lane. A variant the cue does not have resolves to the cue (as the game).
 */
export function gainTarget(table: CueTable, name: string, lane: Lane): GainTarget | null {
  const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
  if (!e || isLoopCue(table, e.ref.cue)) return null
  const variant = e.ref.variant !== null
  if (lane === 'haptics') {
    if (!e.haptics.length) return null
    const shared = variant && !e.own.haptics
    return shared && isRamped(table, e.ref) ? null : { kind: shared ? 'hapticsGain' : 'routes', ref: e.ref }
  }
  if (!e.sfx) return null
  const shared = variant && !e.own.sfx
  return shared && isRamped(table, e.ref) ? null : { kind: shared ? 'sfxVolume' : 'sfx', ref: e.ref }
}

/**
 * Whether variant `ref` changes its multipliers over a run (`rampTo` / `rampSteps`): its firings play other values than
 * its hapticsGain / sfxVolume (one ramp for sound and haptics), so a bar cannot scale it; the Event panel edits the ramp.
 */
export function isRamped(table: CueTable, ref: EventRef): boolean {
  const v = ref.variant === null ? undefined : table.cues[ref.cue]?.variants?.[ref.variant]
  return !!v && (v.rampTo !== undefined || !!v.rampSteps?.length)
}

/** Names among `names` whose `lane` multiplier is a ramped variant's (gainTarget gives none for them; the panel says why). */
export function rampedNames(table: CueTable, names: Iterable<string>, lane: Lane): string[] {
  return [...new Set(names)].filter(name => {
    const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
    return !!e && e.ref.variant !== null && !(lane === 'haptics' ? e.own.haptics : e.own.sfx) && isRamped(table, e.ref)
  })
}

/** The target's values now (routes: one gain per route; the others: one value, 1 when not written), or null when it no longer exists. */
export function targetValues(table: CueTable, t: GainTarget): number[] | null {
  const cue = table.cues[t.ref.cue], entry = t.ref.variant === null ? cue : cue?.variants?.[t.ref.variant]
  if (!entry) return null
  if (t.kind === 'routes') return entry.haptics?.length ? entry.haptics.map(r => r.gain) : null
  if (t.kind === 'sfx') return entry.sfx ? [entry.sfx.volume] : null
  if (t.ref.variant === null) return null
  const v = entry as CueVariant
  if (t.kind === 'hapticsGain') return v.haptics === undefined ? [v.hapticsGain ?? 1] : null
  return v.sfx === undefined ? [v.sfxVolume ?? 1] : null
}

/** Writes the target's values (as targetValues gives them; each kept in 0..2). A multiplier at 1 stays written (it was set). */
export function setTargetValues(table: CueTable, t: GainTarget, values: readonly number[]): CueTable {
  const clamp = (x: number) => Math.max(0, Math.min(GAIN_TARGET_MAX, x))
  if (t.kind === 'routes') return values.reduce((tb, gain, i) => updateOwnRoute(tb, t.ref, i, { gain: clamp(gain) }), table)
  if (t.kind === 'sfx') return setOwnSfxVolume(table, t.ref, clamp(values[0]))
  return setVariantScale(table, t.ref, { [t.kind]: clamp(values[0]) })
}

/** The ratio actually applied to `values` for a wished `ratio`: never past GAIN_TARGET_MAX on the largest (the set keeps its proportions). */
export function boundedRatio(values: readonly number[], ratio: number): number {
  const max = Math.max(0, ...values)
  return max > 0 && max * ratio > GAIN_TARGET_MAX ? GAIN_TARGET_MAX / max : ratio
}

/** `values` × `ratio` (bounded): 4 significant digits; a value above 0 never reaches 0 (it stops at MIN_TARGET_GAIN, or stays below it); 0 stays 0. */
export function scaledValues(values: readonly number[], ratio: number): number[] {
  const r = boundedRatio(values, ratio)
  return values.map(g => r === 1 ? g : g > 0 ? Math.min(GAIN_TARGET_MAX, Math.max(Math.min(g, MIN_TARGET_GAIN), roundGain(g * r))) : 0)
}

/** `values` with their largest at `value` (the others by the same ratio; all at `value` when they are all 0), kept in 0..2. */
export function valuesAt(values: readonly number[], value: number): number[] {
  const v = Math.max(0, Math.min(GAIN_TARGET_MAX, value)), max = Math.max(0, ...values)
  return max > 0 ? values.map(g => Math.min(GAIN_TARGET_MAX, roundGain(g * v / max))) : values.map(() => roundGain(v))
}

/** One target's values before and after an edit (the undo record). */
export interface TargetChange { key: string; before: number[]; after: number[] }

/** The distinct targets of `names` in `lane` (each once, in the order first met). */
export function targetsOf(table: CueTable, names: Iterable<string>, lane: Lane): GainTarget[] {
  const out = new Map<string, GainTarget>()
  for (const name of names) { const t = gainTarget(table, name, lane); if (t && !out.has(targetKey(t))) out.set(targetKey(t), t) }
  return [...out.values()]
}

/**
 * Applies `change` (the values now → the new ones) to each of `targets` once: the new table and what changed
 * (unchanged targets left out); the table itself when nothing did.
 */
export function changeTargets(table: CueTable, targets: readonly GainTarget[], change: (values: number[]) => number[]): { table: CueTable; changes: TargetChange[] } {
  let next = table
  const changes: TargetChange[] = []
  for (const t of targets) {
    const before = targetValues(next, t)
    if (!before) continue
    const after = change(before)
    if (after.length !== before.length || after.every((x, i) => x === before[i])) continue
    next = setTargetValues(next, t, after)
    changes.push({ key: targetKey(t), before, after: targetValues(next, t) ?? after })
  }
  return { table: changes.length ? next : table, changes }
}

/** Each target's value as one number: its largest (routes: the fader's value). */
export const targetValue = (values: readonly number[]) => Math.max(0, ...values)
