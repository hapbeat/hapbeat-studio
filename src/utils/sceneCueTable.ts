import type { SceneLib } from './sceneData'

/**
 * The project's cue table (`lib.paths.cues`, e.g. Safety Mill
 * `Content/Hapbeat/safety-mill-cues.json`, T-Rex `Content/Hapbeat/trex-cues.json`):
 * per cue one optional sound effect and any number of haptic routes
 * (Kit clip × body position × gain). The schema and its checks belong to the
 * demos (`Scripts/haptic_cues.py` / `Scripts/trex_haptic_cues.py` `validate`);
 * `validateCueTable` runs the same checks with what the lib provides, so a
 * table saved here passes the project's import step.
 *
 * Edits are immutable (each returns a new table); unknown fields are kept.
 *
 * v2 (docs/haptic-authoring-cue-table.md, DEC-083) adds optional fields only:
 * per-cue `variants` (each overrides `sfx` / `haptics` / `variation` as a
 * whole, the rest is inherited from the cue), `variation` (jitter + how a
 * multi-material route / sound is picked), and multi-material `clips` on a
 * route / `sounds` on a sfx (exactly one of `clip` / `clips`, `sound` / `sounds`).
 */

/** A route plays `clip`, or one of `clips` per firing (picked by `variation.pick`). */
export interface CueRoute { clip?: string; clips?: string[]; at: string; gain: number; [key: string]: unknown }
/** A cue sound: `sound`, or one of `sounds` per firing. */
export interface CueSfx { sound?: string; sounds?: string[]; volume: number; [key: string]: unknown }
export const PICK_MODES = ['random', 'roundRobin'] as const
export type PickMode = typeof PICK_MODES[number]
/** `paired`: the clip with the picked sound's index is played on every route (sounds and each route's clips line up). */
export interface CueVariation { gainJitterDb?: number; pitchJitterSt?: number; rateJitterPct?: number; pick?: PickMode; paired?: boolean; [key: string]: unknown }
/** Whether an assigned sound / haptic is still tentative or approved by the user (missing = tentative). */
export const REVIEW_STATES = ['tentative', 'approved'] as const
export type ReviewState = typeof REVIEW_STATES[number]
export interface CueReview { sfx?: ReviewState; haptics?: ReviewState }
/** A field left out (undefined) is inherited from the cue; `sfx: null` overrides with "no sound". */
export interface CueVariant {
  description?: string; sfx?: CueSfx | null; haptics?: CueRoute[]; variation?: CueVariation; review?: CueReview
  /** A variant that inherits the materials (no own sfx / haptics): scene multipliers on the inherited sfx volume / every route gain (0..2). */
  sfxVolume?: number; hapticsGain?: number
  /** Over a run of firings the multipliers go from sfxVolume / hapticsGain (default 1) to this (0..2), shaped by `rampCurve`. */
  rampTo?: number
  /** The shape of the ramp (default linear; needs rampTo). */
  rampCurve?: RampCurve
  /** One multiplier per firing of a run (1–64, 0..2; past the end the last one) — instead of rampTo / rampCurve. */
  rampSteps?: number[]
  /** Scene multiplier by distance (own; null = none here; absent = the cue's). */
  distanceFalloff?: DistanceFalloff | null
  [key: string]: unknown
}
/**
 * Scene multiplier by the distance to the player, on sound and haptics: 1 + (farGain − 1) × curve(t),
 * t = clamp((distance − nearCm) / (farCm − nearCm)). The game uses the live distance; Studio the recorded `dist`.
 */
export interface DistanceFalloff { nearCm: number; farCm: number; farGain: number; curve?: RampCurve }
/**
 * Undecided vs none: a cue without the `sfx` / `haptics` key has not been decided yet;
 * `sfx: null` = no sound and `haptics: []` = no haptic (both decided). The game plays neither.
 */
export interface CueEntry {
  description?: string; sfx?: CueSfx | null; haptics?: CueRoute[]
  /** Scene multiplier by distance (null / absent = none). */
  distanceFalloff?: DistanceFalloff | null
  variants?: Record<string, CueVariant>; variation?: CueVariation
  review?: CueReview
  [key: string]: unknown
}
export const RAMP_CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'sigmoid'] as const
export type RampCurve = typeof RAMP_CURVES[number]

/** Variant names (`<cue>:<variant>` in the game and in viewer-data events). */
export const VARIANT_NAME = /^[a-z][a-z0-9_]*$/
/** Ranges of the numeric `variation` fields. */
export const VARIATION_RANGES = { gainJitterDb: [0, 12], pitchJitterSt: [0, 12], rateJitterPct: [0, 50] } as const
export type VariationNumberKey = keyof typeof VARIATION_RANGES

/** The clips a route may play (one for `clip`). */
export const routeClips = (route: CueRoute): string[] => Array.isArray(route.clips) ? route.clips : typeof route.clip === 'string' ? [route.clip] : []
/** The sounds a sfx may play (one for `sound`). */
export const sfxSounds = (sfx: CueSfx | null | undefined): string[] => !sfx ? [] : Array.isArray(sfx.sounds) ? sfx.sounds : typeof sfx.sound === 'string' ? [sfx.sound] : []
export interface ClipEntry { intensity: number; loop: boolean; description?: string; [key: string]: unknown }
/** A sound's base level (DEC-086): the WAV holds the shape at full scale, `intensity` how strong it is (0..1; absent = 1). */
export interface SoundEntry { intensity: number; [key: string]: unknown }
export interface CueTable { kit?: string; clips: Record<string, ClipEntry>; sounds?: Record<string, SoundEntry>; cues: Record<string, CueEntry>; [key: string]: unknown }

/** WAV peak the materials are written at (−0.5 dBFS, DEC-086). */
export const MATERIAL_PEAK = 10 ** (-0.5 / 20)
/** The base level of a sound (its `sounds` entry; 1 when it has none). */
export const soundIntensity = (table: CueTable, sound: string) => table.sounds?.[sound]?.intensity ?? 1
/** The base level of a material: a clip's intensity, or a sound's. */
export const materialIntensity = (table: CueTable, target: 'sound' | 'haptic', name: string) => target === 'haptic' ? table.clips[name]?.intensity ?? 1 : soundIntensity(table, name)

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Structural parse; value ranges are checked by `validateCueTable`. */
export function parseCueTable(text: string): CueTable {
  let v: unknown
  try { v = JSON.parse(text) } catch (error) { throw new Error(`cue table: ${error instanceof Error ? error.message : String(error)}`) }
  if (!isRecord(v) || !isRecord(v.clips) || !isRecord(v.cues)) throw new Error('cue table: clips and cues must be objects')
  for (const [name, clip] of Object.entries(v.clips)) if (!isRecord(clip)) throw new Error(`cue table: clip ${name} must be an object`)
  for (const [name, cue] of Object.entries(v.cues)) {
    if (!isRecord(cue)) throw new Error(`cue table: cue ${name} must be an object`)
    if (cue.haptics !== undefined && !(Array.isArray(cue.haptics) && cue.haptics.every(isRecord))) throw new Error(`cue table: ${name}.haptics must be a list`)
    if (cue.sfx !== undefined && cue.sfx !== null && !isRecord(cue.sfx)) throw new Error(`cue table: ${name}.sfx must be an object or null`)
    if (cue.variation !== undefined && !isRecord(cue.variation)) throw new Error(`cue table: ${name}.variation must be an object`)
    if (cue.distanceFalloff !== undefined && cue.distanceFalloff !== null && !isRecord(cue.distanceFalloff)) throw new Error(`cue table: ${name}.distanceFalloff must be an object or null`)
    if (cue.variants !== undefined) {
      if (!isRecord(cue.variants)) throw new Error(`cue table: ${name}.variants must be an object`)
      for (const [vn, variant] of Object.entries(cue.variants)) {
        const at = `${name}.variants.${vn}`
        if (!isRecord(variant)) throw new Error(`cue table: ${at} must be an object`)
        if (variant.haptics !== undefined && !(Array.isArray(variant.haptics) && variant.haptics.every(isRecord))) throw new Error(`cue table: ${at}.haptics must be a list`)
        if (variant.sfx !== undefined && variant.sfx !== null && !isRecord(variant.sfx)) throw new Error(`cue table: ${at}.sfx must be an object or null`)
        if (variant.variation !== undefined && !isRecord(variant.variation)) throw new Error(`cue table: ${at}.variation must be an object`)
        for (const k of ['sfxVolume', 'hapticsGain', 'rampTo'] as const) if (variant[k] !== undefined && typeof variant[k] !== 'number') throw new Error(`cue table: ${at}.${k} must be a number`)
        if (variant.distanceFalloff !== undefined && variant.distanceFalloff !== null && !isRecord(variant.distanceFalloff)) throw new Error(`cue table: ${at}.distanceFalloff must be an object or null`)
        if (variant.rampCurve !== undefined && typeof variant.rampCurve !== 'string') throw new Error(`cue table: ${at}.rampCurve must be a string`)
        if (variant.rampSteps !== undefined && !(Array.isArray(variant.rampSteps) && variant.rampSteps.every(x => typeof x === 'number'))) throw new Error(`cue table: ${at}.rampSteps must be a list of numbers`)
      }
    }
  }
  const table = v as unknown as CueTable
  // A missing `sfx` / `haptics` stays missing: it means "not decided yet" (see CueEntry).
  return table
}

/** Written exactly like the standalone viewer: 2-space JSON plus a trailing newline. */
export const serializeCueTable = (table: CueTable) => JSON.stringify(table, null, 2) + '\n'

export const isLoopCue = (lib: SceneLib, name: string) => lib.loop_cues.includes(name)
/** A cue may have a sound: one-shot cues always; loop cues only where the project allows looping cue sounds (lib.loop_cue_sounds, T-Rex). */
export const soundAllowed = (lib: SceneLib, name: string) => !isLoopCue(lib, name) || lib.loop_cue_sounds === true

/** Positions a cue's routes may use: lib.at, narrowed by lib.loop_at for loop cues. */
export const positionsForCue = (lib: SceneLib, name: string) =>
  isLoopCue(lib, name) && lib.loop_at ? lib.at.filter(a => lib.loop_at!.includes(a)) : lib.at

/** Clips a cue may use: loop clips for loop cues, one-shots otherwise. */
export const clipsForCue = (table: CueTable, lib: SceneLib, name: string) =>
  Object.keys(table.clips).filter(c => table.clips[c].loop === isLoopCue(lib, name)).sort()

export interface CueTableContext {
  lib: SceneLib
  /** `kit` and cue names of the table as loaded: the scene tab never changes them. */
  kit: string | undefined
  cueNames: string[]
  /** Base names of the WAVs in lib.paths.clips / lib.paths.sounds (including ones written by this save). */
  clipFiles: Set<string>
  soundFiles: Set<string>
}

const inRange = (value: unknown, lo: number, hi: number) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi

/**
 * The demos' `validate(table)` with the lib's vocabulary: kit, clip names /
 * intensity / loop / WAV, the cue set, sound name / WAV / volume, route clip /
 * loop fit / position / gain, and the v2 variants / variation / multi-material
 * fields. Returns every problem (empty = savable). Shared by the Scene tab save and the editor's "decide".
 */
export function validateCueTable(table: CueTable, ctx: CueTableContext): string[] {
  const err: string[] = []
  const { lib } = ctx
  const clipRe = new RegExp(lib.clip_name)
  if (table.kit !== ctx.kit) err.push(`kit must be ${ctx.kit}`)
  const clips = table.clips
  for (const [name, c] of Object.entries(clips)) {
    if (!clipRe.test(name)) err.push(`clip name ${name} must match ${lib.clip_name}`)
    if (!inRange(c.intensity, 0, 1)) err.push(`clip ${name}: intensity must be 0..1`)
    if (typeof c.loop !== 'boolean') err.push(`clip ${name}: loop must be true/false`)
    if (!ctx.clipFiles.has(name)) err.push(`clip ${name}: ${lib.paths.clips}/${name}.wav missing`)
  }
  const sounds = table.sounds as unknown
  if (sounds !== undefined) {
    if (!isRecord(sounds)) err.push('sounds must be an object')
    else {
      const soundRe = new RegExp(lib.sound_name)
      for (const [name, entry] of Object.entries(sounds)) {
        if (!soundRe.test(name)) err.push(`sound name ${name} must match ${lib.sound_name}`)
        if (!isRecord(entry) || !inRange(entry.intensity, 0, 1)) err.push(`sound ${name}: intensity must be 0..1`)
        if (!ctx.soundFiles.has(name)) err.push(`sound ${name}: ${lib.paths.sounds}/${name}.wav missing`)
      }
    }
  }
  const names = Object.keys(table.cues)
  if (names.length !== ctx.cueNames.length || names.some(n => !ctx.cueNames.includes(n))) err.push(`cues must be exactly ${ctx.cueNames.join(', ')}`)
  for (const [name, cue] of Object.entries(table.cues)) {
    validateCueFields(err, table, ctx, name, name, cue)
    for (const [vn, variant] of Object.entries(cue.variants ?? {})) {
      if (!VARIANT_NAME.test(vn)) err.push(`${name}: variant name ${vn} must match ${VARIANT_NAME.source}`)
      validateCueFields(err, table, ctx, name, `${name}:${vn}`, variant)
      validateVariantScale(err, `${name}:${vn}`, variant)
    }
  }
  return err
}

/** A variant's scene multipliers: 0..2, only on what it inherits (with its own sfx / haptics they cannot be used). */
function validateVariantScale(err: string[], label: string, v: CueVariant): void {
  for (const k of ['sfxVolume', 'hapticsGain', 'rampTo'] as const) if (v[k] !== undefined && !inRange(v[k], 0, 2)) err.push(`${label}: ${k} must be 0..2`)
  if (v.sfxVolume !== undefined && v.sfx !== undefined) err.push(`${label}: sfxVolume is for an inherited sfx (this variant has its own sfx)`)
  if (v.hapticsGain !== undefined && v.haptics !== undefined) err.push(`${label}: hapticsGain is for inherited haptics (this variant has its own haptics)`)
  if (v.rampTo !== undefined && v.sfx !== undefined && v.haptics !== undefined) err.push(`${label}: rampTo needs an inherited sfx or haptics`)
  if (v.rampCurve !== undefined) {
    if (!(RAMP_CURVES as readonly string[]).includes(v.rampCurve)) err.push(`${label}: rampCurve must be one of ${RAMP_CURVES.join(', ')}`)
    if (v.rampTo === undefined) err.push(`${label}: rampCurve needs rampTo`)
  }
  if (v.rampSteps !== undefined) {
    if (v.rampSteps.length < 1 || v.rampSteps.length > 64 || v.rampSteps.some(x => !inRange(x, 0, 2))) err.push(`${label}: rampSteps must be 1-64 numbers 0..2`)
    if (v.rampTo !== undefined || v.rampCurve !== undefined) err.push(`${label}: rampSteps replaces rampTo / rampCurve (not both)`)
    if (v.sfx !== undefined && v.haptics !== undefined) err.push(`${label}: rampSteps needs an inherited sfx or haptics`)
  }
}

/**
 * The checks of one cue or variant (`label` names it in messages; `cue` is the
 * cue whose loop kind / positions apply). Fields a variant leaves out are inherited, so they are not checked twice.
 * In a loop cue only `variation.gainJitterDb` takes effect; the other variation fields are allowed but ignored.
 */
function validateCueFields(err: string[], table: CueTable, ctx: CueTableContext, cue: string, label: string, entry: CueVariant): void {
  const { lib } = ctx, clips = table.clips, soundRe = new RegExp(lib.sound_name)
  const sfx = entry.sfx
  if (sfx) {
    const hasOne = sfx.sound !== undefined, hasMany = sfx.sounds !== undefined
    if (isLoopCue(lib, cue) && !lib.loop_cue_sounds) err.push(`${label}: continuous layers have no cue sound`)
    else if (hasOne === hasMany) err.push(`${label}: sfx needs exactly one of sound / sounds`)
    else if (hasMany && !(Array.isArray(sfx.sounds) && sfx.sounds.length > 0)) err.push(`${label}: sfx.sounds must be a non-empty list`)
    else for (const sound of hasMany ? sfx.sounds! : [sfx.sound]) {
      if (typeof sound !== 'string' || !soundRe.test(sound) || lib.loop_sounds.includes(sound)) err.push(`${label}: bad sound ${String(sound)}`)
      else if (!ctx.soundFiles.has(sound)) err.push(`${label}: ${lib.paths.sounds}/${sound}.wav missing`)
    }
    if (!inRange(sfx.volume, 0, 2)) err.push(`${label}: sfx volume must be 0..2`)
  }
  for (const r of entry.haptics ?? []) {
    const hasOne = r.clip !== undefined, hasMany = r.clips !== undefined
    if (hasOne === hasMany) err.push(`${label}: a route needs exactly one of clip / clips`)
    else if (hasMany && !(Array.isArray(r.clips) && r.clips.length > 0)) err.push(`${label}: route clips must be a non-empty list`)
    else for (const clip of hasMany ? r.clips! : [r.clip]) {
      if (typeof clip !== 'string' || !Object.prototype.hasOwnProperty.call(clips, clip)) err.push(`${label}: unknown clip ${String(clip)}`)
      else if (clips[clip].loop !== isLoopCue(lib, cue)) err.push(`${label}: clip ${clip} loop=${clips[clip].loop} does not fit this cue`)
    }
    if (!lib.at.includes(r.at)) err.push(`${label}: at must be one of ${lib.at.join(', ')}`)
    else if (!positionsForCue(lib, cue).includes(r.at)) err.push(`${label}: continuous layers allow at = ${positionsForCue(lib, cue).join(', ')}`)
    if (!inRange(r.gain, 0, 2)) err.push(`${label}: gain must be 0..2`)
  }
  const df = entry.distanceFalloff
  if (df) {
    if (!inRange(df.nearCm, 0, 1e6) || !inRange(df.farCm, 0, 1e6) || !(df.farCm > df.nearCm)) err.push(`${label}: distanceFalloff needs 0 <= nearCm < farCm`)
    if (!inRange(df.farGain, 0, 2)) err.push(`${label}: distanceFalloff.farGain must be 0..2`)
    if (df.curve !== undefined && !(RAMP_CURVES as readonly string[]).includes(df.curve)) err.push(`${label}: distanceFalloff.curve must be one of ${RAMP_CURVES.join(', ')}`)
  }
  const review = entry.review as unknown
  if (review !== undefined) {
    if (!review || typeof review !== 'object' || Array.isArray(review)) err.push(`${label}: review must be an object`)
    else for (const [key, state] of Object.entries(review)) {
      if (key !== 'sfx' && key !== 'haptics') err.push(`${label}: review.${key} is not a field (sfx / haptics)`)
      else if (!(REVIEW_STATES as readonly unknown[]).includes(state)) err.push(`${label}: review.${key} must be ${REVIEW_STATES.join(' or ')}`)
    }
  }
  // `preview` (Studio's repeated preview) was removed (DEC-085): repetition is heard with "×5" and the recording's real firings.
  if (entry.preview !== undefined) err.push(`${label}: preview is not a field (removed; use the recording or ×5 in Studio)`)
  const v = entry.variation
  if (v !== undefined) {
    for (const [key, [lo, hi]] of Object.entries(VARIATION_RANGES)) if (v[key] !== undefined && !inRange(v[key], lo, hi)) err.push(`${label}: variation.${key} must be ${lo}..${hi}`)
    if (v.pick !== undefined && !(PICK_MODES as readonly unknown[]).includes(v.pick)) err.push(`${label}: variation.pick must be ${PICK_MODES.join(' or ')}`)
    if (v.paired !== undefined && typeof v.paired !== 'boolean') err.push(`${label}: variation.paired must be true/false`)
  }
  // Paired: as many clips on every route as sounds (checked on what this entry plays, inherited fields included).
  const effective = { ...(table.cues[cue] ?? {}), ...entry } as CueVariant
  if (effective.variation?.paired === true) {
    const problem = pairedProblem(effective.sfx ?? null, effective.haptics ?? [])
    if (problem) err.push(`${label}: variation.paired: ${problem}`)
  }
}

/** Why sounds and clips cannot be paired (null when they line up): every route needs as many clips as there are sounds. */
export function pairedProblem(sfx: CueSfx | null, routes: readonly CueRoute[]): string | null {
  const n = sfxSounds(sfx).length
  if (!n) return 'there is no sound to pair'
  const bad = routes.map((r, i) => ({ i, count: routeClips(r).length })).filter(r => r.count !== n)
  return bad.length ? bad.map(r => `route ${r.i + 1} has ${r.count} clip(s) for ${n} sound(s)`).join('; ') : null
}

// ── Edits ──

export const clampNumber = (value: number, lo: number, hi: number) => Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo

/** Sets a sound's base level (adds its `sounds` entry). */
// Intensity setters share every untouched part (cues stay the same object): a strength change re-resolves nothing that reads only the cues.
export function setSoundIntensity(table: CueTable, sound: string, intensity: number): CueTable {
  return { ...table, sounds: { ...(table.sounds ?? {}), [sound]: { ...(table.sounds?.[sound] ?? {}), intensity: clampNumber(intensity, 0, 1) } } }
}
export function setClipIntensity(table: CueTable, clip: string, intensity: number): CueTable {
  return { ...table, clips: { ...table.clips, [clip]: { ...table.clips[clip], intensity: clampNumber(intensity, 0, 1) } } }
}

/** Interleaved float samples → PCM16 WAV (the viewer's writer: clips 16 kHz mono, sounds 48 kHz). */
export function encodePcm16Wav(samples: Float32Array, rate: number, channels: number): ArrayBuffer {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * channels * 2, true); dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true)
  return buf
}
