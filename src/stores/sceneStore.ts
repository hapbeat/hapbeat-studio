import { create } from 'zustand'
import { documentMessage, type MessageId, type MessageParams } from '@/i18n/messages'
import { appFolderStamp, appProjectFileUrl, isAppProject } from '@/utils/appProject'
import { loadDirectoryHandle, saveDirectoryHandle } from '@/utils/localDirectory'
import { buildItems, VIEWER_DIR, type SceneData, type SceneItem, type SceneLib } from '@/utils/sceneData'
import { alignClipGains, CLIP_GAIN_RENAME_SCRIPT, kitCopyDiffers, loopCuesOf, SceneFormatError, serializeCueTable, StaleClipGainKeyError, validateCueTable, type CueTable } from '@/utils/sceneCueTable'
import { createSceneTable, listWavs, openSceneProject, readProjectFile, readSceneTable, writeProjectFile, writeSceneSave, type PendingWavs } from '@/utils/sceneProject'
import { CueTableSync } from '@/utils/cueTableSync'
import { clearJournal, journalKey, readJournal, restoreFromJournal, writeJournal } from '@/utils/sceneJournal'
import { applyOverrides, type SceneOverride } from '@/utils/sceneOverrides'
import { applyEmits, emitSignature, newEmitSeed } from '@/utils/sceneEmit'
import { pageVisible, perfTrack } from '@/utils/perfRegistry'
import { RATE } from '@/utils/sceneHaptics'
import { lastSceneProject, lookupSceneProject, registerSceneProject, rememberSceneProject, restoreSceneHandle } from '@/utils/sceneRegistry'
import { rewriteViewerDataGains, type FiringGainChange } from '@/utils/viewerDataGains'
import { locateProjectKit, type ProjectKit } from '@/utils/sceneKit'
import { onKitManifestWritten } from '@/utils/kitManifestWrites'

/**
 * Scene tab (haptic authoring) state: the opened game project folder, its
 * recording, the cue table being edited (one cue at a time) and the decoded
 * clip / sound audio. Disk is the truth: every table edit is saved 300 ms later
 * (onto the file's newer version when it changed outside Studio, see
 * CueTableSync), and the file is read again when it changes while nothing is
 * unsaved. Until the file has it, each edit is also kept in localStorage at once
 * (sceneJournal) and applied again on the next open. Only the folder handle is
 * kept in IndexedDB (key `scenedir`).
 */

export interface SceneNotice { id: MessageId; params?: MessageParams; error?: boolean }
/**
 * `needsClick`: registered but the folder permission must be granted from a click; `unregistered`: no folder known for the name yet;
 * `otherOpen`: another project is open, and only a click replaces it (an automatic link never does, so the user's choice stays).
 */
export type LinkResult = { ok: true } | { ok: false; reason: 'needsClick' | 'unregistered' | 'cancelled' | 'failed' | 'dirty' | 'otherOpen'; notice?: SceneNotice }
export interface SceneSelection { name: string; /** Time in the current item's video; null when picked from the list. */ t: number | null }

interface SceneState {
  root: FileSystemDirectoryHandle | null
  remembered: FileSystemDirectoryHandle | null
  restored: boolean
  busy: boolean
  lib: SceneLib | null
  /**
   * The recording as Studio uses it: `recorded` with the firings the user changed (sceneOverrides) already renamed,
   * and the firings of emitting cues (DEC-088) made from their `during` layer instead of the recorded ones (sceneEmit).
   */
  data: SceneData | null
  /** The recording as read from the project (viewer-data). */
  recorded: SceneData | null
  /**
   * How `recorded` last changed: 'open' = a project opened (the runtime starts the full replay from 0); 'refresh' = the
   * player app read the same project's recording again after Studio changed it (the runtime keeps its position).
   */
  recordingFrom: 'open' | 'refresh'
  /** Firings changed in the Scene tab ("Change"), until the scene is re-recorded (editor folder scene-overrides/). */
  overrides: SceneOverride[]
  /** Replaces the overrides (data / items recomputed; the caller saves the file). */
  setOverrides: (overrides: SceneOverride[]) => void
  /**
   * Sets recorded firings' own gains (viewer-data `events[i].gain` by index; the strength panel with per-firing editing
   * on): `recorded` and `data` change at once (the runtime fires from them, the bars follow), and viewer-data.json is
   * rewritten 300 ms after the last change, only those `gain` values (rewriteViewerDataGains). The recording is never
   * read again from the file meanwhile (only the cue table is watched), so a pending change is not overwritten.
   */
  setFiringGains: (gains: ReadonlyMap<number, number>) => void
  /** Seed of the emitted cues' firings (one per session, so a replay repeats them); `reseedEmit` draws a new one. */
  emitSeed: number
  reseedEmit: () => void
  items: SceneItem[]
  table: CueTable | null
  /** The open project has no cue table yet (lib.paths.cues): "Create the cue table" is offered (createTable). */
  noTable: boolean
  /** Writes a new cue table for the open project (only when it has none) and reads it. */
  createTable: () => Promise<void>
  /** kit and cue names as loaded (the tab never changes them; save checks it). */
  loaded: { kit: string | undefined; cueNames: string[] } | null
  /**
   * The project's Kit (the cue table's `kit`, locateProjectKit): its manifest's clip gains are the haptic clips'
   * material strength (contracts cue-table §9.1; clipGainOf), the cue table holding a copy that Studio aligns whenever it
   * saves. undefined while looking, null = no Kit (no `kit`, or no Kit folder in the project: the cue table's values).
   * Read again after the table, when the editor writes a Kit manifest (kitManifestWrites) and every 2 s / on focus.
   */
  projectKit: ProjectKit | null | undefined
  /** Why the project's Kit could not be read (a manifest that is not JSON); projectKit is null then. */
  kitError: string | null
  /** Reads the project's Kit again (SceneKitStatus "Check again"). */
  reloadKit: () => Promise<void>
  /** 「cue 表をそろえる」: writes the Kit's clip gains into the cue table now (an edit, saved like any other); false when nothing differs. */
  alignToKit: () => boolean
  clipFiles: string[]
  soundFiles: string[]
  pending: PendingWavs
  /** clip → mono 16 kHz samples. */
  pcm: Record<string, Float32Array>
  /** sound → decoded 48 kHz buffer. */
  sfx: Record<string, AudioBuffer>
  dirty: boolean
  cur: number
  sel: SceneSelection | null
  /** The loop cue span playing in the full replay (replay seconds, without lead-in / post-roll; SceneRuntime.playSpan). */
  span: [number, number] | null
  setSpan: (span: [number, number] | null) => void
  /** The chapter (data.chapters index) whose range plays in the full replay (SceneRuntime.playChapter); null = none. */
  chapter: number | null
  setChapter: (chapter: number | null) => void
  notice: SceneNotice | null
  /** Shown in the video panel while no recording is loaded. */
  empty: SceneNotice | null
  log: string[]
  /** Opens the last opened project (else the Scene tab's remembered folder) once per page; later calls wait for the same run. */
  restore: () => Promise<void>
  /** Opens the player app's project folder (read-only, appProject) at its full replay. */
  openAppProject: (handle: FileSystemDirectoryHandle) => Promise<void>
  /**
   * Checks the open project on disk now, as the 2-second checks do (the player app calls it when its folder changed):
   * the cue table, the Kit and, for the app's project, the recording, the WAVs and the lib / video.
   */
  checkDisk: () => Promise<void>
  /** Opens the folder picker (call from the click handler). */
  pick: () => Promise<void>
  reconnect: () => Promise<void>
  /**
   * Makes the project `name` (null = any project) the open one through the
   * project registry. `interactive` (call from a click): may ask for folder
   * permission, or show the folder picker once for an unregistered project.
   */
  linkProject: (name: string | null, interactive: boolean) => Promise<LinkResult>
  select: (index: number) => void
  selectCue: (name: string, t: number | null) => void
  edit: (change: (table: CueTable) => CueTable | null) => boolean
  /** Saves pending edits now (they are saved 300 ms after the last edit anyway). */
  save: () => Promise<void>
  /** The last automatic save failed (an invalid table or a write error); shown until a save works. */
  saveError: SceneNotice | null
  /**
   * Editor "decide": validates `next` (with the new WAVs), writes the WAVs then
   * the table, and reloads (the Scene tab shows it at once). Refused while the
   * tab has unsaved edits, so a decision never saves them along unseen.
   */
  commitDecision: (next: CueTable, wavs: PendingWavs) => Promise<{ ok: true } | { ok: false; notice: SceneNotice; problems?: string[] }>
  /**
   * Writes new bytes to an existing material WAV (an edited "Edit as clip" result): the previous file goes to
   * `_archive/<dir>/<name>_<time>.wav` first (never deleted), then the cache is decoded again.
   */
  replaceMaterial: (target: 'sound' | 'haptic', name: string, wav: ArrayBuffer) => Promise<{ archived: string }>
  revert: () => Promise<void>
  note: (notice: SceneNotice) => void
  addLog: (text: string) => void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** The clipGain.staleKey parameters of a file still carrying `intensity` (`file` names it better than the error can). */
const staleParams = (error: StaleClipGainKeyError, file = error.file): MessageParams => ({ file, entries: error.entries.join(', '), script: CLIP_GAIN_RENAME_SCRIPT })
const clipKey = (project: string) => `hapbeat-scene-clip:${project}`

async function decode(buf: ArrayBuffer, rate: number): Promise<AudioBuffer> { return new OfflineAudioContext(1, 1, rate).decodeAudioData(buf) }
function mono(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length)
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) out[i] += d[i] / b.numberOfChannels }
  return out
}

/**
 * The mp4s are read from the project folder: one Blob URL per file while the project is open. The player app's project
 * streams its video from its own absolute URL instead (by Range, never read whole; SceneRuntime.loadItem compares it with video.src).
 */
const videoUrls = new Map<string, Promise<string>>()
function clearVideoUrls() {
  for (const url of videoUrls.values()) void url.then(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u) }, () => {})
  videoUrls.clear()
}
export function sceneVideoUrl(root: FileSystemDirectoryHandle, file: string): Promise<string> {
  let url = videoUrls.get(file)
  if (!url) {
    const direct = appProjectFileUrl(root, `${VIEWER_DIR}/${file}`)
    url = direct !== null ? Promise.resolve(direct) : readProjectFile(root, `${VIEWER_DIR}/${file}`).then(f => URL.createObjectURL(f))
    url.catch(() => videoUrls.delete(file))
    videoUrls.set(file, url)
  }
  return url
}

export const useSceneStore = create<SceneState>((set, get) => {
  const note = (notice: SceneNotice) => set({ notice })
  const addLog = (text: string) => set(s => ({ log: [...s.log.slice(-199), `${new Date().toLocaleTimeString()}  ${text}`] }))
  /** `data` for `table` (overrides applied, emitted cues' firings made); none while nothing is recorded. */
  const derivedData = (table: CueTable | null, overrides = get().overrides, emitSeed = get().emitSeed): { data: SceneData } | Record<string, never> => {
    const { recorded, lib } = get()
    if (!recorded) return {}
    const data = applyOverrides(recorded, overrides)
    return { data: table && lib ? applyEmits(data, table, lib, emitSeed) : data }
  }

  /**
   * Reads the cue table and decodes every clip / cue sound of the open project; the lib's loop cues are the table's.
   * A project without a cue table opens without one (noTable).
   */
  const loadTable = async () => {
    const { root, lib } = get()
    if (!root || !lib) return
    const files = await readSceneTable(root, lib)
    if (!files) {
      kitRead++
      set({ table: null, noTable: true, ...derivedData(null), loaded: null, clipFiles: [], soundFiles: [], pcm: {}, sfx: {}, pending: { clips: {}, sounds: {} }, dirty: false, saveError: null,
        projectKit: null, kitError: null })
      note({ id: 'scene.table.missing', params: { file: lib.paths.cues } })
      addLog(`${lib.paths.cues}: no cue table yet`)
      return
    }
    const file = await readProjectFile(root, lib.paths.cues)
    sync.reset(await file.text(), file.lastModified)
    const loops = loopCuesOf(files.table)
    if (loops.join('\n') !== lib.loop_cues.join('\n')) set({ lib: { ...lib, loop_cues: loops } })
    const pcm: Record<string, Float32Array> = {}, sfx: Record<string, AudioBuffer> = {}
    await Promise.all([
      ...Object.keys(files.table.clips).map(async n => { pcm[n] = mono(await decode(await (await readProjectFile(root, `${lib.paths.clips}/${n}.wav`)).arrayBuffer(), RATE)) }),
      ...files.soundFiles.map(async n => { sfx[n] = await decode(await (await readProjectFile(root, `${lib.paths.sounds}/${n}.wav`)).arrayBuffer(), 48000) }),
    ])
    set({ table: files.table, noTable: false, ...derivedData(files.table), loaded: { kit: files.table.kit, cueNames: Object.keys(files.table.cues) }, clipFiles: files.clipFiles, soundFiles: files.soundFiles,
      pcm, sfx, pending: { clips: {}, sounds: {} }, dirty: false, saveError: null })
    await loadKit()
  }

  // ── The project's Kit: the haptic clips' material strength (DEC-103, contracts cue-table §9.1) ──
  /** Bumped by every read of the Kit (and a table without one): a read that a later one superseded is dropped. */
  let kitRead = 0
  const sameKit = (a: ProjectKit | null, b: ProjectKit | null) => a === b || (!!a && !!b && a.folder === b.folder && a.manifest === b.manifest
    && a.version === b.version && JSON.stringify(a.clipGains) === JSON.stringify(b.clipGains))
  /** Reads the cue table's Kit from the project folder; an unchanged result keeps the state as it is (no re-render, no rebuilt loops). */
  const loadKit = async () => {
    const { root, lib, table } = get(), kit = table?.kit, read = ++kitRead
    if (!root || !lib || !kit) { set({ projectKit: null, kitError: null }); return }
    let found: ProjectKit | null = null, error: string | null = null
    // A manifest with the key before DEC-103 is not read (projectKit null): the copy is not aligned to 1s on the next save.
    try { found = await locateProjectKit(root, kit, lib.paths.clips) } catch (e) { error = e instanceof StaleClipGainKeyError ? documentMessage('clipGain.staleKey', staleParams(e)) : message(e) }
    if (read !== kitRead || get().root !== root || get().table?.kit !== kit) return
    const now = get().projectKit
    if (now !== undefined && sameKit(now, found) && get().kitError === error) return
    set({ projectKit: found, kitError: error })
    addLog(error ? `Kit ${kit}: ${error}` : found ? `Kit ${kit}: clip gains from ${found.folder}/${found.manifest}` : `Kit ${kit}: not in the project (the cue table's clip gains)`)
  }
  /** The polling read (every 2 s and on focus, like the cue table's): only while a project with a Kit is open and idle. */
  const refreshKit = () => { const s = get(); if (s.root && s.table?.kit && !s.busy && pageVisible()) void loadKit().catch(() => {}) }

  // ── Autosave and outside changes ──
  const sync = new CueTableSync<PendingWavs>({
    read: async () => { const { root, lib } = get(); const f = await readProjectFile(root!, lib!.paths.cues); return { text: await f.text(), mtime: f.lastModified } },
    mtime: async () => { const { root, lib } = get(); return (await readProjectFile(root!, lib!.paths.cues)).lastModified },
    write: async (table, pending) => {
      const { root, lib } = get()
      await writeSceneSave(root!, lib!, table, pending)
      return (await readProjectFile(root!, lib!.paths.cues)).lastModified
    },
  })
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saving: Promise<void> | null = null
  const journalOf = () => { const lib = get().lib; return lib ? journalKey(lib.project_name, lib.paths.cues) : null }
  /** Keeps `table` (unsaved) in the journal at once, with the file text it was edited on. */
  const journal = (table: CueTable) => { const key = journalOf(); if (key && sync.known) writeJournal(key, table, sync.fileText) }
  /** Clears the journal once the file reads back as `written` and no edit came after it. */
  const clearJournalIfSaved = async (written: CueTable) => {
    const { root, lib } = get(), key = journalOf()
    if (!root || !lib || !key || get().table !== written) return
    const text = await (await readProjectFile(root, lib.paths.cues)).text()
    if (text === serializeCueTable(written) && get().table === written) clearJournal(key)
  }
  /** The notice of the last openFolder to show instead of "loaded" (a restored journal, else chapters left out). */
  let restoredNotice: SceneNotice | null = null
  /** Applies a journal left by an earlier page (edits the file never got) onto the file just read, and saves it. */
  const restoreJournal = () => {
    const key = journalOf(), j = key ? readJournal(key) : null
    if (!key || !j) return
    let restored: ReturnType<typeof restoreFromJournal>
    try { restored = restoreFromJournal(j, sync.fileText) } catch (error) {
      if (!(error instanceof StaleClipGainKeyError)) throw error
      // Edits journaled before DEC-103 (intensity): said, never cleared silently (the next edit journals over them).
      addLog(`${key}: the journal is not restored: ${error.message}`)
      restoredNotice = { id: 'scene.journal.staleKey', error: true }
      note(restoredNotice)
      return
    }
    if (!restored) { clearJournal(key); return }
    set({ table: restored.table, ...derivedData(restored.table), dirty: true })
    journal(restored.table)
    scheduleSave()
    addLog(`restored unsaved Scene edits from the journal → ${get().lib!.paths.cues}`)
    restoredNotice = restored.conflicts.length ? { id: 'scene.journal.restoredConflicts', params: { fields: restored.conflicts.join(', ') } } : { id: 'scene.journal.restored' }
    note(restoredNotice)
  }
  const scheduleSave = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; void saveNow() }, 300) }
  /** Writes Studio's table (merged onto an outside change); a later edit made during the write is saved next. */
  const saveNow = async (): Promise<void> => {
    if (saving) { await saving; if (get().dirty) return saveNow(); return }
    const { root, lib, loaded, pending } = get()
    const current = get().table
    if (!root || !lib || !current || !loaded || !get().dirty) return
    // The cue table's clip gains are a copy of the Kit's (contracts cue-table §9.1): written aligned, in memory too.
    const table = alignClipGains(current, get().projectKit?.clipGains ?? null)
    if (table !== current) { set({ table }); journal(table) }
    saving = (async () => {
      try {
        const result = await sync.save(table, pending, async (next, external) => {
          // Outside changes may name WAVs written meanwhile and cues added there: check against the folder now.
          const [clipFiles, soundFiles] = external ? await Promise.all([listWavs(root, lib.paths.clips), listWavs(root, lib.paths.sounds)]) : [get().clipFiles, get().soundFiles]
          return validateCueTable(next, { lib, kit: loaded.kit, cueNames: external ? Object.keys(next.cues) : loaded.cueNames,
            clipFiles: new Set([...clipFiles, ...Object.keys(pending.clips)]), soundFiles: new Set([...soundFiles, ...Object.keys(pending.sounds)]) })
        })
        if (!result.ok) {
          for (const p of result.problems) addLog(p)
          const notice = { id: 'scene.save.invalid' as const, params: { problems: result.problems.join(' / ') }, error: true }
          set({ saveError: notice, notice })
          return
        }
        const now = get().table
        if (result.external) {
          // Reload the merged file (new WAVs decoded); an edit made during the write is kept and saved next.
          const edited = now !== table ? now : null
          await loadTable()
          if (edited) { set({ table: edited, ...derivedData(edited), dirty: true }); journal(edited); scheduleSave() }
          else await clearJournalIfSaved(get().table!)
          if (result.conflicts.length) note({ id: 'scene.autosave.conflicts', params: { fields: result.conflicts.join(', ') }, error: true })
          else addLog(`merged outside changes into ${lib.paths.cues}`)
        } else if (now === table) { set({ dirty: false, pending: { clips: {}, sounds: {} }, saveError: null }); await clearJournalIfSaved(table) }
        else { set({ pending: { clips: {}, sounds: {} }, saveError: null }); scheduleSave() }
        addLog(`autosave → ${lib.paths.cues}`)
      } catch (error) {
        const notice = { id: 'scene.save.failed' as const, params: { error: message(error) }, error: true }
        set({ saveError: notice, notice }); addLog(message(error))
      }
    })()
    try { await saving } finally { saving = null }
  }
  // ── Firing gains → viewer-data.json (only `events[i].gain`; checked against the name and time read at that index) ──
  const VIEWER_DATA = `${VIEWER_DIR}/viewer-data.json`
  let firingPending = new Map<number, FiringGainChange>()
  /** The project the pending firing gains belong to (a newly opened project still gets them written to the old one). */
  let firingRoot: FileSystemDirectoryHandle | null = null
  /** That project's name (the notices say which project's gains could not be written). */
  let firingProject = ''
  let firingTimer: ReturnType<typeof setTimeout> | null = null
  let firingSaving: Promise<void> | null = null
  /** After a failed write the next try waits longer (2 s, doubling up to 30 s); a write that works resets it. */
  let firingRetryMs = 0
  const scheduleFiringSave = (ms = 300) => { if (firingTimer) clearTimeout(firingTimer); firingTimer = setTimeout(() => { firingTimer = null; void saveFiringsNow() }, ms) }
  const saveFiringsNow = async (): Promise<void> => {
    if (firingSaving) { await firingSaving; if (firingPending.size) return saveFiringsNow(); return }
    const root = firingRoot, changes = [...firingPending.values()]
    if (!root || !changes.length) return
    firingPending = new Map()
    firingSaving = (async () => {
      try {
        const result = rewriteViewerDataGains(await (await readProjectFile(root, VIEWER_DATA)).text(), changes)
        if (!result.ok) {
          const notice = result.reason === 'mismatch' ? { id: 'scene.firings.mismatch' as const, params: { index: result.index, file: VIEWER_DATA }, error: true }
            : { id: 'scene.firings.saveFailed' as const, params: { project: firingProject, error: result.error }, error: true }
          note(notice); addLog(`${VIEWER_DATA}: firing gains not written (${result.reason === 'mismatch' ? `events[${result.index}] is not the firing Studio read` : result.error})`)
          return
        }
        await writeProjectFile(root, VIEWER_DATA, result.text)
        firingRetryMs = 0
        addLog(`firing gains (${changes.length}) → ${VIEWER_DATA}`)
      } catch (error) {
        // Kept and tried again later (a newer change of the same firing wins).
        for (const c of changes) if (!firingPending.has(c.index)) firingPending.set(c.index, c)
        firingRetryMs = Math.min(30000, firingRetryMs ? firingRetryMs * 2 : 2000)
        if (!firingTimer) scheduleFiringSave(firingRetryMs)
        note({ id: 'scene.firings.saveFailed', params: { project: firingProject, error: message(error) }, error: true }); addLog(message(error))
      }
    })()
    try { await firingSaving } finally { firingSaving = null }
  }
  /** Writes whatever is pending now (after a write in flight, which it waits for). */
  const flushFirings = async () => {
    if (firingTimer) { clearTimeout(firingTimer); firingTimer = null }
    if (firingSaving) await firingSaving
    if (firingPending.size) await saveFiringsNow()
  }
  /**
   * Another project replaces the open one while firing gains of the old one could not be written (flushFirings failed):
   * its retries stop and one notice says which project and how many (they are not dropped silently).
   */
  const abandonFirings = (): SceneNotice | null => {
    if (firingTimer) { clearTimeout(firingTimer); firingTimer = null }
    firingRetryMs = 0
    const count = firingPending.size
    firingPending = new Map(); firingRoot = null
    if (!count) return null
    addLog(`${firingProject}: ${count} firing gain(s) could not be written to ${VIEWER_DATA}`)
    return { id: 'scene.firings.unsaved', params: { project: firingProject, count }, error: true }
  }

  /** Reads the file again when it changed outside Studio and nothing is unsaved (every 2 s and on focus). */
  const checkOutside = async () => {
    const { root, lib, dirty, busy } = get()
    if (!root || !lib || dirty || busy || saving || !sync.known || !pageVisible()) return
    try {
      if (await sync.changedOnDisk() === null) return
      await loadTable()
      addLog(`${lib.paths.cues} changed outside Studio: reloaded`)
    } catch { /* checked again later */ }
  }

  // ── The player app's project: Studio saves into the folder the app reads (appProject); nothing is unsaved here ──
  /** What the open app project's files were when it was read (appFolderStamp); null for any other project. */
  let appStamp: { lib: string; recording: string; wavs: string } | null = null
  const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i
  const readAppStamp = async (root: FileSystemDirectoryHandle, lib: SceneLib) => ({
    lib: await appFolderStamp(root, VIEWER_DIR, name => name === 'viewer-lib.json' || VIDEO_FILE.test(name)),
    recording: await appFolderStamp(root, VIEWER_DIR, name => name === 'viewer-data.json'),
    wavs: (await Promise.all([lib.paths.clips, lib.paths.sounds].map(dir => appFolderStamp(root, dir, name => /\.wav$/i.test(name))))).join('#'),
  })
  /** The recording apart from its firings' own gains (what Studio's per-firing strength edits change). */
  const withoutGains = (data: SceneData) => JSON.stringify({ ...data, full: { ...data.full, events: data.full.events.map(({ gain: _gain, ...ev }) => ev) } })
  /**
   * The app project's viewer-data.json changed. When only its firings' gains differ (Studio's per-firing strength), they
   * replace the old ones and playback goes on untouched (the same levels: the runtime keeps its video). Anything else:
   * the new recording replaces the old one at the full replay, in one change, and the runtime keeps its position
   * (recordingFrom 'refresh').
   */
  const reloadRecording = async (root: FileSystemDirectoryHandle) => {
    const opened = await openSceneProject(root)
    if (!opened.ok) throw new Error(opened.error)
    const { recorded, lib, table, overrides, emitSeed, chapter } = get()
    if (get().root !== root || !recorded || !lib) return
    const next = opened.data
    if (withoutGains(next) === withoutGains(recorded)) {
      let changed = 0
      const events = recorded.full.events.map((ev, i) => { const gain = next.full.events[i].gain; if (gain === ev.gain) return ev; changed++; return { ...ev, gain } })
      if (!changed) return
      set({ recorded: { ...recorded, full: { ...recorded.full, events } } })
      const derived = derivedData(table)
      if (derived.data) set({ data: derived.data })
      addLog(`${VIEWER_DIR}/viewer-data.json changed: ${changed} firing gain(s) read again`)
      return
    }
    const nextLib = { ...opened.lib, loop_cues: lib.loop_cues }
    const plain = applyOverrides(next, overrides)
    const data = table ? applyEmits(plain, table, nextLib, emitSeed) : plain
    const items = buildItems(data)
    set({ lib: nextLib, recorded: next, recordingFrom: 'refresh', data, items, cur: Math.max(0, items.findIndex(it => it.kind === 'full')), sel: null,
      chapter: chapter !== null && chapter < data.chapters.length ? chapter : null })
    addLog(`${VIEWER_DIR}/viewer-data.json changed: the recording read again`)
  }
  let appChecking: Promise<void> | null = null
  /** The last check's error, logged once (a file Studio is still writing reads as broken until the next check). */
  let appCheckError = ''
  /** Reads again what changed in the app project since it was read: the lib or the video (the whole project), the recording, the WAVs. */
  const checkAppProject = (): Promise<void> => {
    if (appChecking) return appChecking
    appChecking = (async () => {
      const { root, lib, busy } = get(), was = appStamp
      if (!root || !lib || busy || !was || !isAppProject(root)) return
      try {
        const now = await readAppStamp(root, lib)
        if (get().root !== root || appStamp !== was) return
        if (now.lib !== was.lib) {
          addLog(`${VIEWER_DIR}: the lib or the video changed: the project is opened again`)
          await get().openAppProject(root)
          return
        }
        if (now.recording !== was.recording) { await reloadRecording(root); appStamp = { ...appStamp!, recording: now.recording } }
        if (now.wavs !== was.wavs) { await loadTable(); appStamp = { ...appStamp!, wavs: now.wavs }; addLog(`WAVs in ${lib.paths.clips} / ${lib.paths.sounds} changed: read again`) }
        appCheckError = ''
      } catch (error) {
        // Tried again on the next check; the stamps that were not read again stay, so nothing is skipped.
        if (message(error) !== appCheckError) { appCheckError = message(error); addLog(`project check: ${appCheckError}`) }
      }
    })().finally(() => { appChecking = null })
    return appChecking
  }

  if (typeof window !== 'undefined') {
    // One watcher per page: a hot reload of this module replaces the previous one instead of adding another.
    const w = window as unknown as { __sceneWatch?: () => void }
    w.__sceneWatch?.()
    const timer = setInterval(() => { void checkOutside(); refreshKit(); void checkAppProject() }, 2000)
    const onFocus = () => { void checkOutside(); refreshKit(); void checkAppProject() }
    // The editor wrote a Kit manifest (Save Folder / Deploy): the open project's Kit, when it is that one, is read again at once.
    const offKitWrites = onKitManifestWritten(kitId => { if (get().table?.kit === kitId) void loadKit().catch(() => {}) })
    // Leaving the page starts writing what is pending; the write may not finish, so the journal (written at every edit) is what keeps it.
    const onHide = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void saveNow() } void flushFirings() }
    window.addEventListener('focus', onFocus); window.addEventListener('pagehide', onHide); window.addEventListener('beforeunload', onHide)
    perfTrack('intervals', 1)
    w.__sceneWatch = () => { clearInterval(timer); offKitWrites(); window.removeEventListener('focus', onFocus); window.removeEventListener('pagehide', onHide); window.removeEventListener('beforeunload', onHide); perfTrack('intervals', -1) }
  }

  /** Opens a project folder; a folder with a lib is remembered even when the recording is missing (one click after recording). */
  const openFolder = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
    restoredNotice = null
    // The open project's firing gains are written before another project's files are read.
    await flushFirings()
    const opened = await openSceneProject(handle)
    if (!opened.ok && opened.reason === 'noLib') {
      const notice = opened.oldFormat ? oldFormatNotice(handle.name) : { id: 'scene.open.noLib' as const, params: { folder: handle.name, dir: VIEWER_DIR }, error: true }
      set({ notice, empty: get().items.length ? get().empty : notice })
      addLog(opened.error)
      return false
    }
    set({ remembered: handle })
    // The player app's project cannot be cloned into IndexedDB (the app gives it anew every launch).
    if (!isAppProject(handle)) {
      await saveDirectoryHandle(handle, 'scenedir').catch(() => {})
      await registerSceneProject(opened.lib.project_name, handle).catch(() => {})
    }
    if (!opened.ok) {
      const notice = opened.oldFormat ? oldFormatNotice(handle.name)
        : opened.lib.record_command ? { id: 'scene.open.noData' as const, params: { title: opened.lib.title, dir: VIEWER_DIR, command: opened.lib.record_command }, error: true }
          : { id: 'scene.open.noDataBuild' as const, params: { title: opened.lib.title, dir: VIEWER_DIR }, error: true }
      set({ notice, empty: get().items.length ? get().empty : notice })
      addLog(opened.error)
      return false
    }
    clearVideoUrls()
    rememberSceneProject(opened.lib.project_name)
    // The old project's firing gains that could still not be written (after the flush above) stop here, said once.
    const unsaved = firingRoot && firingRoot !== handle ? abandonFirings() : null
    // The app project's files as they are now (what changes after this is read again by checkAppProject).
    appStamp = null
    const stamp = isAppProject(handle) ? await readAppStamp(handle, opened.lib) : null
    set({ root: handle, lib: opened.lib, recorded: opened.data, recordingFrom: 'open', overrides: [], data: opened.data, items: buildItems(opened.data), sel: null, cur: 0, empty: null, table: null, noTable: false, projectKit: undefined, kitError: null })
    await loadTable()
    appStamp = stamp
    restoreJournal()
    const dropped = opened.data.droppedChapters
    if (dropped) {
      addLog(`viewer-data.json: ${dropped} chapter(s) left out (start >= 0, start < end <= the video's length, a label)`)
      if (!restoredNotice) { restoredNotice = { id: 'scene.chapters.dropped', params: { count: dropped }, error: true }; note(restoredNotice) }
    }
    if (unsaved) { restoredNotice = unsaved; note(unsaved) }
    let start = 1
    try { start = Number(localStorage.getItem(clipKey(opened.lib.project_name))) || 1 } catch { /* preference only */ }
    get().select(Math.min(start, get().items.length - 1))
    return true
  }

  /** A Scene file of an older format (SceneFormatError): migrated with hapbeat-haptic-authoring, never read. */
  const oldFormatNotice = (folder: string): SceneNotice => ({ id: 'scene.open.oldFormat', params: { folder }, error: true })
  /** A cue table still carrying `intensity` (StaleClipGainKeyError): not opened, converted with the DEC-103 script. */
  const errorNotice = (error: unknown): SceneNotice => error instanceof SceneFormatError ? oldFormatNotice(get().root?.name ?? '')
    : error instanceof StaleClipGainKeyError ? { id: 'clipGain.staleKey', params: staleParams(error, get().lib?.paths.cues), error: true }
      : { id: 'scene.open.failed', params: { error: message(error) }, error: true }
  let restoring: Promise<void> | null = null
  const guarded = async (work: () => Promise<void>) => {
    if (get().busy) return
    set({ busy: true })
    try { await work() } catch (error) {
      note(errorNotice(error))
      addLog(message(error))
    } finally { set({ busy: false }) }
  }

  return {
    root: null, remembered: null, restored: false, busy: false,
    lib: null, data: null, recorded: null, recordingFrom: 'open', overrides: [], items: [], table: null, noTable: false, loaded: null, clipFiles: [], soundFiles: [],
    pending: { clips: {}, sounds: {} }, pcm: {}, sfx: {}, dirty: false, saveError: null, projectKit: null, kitError: null, cur: 0, sel: null, span: null, chapter: null, emitSeed: newEmitSeed(),
    notice: null, empty: null, log: [],
    note, addLog,

    restore: () => {
      if (restoring) return restoring
      set({ restored: true })
      restoring = guarded(async () => {
        const candidate = async (handle: FileSystemDirectoryHandle | null) => handle && { handle, permission: await handle.queryPermission({ mode: 'readwrite' }) }
        const name = lastSceneProject()
        const last = await candidate(name ? await lookupSceneProject(name).catch(() => null) : null)
        const sceneDir = await candidate(await loadDirectoryHandle('scenedir'))
        set({ remembered: last?.handle ?? sceneDir?.handle ?? null })
        const handle = restoreSceneHandle(last, sceneDir)
        if (handle) await openFolder(handle)
      })
      return restoring
    },
    openAppProject: handle => guarded(async () => {
      if (!await openFolder(handle)) return
      const full = get().items.findIndex(it => it.kind === 'full')
      if (full >= 0) get().select(full)
    }),
    checkDisk: async () => {
      const s = get()
      await Promise.all([checkOutside(), s.root && s.table?.kit && !s.busy ? loadKit().catch(() => {}) : undefined, checkAppProject()])
    },
    pick: async () => {
      if (!('showDirectoryPicker' in window)) { note({ id: 'scene.open.unsupported', error: true }); return }
      let handle: FileSystemDirectoryHandle
      try { handle = await window.showDirectoryPicker({ id: 'hapbeat-scene-project', mode: 'readwrite' }) }
      catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) note({ id: 'scene.open.failed', params: { error: message(error) }, error: true }); return }
      await guarded(async () => { if (await openFolder(handle)) note(restoredNotice ?? { id: 'scene.open.loaded', params: { folder: handle.name } }) })
    },
    reconnect: async () => {
      const handle = get().remembered
      if (!handle) return
      if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return
      await guarded(async () => { if (await openFolder(handle)) note(restoredNotice ?? { id: 'scene.open.loaded', params: { folder: handle.name } }) })
    },

    linkProject: async (name, interactive) => {
      const s = get()
      if (s.root && s.lib && (!name || s.lib.project_name === name)) return { ok: true }
      if (!interactive && s.lib) return { ok: false, reason: 'otherOpen' }
      if (s.busy) return { ok: false, reason: 'failed' }
      if (s.dirty) return { ok: false, reason: 'dirty', notice: { id: 'scene.link.dirty', error: true } }
      let handle = name ? await lookupSceneProject(name).catch(() => null) : null
      if (handle) {
        if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
          if (!interactive) return { ok: false, reason: 'needsClick' }
          if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return { ok: false, reason: 'cancelled' }
        }
      } else {
        if (!interactive) return { ok: false, reason: 'unregistered' }
        if (!('showDirectoryPicker' in window)) return { ok: false, reason: 'failed', notice: { id: 'scene.open.unsupported', error: true } }
        try { handle = await window.showDirectoryPicker({ id: 'hapbeat-scene-project', mode: 'readwrite' }) }
        catch { return { ok: false, reason: 'cancelled' } }
        if (name) {
          // Register only the folder that really is this project.
          const opened = await openSceneProject(handle)
          if (!opened.ok && opened.reason === 'noLib') return { ok: false, reason: 'failed', notice: { id: 'scene.link.noLib', params: { folder: handle.name, name, dir: VIEWER_DIR }, error: true } }
          if (opened.lib.project_name !== name) return { ok: false, reason: 'failed', notice: { id: 'scene.link.mismatch', params: { folder: handle.name, found: opened.lib.project_name, name }, error: true } }
        }
      }
      let opened = false
      const chosen = handle
      await guarded(async () => { opened = await openFolder(chosen) })
      return opened ? { ok: true } : { ok: false, reason: 'failed', notice: get().notice ?? undefined }
    },

    select: index => {
      const { items, lib } = get()
      if (!items.length) return
      const cur = (index + items.length) % items.length, it = items[cur]
      // Another selection leaves a chapter (SceneRuntime.playChapter sets it once the full replay is selected).
      set({ cur, chapter: null, sel: it.kind === 'clip' ? { name: it.name, t: it.event } : get().sel && { ...get().sel!, t: null } })
      if (lib) try { localStorage.setItem(clipKey(lib.project_name), String(cur)) } catch { /* preference only */ }
    },
    selectCue: (name, t) => set({ sel: { name, t } }),
    setSpan: span => set({ span }),
    setChapter: chapter => set({ chapter }),
    setOverrides: overrides => {
      const derived = derivedData(get().table, overrides)
      if (!derived.data) { set({ overrides }); return }
      set({ overrides, data: derived.data, items: buildItems(derived.data) })
    },
    setFiringGains: gains => {
      const { recorded, root } = get()
      if (!recorded || !root || !gains.size) return
      if (firingRoot !== root) { const unsaved = abandonFirings(); if (unsaved) note(unsaved); firingRoot = root; firingProject = get().lib?.project_name ?? '' }
      const events = recorded.full.events.map((ev, i) => {
        const gain = gains.get(i)
        // Absent and still 1 stays absent (in the file too).
        return gain === undefined || gain === (ev.gain ?? 1) ? ev : { ...ev, gain }
      })
      for (const [i, gain] of gains) { const ev = recorded.full.events[i]; if (ev) firingPending.set(i, { index: i, name: ev.name, t: ev.t, gain }) }
      // Same levels and clips: the runtime and the moments list see the same recording, only its firings' gains moved.
      set({ recorded: { ...recorded, full: { ...recorded.full, events } } })
      const derived = derivedData(get().table)
      if (derived.data) set({ data: derived.data })
      scheduleFiringSave()
    },
    reseedEmit: () => {
      const emitSeed = newEmitSeed()
      set({ emitSeed, ...derivedData(get().table, get().overrides, emitSeed) })
    },

    edit: change => {
      const table = get().table
      if (!table) return false
      const next = change(table)
      if (!next) return false
      // New emitted firings only when an emit changed (every other edit keeps `data`).
      set({ table: next, ...(emitSignature(next) !== emitSignature(table) ? derivedData(next) : {}), dirty: true })
      journal(next)
      scheduleSave()
      return true
    },


    save: async () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      await saveNow()
    },
    commitDecision: async (next, wavs) => {
      const { root, lib, loaded, clipFiles, soundFiles, busy } = get()
      if (!root || !lib || !loaded) return { ok: false, notice: { id: 'scene.save.noProject', error: true } }
      if (busy) return { ok: false, notice: { id: 'events.decide.busy', error: true } }
      // Pending edits first (autosave); a table that cannot be saved stops the decision.
      await get().save()
      if (get().dirty) return { ok: false, notice: get().saveError ?? { id: 'events.decide.dirty', error: true } }
      const problems = validateCueTable(next, { lib, kit: loaded.kit, cueNames: loaded.cueNames,
        clipFiles: new Set([...clipFiles, ...Object.keys(wavs.clips)]), soundFiles: new Set([...soundFiles, ...Object.keys(wavs.sounds)]) })
      if (problems.length) { for (const p of problems) addLog(p); return { ok: false, notice: { id: 'scene.save.invalid', params: { problems: problems.join(' / ') }, error: true }, problems } }
      // Saved like an edit: onto the file's newer version when the agent changed it meanwhile.
      set({ table: next, pending: wavs, dirty: true, busy: true })
      journal(next)
      try { await saveNow() } finally { set({ busy: false }) }
      if (get().dirty) return { ok: false, notice: get().saveError ?? { id: 'scene.save.failed', params: { error: '' }, error: true } }
      await loadTable()
      addLog(`decide → ${[...Object.keys(wavs.clips).map(n => `${lib.paths.clips}/${n}.wav`), ...Object.keys(wavs.sounds).map(n => `${lib.paths.sounds}/${n}.wav`), lib.paths.cues].join(', ')}`)
      return { ok: true }
    },
    replaceMaterial: async (target, name, wav) => {
      const { root, lib } = get()
      if (!root || !lib) throw new Error('No game project is open')
      const dir = target === 'haptic' ? lib.paths.clips : lib.paths.sounds
      const previous = await (await readProjectFile(root, `${dir}/${name}.wav`)).arrayBuffer()
      const archived = `_archive/${dir}/${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`
      await writeProjectFile(root, archived, previous)
      await writeProjectFile(root, `${dir}/${name}.wav`, wav)
      if (target === 'haptic') { const pcm = mono(await decode(wav.slice(0), RATE)); set(st => ({ pcm: { ...st.pcm, [name]: pcm } })) }
      else { const b = await decode(wav.slice(0), 48000); set(st => ({ sfx: { ...st.sfx, [name]: b } })) }
      addLog(`edited ${dir}/${name}.wav (previous → ${archived})`)
      return { archived }
    },
    createTable: async () => {
      const { root, lib, recorded, noTable } = get()
      if (!root || !lib || !recorded || !noTable) return
      await guarded(async () => {
        await createSceneTable(root, lib, recorded)
        addLog(`created ${lib.paths.cues}`)
        await loadTable()
        note({ id: 'scene.table.created', params: { file: lib.paths.cues } })
      })
    },
    reloadKit: () => loadKit(),
    alignToKit: () => {
      const kit = get().projectKit?.clipGains ?? null, table = get().table
      const differs = table ? kitCopyDiffers(table, kit) : []
      if (!differs.length || !get().edit(tb => { const next = alignClipGains(tb, kit); return next === tb ? null : next })) return false
      addLog(`cue table clip_gain aligned to the Kit (${differs.join(', ')})`)
      return true
    },
    revert: async () => {
      if (!get().root) return
      // Reverting drops the unsaved edits on purpose: the journal goes with them.
      await guarded(async () => { const key = journalOf(); if (key) clearJournal(key); await loadTable(); note({ id: 'scene.reverted' }) })
    },
  }
})
