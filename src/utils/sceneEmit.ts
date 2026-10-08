import type { SceneData, SceneEvent, SceneLayer, SceneLib } from './sceneData'
import type { CueEmit, CueTable } from './sceneCueTable'
import { mulberry32 } from './textureDsp'

/**
 * Emitted cues (DEC-088, docs/haptic-authoring-cue-table.md `emit`): a pulse cue
 * the game fires by itself while its `during` loop cue runs, every
 * intervalSec × (1 + U(−j, j)) seconds (j = jitterPct / 100, at least
 * EMIT_MIN_WAIT), the first one at U(0, 1) × one wait after the run starts; a run
 * ends (and starts over) when the loop cue stops. Same rule as Safety Mill
 * `USafetyMillHaptics::TickComponent`.
 *
 * The Scene tab does not play the recorded firings of such a cue: it makes them
 * from the recorded level of the `during` layer (active = the louder hand's gain
 * > 0, as the loop sounds), with a seeded PRNG so a replay — and any seek — gives
 * the same firings until the seed is drawn again.
 */

/** Shortest wait between two firings (s), as the game. */
export const EMIT_MIN_WAIT = 0.02
export const EMIT_INTERVAL_RANGE = [0.05, 30] as const
export const EMIT_JITTER_RANGE = [0, 100] as const

/** A firing made by the emit rule (not recorded). */
export type EmittedEvent = SceneEvent & { emitted?: true }

/** One wait: intervalSec × (1 + U(−j, j)), floored at EMIT_MIN_WAIT. */
export function emitWait(emit: CueEmit, random: () => number): number {
  const j = (emit.jitterPct ?? 0) / 100
  return Math.max(EMIT_MIN_WAIT, emit.intervalSec * (1 + (random() * 2 - 1) * j))
}

/** The firing times of one run [start, end): the first within one wait of the start, then one wait apart. */
export function emitRun(emit: CueEmit, start: number, end: number, random: () => number): number[] {
  const out: number[] = []
  for (let t = start + emitWait(emit, random) * random(); t < end; t += emitWait(emit, random)) out.push(t)
  return out
}

/** The runs [start, end) in replay time where the layer is active: a frame's louder hand gain > 0. */
export function layerRuns(levels: number[][], fps: number, layer: SceneLayer): [number, number][] {
  const runs: [number, number][] = []
  let start: number | null = null
  levels.forEach((row, i) => {
    const on = Math.max(row[layer.gain[0]], row[layer.gain[1]]) > 0
    if (on && start === null) start = i / fps
    else if (!on && start !== null) { runs.push([start, i / fps]); start = null }
  })
  if (start !== null) runs.push([start, levels.length / fps])
  return runs
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The cues with a usable `emit` (an interval in range, a `during` that is a recorded layer), with that layer. */
export function emittingCues(table: CueTable, lib: SceneLib): { cue: string; emit: CueEmit; layer: SceneLayer }[] {
  return Object.entries(table.cues).flatMap(([cue, entry]) => {
    const emit = entry.emit as unknown
    if (!isRecord(emit) || lib.loop_cues.includes(cue)) return []
    const interval = emit.intervalSec, jitter = emit.jitterPct ?? 0
    if (typeof interval !== 'number' || !(interval >= EMIT_INTERVAL_RANGE[0] && interval <= EMIT_INTERVAL_RANGE[1])) return []
    if (typeof jitter !== 'number' || !(jitter >= EMIT_JITTER_RANGE[0] && jitter <= EMIT_JITTER_RANGE[1])) return []
    const layer = lib.layers.find(l => l.cue === emit.during)
    return layer ? [{ cue, emit: emit as CueEmit, layer }] : []
  })
}

/** A cue's own stream of random numbers for `seed` (cues do not share one, so editing one leaves the others as they were). */
function cueRandom(seed: number, cue: string): () => number {
  let h = 2166136261
  for (let i = 0; i < cue.length; i++) h = Math.imul(h ^ cue.charCodeAt(i), 16777619)
  return mulberry32((seed ^ h) >>> 0)
}

/** Every firing the emit rule makes over the whole recording, in time order (hand `both`, as the game's emit sends without a hand). */
export function emittedEvents(table: CueTable, lib: SceneLib, levels: number[][], fps: number, seed: number): EmittedEvent[] {
  const out: EmittedEvent[] = []
  for (const { cue, emit, layer } of emittingCues(table, lib)) {
    const random = cueRandom(seed, cue)
    for (const [start, end] of layerRuns(levels, fps, layer)) for (const t of emitRun(emit, start, end, random)) out.push({ t, name: cue, hand: 'both', emitted: true })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The recording as the Scene tab plays it: the recorded firings of emitting cues replaced by the generated ones. */
export function applyEmits(data: SceneData, table: CueTable, lib: SceneLib, seed: number): SceneData {
  const cues = new Set(emittingCues(table, lib).map(x => x.cue))
  if (!cues.size) return data
  const events = [...data.full.events.filter(e => !cues.has(e.name)), ...emittedEvents(table, lib, data.full.levels, data.fps, seed)].sort((a, b) => a.t - b.t)
  return { ...data, full: { ...data.full, events } }
}

/** What the generated firings depend on in the table (the emits); an edit that leaves it unchanged needs no new firings. */
export const emitSignature = (table: CueTable | null) => table ? JSON.stringify(Object.entries(table.cues).filter(([, c]) => c.emit !== undefined).map(([n, c]) => [n, c.emit])) : ''

/** A new seed for the generated firings ("draw again"). */
export const newEmitSeed = () => Math.floor(Math.random() * 2 ** 32) >>> 0
