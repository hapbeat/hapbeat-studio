import { create } from 'zustand'
import type { MessageId, MessageParams } from '@/i18n/messages'
import { loadDirectoryHandle, saveDirectoryHandle } from '@/utils/localDirectory'
import { buildItems, VIEWER_DIR, type SceneData, type SceneItem, type SceneLib } from '@/utils/sceneData'
import { serializeCueTable, validateCueTable, type CueTable } from '@/utils/sceneCueTable'
import { listWavs, openSceneProject, readProjectFile, readSceneTable, writeProjectFile, writeSceneSave, type PendingWavs } from '@/utils/sceneProject'
import { CueTableSync } from '@/utils/cueTableSync'
import { clearJournal, journalKey, readJournal, restoreFromJournal, writeJournal } from '@/utils/sceneJournal'
import { applyOverrides, type SceneOverride } from '@/utils/sceneOverrides'
import { applyEmits, emitSignature, newEmitSeed } from '@/utils/sceneEmit'
import { pageVisible, perfTrack } from '@/utils/perfRegistry'
import { RATE } from '@/utils/sceneHaptics'
import { lastSceneProject, lookupSceneProject, registerSceneProject, rememberSceneProject, restoreSceneHandle } from '@/utils/sceneRegistry'

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
  /** Firings changed in the Scene tab ("Change"), until the scene is re-recorded (editor folder scene-overrides/). */
  overrides: SceneOverride[]
  /** Replaces the overrides (data / items recomputed; the caller saves the file). */
  setOverrides: (overrides: SceneOverride[]) => void
  /** Seed of the emitted cues' firings (one per session, so a replay repeats them); `reseedEmit` draws a new one. */
  emitSeed: number
  reseedEmit: () => void
  items: SceneItem[]
  table: CueTable | null
  /** kit and cue names as loaded (the tab never changes them; save checks it). */
  loaded: { kit: string | undefined; cueNames: string[] } | null
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
  notice: SceneNotice | null
  /** Shown in the video panel while no recording is loaded. */
  empty: SceneNotice | null
  log: string[]
  /** Opens the last opened project (else the Scene tab's remembered folder) once per page; later calls wait for the same run. */
  restore: () => Promise<void>
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
const clipKey = (project: string) => `hapbeat-scene-clip:${project}`

async function decode(buf: ArrayBuffer, rate: number): Promise<AudioBuffer> { return new OfflineAudioContext(1, 1, rate).decodeAudioData(buf) }
function mono(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length)
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) out[i] += d[i] / b.numberOfChannels }
  return out
}

/** The mp4s are read from the project folder: one Blob URL per file while the project is open. */
const videoUrls = new Map<string, Promise<string>>()
function clearVideoUrls() {
  for (const url of videoUrls.values()) void url.then(u => URL.revokeObjectURL(u), () => {})
  videoUrls.clear()
}
export function sceneVideoUrl(root: FileSystemDirectoryHandle, file: string): Promise<string> {
  let url = videoUrls.get(file)
  if (!url) {
    url = readProjectFile(root, `${VIEWER_DIR}/${file}`).then(f => URL.createObjectURL(f))
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

  /** Reads the cue table and decodes every clip / cue sound of the open project. */
  const loadTable = async () => {
    const { root, lib } = get()
    if (!root || !lib) return
    const file = await readProjectFile(root, lib.paths.cues)
    sync.reset(await file.text(), file.lastModified)
    const files = await readSceneTable(root, lib)
    const pcm: Record<string, Float32Array> = {}, sfx: Record<string, AudioBuffer> = {}
    await Promise.all([
      ...Object.keys(files.table.clips).map(async n => { pcm[n] = mono(await decode(await (await readProjectFile(root, `${lib.paths.clips}/${n}.wav`)).arrayBuffer(), RATE)) }),
      ...files.soundFiles.map(async n => { sfx[n] = await decode(await (await readProjectFile(root, `${lib.paths.sounds}/${n}.wav`)).arrayBuffer(), 48000) }),
    ])
    set({ table: files.table, ...derivedData(files.table), loaded: { kit: files.table.kit, cueNames: Object.keys(files.table.cues) }, clipFiles: files.clipFiles, soundFiles: files.soundFiles,
      pcm, sfx, pending: { clips: {}, sounds: {} }, dirty: false, saveError: null })
  }

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
  /** The notice of the journal restored by the last openFolder (shown instead of "loaded"). */
  let restoredNotice: SceneNotice | null = null
  /** Applies a journal left by an earlier page (edits the file never got) onto the file just read, and saves it. */
  const restoreJournal = () => {
    const key = journalOf(), j = key ? readJournal(key) : null
    if (!key || !j) return
    const restored = restoreFromJournal(j, sync.fileText)
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
    const { root, lib, table, loaded, pending } = get()
    if (!root || !lib || !table || !loaded || !get().dirty) return
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
  if (typeof window !== 'undefined') {
    // One watcher per page: a hot reload of this module replaces the previous one instead of adding another.
    const w = window as unknown as { __sceneWatch?: () => void }
    w.__sceneWatch?.()
    const timer = setInterval(() => void checkOutside(), 2000)
    const onFocus = () => void checkOutside()
    // Leaving the page starts writing what is pending; the write may not finish, so the journal (written at every edit) is what keeps it.
    const onHide = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void saveNow() } }
    window.addEventListener('focus', onFocus); window.addEventListener('pagehide', onHide); window.addEventListener('beforeunload', onHide)
    perfTrack('intervals', 1)
    w.__sceneWatch = () => { clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('pagehide', onHide); window.removeEventListener('beforeunload', onHide); perfTrack('intervals', -1) }
  }

  /** Opens a project folder; a folder with a lib is remembered even when the recording is missing (one click after recording). */
  const openFolder = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
    restoredNotice = null
    const opened = await openSceneProject(handle)
    if (!opened.ok && opened.reason === 'noLib') {
      const notice = { id: 'scene.open.noLib' as const, params: { folder: handle.name, dir: VIEWER_DIR }, error: true }
      set({ notice, empty: get().items.length ? get().empty : notice })
      addLog(opened.error)
      return false
    }
    set({ remembered: handle })
    await saveDirectoryHandle(handle, 'scenedir').catch(() => {})
    await registerSceneProject(opened.lib.project_name, handle).catch(() => {})
    if (!opened.ok) {
      const notice = { id: 'scene.open.noData' as const, params: { title: opened.lib.title, dir: VIEWER_DIR, command: opened.lib.record_command ?? 'Scripts/record-haptic-clips.ps1' }, error: true }
      set({ notice, empty: get().items.length ? get().empty : notice })
      addLog(opened.error)
      return false
    }
    clearVideoUrls()
    rememberSceneProject(opened.lib.project_name)
    set({ root: handle, lib: opened.lib, recorded: opened.data, overrides: [], data: opened.data, items: buildItems(opened.data), sel: null, cur: 0, empty: null, table: null })
    await loadTable()
    restoreJournal()
    let start = 1
    try { start = Number(localStorage.getItem(clipKey(opened.lib.project_name))) || 1 } catch { /* preference only */ }
    get().select(Math.min(start, get().items.length - 1))
    return true
  }

  let restoring: Promise<void> | null = null
  const guarded = async (work: () => Promise<void>) => {
    if (get().busy) return
    set({ busy: true })
    try { await work() } catch (error) { note({ id: 'scene.open.failed', params: { error: message(error) }, error: true }); addLog(message(error)) }
    finally { set({ busy: false }) }
  }

  return {
    root: null, remembered: null, restored: false, busy: false,
    lib: null, data: null, recorded: null, overrides: [], items: [], table: null, loaded: null, clipFiles: [], soundFiles: [],
    pending: { clips: {}, sounds: {} }, pcm: {}, sfx: {}, dirty: false, saveError: null, cur: 0, sel: null, span: null, emitSeed: newEmitSeed(),
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
      set({ cur, sel: it.kind === 'clip' ? { name: it.name, t: it.event } : get().sel && { ...get().sel!, t: null } })
      if (lib) try { localStorage.setItem(clipKey(lib.project_name), String(cur)) } catch { /* preference only */ }
    },
    selectCue: (name, t) => set({ sel: { name, t } }),
    setSpan: span => set({ span }),
    setOverrides: overrides => {
      const derived = derivedData(get().table, overrides)
      if (!derived.data) { set({ overrides }); return }
      set({ overrides, data: derived.data, items: buildItems(derived.data) })
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
    revert: async () => {
      if (!get().root) return
      // Reverting drops the unsaved edits on purpose: the journal goes with them.
      await guarded(async () => { const key = journalOf(); if (key) clearJournal(key); await loadTable(); note({ id: 'scene.reverted' }) })
    },
  }
})
