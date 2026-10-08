import { parseCueTable, serializeCueTable, type CueTable } from './sceneCueTable'
import { mergeCueTables } from './cueTableSync'

/**
 * The Scene tab's edit journal: every table edit is written to localStorage at once (synchronously), with the file
 * text it was made on (`base`), so an edit survives a reload / closed tab / crash before the 300 ms autosave (or its
 * async file write) finished. It is cleared once the file is written and reads back as saved. On opening the project,
 * a journal left over is applied onto the file like an outside change (mergeCueTables: Studio's changes since `base`
 * win, the file's other changes are kept) and saved.
 */

export interface SceneJournal { table: string; base: string; savedAt: number }

const PREFIX = 'hapbeat-scene-journal:'
/** One journal per project and cue table path. */
export const journalKey = (project: string, cuesPath: string) => `${PREFIX}${project}:${cuesPath}`

/** Writes the journal; false when storage is unavailable (private window, quota): the file autosave still runs. */
export function writeJournal(key: string, table: CueTable, base: string, now = Date.now()): boolean {
  try { localStorage.setItem(key, JSON.stringify({ table: serializeCueTable(table), base, savedAt: now } satisfies SceneJournal)); return true } catch { return false }
}
export function readJournal(key: string): SceneJournal | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    if (!v || typeof v !== 'object') return null
    const j = v as Partial<SceneJournal>
    return typeof j.table === 'string' && typeof j.base === 'string' && typeof j.savedAt === 'number' ? j as SceneJournal : null
  } catch { return null }
}
export function clearJournal(key: string): void {
  try { localStorage.removeItem(key) } catch { /* nothing kept */ }
}

/**
 * The table to restore from `journal` onto the file's text now: Studio's journaled edits applied onto the file
 * (mergeCueTables with the journal's base; a unit changed on both sides keeps the journaled value and is a conflict).
 * Null when the file already has them (nothing to restore) or the journal cannot be read.
 */
export function restoreFromJournal(journal: SceneJournal, fileText: string): { table: CueTable; conflicts: string[] } | null {
  let base: CueTable, ours: CueTable, theirs: CueTable
  try { base = parseCueTable(journal.base); ours = parseCueTable(journal.table); theirs = parseCueTable(fileText) } catch { return null }
  const merged = journal.base === fileText ? { table: ours, conflicts: [] } : mergeCueTables(base, ours, theirs)
  return serializeCueTable(merged.table) === serializeCueTable(theirs) ? null : merged
}
