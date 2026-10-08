import type { SceneLib } from './sceneData'
import type { MaterialReserve } from './editorUiSettings'
import {
  type CueReview, type ReviewState,
  clampNumber, isLoopCue, soundAllowed, soundIntensity, positionsForCue, routeAlternates, routeClips, sfxAlternates, sfxSounds, VARIANT_NAME,
  type CueEntry, type CueRoute, type CueSfx, type CueTable, type CueVariant, type CueVariation, type PickMode, type DistanceFalloff, type CueEmit,
} from './sceneCueTable'
import type { LevelMap } from './levelMap'
import { curveAt, type RampCurve } from './rampCurve'

/**
 * Events = the cues of a project's cue table (and their v2 variants), as the
 * editor's Events panel and "decide" see them (DEC-083,
 * docs/haptic-authoring-cue-table.md). A variant inherits every field it does
 * not write from its cue; the game names one as `cue:variant`.
 *
 * Everything here is pure; edits return a new table (unknown fields kept).
 */

export interface EventRef { cue: string; variant: string | null }
/** `cue` or `cue:variant` (the game's and viewer-data's name). */
export const eventKey = (ref: EventRef) => ref.variant ? `${ref.cue}:${ref.variant}` : ref.cue
export function parseEventKey(key: string): EventRef {
  const i = key.indexOf(':')
  return i < 0 ? { cue: key, variant: null } : { cue: key.slice(0, i), variant: key.slice(i + 1) }
}

/**
 * A game cue name (`cue` / `cue:variant`) against the table: null when the cue
 * is unknown; a variant the cue does not have resolves to the cue itself
 * (`unknownVariant` set — the game plays the cue and logs a warning).
 */
export function resolveEventName(table: CueTable, name: string): { ref: EventRef; unknownVariant: string | null } | null {
  const ref = parseEventKey(name), cue = table.cues[ref.cue]
  if (!cue) return null
  if (ref.variant === null) return { ref, unknownVariant: null }
  return cue.variants && Object.prototype.hasOwnProperty.call(cue.variants, ref.variant) ? { ref, unknownVariant: null } : { ref: { cue: ref.cue, variant: null }, unknownVariant: ref.variant }
}

export interface EffectiveEvent {
  ref: EventRef
  description?: string
  sfx: CueSfx | null
  haptics: CueRoute[]
  variation?: CueVariation
  /** Which fields the variant writes itself (always true for a cue). */
  own: { sfx: boolean; haptics: boolean; variation: boolean }
  /** Review of the shown sfx / haptics (from the entry that writes them; missing = tentative). */
  review: { sfx: ReviewState; haptics: ReviewState }
  /** Decided (key present: a material, or none = null / []) vs undecided (no key on the cue). */
  decided: { sfx: boolean; haptics: boolean }
  /** A variant's scene multipliers on what it inherits (1 = none; own fields are never scaled) and its ramp target (null = none). */
  scale: VariantScale
  /** Scene multiplier by distance (the variant's own, else the cue's; null = none). */
  falloff: DistanceFalloff | null
}
/** A variant's multipliers: start values, and a ramp (to rampTo along rampCurve) or one value per firing (steps). */
export interface VariantScale { sfx: number; haptics: number; rampTo: number | null; curve: RampCurve; steps: number[] | null }
const NO_SCALE: VariantScale = { sfx: 1, haptics: 1, rampTo: null, curve: 'linear', steps: null }

const variantOf = (table: CueTable, ref: EventRef): CueVariant | null => ref.variant === null ? null : table.cues[ref.cue]?.variants?.[ref.variant] ?? null

/** What an event plays: the variant's fields where it writes them, else the cue's. Null when the event does not exist. */
export function effectiveEvent(table: CueTable, ref: EventRef): EffectiveEvent | null {
  const cue = table.cues[ref.cue]
  if (!cue) return null
  const state = (entry: CueVariant | undefined, field: 'sfx' | 'haptics'): ReviewState => entry?.review?.[field] ?? 'tentative'
  const cueDecided = { sfx: cue.sfx !== undefined, haptics: cue.haptics !== undefined }
  if (ref.variant === null) return { ref, description: cue.description, sfx: cue.sfx ?? null, haptics: cue.haptics ?? [], variation: cue.variation, own: { sfx: true, haptics: true, variation: true },
    review: { sfx: state(cue, 'sfx'), haptics: state(cue, 'haptics') }, decided: cueDecided, scale: NO_SCALE, falloff: cue.distanceFalloff ?? null }
  const v = variantOf(table, ref)
  if (!v) return null
  const own = { sfx: v.sfx !== undefined, haptics: v.haptics !== undefined, variation: v.variation !== undefined }
  return { ref, description: v.description ?? cue.description, sfx: own.sfx ? v.sfx ?? null : cue.sfx ?? null, haptics: own.haptics ? v.haptics! : cue.haptics ?? [], variation: own.variation ? v.variation : cue.variation, own,
    review: { sfx: state(own.sfx ? v : cue, 'sfx'), haptics: state(own.haptics ? v : cue, 'haptics') },
    decided: { sfx: own.sfx || cueDecided.sfx, haptics: own.haptics || cueDecided.haptics },
    scale: { sfx: own.sfx ? 1 : v.sfxVolume ?? 1, haptics: own.haptics ? 1 : v.hapticsGain ?? 1, rampTo: own.sfx && own.haptics ? null : v.rampTo ?? null,
      curve: v.rampCurve ?? 'linear', steps: own.sfx && own.haptics ? null : v.rampSteps ?? null },
    falloff: v.distanceFalloff !== undefined ? v.distanceFalloff : cue.distanceFalloff ?? null }
}

/**
 * The note shown before a haptic is decided for an event without a sound (none for a loop cue or one with a sound):
 * a warning while its sound is undecided (no `sfx` key), a neutral note when it is decided as none (`sfx: null`).
 */
export function soundFirstNote(e: EffectiveEvent | null, loop: boolean): 'events.soundFirst' | 'events.soundNoneDecided' | null {
  if (!e || loop || e.sfx) return null
  return e.decided.sfx ? 'events.soundNoneDecided' : 'events.soundFirst'
}

/** The sound section's note for an event without sounds: decided as none (`sfx: null`), or still undecided (no `sfx` key). */
export function noSoundNote(e: Pick<EffectiveEvent, 'decided'>): 'events.soundNoneDecided' | 'events.undecidedSound' {
  return e.decided.sfx ? 'events.soundNoneDecided' : 'events.undecidedSound'
}

/** Undecided (no key) / decided as none (null / []) / a material; each decided state is tentative or approved. */
export type MaterialState = 'undecided' | 'none' | 'set'
export interface MaterialStatus { state: MaterialState; review: ReviewState }
/** The state of an event's sound (`sfx`) or haptics. */
export function materialStatus(e: Pick<EffectiveEvent, 'sfx' | 'haptics' | 'decided' | 'review'>, field: 'sfx' | 'haptics'): MaterialStatus {
  const has = field === 'sfx' ? !!e.sfx : e.haptics.length > 0
  return { state: !e.decided[field] ? 'undecided' : has ? 'set' : 'none', review: e.review[field] }
}
/** 'na': a loop cue's sound where the project has no looping cue sounds. */
export type SoundStatus = MaterialStatus | 'na'
/**
 * How an Events status pill shows a material state: 未定 / なし 仮 (grey outline, slashed icon) / なし OK (green outline,
 * slashed icon, ✓: "approved: no material") / 仮 / OK (solid green).
 */
export type MaterialPill = 'undecided' | 'none-tentative' | 'none-approved' | 'tentative' | 'approved'
export function materialPill(s: MaterialStatus): MaterialPill {
  if (s.state === 'undecided') return 'undecided'
  if (s.state === 'none') return s.review === 'approved' ? 'none-approved' : 'none-tentative'
  return s.review
}
export interface EventRow {
  key: string
  ref: EventRef
  description?: string
  loop: boolean
  sound: SoundStatus
  haptic: MaterialStatus
  /** The cue's variants (empty for a variant row). */
  variants: EventRow[]
}

function row(table: CueTable, lib: SceneLib, ref: EventRef, variants: EventRow[]): EventRow {
  const e = effectiveEvent(table, ref)!, loop = isLoopCue(lib, ref.cue)
  return { key: eventKey(ref), ref, description: e.description, loop,
    sound: soundAllowed(lib, ref.cue) ? materialStatus(e, 'sfx') : 'na',
    haptic: materialStatus(e, 'haptics'), variants }
}

/** A variant that writes its own sfx or haptics (shown in the editor as a child row of its cue; DEC-085 addendum). */
export function hasOwnMaterials(table: CueTable, ref: EventRef): boolean {
  const v = variantOf(table, ref)
  return !!v && (v.sfx !== undefined || v.haptics !== undefined)
}

/**
 * The event the editor's Events list highlights and the event detail panel shows for the selected key: a variant with
 * its own sfx / haptics as itself; any other variant (opened from the Scene tab, an AI trial) as its cue.
 */
export function shownEventKey(table: CueTable | null, selected: string | null): string | null {
  if (!selected) return null
  const ref = parseEventKey(selected)
  return eventKey(table && (ref.variant === null || !hasOwnMaterials(table, ref)) ? { cue: ref.cue, variant: null } : ref)
}

/** Every cue in table order, each with its variants nested. */
export function listEvents(table: CueTable, lib: SceneLib): EventRow[] {
  return Object.keys(table.cues).map(cue => row(table, lib, { cue, variant: null },
    Object.keys(table.cues[cue].variants ?? {}).map(variant => row(table, lib, { cue, variant }, []))))
}

/** Every event key of the table (cues, then `cue:variant`). */
export const allEventKeys = (table: CueTable) => Object.entries(table.cues).flatMap(([cue, entry]) => [cue, ...Object.keys(entry.variants ?? {}).map(v => `${cue}:${v}`)])

// ── Decide (an editor clip / AI candidate becomes an event's sound or haptic) ──

const toClipName = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '') || 'clip'
const toSoundName = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('').replace(/^[^A-Za-z]+/, '') || 'Sfx'

/** A WAV name from free text (clip name, candidate label, file name) in the lib's style, or '' when nothing usable is left. */
export function safeWavName(text: string, kind: 'clip' | 'sound', pattern: string): string {
  const base = text.replace(/\.(wav|mp3|ogg|flac)$/i, '').split(/[\\/]/).pop() ?? ''
  const name = kind === 'clip'
    ? base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '')
    : base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/_+$/, '')
  return name && matchesName(name, pattern) ? name : ''
}
/**
 * Base name of a decided WAV: the first source text (original clip name,
 * candidate label, source file name …) that makes a safe name, else the event
 * (`cue` / `cue_variant`; sounds in PascalCase). Collisions are resolved later
 * (nextWavName) against the files on disk.
 */
export function wavBaseName(sources: readonly (string | undefined)[], kind: 'clip' | 'sound', pattern: string, event: EventRef): string {
  for (const text of sources) { const n = text ? safeWavName(text, kind, pattern) : ''; if (n) return n }
  const label = event.variant ? `${event.cue}_${event.variant}` : event.cue
  return kind === 'clip' ? toClipName(label) : toSoundName(label)
}
/** `base`, `base_2`, `base_3` … (the order nextWavName tries). */
export const numberedName = (base: string, n: number) => n <= 1 ? base : `${base}_${n}`
/**
 * The name to write: the first of base, base_2 … that is free, or that already
 * holds exactly these bytes (`same`: nothing to write). `existing` returns a
 * file's bytes, or null when there is none.
 */
export async function nextWavName(base: string, wav: ArrayBuffer, existing: (name: string) => Promise<ArrayBuffer | null>, taken: (name: string) => boolean = () => false): Promise<{ name: string; same: boolean }> {
  for (let n = 1; n < 1000; n++) {
    const name = numberedName(base, n)
    if (taken(name)) continue
    const bytes = await existing(name)
    if (!bytes) return { name, same: false }
    if (sameBytes(bytes, wav)) return { name, same: true }
  }
  throw new Error(`no free WAV name for ${base}`)
}
export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a), y = new Uint8Array(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}
/**
 * Events a rated trial's best candidate is assigned to: per cue named in
 * `scene.cues`, the cue itself when it is listed (its variants inherit it),
 * else each listed variant. Unknown names are skipped, and loop cues for sounds
 * unless the project plays loop-cue sounds.
 */
export function assignEventsForTrial(table: CueTable, lib: SceneLib, cues: readonly string[], target: 'sound' | 'haptic'): string[] {
  const refs = cues.map(name => resolveEventName(table, name)).filter((r): r is NonNullable<typeof r> => !!r && !r.unknownVariant).map(r => r.ref)
  const out: string[] = []
  for (const ref of refs) {
    // A loop cue takes a sound only where the project plays loop-cue sounds (lib.loop_cue_sounds).
    if (target === 'sound' && !soundAllowed(lib, ref.cue)) continue
    const key = refs.some(r => r.cue === ref.cue && r.variant === null) ? ref.cue : eventKey(ref)
    if (!out.includes(key)) out.push(key)
  }
  return out
}
export const matchesName = (name: string, pattern: string) => { try { return new RegExp(pattern).test(name) } catch { return false } }

/** Events (keys) whose own routes / sfx use the clip / sound. A variant counts only for the fields it writes. */
export function materialUsers(table: CueTable, kind: 'clip' | 'sound', name: string): string[] {
  const out: string[] = []
  const uses = (entry: CueVariant) => kind === 'clip' ? (entry.haptics ?? []).some(r => routeClips(r).includes(name)) : sfxSounds(entry.sfx).includes(name)
  for (const [cue, entry] of Object.entries(table.cues)) {
    if (uses(entry)) out.push(cue)
    for (const [variant, v] of Object.entries(entry.variants ?? {})) if (uses(v)) out.push(`${cue}:${variant}`)
  }
  return out
}
/** Other events that would hear the new WAV when `name` is overwritten for `refs` (shown before overwriting). */
export const overwriteUsers = (table: CueTable, kind: 'clip' | 'sound', name: string, keys: readonly string[]) => materialUsers(table, kind, name).filter(k => !keys.includes(k))

/** Body position offered for a new route: the acting hand where the project has it (wrist demos), else the first allowed one. */
export function defaultAt(lib: SceneLib, cue: string): string {
  const positions = positionsForCue(lib, cue)
  return positions.includes('hand') ? 'hand' : positions[0] ?? 'hand'
}
/** True when a haptic decision for `ref` must ask for at / gain (the event has no route to keep them from). */
export const needsRouteForm = (table: CueTable, ref: EventRef) => (effectiveEvent(table, ref)?.haptics.length ?? 0) === 0

/** The entry `ref` writes to: the cue, or the variant (null when it does not exist). */
function ownEntry(table: CueTable, ref: EventRef): CueEntry | CueVariant | null {
  return ref.variant === null ? table.cues[ref.cue] ?? null : variantOf(table, ref)
}
function edited(table: CueTable, ref: EventRef, change: (entry: CueEntry | CueVariant, effective: EffectiveEvent) => void): CueTable {
  const next = structuredClone(table), entry = ownEntry(next, ref), effective = effectiveEvent(next, ref)
  if (!entry || !effective) throw new Error(`unknown event ${eventKey(ref)}`)
  change(entry, structuredClone(effective))
  // A variant that now writes its own sfx / haptics has no multiplier for it (they are for inherited materials only).
  if (ref.variant !== null) {
    const v = entry as CueVariant
    if (v.sfx !== undefined) delete v.sfxVolume
    if (v.haptics !== undefined) delete v.hapticsGain
    if (v.sfx !== undefined && v.haptics !== undefined) { delete v.rampTo; delete v.rampCurve; delete v.rampSteps }
  }
  return next
}

export interface HapticDecision { ref: EventRef; clip: string; /** at / gain for a new route (used only when the event has none). */ at: string; gain: number; /** A new clip entry's intensity (default 1). */ intensity?: number }

// ── Starred (played) and alternates (DEC-089) ──

const uniqueNot = (list: readonly string[], starred: readonly string[]) => [...new Set(list)].filter(x => !starred.includes(x))
/**
 * A sfx playing `sounds` (one = `sound`, several = `sounds`) with `alternates` (unstarred; omitted when empty, a
 * starred name never listed there); every other field of `prev` kept, volume 1.0 when new.
 */
export function sfxWith(prev: CueSfx | null | undefined, sounds: readonly string[], alternates: readonly string[] = sfxAlternates(prev)): CueSfx {
  const { sound: _one, sounds: _many, alternates: _alts, volume, ...rest } = prev ?? { volume: 1.0 }
  const alts = uniqueNot(alternates, sounds)
  return { ...(sounds.length === 1 ? { sound: sounds[0] } : { sounds: [...sounds] }), volume: volume ?? 1.0, ...rest, ...(alts.length ? { alternates: alts } : {}) }
}
/** `route` playing `clips` (one = `clip`) with `alternates` (omitted when empty); at / gain and other fields kept. */
export function routeWith(route: CueRoute, clips: readonly string[], alternates: readonly string[] = routeAlternates(route)): CueRoute {
  const { clip: _one, clips: _many, alternates: _alts, ...rest } = route
  const alts = uniqueNot(alternates, clips)
  return { ...rest, ...(clips.length === 1 ? { clip: clips[0] } : { clips: [...clips] }), ...(alts.length ? { alternates: alts } : {}) }
}
/**
 * Where an adopted / added / put back material goes (DEC-089): to the alternates, or — when nothing is starred
 * yet — starred (it becomes the representative). Unchanged (null) when it is already starred or an alternate.
 */
function adoptInto(starred: readonly string[], alternates: readonly string[], name: string): { starred: string[]; alternates: string[] } | null {
  if (starred.includes(name) || alternates.includes(name)) return null
  return starred.length ? { starred: [...starred], alternates: [...alternates, name] } : { starred: [name], alternates: [...alternates] }
}

/**
 * Clip entry (added with intensity 1.0 and the cue's loop kind; an existing entry keeps its values) + the event's
 * haptics: `clip` joins the first route's alternates (DEC-089; the user stars what plays), or becomes its starred
 * clip when the route has none; a new route when there is none. Never twice. A variant that inherited its haptics
 * gets its own copy first. The review goes back to tentative only when what plays changed.
 */
export function applyHapticDecision(table: CueTable, lib: SceneLib, d: HapticDecision): CueTable {
  const next = edited(table, d.ref, (entry, effective) => {
    const routes = effective.haptics
    let plays = true
    if (routes.length) {
      const before = routeClips(routes[0]), placed = adoptInto(before, routeAlternates(routes[0]), d.clip)
      if (placed) routes[0] = routeWith(routes[0], placed.starred, placed.alternates)
      plays = !!placed && placed.starred.length !== before.length
    } else routes.push({ clip: d.clip, at: d.at, gain: clampNumber(d.gain, 0, 2) })
    entry.haptics = routes
    // A decision that changes what plays is tentative until the user approves it.
    if (plays) entry.review = { ...(entry.review ?? {}), haptics: 'tentative' }
  })
  if (!next.clips[d.clip]) next.clips[d.clip] = { intensity: clampNumber(d.intensity ?? 1, 0, 1), loop: isLoopCue(lib, d.ref.cue), description: `Decided in Studio for ${eventKey(d.ref)}` }
  return next
}
/**
 * `sound` joins the event's alternates (DEC-089), or becomes its starred sound (the representative) when none is
 * starred; never twice. Volume kept, 1.0 when new. The review goes back to tentative only when what plays changed.
 */
export function applySoundDecision(table: CueTable, ref: EventRef, sound: string): CueTable {
  return edited(table, ref, (entry, effective) => {
    const before = sfxSounds(effective.sfx), placed = adoptInto(before, sfxAlternates(effective.sfx), sound)
    entry.sfx = placed ? sfxWith(effective.sfx, placed.starred, placed.alternates) : effective.sfx
    if (placed && placed.starred.length !== before.length) entry.review = { ...(entry.review ?? {}), sfx: 'tentative' }
  })
}

// ── Events panel edits ──

/** Adds an empty variant (inherits everything). Throws on a bad or taken name. */
export function addVariant(table: CueTable, cue: string, name: string): CueTable {
  if (!VARIANT_NAME.test(name)) throw new Error(`variant name must match ${VARIANT_NAME.source}`)
  if (!table.cues[cue]) throw new Error(`unknown cue ${cue}`)
  if (table.cues[cue].variants?.[name]) throw new Error(`${cue}:${name} already exists`)
  const next = structuredClone(table), entry = next.cues[cue]
  entry.variants = { ...(entry.variants ?? {}), [name]: {} }
  return next
}
export function removeVariant(table: CueTable, cue: string, name: string): CueTable {
  const next = structuredClone(table), entry = next.cues[cue]
  if (entry?.variants) { delete entry.variants[name]; if (!Object.keys(entry.variants).length) delete entry.variants }
  return next
}
export type OverridableField = 'sfx' | 'haptics' | 'variation'
/** A variant starts writing `field` (a copy of what it inherited) or goes back to inheriting it. */
export function setOverride(table: CueTable, ref: EventRef, field: OverridableField, on: boolean): CueTable {
  if (ref.variant === null) return table
  return edited(table, ref, (entry, effective) => {
    if (!on) { delete entry[field]; return }
    // The copy keeps how it sounded: the multiplier (sfxVolume / hapticsGain) goes into the copied volume / gains.
    if (field === 'sfx') entry.sfx = effective.sfx && { ...effective.sfx, volume: clampNumber(effective.sfx.volume * effective.scale.sfx, 0, 2) }
    else if (field === 'haptics') entry.haptics = effective.haptics.map(r => ({ ...r, gain: clampNumber(r.gain * effective.scale.haptics, 0, 2) }))
    else entry.variation = effective.variation ?? {}
  })
}
/** A variant's scene multipliers (DEC-086 3rd layer for inherited materials): undefined clears one. */
export function setVariantScale(table: CueTable, ref: EventRef, patch: Partial<Pick<CueVariant, 'sfxVolume' | 'hapticsGain' | 'rampTo' | 'rampCurve' | 'rampSteps'>>): CueTable {
  if (ref.variant === null) return table
  return edited(table, ref, entry => {
    for (const [k, value] of Object.entries(patch)) {
      if (value === undefined) delete entry[k]
      else if (k === 'rampSteps') entry.rampSteps = (value as number[]).slice(0, 64).map(x => Math.round(clampNumber(x, 0, 2) * 1000) / 1000)
      else if (k === 'rampCurve') entry.rampCurve = value as RampCurve
      else entry[k] = clampNumber(value as number, 0, 2)
    }
    // linear is the default (not written); a curve or steps without their ramp make no sense.
    if (entry.rampCurve === 'linear') delete entry.rampCurve
    if (entry.rampTo === undefined) delete entry.rampCurve
  })
}
/** Variant kinds: "materials" (own sfx + haptics, a copy of the inherited ones) or "scale" (inherits both; multipliers only). */
export function setVariantKind(table: CueTable, ref: EventRef, kind: 'materials' | 'scale'): CueTable {
  if (ref.variant === null) return table
  if (kind === 'materials') return setOverride(setOverride(table, ref, 'sfx', true), ref, 'haptics', true)
  return edited(table, ref, entry => { delete entry.sfx; delete entry.haptics })
}
/** The kind of variant `ref`: own materials (either field) or multipliers only. */
export const variantKind = (e: EffectiveEvent): 'materials' | 'scale' => e.own.sfx || e.own.haptics ? 'materials' : 'scale'
/** Sets / clears (undefined) `variation` fields of what `ref` writes; an emptied variation is removed (a variant then inherits again only through setOverride). */
export function setVariation(table: CueTable, ref: EventRef, patch: Partial<CueVariation>): CueTable {
  return edited(table, ref, entry => {
    const v: CueVariation = { ...(entry.variation ?? {}) }
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete v[key]; else v[key] = value
    if (Object.keys(v).length || ref.variant !== null) entry.variation = v
    else delete entry.variation
  })
}
/**
 * Moves pair `index` of a paired event one place (`dir` −1 / +1): its sound and, on every route with as many clips
 * as sounds, its clip (the pairs stay together). Out of range: unchanged.
 */
export function movePair(table: CueTable, ref: EventRef, index: number, dir: -1 | 1): CueTable {
  const j = index + dir
  return edited(table, ref, (entry, effective) => {
    const sounds = sfxSounds(effective.sfx)
    if (j < 0 || j >= sounds.length || index >= sounds.length) return
    const swap = <T,>(list: T[]) => { const next = [...list]; [next[index], next[j]] = [next[j], next[index]]; return next }
    const nextSounds = swap(sounds)
    entry.sfx = effective.sfx && sfxWith(effective.sfx, nextSounds)
    entry.haptics = effective.haptics.map(r => {
      const clips = routeClips(r)
      return clips.length !== sounds.length ? r : routeWith(r, swap(clips))
    })
  })
}
/** Route `index` of what `ref` writes plays `clips` (one = `clip`, several = `clips`); its alternates are kept (less any now starred). */
export function setRouteClips(table: CueTable, ref: EventRef, index: number, clips: string[]): CueTable {
  if (!clips.length) return table
  return edited(table, ref, entry => {
    const route = entry.haptics?.[index]
    if (route) entry.haptics![index] = routeWith(route, clips)
  })
}
export function updateOwnRoute(table: CueTable, ref: EventRef, index: number, patch: { at?: string; gain?: number }): CueTable {
  return edited(table, ref, entry => {
    const route = entry.haptics?.[index]
    if (!route) return
    if (patch.at !== undefined) route.at = patch.at
    if (patch.gain !== undefined) route.gain = clampNumber(patch.gain, 0, 2)
  })
}
export function removeOwnRoute(table: CueTable, ref: EventRef, index: number): CueTable {
  return edited(table, ref, entry => { entry.haptics?.splice(index, 1) })
}
/** The scene multiplier of the sound `ref` writes (sfx.volume, 0..2; DEC-086 3rd layer). */
export function setOwnSfxVolume(table: CueTable, ref: EventRef, volume: number): CueTable {
  return edited(table, ref, entry => { if (entry.sfx) entry.sfx = { ...entry.sfx, volume: clampNumber(volume, 0, 2) } })
}
/** A loop cue's level → multiplier (DEC-090) on its sfx (`'sfx'`) or route `where`; undefined removes it (the multiplier is the level). */
export function setLevelMap(table: CueTable, cue: string, where: 'sfx' | number, map: LevelMap | undefined): CueTable {
  return edited(table, { cue, variant: null }, entry => {
    const target = where === 'sfx' ? entry.sfx : entry.haptics?.[where]
    if (!target) return
    const next = { ...target }
    if (map) next.levelMap = map; else delete next.levelMap
    if (where === 'sfx') entry.sfx = next as CueSfx; else entry.haptics![where] = next as CueRoute
  })
}
/**
 * The sfx `ref` writes plays `sounds` (one = `sound`, several = `sounds`; empty = no sound, its alternates go too);
 * volume and alternates kept (less any now starred; volume 1.0 when new).
 */
export function setSfxSounds(table: CueTable, ref: EventRef, sounds: string[]): CueTable {
  return edited(table, ref, entry => { entry.sfx = !sounds.length ? null : sfxWith(entry.sfx, sounds) })
}
/** The starred and alternate materials of what `ref` writes (a sound, or route `route`'s clips); null when it does not write them. */
function ownMaterials(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number): { starred: string[]; alternates: string[] } | null {
  const e = effectiveEvent(table, ref)
  if (!e) return null
  if (target === 'sound') return e.own.sfx ? { starred: sfxSounds(e.sfx), alternates: sfxAlternates(e.sfx) } : null
  const r = e.own.haptics ? e.haptics[route] : undefined
  return r ? { starred: routeClips(r), alternates: routeAlternates(r) } : null
}
/** Writes the starred / alternate lists of what `ref` writes (a sound, or route `route`). */
function writeMaterials(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number, starred: string[], alternates: string[], review: boolean): CueTable {
  return edited(table, ref, (entry, effective) => {
    if (target === 'sound') entry.sfx = sfxWith(effective.sfx, starred, alternates)
    else entry.haptics![route] = routeWith(effective.haptics[route], starred, alternates)
    if (review) entry.review = { ...(entry.review ?? {}), [target === 'sound' ? 'sfx' : 'haptics']: 'tentative' }
  })
}
/**
 * ★ of one material of what `ref` writes (DEC-089; `route` = the route index for a haptic): on = from the
 * alternates to the end of the starred list, off = from the starred list to the end of the alternates (what plays
 * changed: tentative). Null when nothing changes, or when it would leave nothing starred (refused: the validators
 * need a starred material; "none" is how an event is silenced).
 */
export function setStarred(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number, name: string, on: boolean): CueTable | null {
  const m = ownMaterials(table, ref, target, route)
  if (!m || (on ? !m.alternates.includes(name) : !m.starred.includes(name) || m.starred.length === 1)) return null
  return on ? writeMaterials(table, ref, target, route, [...m.starred, name], m.alternates.filter(x => x !== name), true)
    : writeMaterials(table, ref, target, route, m.starred.filter(x => x !== name), [...m.alternates, name], true)
}
/** True when `name` is the only starred material of what `ref` writes (its ★ cannot be taken off). */
export function isLastStar(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number, name: string): boolean {
  const m = ownMaterials(table, ref, target, route)
  return !!m && m.starred.length === 1 && m.starred[0] === name
}
/**
 * "＋ add" of a material to what `ref` writes (a sound, or route `route`'s clips): to the alternates, or starred when
 * nothing is starred yet (DEC-089, like an adoption). Null when it is already there or `ref` does not write it.
 */
export function addMaterial(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number, name: string): CueTable | null {
  const m = ownMaterials(table, ref, target, route)
  const placed = m && adoptInto(m.starred, m.alternates, name)
  return placed ? writeMaterials(table, ref, target, route, placed.starred, placed.alternates, placed.starred.length !== m!.starred.length) : null
}
/**
 * Takes one material off what `ref` writes (a starred one or an alternate). Null when it is not there, or when it is
 * the last starred one while it cannot go (a route's last clip; a sound with alternates): unstar another or "none".
 * The last starred sound without alternates leaves no sound (`sfx: null`), as before.
 */
export function removeMaterial(table: CueTable, ref: EventRef, target: 'sound' | 'haptic', route: number, name: string): CueTable | null {
  const m = ownMaterials(table, ref, target, route)
  if (!m) return null
  if (m.alternates.includes(name)) return writeMaterials(table, ref, target, route, m.starred, m.alternates.filter(x => x !== name), false)
  if (!m.starred.includes(name)) return null
  const left = m.starred.filter(x => x !== name)
  if (!left.length && (target === 'haptic' || m.alternates.length)) return null
  return target === 'sound' ? setSfxSounds(table, ref, left) : setRouteClips(table, ref, route, left)
}

// ── Playback of v2 events (Scene tab, editor previews) ──

/** Picks one of several materials per firing: `random` never repeats the previous pick, `roundRobin` cycles. State is per key. */
export class MaterialPicker {
  private last = new Map<string, number>()
  constructor(private random: () => number = Math.random) {}
  pick<T>(key: string, options: readonly T[], mode: PickMode = 'random'): T | undefined {
    if (options.length <= 1) return options[0]
    const prev = this.last.get(key)
    let i: number
    if (mode === 'roundRobin') i = prev === undefined ? 0 : (prev + 1) % options.length
    else {
      // Uniform over the options except the previous one.
      const n = options.length - (prev === undefined ? 0 : 1)
      i = Math.min(n - 1, Math.floor(this.random() * n))
      if (prev !== undefined && i >= prev) i++
    }
    this.last.set(key, i)
    return options[i]
  }
}
/** Gain factor of one firing: a uniform ±`db` dB jitter (1 when 0 / absent). */
export const jitterGain = (db: number | undefined, random: () => number = Math.random) => db ? 10 ** ((random() * 2 - 1) * db / 20) : 1

// ── Links to the recording, AI trials and the clip list ──

/** Recorded cue names that show an event: a variant its own `cue:variant`; a cue itself, then its variants (moments recorded before a variant existed show under the cue). */
export function eventSceneCues(table: CueTable, key: string): string[] {
  const ref = parseEventKey(key)
  return ref.variant ? [key] : [ref.cue, ...Object.keys(table.cues[ref.cue]?.variants ?? {}).map(v => `${ref.cue}:${v}`)]
}

interface TrialLike { trial: { id: string; target?: 'sound' | 'haptic'; scene?: { project: string; cues: string[] } } }
/** AI trials whose `scene` names the event (`cue` / `cue:variant`, exact) in `project`, split by target (default haptic). */
export function trialsForEvent<T extends TrialLike>(trials: readonly T[], project: string, key: string): { sound: T[]; haptic: T[] } {
  const linked = trials.filter(r => r.trial.scene?.project === project && r.trial.scene.cues.includes(key))
  return { sound: linked.filter(r => r.trial.target === 'sound'), haptic: linked.filter(r => r.trial.target !== 'sound') }
}
/** The event a trial's candidates are decided for: its first scene cue that exists in the table. */
export function trialEvent(table: CueTable, scene: { cues: string[] } | undefined): string | null {
  for (const name of scene?.cues ?? []) { const r = resolveEventName(table, name); if (r && !r.unknownVariant) return eventKey(r.ref) }
  return null
}

/** Clip-list marks: adds (or moves to the end) one decision, keeping at most `limit` per subject. */
export function addEventMark<M extends { project: string; event: string; target: string }>(marks: Record<string, M[]>, subject: string, mark: M, limit = 20): Record<string, M[]> {
  const list = (marks[subject] ?? []).filter(m => !(m.project === mark.project && m.event === mark.event && m.target === mark.target))
  return { ...marks, [subject]: [...list, mark].slice(-limit) }
}

// ── The recording: which cues fire together ──

/**
 * Cues the recording plays at the same moment (the cue names of one recorded
 * clip, i.e. within MOMENT_S, e.g. roar + roar_impact), joined transitively;
 * ticks and unknown names left out, variants counted as their cue. Groups of
 * two or more, each in table order; display only (the table is not changed).
 */
export function simultaneousGroups(table: CueTable, moments: readonly { names: readonly string[] }[], ticks: readonly string[]): string[][] {
  const order = Object.keys(table.cues), parent = new Map<string, string>()
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r }
  for (const m of moments) {
    const cues = [...new Set(m.names.map(n => resolveEventName(table, n)?.ref.cue).filter((c): c is string => !!c && !ticks.includes(c)))]
    for (let i = 1; i < cues.length; i++) { const a = find(cues[0]), b = find(cues[i]); if (a !== b) parent.set(b, a) }
  }
  const groups = new Map<string, string[]>()
  for (const cue of order) { const r = find(cue); groups.set(r, [...(groups.get(r) ?? []), cue]) }
  return [...groups.values()].filter(g => g.length > 1)
}

/** The recording's first firing (seconds) of each cue (variants counted as their cue); cues it never fires are absent. */
export function firstFirings(table: CueTable, events: readonly { t: number; name: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of events) {
    const cue = resolveEventName(table, e.name)?.ref.cue
    if (cue && (out[cue] === undefined || e.t < out[cue])) out[cue] = e.t
  }
  return out
}

/** "＋ add position": a new route of what `ref` writes with the first route's clip at the next unused position (null when every position is used or no clip fits). */
export function addPositionRoute(table: CueTable, lib: SceneLib, ref: EventRef): CueTable | null {
  const e = effectiveEvent(table, ref)
  if (!e) return null
  const used = new Set(e.haptics.map(r => r.at))
  const at = positionsForCue(lib, ref.cue).find(a => !used.has(a))
  const clip = e.haptics.length ? routeClips(e.haptics[0])[0] : Object.keys(table.clips).find(c => table.clips[c].loop === isLoopCue(lib, ref.cue))
  if (!at || !clip) return null
  return edited(table, ref, (entry, effective) => { entry.haptics = [...effective.haptics, { clip, at, gain: e.haptics[0]?.gain ?? 1.0 }] })
}

// ── Review (tentative / approved) ──

/** Sets the review of the event's shown sfx / haptics on the entry that writes them (the cue when a variant inherits). Approved is written, tentative removes the mark (missing = tentative). */
export function setReview(table: CueTable, ref: EventRef, field: 'sfx' | 'haptics', state: ReviewState): CueTable {
  const e = effectiveEvent(table, ref)
  if (!e) return table
  const owner: EventRef = ref.variant !== null && e.own[field] ? ref : { cue: ref.cue, variant: null }
  return edited(table, owner, entry => {
    const review: CueReview = { ...(entry.review ?? {}) }
    if (state === 'approved') review[field] = 'approved'; else delete review[field]
    if (Object.keys(review).length) entry.review = review; else delete entry.review
  })
}
/** "Set everything back to tentative": removes every review mark (cues and variants). */
export function resetAllReviews(table: CueTable): CueTable {
  const next = structuredClone(table)
  for (const cue of Object.values(next.cues)) {
    delete cue.review
    for (const v of Object.values(cue.variants ?? {})) delete v.review
  }
  return next
}

// ── Undecided / none ──

/** "None" for the event's sound / haptic (sfx: null, haptics: []) on what `ref` writes; tentative like any decision. */
export function setNone(table: CueTable, ref: EventRef, field: 'sfx' | 'haptics'): CueTable {
  return edited(table, ref, entry => {
    if (field === 'sfx') entry.sfx = null; else entry.haptics = []
    entry.review = { ...(entry.review ?? {}), [field]: 'tentative' }
  })
}
/** Back to undecided (a cue only: the key and its review go; a variant uses "inherit" instead). */
export function setUndecided(table: CueTable, cue: string, field: 'sfx' | 'haptics'): CueTable {
  return edited(table, { cue, variant: null }, entry => {
    delete entry[field]
    if (entry.review) { delete entry.review[field]; if (!Object.keys(entry.review).length) delete entry.review }
  })
}
/**
 * The materials "back to undecided" takes off a cue's sound / haptic, to keep as the event's reserves: the sounds
 * (representative first, then the alternates), or each route's clips and alternates in route order with the route's
 * position and gain.
 */
export function undecidedReserves(table: CueTable, cue: string, field: 'sfx' | 'haptics'): MaterialReserve[] {
  const entry = table.cues[cue]
  if (!entry) return []
  if (field === 'sfx') return [...sfxSounds(entry.sfx), ...sfxAlternates(entry.sfx)].map(material => ({ material, target: 'sound' as const }))
  return (entry.haptics ?? []).flatMap(r => [...routeClips(r), ...routeAlternates(r)].map(material => ({ material, target: 'haptic' as const, at: r.at, gain: r.gain })))
}
/**
 * "Put back" of a reserved material: to the cue's alternates, or starred when nothing is starred yet (DEC-089; it
 * becomes the representative); a haptic onto the route at its position (a new route, starred, when there is none);
 * never twice. The review goes to tentative when what plays changed.
 */
export function restoreReserve(table: CueTable, cue: string, r: MaterialReserve): CueTable {
  const ref: EventRef = { cue, variant: null }
  let plays = false
  const next = edited(table, ref, entry => {
    if (r.target === 'sound') {
      const placed = adoptInto(sfxSounds(entry.sfx), sfxAlternates(entry.sfx), r.material)
      if (!placed) return
      plays = !sfxSounds(entry.sfx).length
      entry.sfx = sfxWith(entry.sfx, placed.starred, placed.alternates)
      return
    }
    const routes = entry.haptics ?? [], at = r.at ?? routes[0]?.at
    if (!at) return
    const i = routes.findIndex(x => x.at === at)
    if (i < 0) { entry.haptics = [...routes, { clip: r.material, at, gain: r.gain ?? 1.0 }]; plays = true; return }
    const placed = adoptInto(routeClips(routes[i]), routeAlternates(routes[i]), r.material)
    if (!placed) return
    plays = !routeClips(routes[i]).length
    routes[i] = routeWith(routes[i], placed.starred, placed.alternates)
    entry.haptics = routes
  })
  return plays ? setReview(next, ref, r.target === 'sound' ? 'sfx' : 'haptics', 'tentative') : next
}
// ── One firing (shared by the Scene tab and the editor) ──

/** What one firing of an event plays: picked materials and this firing's jitter (variation). */
export interface Shot {
  sound: string | null
  /** sfx volume × gain jitter. */
  soundGain: number
  /** Pitch shift of the sound in semitones (played as a rate change). */
  pitchSt: number
  /** The gain jitter of this firing in dB (sound and haptics). */
  jitterDb: number
  /** Haptic playback rate (frequency and length together). */
  rate: number
  routes: { clip: string; at: string; /** route gain × gain jitter (× clip intensity is applied by the player). */ gain: number }[]
}
const jitter = (amount: number | undefined, random: () => number) => amount ? (random() * 2 - 1) * amount : 0

/** One firing: materials picked per `variation.pick` (never the previous one at random), gain / pitch / rate jitter drawn. Loop cues: only the gain jitter. */
/**
 * One firing as the game plays it: pick (variation.pick), paired index, gain / pitch / rate jitter, and a variant's
 * multipliers on what it inherits (sfxVolume / hapticsGain), ramped to `rampTo` along `rampCurve` over a run, or
 * `rampSteps` per firing (`run`: which firing of how many; Studio counts firings, see runPosition).
 */
/** A variant's multipliers at `progress` (0..1 through its run) on what it inherits: 1 for own materials and for a cue. */
export interface RunPosition { index: number; count: number }
const ONE: RunPosition = { index: 0, count: 1 }
/** A ramp's multiplier at firing `run.index` of `run.count` from `start` (t = index / (count − 1)). */
export const rampValue = (start: number, to: number, curve: RampCurve, run: RunPosition) => start + (to - start) * curveAt(curve, run.count > 1 ? run.index / (run.count - 1) : 0)
export function scaleAt(e: EffectiveEvent, run: RunPosition = ONE): { sfx: number; haptics: number } {
  const s = e.scale
  const at = (start: number) => s.steps?.length ? s.steps[Math.min(run.index, s.steps.length - 1)] : s.rampTo === null ? start : rampValue(start, s.rampTo, s.curve, run)
  return { sfx: e.own.sfx ? 1 : at(s.sfx), haptics: e.own.haptics ? 1 : at(s.haptics) }
}
/** The distance multiplier at `distCm` (1 without a falloff or without a recorded distance). */
export function falloffGain(f: DistanceFalloff | null, distCm: number | undefined): number {
  if (!f || distCm === undefined || !(f.farCm > f.nearCm)) return 1
  return 1 + (f.farGain - 1) * curveAt(f.curve ?? 'linear', (distCm - f.nearCm) / (f.farCm - f.nearCm))
}
/** Sets (an object), turns off here (null) or — on a variant — goes back to the cue's (undefined) distance falloff. */
export function setDistanceFalloff(table: CueTable, ref: EventRef, value: DistanceFalloff | null | undefined): CueTable {
  return edited(table, ref, entry => { if (value === undefined || (value === null && ref.variant === null)) delete entry.distanceFalloff; else entry.distanceFalloff = value })
}
/**
 * Changes an existing `emit` of a cue (DEC-088; interval 0.05..30 s, jitter 0..100 %). The key keeps its place
 * (the demos write it before `review`); a cue without `emit` is left as it is (the game decides which cues emit).
 */
export function setEmit(table: CueTable, cue: string, patch: Partial<CueEmit>): CueTable {
  return edited(table, { cue, variant: null }, entry => {
    const target = entry as CueEntry, prev = target.emit
    if (!prev) return
    const next: CueEmit = { ...prev, ...patch }
    next.intervalSec = clampNumber(next.intervalSec, 0.05, 30)
    if (next.jitterPct !== undefined) next.jitterPct = clampNumber(next.jitterPct, 0, 100)
    target.emit = next
  })
}
export function fireShot(e: EffectiveEvent, loop: boolean, picker: MaterialPicker, random: () => number = Math.random, run: RunPosition = ONE, distCm?: number): Shot {
  const v = e.variation ?? {}, key = eventKey(e.ref)
  const d = falloffGain(e.falloff, distCm)
  const { sfx: sfxScaleRaw, haptics: hapticScaleRaw } = scaleAt(e, run)
  const sfxScale = sfxScaleRaw * d, hapticScale = hapticScaleRaw * d
  const jitterDb = jitter(v.gainJitterDb, random), gain = 10 ** (jitterDb / 20)
  const pitchSt = loop ? 0 : jitter(v.pitchJitterSt, random)
  const rate = loop ? 1 : 1 + jitter(v.rateJitterPct, random) / 100
  const sounds = sfxSounds(e.sfx)
  const sound = e.sfx ? picker.pick(`${key}#sfx`, sounds, v.pick) ?? null : null
  // Paired: the clip with the sound's index on every route (when they line up), else each route picks on its own.
  const index = v.paired === true && sound ? sounds.indexOf(sound) : -1
  const routes = e.haptics.flatMap((r, i) => {
    const clips = routeClips(r)
    const clip = index >= 0 && clips.length === sounds.length ? clips[index] : picker.pick(`${key}#${i}`, clips, v.pick)
    return clip ? [{ clip, at: r.at, gain: r.gain * hapticScale * gain }] : []
  })
  return { sound, soundGain: (e.sfx?.volume ?? 0) * sfxScale * gain, pitchSt, jitterDb, rate, routes }
}

export interface PlannedShot extends Shot { index: number; atSec: number }

/**
 * The sound the editor plays with a haptic audition: the event's representative (the first of its sound
 * candidates) or the one picked for an AI candidate (`prefer`), always the same, without jitter — picking among
 * the pool and the variation are for the Scene tab's playback only.
 */
export function representativeSound<B>(table: CueTable, lib: SceneLib, names: readonly string[], buffers: Record<string, B>, prefer: string | null = null): { buffer: B; volume: number; loop: boolean } | null {
  for (const name of names) {
    const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
    // `prefer`: a sound of the event's pool picked for what is shown (an AI candidate's `sound`), else the representative.
    const sounds = sfxSounds(e?.sfx), first = prefer && sounds.includes(prefer) && buffers[prefer] ? prefer : sounds[0]
    // The editor plays a material at its base level only (DEC-086: sfx.volume is the scene multiplier).
    if (e?.sfx && first && buffers[first]) return { buffer: buffers[first], volume: soundIntensity(table, first), loop: isLoopCue(lib, e.ref.cue) }
  }
  return null
}

/** On a paired cue (`variation.paired`): the sound with the same index as haptic `clip` (sound i goes with clip i of every route); else null. */
export function pairedSoundOf(e: EffectiveEvent, clip: string): string | null {
  if (e.variation?.paired !== true) return null
  const sounds = sfxSounds(e.sfx)
  for (const r of e.haptics) { const clips = routeClips(r), i = clips.indexOf(clip); if (i >= 0 && clips.length === sounds.length) return sounds[i] }
  return null
}

/**
 * The sound played with what the editor shows (null = the event's representative): an AI haptic candidate's
 * `sound` / the user's pick, else — on a paired scene cue — the sound at the position its clip will take
 * (after the clips already there, in candidate order; none when past the sounds); an event's haptic material or
 * one being adjusted: its paired sound.
 */
export function companionSoundName(table: CueTable, o: {
  audition: { trial: { id: string; candidates: readonly { id: string; sound?: string }[]; scene?: { cues: string[] } }; candidateId: string; picks: Record<string, string> } | null
  material: { event: string; target: 'sound' | 'haptic'; wav: string } | null
}): string | null {
  if (o.audition) {
    const { trial, candidateId, picks } = o.audition
    const own = candidateSound(trial, candidateId, picks)
    if (own) return own
    const cue = trial.scene?.cues[0], r = cue ? resolveEventName(table, cue) : null, e = r && effectiveEvent(table, r.ref)
    if (!e || e.variation?.paired !== true || !e.haptics[0]) return null
    return sfxSounds(e.sfx)[routeClips(e.haptics[0]).length + trial.candidates.findIndex(c => c.id === candidateId)] ?? null
  }
  if (o.material?.target !== 'haptic') return null
  const r = resolveEventName(table, o.material.event), e = r && effectiveEvent(table, r.ref)
  return e ? pairedSoundOf(e, o.material.wav) : null
}

/** The sound played with AI candidate `cid`: the user's pick for it (`picks`, keyed `<trialId>/<cid>`), else its `sound`; null = the representative. */
export function candidateSound(trial: { id: string; candidates: readonly { id: string; sound?: string }[] }, cid: string, picks: Record<string, string>): string | null {
  return picks[`${trial.id}/${cid}`] ?? trial.candidates.find(c => c.id === cid)?.sound ?? null
}

/** The route positions (`at`) an audition of event `name` goes to: its haptic routes, else the project's default position; null for an unknown event. */
export function cueRoutePositions(table: CueTable, lib: SceneLib, name: string): string[] | null {
  const r = resolveEventName(table, name), e = r && effectiveEvent(table, r.ref)
  if (!r || !e) return null
  return e.haptics.length ? [...new Set(e.haptics.map(route => route.at))] : [defaultAt(lib, r.ref.cue)]
}

/** Route positions of every event using a material (a clip of the routes / a sound of the sfx), plus `fallbackEvent`'s; null when none resolves. */
export function materialRoutePositions(table: CueTable, lib: SceneLib, target: 'sound' | 'haptic', wav: string, fallbackEvent: string): string[] | null {
  const users = materialUsers(table, target === 'haptic' ? 'clip' : 'sound', wav)
  const all = [...new Set([...users, fallbackEvent])].flatMap(key => cueRoutePositions(table, lib, key) ?? [])
  return all.length ? [...new Set(all)] : null
}

/** For a paired event: the clip of each route that goes with sound `index` (empty when not paired or not lined up). */
export function pairedClips(e: EffectiveEvent, index: number): { clip: string; at: string }[] {
  if (e.variation?.paired !== true) return []
  const n = sfxSounds(e.sfx).length
  return e.haptics.flatMap(r => { const clips = routeClips(r); return clips.length === n && clips[index] ? [{ clip: clips[index], at: r.at }] : [] })
}
