/**
 * The Events panel's 「同時」 groups by hand: the user's edits (per Scene project, keyed by cue names) applied on top
 * of the automatic grouping (simultaneousGroups: cues the recording fires within MOMENT_S). Display only for the cue
 * table (it is never changed); the groups also say which cues play as context of an audition (trialContext).
 */
export interface GroupEdits {
  /** Cues taken out of their automatic group (「このグループから外す」). */
  detached: string[]
  /** Cue pairs joined by hand (「前のイベントとまとめる」), joined transitively with the rest of their groups. */
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

/** 「前のイベントとまとめる」: `cue` joins the group of `previous` (both come back from a detach). */
export function joinCues(edits: GroupEdits | undefined, previous: string, cue: string): GroupEdits {
  const e = edits ?? NO_GROUP_EDITS
  const joined = e.joined.some(p => p.includes(previous) && p.includes(cue)) ? e.joined : [...e.joined, [previous, cue] as [string, string]]
  return { detached: e.detached.filter(c => c !== previous && c !== cue), joined }
}

/** The other cues of `cue`'s group ([] when it is in none): they play as context of its auditions. */
export function groupContext(groups: readonly (readonly string[])[], cue: string): string[] {
  return groups.find(g => g.includes(cue))?.filter(c => c !== cue) ?? []
}
