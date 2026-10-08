import { firstFirings } from './cueEvents'
import type { CueTable } from './sceneCueTable'
import { MOMENT_S, type SceneData, type SceneLib } from './sceneData'
import { layerRuns } from './sceneEmit'

/**
 * The Events panel's 「同時」 groups by hand: the user's edits (per Scene project, keyed by cue names) applied on top
 * of the automatic grouping (simultaneousGroups: cues the recording fires within MOMENT_S). Display only for the cue
 * table (it is never changed); the groups also say which cues play as context of an audition (trialContext).
 */
export interface GroupEdits {
  /** Cues taken out of their automatic group (「このグループから外す」). */
  detached: string[]
  /** Cue pairs joined by hand (「… と同じグループにする」), joined transitively with the rest of their groups. */
  joined: [string, string][]
}
export const NO_GROUP_EDITS: GroupEdits = { detached: [], joined: [] }

/** The groups after the user's edits: groups of two or more, each in `order` (the table's cue order), in the order of their first cue. */
export function applyGroupEdits(groups: readonly (readonly string[])[], edits: GroupEdits | undefined, order: readonly string[]): string[][] {
  const e = edits ?? NO_GROUP_EDITS, parent = new Map<string, string>()
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
  for (const g of groups) {
    const kept = g.filter(c => order.includes(c) && !e.detached.includes(c))
    for (let i = 1; i < kept.length; i++) union(kept[0], kept[i])
  }
  for (const [a, b] of e.joined) if (order.includes(a) && order.includes(b)) union(a, b)
  const out = new Map<string, string[]>()
  for (const cue of order) { const r = find(cue); out.set(r, [...(out.get(r) ?? []), cue]) }
  return [...out.values()].filter(g => g.length > 1)
}

/** 「このグループから外す」: `cue` leaves its group (its automatic group and every pair joined by hand). */
export function detachCue(edits: GroupEdits | undefined, cue: string): GroupEdits {
  const e = edits ?? NO_GROUP_EDITS
  return { detached: [...new Set([...e.detached, cue])], joined: e.joined.filter(p => !p.includes(cue)) }
}

/**
 * 「{target} と同じグループにする」: `cue` leaves its own group (as detachCue) and joins the group of `target`, which
 * stays as it is. A cue not in the table any more is ignored by applyGroupEdits.
 */
export function joinGroupOf(edits: GroupEdits | undefined, cue: string, target: string): GroupEdits {
  if (cue === target) return edits ?? NO_GROUP_EDITS
  const e = detachCue(edits, cue)
  return { detached: e.detached, joined: [...e.joined, [target, cue]] }
}

/** The other cues of `cue`'s group ([] when it is in none): they play as context of its auditions. */
export function groupContext(groups: readonly (readonly string[])[], cue: string): string[] {
  return groups.find(g => g.includes(cue))?.filter(c => c !== cue) ?? []
}

/**
 * When each cue first plays in the recording (s): its first recorded firing, or — for a loop cue — its layer's first
 * active run when that is earlier. Cues that never play are absent.
 */
export function firstTimes(table: CueTable, lib: SceneLib, data: SceneData): Record<string, number> {
  const out = firstFirings(table, data.full.events)
  for (const layer of lib.layers) {
    const run = table.cues[layer.cue] ? layerRuns(data.full.levels, data.fps, layer)[0] : undefined
    if (run && (out[layer.cue] === undefined || run[0] < out[layer.cue])) out[layer.cue] = run[0]
  }
  return out
}

/**
 * A group's cues in the order they play: by first time (`firsts`); a loop cue starting within MOMENT_S of a one-shot
 * comes after it (the one-shot starts it); cues never played last; otherwise as given.
 */
export function orderByFirst(group: readonly string[], firsts: Record<string, number>, isLoop: (cue: string) => boolean): string[] {
  const key = (cue: string) => (firsts[cue] ?? Infinity) + (isLoop(cue) ? MOMENT_S : 0)
  return group.map((cue, i) => ({ cue, i, k: key(cue) })).sort((a, b) => (a.k - b.k) || (a.i - b.i)).map(x => x.cue)
}
/** A group's header: its cues in play order joined with 「 → 」. */
export const groupLabel = (ordered: readonly string[]) => ordered.join(' → ')

/**
 * The Events list: one item per group (at its first cue's place in the table) or per ungrouped cue. A group never
 * merges its events: `cues` lists every one (each its own selectable row), in play order (orderByFirst).
 */
export function eventListItems(order: readonly string[], groups: readonly (readonly string[])[], firsts: Record<string, number>, isLoop: (cue: string) => boolean): { cues: string[]; group: boolean }[] {
  const out: { cues: string[]; group: boolean }[] = [], done = new Set<string>()
  for (const cue of order) {
    if (done.has(cue)) continue
    const group = groups.find(g => g.includes(cue))
    if (!group) { out.push({ cues: [cue], group: false }); continue }
    group.forEach(c => done.add(c))
    out.push({ cues: orderByFirst(group.filter(c => order.includes(c)), firsts, isLoop), group: true })
  }
  return out
}
