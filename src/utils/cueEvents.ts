import type { SceneLib } from './sceneData'
import {
  type CueReview, type ReviewState,
  clampNumber, isLoopCue, positionsForCue, routeClips, sfxSounds, VARIANT_NAME,
  type CueEntry, type CueRoute, type CueSfx, type CueTable, type CueVariant, type CueVariation, type PickMode,
} from './sceneCueTable'

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
}

const variantOf = (table: CueTable, ref: EventRef): CueVariant | null => ref.variant === null ? null : table.cues[ref.cue]?.variants?.[ref.variant] ?? null

/** What an event plays: the variant's fields where it writes them, else the cue's. Null when the event does not exist. */
export function effectiveEvent(table: CueTable, ref: EventRef): EffectiveEvent | null {
  const cue = table.cues[ref.cue]
  if (!cue) return null
  const state = (entry: CueVariant | undefined, field: 'sfx' | 'haptics'): ReviewState => entry?.review?.[field] ?? 'tentative'
  if (ref.variant === null) return { ref, description: cue.description, sfx: cue.sfx, haptics: cue.haptics, variation: cue.variation, own: { sfx: true, haptics: true, variation: true },
    review: { sfx: state(cue, 'sfx'), haptics: state(cue, 'haptics') } }
  const v = variantOf(table, ref)
  if (!v) return null
  const own = { sfx: v.sfx !== undefined, haptics: v.haptics !== undefined, variation: v.variation !== undefined }
  return { ref, description: v.description ?? cue.description, sfx: own.sfx ? v.sfx ?? null : cue.sfx, haptics: own.haptics ? v.haptics! : cue.haptics, variation: own.variation ? v.variation : cue.variation, own,
    review: { sfx: state(own.sfx ? v : cue, 'sfx'), haptics: state(own.haptics ? v : cue, 'haptics') } }
}

/** Assigned and approved / assigned but tentative / nothing assigned; 'na' for a loop cue's sound (continuous layers have no cue sound). */
export type MaterialStatus = ReviewState | 'unset'
export type SoundStatus = MaterialStatus | 'na'
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
  return { key: eventKey(ref), ref, description: e.description, loop, sound: loop ? 'na' : e.sfx ? e.review.sfx : 'unset', haptic: e.haptics.length ? e.review.haptics : 'unset', variants }
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
 * else each listed variant. Unknown names are skipped, and loop cues for sounds.
 */
export function assignEventsForTrial(table: CueTable, lib: SceneLib, cues: readonly string[], target: 'sound' | 'haptic'): string[] {
  const refs = cues.map(name => resolveEventName(table, name)).filter((r): r is NonNullable<typeof r> => !!r && !r.unknownVariant).map(r => r.ref)
  const out: string[] = []
  for (const ref of refs) {
    if (target === 'sound' && isLoopCue(lib, ref.cue)) continue
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
  return next
}

export interface HapticDecision { ref: EventRef; clip: string; /** at / gain for a new route (used only when the event has none). */ at: string; gain: number }
/**
 * Clip entry (added with intensity 1.0 and the cue's loop kind; an existing
 * entry keeps its values) + the event's haptics: the first route plays `clip`
 * (its at / gain kept), or a new route when there is none. A variant that
 * inherited its haptics gets its own copy first.
 */
export function applyHapticDecision(table: CueTable, lib: SceneLib, d: HapticDecision): CueTable {
  const next = edited(table, d.ref, (entry, effective) => {
    const routes = effective.haptics
    if (routes.length) { const { clips: _drop, ...first } = routes[0]; routes[0] = { ...first, clip: d.clip } }
    else routes.push({ clip: d.clip, at: d.at, gain: clampNumber(d.gain, 0, 2) })
    entry.haptics = routes
    // A decision is tentative until the user approves it.
    entry.review = { ...(entry.review ?? {}), haptics: 'tentative' }
  })
  if (!next.clips[d.clip]) next.clips[d.clip] = { intensity: 1.0, loop: isLoopCue(lib, d.ref.cue), description: `Decided in Studio for ${eventKey(d.ref)}` }
  return next
}
/** The event's sound becomes `sound` (one sound; volume kept, 1.0 when it had none). */
export function applySoundDecision(table: CueTable, ref: EventRef, sound: string): CueTable {
  return edited(table, ref, (entry, effective) => {
    entry.sfx = { sound, volume: effective.sfx ? effective.sfx.volume : 1.0 }
    entry.review = { ...(entry.review ?? {}), sfx: 'tentative' }
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
    if (field === 'sfx') entry.sfx = effective.sfx
    else if (field === 'haptics') entry.haptics = effective.haptics
    else entry.variation = effective.variation ?? {}
  })
}
/** Sets / clears (undefined) `variation` fields of what `ref` writes; an emptied variation is removed (a variant then inherits again only through setOverride). */
export function setVariation(table: CueTable, ref: EventRef, patch: Partial<CueVariation>): CueTable {
  return edited(table, ref, entry => {
    const v: CueVariation = { ...(entry.variation ?? {}) }
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete v[key]; else v[key] = value
    if (Object.keys(v).length || ref.variant !== null) entry.variation = v
    else delete entry.variation
  })
}
/** Route `index` of what `ref` writes plays `clips` (one = `clip`, several = `clips`). */
export function setRouteClips(table: CueTable, ref: EventRef, index: number, clips: string[]): CueTable {
  if (!clips.length) return table
  return edited(table, ref, entry => {
    const route = entry.haptics?.[index]
    if (!route) return
    delete route.clip; delete route.clips
    if (clips.length === 1) route.clip = clips[0]; else route.clips = [...clips]
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
/** The sfx `ref` writes plays `sounds` (one = `sound`, several = `sounds`; empty = no sound); volume kept (1.0 when new). */
export function setSfxSounds(table: CueTable, ref: EventRef, sounds: string[]): CueTable {
  return edited(table, ref, entry => {
    const volume = entry.sfx ? entry.sfx.volume : 1.0
    entry.sfx = !sounds.length ? null : sounds.length === 1 ? { sound: sounds[0], volume } : { sounds: [...sounds], volume }
  })
}
export function setOwnSfxVolume(table: CueTable, ref: EventRef, volume: number): CueTable {
  return edited(table, ref, entry => { if (entry.sfx) entry.sfx.volume = clampNumber(volume, 0, 2) })
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

// ── The recording: how often events fire, which fire together ──

/** Firings per event key in the recording (`cue:variant` names resolved like the game; unknown names skipped). */
export function eventFireCounts(table: CueTable, events: readonly { name: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const ev of events) { const r = resolveEventName(table, ev.name); if (r) { const k = eventKey(r.ref); out[k] = (out[k] ?? 0) + 1 } }
  return out
}

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

/** True when the event writes anything of the "Repetition" section (several clips / sounds, or a variation). */
export function hasRepeatSettings(e: EffectiveEvent): boolean {
  return sfxSounds(e.sfx).length > 1 || e.haptics.some(r => routeClips(r).length > 1) || (!!e.variation && Object.keys(e.variation).length > 0)
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

/** Clip ids / `trialId/candidateId` whose decision put a material on `event` ("edit as clip" opens that clip instead of the bare WAV). */
export function decidedSubjects(marks: Record<string, readonly { project: string; event: string; target: string }[]>, project: string, event: string, target: string): string[] {
  return Object.entries(marks).filter(([, list]) => list.some(m => m.project === project && m.event === event && m.target === target)).map(([subject]) => subject)
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
