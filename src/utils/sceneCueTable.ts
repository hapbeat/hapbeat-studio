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
 */

export interface CueRoute { clip: string; at: string; gain: number }
export interface CueSfx { sound: string; volume: number }
export interface CueEntry { description?: string; sfx: CueSfx | null; haptics: CueRoute[]; [key: string]: unknown }
export interface ClipEntry { intensity: number; loop: boolean; description?: string; [key: string]: unknown }
export interface CueTable { kit?: string; clips: Record<string, ClipEntry>; cues: Record<string, CueEntry>; [key: string]: unknown }

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
  }
  const table = v as unknown as CueTable
  // Missing `haptics` / `sfx` read as empty, as the demo scripts do (`cue.get(...)`).
  for (const cue of Object.values(table.cues)) { cue.haptics ??= []; cue.sfx ??= null }
  return table
}

/** Written exactly like the standalone viewer: 2-space JSON plus a trailing newline. */
export const serializeCueTable = (table: CueTable) => JSON.stringify(table, null, 2) + '\n'

export const isLoopCue = (lib: SceneLib, name: string) => lib.loop_cues.includes(name)

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
 * loop fit / position / gain. Returns every problem (empty = savable).
 */
export function validateCueTable(table: CueTable, ctx: CueTableContext): string[] {
  const err: string[] = []
  const { lib } = ctx
  const clipRe = new RegExp(lib.clip_name), soundRe = new RegExp(lib.sound_name)
  if (table.kit !== ctx.kit) err.push(`kit must be ${ctx.kit}`)
  const clips = table.clips
  for (const [name, c] of Object.entries(clips)) {
    if (!clipRe.test(name)) err.push(`clip name ${name} must match ${lib.clip_name}`)
    if (!inRange(c.intensity, 0, 1)) err.push(`clip ${name}: intensity must be 0..1`)
    if (typeof c.loop !== 'boolean') err.push(`clip ${name}: loop must be true/false`)
    if (!ctx.clipFiles.has(name)) err.push(`clip ${name}: ${lib.paths.clips}/${name}.wav missing`)
  }
  const names = Object.keys(table.cues)
  if (names.length !== ctx.cueNames.length || names.some(n => !ctx.cueNames.includes(n))) err.push(`cues must be exactly ${ctx.cueNames.join(', ')}`)
  for (const [name, cue] of Object.entries(table.cues)) {
    const sfx = cue.sfx
    if (sfx) {
      if (isLoopCue(lib, name)) err.push(`${name}: continuous layers have no cue sound`)
      else if (typeof sfx.sound !== 'string' || !soundRe.test(sfx.sound) || lib.loop_sounds.includes(sfx.sound)) err.push(`${name}: bad sound ${String(sfx.sound)}`)
      else if (!ctx.soundFiles.has(sfx.sound)) err.push(`${name}: ${lib.paths.sounds}/${sfx.sound}.wav missing`)
      if (!inRange(sfx.volume, 0, 2)) err.push(`${name}: sfx volume must be 0..2`)
    }
    for (const r of cue.haptics) {
      if (!Object.prototype.hasOwnProperty.call(clips, r.clip)) err.push(`${name}: unknown clip ${String(r.clip)}`)
      else if (clips[r.clip].loop !== isLoopCue(lib, name)) err.push(`${name}: clip ${r.clip} loop=${clips[r.clip].loop} does not fit this cue`)
      if (!lib.at.includes(r.at)) err.push(`${name}: at must be one of ${lib.at.join(', ')}`)
      else if (!positionsForCue(lib, name).includes(r.at)) err.push(`${name}: continuous layers allow at = ${positionsForCue(lib, name).join(', ')}`)
      if (!inRange(r.gain, 0, 2)) err.push(`${name}: gain must be 0..2`)
    }
  }
  return err
}

// ── Edits ──

const clone = (table: CueTable): CueTable => structuredClone(table)
export const clampNumber = (value: number, lo: number, hi: number) => Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo

export function updateRoute(table: CueTable, cue: string, index: number, patch: Partial<CueRoute>): CueTable {
  const next = clone(table), route = next.cues[cue].haptics[index]
  Object.assign(route, patch)
  if (patch.gain !== undefined) route.gain = clampNumber(patch.gain, 0, 2)
  return next
}

/** Adds a route with the first clip that fits the cue (null when the table has none). */
export function addRoute(table: CueTable, lib: SceneLib, cue: string, clip?: string): CueTable | null {
  const chosen = clip ?? Object.keys(table.clips).find(c => table.clips[c].loop === isLoopCue(lib, cue))
  if (!chosen) return null
  const next = clone(table), positions = positionsForCue(lib, cue)
  next.cues[cue].haptics.push({ clip: chosen, at: positions.includes('hand') ? 'hand' : positions[0] ?? 'hand', gain: 1.0 })
  return next
}

export function removeRoute(table: CueTable, cue: string, index: number): CueTable {
  const next = clone(table)
  next.cues[cue].haptics.splice(index, 1)
  return next
}

/** Sets or clears a cue's sound; a new assignment keeps the previous volume (0.6 when there was none). */
export function assignSound(table: CueTable, cue: string, sound: string | null): CueTable {
  const next = clone(table), entry = next.cues[cue]
  entry.sfx = sound ? { sound, volume: entry.sfx ? entry.sfx.volume : 0.6 } : null
  return next
}

export function setSoundVolume(table: CueTable, cue: string, volume: number): CueTable {
  const next = clone(table), sfx = next.cues[cue].sfx
  if (sfx) sfx.volume = clampNumber(volume, 0, 2)
  return next
}

export function setClipIntensity(table: CueTable, clip: string, intensity: number): CueTable {
  const next = clone(table)
  next.clips[clip].intensity = clampNumber(intensity, 0, 1)
  return next
}

export function addClipEntry(table: CueTable, name: string, loop: boolean, sourceFile: string): CueTable {
  const next = clone(table)
  next.clips[name] = { intensity: 1.0, loop, description: `Imported from ${sourceFile}` }
  return next
}

/** `base`, else `base_2`, `base_3`… not in `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base, k = 2
  while (taken.has(name)) name = `${base}_${k++}`
  return name
}

/** Clip name from a dropped file (lower-case, contracts event-id file-name characters), or null when it breaks lib.clip_name. */
export function clipNameFromFile(fileName: string, taken: Set<string>, pattern: string): string | null {
  const base = fileName.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '') || 'clip'
  const name = uniqueName(base, taken)
  return new RegExp(pattern).test(name) ? name : null
}

/** Sound name from a dropped file (engine asset name characters), or null when it breaks lib.sound_name. */
export function soundNameFromFile(fileName: string, taken: Set<string>, pattern: string): string | null {
  const base = fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^[^A-Za-z]+/, '') || 'Sfx'
  const name = uniqueName(base, taken)
  return new RegExp(pattern).test(name) ? name : null
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
