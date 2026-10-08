import { parseCueTable, serializeCueTable, type CueTable } from './sceneCueTable'

/**
 * Saving the cue table without losing changes made outside Studio (an agent edits the file directly).
 *
 * Studio remembers the table as it last read / wrote it (`base`). Before every save it reads the file
 * again; when the file changed since, Studio's edits are applied onto the file's version per unit —
 * a field of a cue or of a variant (sfx, haptics, review, variation, …), a variant as a whole when one
 * side added / removed it, a clip entry, a top-level key. A unit changed on both sides keeps Studio's
 * value and is reported as a conflict.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** One unit: the file's value unless Studio changed it (a change on both sides keeps Studio's and is a conflict). */
function pick(base: unknown, ours: unknown, theirs: unknown, path: string, conflicts: string[]): unknown {
  if (same(ours, base)) return theirs
  if (!same(theirs, base) && !same(theirs, ours)) conflicts.push(path)
  return ours
}
/** A record of units (`child` merges one entry when it exists on all three sides, else the entry is one unit). */
function mergeRecord(base: unknown, ours: unknown, theirs: unknown, path: string, conflicts: string[],
  child?: (b: Rec, o: Rec, t: Rec, path: string) => Rec): Rec | undefined {
  if (!isRec(ours) || !isRec(theirs) || !isRec(base)) return pick(base, ours, theirs, path, conflicts) as Rec | undefined
  const out: Rec = {}
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)])) {
    const b = base[key], o = ours[key], t = theirs[key], p = path ? `${path}.${key}` : key
    const v = child && isRec(b) && isRec(o) && isRec(t) ? child(b, o, t, p) : pick(b, o, t, p, conflicts)
    if (v !== undefined) out[key] = v
  }
  return out
}

export function mergeCueTables(base: CueTable, ours: CueTable, theirs: CueTable): { table: CueTable; conflicts: string[] } {
  const conflicts: string[] = []
  const fields = (b: Rec, o: Rec, t: Rec, p: string): Rec => mergeRecord(b, o, t, p, conflicts)!
  const entry = (b: Rec, o: Rec, t: Rec, p: string): Rec => {
    const out: Rec = {}
    for (const key of new Set([...Object.keys(t), ...Object.keys(o), ...Object.keys(b)])) {
      const v = key === 'variants'
        ? mergeRecord(b[key] ?? {}, o[key] ?? {}, t[key] ?? {}, `${p}.variants`, conflicts, fields)
        : pick(b[key], o[key], t[key], `${p}.${key}`, conflicts)
      if (v !== undefined && !(key === 'variants' && isRec(v) && !Object.keys(v).length)) out[key] = v
    }
    return out
  }
  const table: Rec = {}
  const b = base as unknown as Rec, o = ours as unknown as Rec, t = theirs as unknown as Rec
  for (const key of new Set([...Object.keys(t), ...Object.keys(o), ...Object.keys(b)])) {
    const v = key === 'cues' ? mergeRecord(b.cues, o.cues, t.cues, 'cues', conflicts, entry)
      : key === 'clips' || key === 'sounds' ? mergeRecord(b[key] ?? {}, o[key] ?? {}, t[key] ?? {}, key, conflicts)
      : pick(b[key], o[key], t[key], key, conflicts)
    if (v !== undefined) table[key] = v
  }
  return { table: table as unknown as CueTable, conflicts }
}

export interface CueTableIo<P> {
  /** The file now (text and its last-modified time). */
  read(): Promise<{ text: string; mtime: number }>
  /** Its last-modified time only (cheap: polled every 2 s). */
  mtime?(): Promise<number>
  /** Writes the table (after `pending` files); returns the new last-modified time. */
  write(table: CueTable, pending: P): Promise<number>
}
export type SaveResult = { ok: true; table: CueTable; external: boolean; conflicts: string[] } | { ok: false; problems: string[] }

export class CueTableSync<P> {
  private base: CueTable | null = null
  private baseText = ''
  private baseMtime = 0
  constructor(private readonly io: CueTableIo<P>) {}

  /** The table as just read from the file. */
  reset(text: string, mtime: number) { this.base = parseCueTable(text); this.baseText = text; this.baseMtime = mtime }
  get known() { return this.base }
  /** The file text as last read / written (the base Studio's unsaved edits are made on). */
  get fileText() { return this.baseText }

  /** Saves Studio's table, applied onto the file's newer version when it changed outside Studio. `validate` sees the table to write and the file's cue names. */
  async save(ours: CueTable, pending: P, validate: (table: CueTable, external: boolean) => Promise<string[]>): Promise<SaveResult> {
    const disk = await this.io.read()
    const external = !!this.base && disk.text !== this.baseText
    const merged = external ? mergeCueTables(this.base!, ours, parseCueTable(disk.text)) : { table: ours, conflicts: [] }
    const problems = await validate(merged.table, external)
    if (problems.length) return { ok: false, problems }
    const mtime = await this.io.write(merged.table, pending)
    this.base = merged.table; this.baseText = serializeCueTable(merged.table); this.baseMtime = mtime
    return { ok: true, table: merged.table, external, conflicts: merged.conflicts }
  }

  /** The file changed outside Studio since it was last read / written (last-modified time first, then the text). */
  async changedOnDisk(): Promise<string | null> {
    // The text is read only when the last-modified time moved.
    if (this.io.mtime && await this.io.mtime() === this.baseMtime) return null
    const disk = await this.io.read()
    if (disk.mtime === this.baseMtime || disk.text === this.baseText) { this.baseMtime = disk.mtime; return null }
    return disk.text
  }
}
