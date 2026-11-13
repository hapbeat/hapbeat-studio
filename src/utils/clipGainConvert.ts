/**
 * The one-time DEC-103 rename (intensity → clip_gain) done inside Studio, for the files Studio itself reads: the same
 * key-text rename as scripts/rename-intensity-to-clip-gain.py, so a user does not need the script to open old Kits.
 * Only the key text is replaced (the formatting stays); when that would also hit an "intensity" key with another
 * meaning, the file is skipped (reported), as in the script.
 */

export type ClipGainFileKind = 'manifest' | 'kits-meta' | 'kit-authoring' | 'clips-meta'

export type ClipGainConversion =
  | { text: string; count: number }
  | { skip: string }
  | null

/** Renames `old` to `neu` in `d`; throws when `d` already has both. */
function renameKey(d: unknown, old: string, neu: string): number {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !(old in d)) return 0
  const o = d as Record<string, unknown>
  if (neu in o) throw new Error(`has both ${old} and ${neu}`)
  o[neu] = o[old]
  delete o[old]
  return 1
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => k in (b as object) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const KEYS: Record<ClipGainFileKind, [string, string]> = {
  manifest: ['intensity', 'clip_gain'],
  'kits-meta': ['intensity', 'clipGain'],
  'kit-authoring': ['intensity', 'clipGain'],
  'clips-meta': ['libraryIntensity', 'libraryClipGain'],
}

/** Renames in place on the parsed document; returns the count. */
function renameDoc(kind: ClipGainFileKind, doc: unknown): number {
  const [old, neu] = KEYS[kind]
  let n = 0
  const events = (kit: unknown) => {
    const evs = (kit as { events?: unknown } | null)?.events
    if (Array.isArray(evs)) for (const ev of evs) n += renameKey(ev, old, neu)
  }
  if (kind === 'manifest') {
    if (!doc || typeof doc !== 'object') return 0
    for (const bucket of ['events', 'stream_events']) {
      const entries = (doc as Record<string, unknown>)[bucket]
      if (!entries || typeof entries !== 'object') continue
      for (const entry of Object.values(entries as Record<string, unknown>)) {
        n += renameKey((entry as { parameters?: unknown } | null)?.parameters, old, neu)
      }
    }
  } else if (kind === 'kits-meta') {
    if (Array.isArray(doc)) doc.forEach(events)
  } else if (kind === 'kit-authoring') {
    events(doc)
  } else if (Array.isArray(doc)) {
    for (const clip of doc) n += renameKey(clip, old, neu)
  }
  return n
}

/** The renamed text of a `kind` file, a reason it is skipped, or null when it has nothing to rename (or is not JSON). */
export function convertClipGainText(kind: ClipGainFileKind, text: string): ClipGainConversion {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return null }
  let count: number
  try { count = renameDoc(kind, doc) } catch (err) { return { skip: err instanceof Error ? err.message : String(err) } }
  if (count === 0) return null
  const [old, neu] = KEYS[kind]
  const next = text.replace(new RegExp(`"${old}"(\\s*):`, 'g'), `"${neu}"$1:`)
  let parsed: unknown
  try { parsed = JSON.parse(next) } catch { return { skip: 'the rename broke the JSON' } }
  if (!deepEqual(parsed, doc)) return { skip: `another "${old}" key in the file has a different meaning` }
  return { text: next, count }
}
