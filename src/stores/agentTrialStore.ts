import { create } from 'zustand'
import { useWaveformStore } from '@/stores/waveformStore'
import { sourceGroup } from '@/utils/editorWaveform'
import { applyEffect, resample } from '@/utils/audioDsp'
import { decodeAudioFile } from '@/utils/wavIO'
import { sha256Hex } from '@/utils/sha256'
import { loadRecipeSamples, renderRecipe, type Recipe } from '@/utils/recipe'
import { CURRENT_STUDIO_VERSION } from '@/utils/studioVersions'
import { ratingError, trialTarget, type RatingBody, type RatingFile, type TrialFile } from '@/utils/agentProtocol'
import { SOUND_DIMENSIONS } from '@/utils/agentTrialUi'
import { processInbox, readAgentBytes, submitTrialRequest, encodePcm16Wav, type AcceptResult, type InboxDeps, type InboxResult } from '@/utils/agentInbox'
import { buildCatalog } from '@/utils/agentGuide'
import { pageVisible, perfTiming, perfTrack } from '@/utils/perfRegistry'
import { buildAgentMessage, outboxFileName, writeOutboxMessage, type HapticRequest, type Reassign, type Revise, type SoundRequest } from '@/utils/agentOutbox'
import type { CueTable } from '@/utils/sceneCueTable'
import { audioToRestore, KnowledgeFolder, localIsoString, lowRatedAudio, SEED_DIMENSIONS, trialSlugs, withShortIds, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'

const POLL_MS = 2000
const CATALOG_DEBOUNCE_MS = 2000

export interface AuditionTarget { trialId: string; candidateId: string }

interface AgentTrialState {
  /** Knowledge / agent folders of the editor folder currently open in useWaveformStore. */
  folder: KnowledgeFolder | null
  /** Newest first. */
  trials: TrialRecord[]
  dimensions: DimensionsDoc | null
  polling: boolean
  lastResult: InboxResult | null
  error: string | null
  /** Trial shown in the AI trials panel. */
  selectedTrialId: string | null
  /** AI trial candidate shown / played in the editor instead of the clip (UI or MCP `audition`). */
  audition: (AuditionTarget & { buffer: AudioBuffer }) | null
  /** Incremented when the AI trials tab should come to the front (MCP `audition`). */
  focusRequest: number
  /** Set by requestAudition(…, play = true); WaveformEditor starts the usual playback and clears it. */
  playRequested: boolean
  /**
   * Binds to the open editor folder (trials from the trial cache), imports inbox requests and takes changes another
   * tab / Studio wrote (seen from index.json's timestamp). Never reads every trial unless the cache is missing or stale.
   */
  refresh: () => Promise<void>
  /** Reads every trial from trials/ again and rewrites the derived files and the trial cache (History → reload). */
  rebuild: () => Promise<void>
  /**
   * Polls every 2 s (skipped while the page is hidden) and keeps catalog.json in sync with editor documents.
   * `sceneCueTable`: the open Scene project's cue table by project name (null = not open), to check a trial's `scene.context`.
   */
  startPolling: (sceneCueTable?: (project: string) => CueTable | null) => void
  stopPolling: () => void
  /** Writes hapbeat-agent/catalog.json from the current editor documents now. */
  writeCatalog: () => Promise<void>
  /**
   * Shows the rating at once (the list holds it before anything is written) and writes rating.json in the background,
   * in order per trial; throws at once when the rating is invalid. The promise settles when the file is written; on a
   * failed write `onFailure` runs first, then the trial's previous rating comes back and the promise rejects.
   */
  saveRating: (trialId: string, rating: RatingBody, onFailure?: () => void) => Promise<void>
  /** Dismisses (true) or restores (false) a trial: dismissed trials are not rated and stay out of the knowledge. */
  setDismissed: (trialId: string, dismissed: boolean) => Promise<void>
  /** Dismisses several trials at once (one knowledge regeneration). */
  dismissMany: (trialIds: string[]) => Promise<void>
  /**
   * Moves the rendered audio of ★1–2 candidates (current rating) to haptic-knowledge/_archive/ (lowRatedAudio) and back
   * the audio of archived candidates rated higher since (audioToRestore); their JSON always stays, so the knowledge
   * keeps them as counter-examples. Every trial, or only `trialIds` (after saving a rating). `keep`: `trialId/candidateId`
   * an event uses (never archived; restored when archived).
   */
  tidyAudio: (keep: ReadonlySet<string>, trialIds?: readonly string[]) => Promise<{ moved: string[]; restored: string[]; bytes: number; failures: string[] }>
  loadCandidateAudio: (trialId: string, candidateId: string) => Promise<AudioBuffer>
  /** Creates a new editor clip from a candidate: its source as the original, its effects as a not-yet-applied chain. */
  adoptCandidate: (trialId: string, candidateId: string) => Promise<{ clipId: string; name: string }>
  selectTrial: (trialId: string | null) => void
  startAudition: (target: AuditionTarget, buffer: AudioBuffer) => void
  clearAudition: () => void
  /** Loads a rendered candidate, selects its trial and auditions it; with `focus` (default; MCP) the editor brings the AI trials tab to the front. */
  requestAudition: (trialId: string, candidateId: string, play: boolean, focus?: boolean) => Promise<void>
  clearPlayRequest: () => void
  /** Accepts one hapbeat-trial@1 object immediately (MCP `submit_trial`) with the same processing as the inbox. */
  submitTrial: (trial: unknown) => Promise<AcceptResult>
  /** Writes a message for the agent session into hapbeat-agent/outbox/ (returns the file name). */
  sendAgentMessage: (message: { text: string; project?: string; trialIds?: string[]; shortIds?: string[]; reassign?: Reassign; revise?: Revise; haptic?: HapticRequest; sound?: SoundRequest }) => Promise<string>
  /** Appends an agent proposal to the "Proposed" section of insights.md. */
  appendInsight: (statement: string, evidence: string[]) => Promise<void>
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let catalogTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeDocuments: (() => void) | undefined
let running: Promise<void> | null = null
/** Set by startPolling: what scene.context is checked against (InboxDeps.sceneCueTable). */
let cueTableOf: ((project: string) => CueTable | null) | undefined
/** Serializes inbox imports, direct submissions and the background writes of derived files (all write trials/ or derived files). */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job)
  queue = next.catch(() => {})
  return next
}

function monoBuffer(data: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: data.length, sampleRate })
  buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
  return buffer
}
const inboxDeps = (): InboxDeps => ({
  studioVersion: CURRENT_STUDIO_VERSION,
  now: () => new Date(),
  getClip: (clipId, use) => {
    const clip = useWaveformStore.getState().documents.find(d => d.clip.id === clipId)?.clip
    return clip ? { buffer: use === 'working' ? clip.buffer : clip.originalBuffer, name: clip.name } : null
  },
  decodeAudio: decodeAudioFile,
  renderRecipe: (recipe, samples) => renderRecipe(recipe as Recipe, samples),
  createBuffer: monoBuffer,
  applyEffect,
  resample,
  encodeWav: encodePcm16Wav,
  sceneCueTable: cueTableOf,
})
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const newestFirst = (records: TrialRecord[]) => [...records].sort((a, b) => Date.parse(b.trial.receivedAt) - Date.parse(a.trial.receivedAt) || a.trial.id.localeCompare(b.trial.id))
/** The trials as the store holds them: short ids, newest first. */
const shown = (records: TrialRecord[]) => newestFirst(withShortIds(records))
const withDismissed = ({ dismissed: _d, ...record }: TrialRecord, at: string | undefined): TrialRecord => at ? { ...record, dismissed: at } : record
type Update = [trialId: string, update: (current: TrialRecord | undefined) => TrialRecord | null]

/**
 * Per bound folder: what keeps the in-memory trials, the trial cache (.hapbeat-editor/trial-cache.json) and the
 * derived knowledge files in step without reading every trial again.
 */
interface Sync {
  /** Trials changed in memory (with a version per change) and not yet in the written trial cache. */
  unflushed: Map<string, number>
  /** Trials whose files are being written right now (count per trial). */
  inFlight: Map<string, number>
  /** index.json's lastModified as this tab last wrote or read it: anything else means another writer. */
  knownStamp: number | null | undefined
  /** Trials whose terms the next background write regenerates ('all': every term), null = none scheduled. */
  derived: Map<string, TrialFile> | 'all' | null
  /** Serializes read-modify-writes of the pending file. */
  pendingLock: Promise<unknown>
  version: number
}
const newSync = (): Sync => ({ unflushed: new Map(), inFlight: new Map(), knownStamp: undefined, derived: null, pendingLock: Promise.resolve(), version: 0 })

export const useAgentTrialStore = create<AgentTrialState>((set, get) => {
  let sync = newSync()
  /** Per trial: the last rating write queued (writes of one trial run in order). */
  const ratingWrites = new Map<string, Promise<void>>()
  let binding: { root: FileSystemDirectoryHandle; promise: Promise<KnowledgeFolder> } | null = null
  /** Opens (and scaffolds) the agent folders when the editor folder changes, and loads its trials. */
  const bind = async (): Promise<KnowledgeFolder | null> => {
    const root = useWaveformStore.getState().folder?.root ?? null
    const current = get().folder
    const reset = { trials: [], dimensions: null, selectedTrialId: null, audition: null, playRequested: false }
    if (!root) { if (current) { sync = newSync(); set({ folder: null, ...reset }) } return null }
    if (current?.root === root) return current
    if (binding?.root === root) return binding.promise
    const promise = (async () => {
      const folder = await KnowledgeFolder.open(root)
      await folder.writeScaffold(CURRENT_STUDIO_VERSION)
      sync = newSync()
      set({ folder, ...reset })
      await get().writeCatalog()
      await load(folder)
      return folder
    })()
    binding = { root, promise }
    try { return await promise } finally { if (binding?.promise === promise) binding = null }
  }
  const readDimensions = async (folder: KnowledgeFolder) => {
    try { return await folder.readDimensions() }
    catch (error) { set({ error: message(error) }); return null }
  }
  const openFolder = async () => {
    const folder = await bind()
    if (!folder) throw new Error('No editor folder is open')
    return folder
  }
  /**
   * Updates the trials shown, by id (an update returning null drops the trial); every other record stays as it is.
   * Nothing changed (every update returned the record it got) = no new list, so nothing re-renders.
   */
  const apply = (folder: KnowledgeFolder, updates: Update[]) => {
    if (get().folder !== folder || !updates.length) return
    const byId = new Map(get().trials.map(r => [r.trial.id, r]))
    let changed = false
    for (const [id, update] of updates) {
      const current = byId.get(id), next = update(current)
      if (next === current || (!next && !current)) continue
      changed = true
      if (next) byId.set(id, next); else byId.delete(id)
    }
    if (changed) set({ trials: shown([...byId.values()]) })
  }
  /** Trials read from disk while this tab has writes in flight or not yet cached: those keep the in-memory record. */
  const keepOwnWrites = (records: TrialRecord[]) => {
    const own = new Map(get().trials.filter(r => sync.unflushed.has(r.trial.id) || sync.inFlight.has(r.trial.id)).map(r => [r.trial.id, r]))
    return own.size ? records.map(r => own.get(r.trial.id) ?? r) : records
  }
  /** Read-modify-write of the pending file, one at a time (another tab may share it). */
  const editPending = (folder: KnowledgeFolder, s: Sync, edit: (ids: Set<string>) => void) => {
    const run = s.pendingLock.then(async () => {
      const ids = new Set(await folder.readPendingTrials()), before = [...ids].sort().join('\n')
      edit(ids)
      if ([...ids].sort().join('\n') !== before) await folder.writePendingTrials([...ids])
    })
    s.pendingLock = run.catch(() => {})
    return run
  }
  /**
   * Cached records brought up to date with one directory listing: trials added or removed since, and those
   * marked pending (written after the cache), read again. `changed`: old and new versions of what differed.
   */
  const reconcile = async (folder: KnowledgeFolder, cached: TrialRecord[], pendingFile: string[]) => {
    const dirs = await folder.listTrialDirs()
    const pending = new Set([...pendingFile, ...sync.unflushed.keys(), ...sync.inFlight.keys()])
    const byId = new Map(cached.map(r => [r.trial.id, r]))
    const records: TrialRecord[] = [], changed: TrialRecord[] = []
    for (const { month, id } of dirs) {
      const old = byId.get(id)
      byId.delete(id)
      if (old && old.month === month && !pending.has(id)) { records.push(old); continue }
      const fresh = await folder.readTrial(month, id)
      if (fresh) records.push(fresh)
      changed.push(...[old, fresh].filter((r): r is TrialRecord => !!r))
    }
    changed.push(...byId.values())
    return { records, changed }
  }
  /** Pending marks read from the file are cleared by the next background write (it caches what was read again). */
  const adoptPending = (s: Sync, pendingFile: string[]) => { for (const id of pendingFile) if (!s.unflushed.has(id)) s.unflushed.set(id, ++s.version) }
  /** A freshly bound folder: the trial cache and what changed since, else (no / stale cache) every trial once. */
  const load = async (folder: KnowledgeFolder) => {
    const t0 = performance.now()
    const dimensions = await readDimensions(folder)
    const stamp = await folder.indexStamp()
    const cache = stamp === null ? null : await folder.readTrialCache()
    const fromCache = !!cache && cache.indexStamp === stamp
    const pendingFile = await folder.readPendingTrials()
    const { records, changed } = fromCache ? await reconcile(folder, cache.trials, pendingFile) : { records: await folder.listTrials(), changed: [] }
    if (get().folder !== folder) return
    sync.knownStamp = stamp
    adoptPending(sync, pendingFile)
    set({ trials: shown(records), ...(dimensions ? { dimensions } : {}) })
    // A rebuilt list writes index.json (all terms when it was missing) and the cache; a cached one only what changed.
    if (!fromCache) scheduleDerived(folder, stamp === null ? 'all' : [])
    else if (changed.length) scheduleDerived(folder, changed.map(r => r.trial))
    perfTiming(fromCache ? 'trials.load' : 'trials.loadAll', performance.now() - t0)
  }
  /** Another tab or Studio wrote index.json since this tab did: take the trial cache it left, else read every trial. */
  const checkExternal = async (folder: KnowledgeFolder) => {
    const stamp = await folder.indexStamp()
    if (stamp === sync.knownStamp) return
    const s = sync, t0 = performance.now()
    const cache = stamp === null ? null : await folder.readTrialCache()
    const fromCache = !!cache && cache.indexStamp === stamp
    const pendingFile = await folder.readPendingTrials()
    const records = fromCache ? (await reconcile(folder, cache.trials, pendingFile)).records : await folder.listTrials()
    if (s !== sync || get().folder !== folder) return
    s.knownStamp = stamp
    adoptPending(s, pendingFile)
    set({ trials: shown(keepOwnWrites(records)) })
    if (!fromCache) scheduleDerived(folder, stamp === null ? 'all' : [])
    perfTiming('trials.external', performance.now() - t0)
  }
  /** Queues the background write of the derived files (terms of `trials`, index.json) and the trial cache; repeated calls merge. */
  const scheduleDerived = (folder: KnowledgeFolder, trials: TrialFile[] | 'all') => {
    const s = sync, first = s.derived === null
    if (trials === 'all') s.derived = 'all'
    else if (s.derived !== 'all') { const map = s.derived ?? new Map<string, TrialFile>(); for (const t of trials) map.set(t.id, t); s.derived = map }
    if (first) void exclusive(() => flushDerived(folder, s))
  }
  const flushDerived = async (folder: KnowledgeFolder, s: Sync) => {
    const job = s.derived
    s.derived = null
    if (!job || s !== sync || get().folder !== folder) return
    const t0 = performance.now()
    try {
      // Another writer since this tab's last write: take its trials first, or this write would drop them.
      await checkExternal(folder)
      const dimensions = await readDimensions(folder)
      const records = get().trials, covered = new Map(s.unflushed)
      if (dimensions) {
        await folder.regenerate(records, dimensions, job === 'all' ? undefined : [...new Set([...job.values()].flatMap(t => trialSlugs(t, dimensions)))])
        set({ dimensions })
      }
      const stamp = await folder.indexStamp()
      await folder.writeTrialCache(records, stamp)
      s.knownStamp = stamp
      for (const [id, version] of covered) if (s.unflushed.get(id) === version) s.unflushed.delete(id)
      await editPending(folder, s, ids => { for (const id of covered.keys()) if (!s.unflushed.has(id) && !s.inFlight.has(id)) ids.delete(id) })
    } catch (error) { set({ error: message(error) }) }
    perfTiming('trials.derived', performance.now() - t0)
  }
  /**
   * Changes files of existing trials: marked pending first (a reload before the cache catches up reads them again),
   * then written; the list updates at once and the knowledge files and the cache follow in the background.
   */
  const mutate = async (folder: KnowledgeFolder, ids: string[], write: () => Promise<Update[]>) => {
    const s = sync
    for (const id of ids) s.inFlight.set(id, (s.inFlight.get(id) ?? 0) + 1)
    try {
      await editPending(folder, s, pending => ids.forEach(id => pending.add(id)))
      const updates = await write()
      if (s !== sync) return
      apply(folder, updates)
      for (const id of ids) s.unflushed.set(id, ++s.version)
      const touched = new Set(ids)
      scheduleDerived(folder, get().trials.filter(r => touched.has(r.trial.id)).map(r => r.trial))
    } finally {
      for (const id of ids) { const n = (s.inFlight.get(id) ?? 1) - 1; if (n > 0) s.inFlight.set(id, n); else s.inFlight.delete(id) }
    }
  }
  /** Trials just accepted (inbox / MCP) join the list; their terms, index.json and the cache follow in the background. */
  const addAccepted = async (folder: KnowledgeFolder, ids: string[]) => {
    const fresh: TrialRecord[] = []
    for (const id of ids) {
      const state = await folder.trialState(id)
      const record = state.state === 'none' ? null : await folder.readTrial(state.month, id)
      if (record) fresh.push(record)
    }
    apply(folder, fresh.map(r => [r.trial.id, () => r]))
    scheduleDerived(folder, fresh.map(r => r.trial))
  }
  return {
    folder: null, trials: [], dimensions: null, polling: false, lastResult: null, error: null,
    selectedTrialId: null, audition: null, focusRequest: 0, playRequested: false,
    refresh: async () => {
      if (running) return running
      running = exclusive(async () => {
        const t0 = performance.now()
        try {
          const folder = await bind()
          if (!folder) return
          // Only the inbox listing and index.json's timestamp: trials are not read again.
          const lastResult = await processInbox(folder, inboxDeps())
          if (lastResult.accepted.length || lastResult.rejected.length) set({ lastResult })
          if (lastResult.accepted.length) await addAccepted(folder, lastResult.accepted)
          await checkExternal(folder)
          if (get().error) set({ error: null })
        } catch (error) { set({ error: message(error) }) }
        finally { running = null; perfTiming('trials.poll', performance.now() - t0) }
      })
      return running
    },
    rebuild: () => exclusive(async () => {
      const folder = get().folder
      if (!folder) return
      const t0 = performance.now()
      const records = await folder.listTrials()
      if (get().folder !== folder) return
      set({ trials: shown(keepOwnWrites(records)) })
      scheduleDerived(folder, 'all')
      perfTiming('trials.loadAll', performance.now() - t0)
    }),
    startPolling: sceneCueTable => {
      cueTableOf = sceneCueTable
      if (pollTimer !== undefined) return
      set({ polling: true })
      // A hot reload keeps the previous module's timer alive: stop it (one poll per page).
      const w = window as unknown as { __trialPoll?: () => void }
      w.__trialPoll?.()
      pollTimer = setInterval(() => { if (pageVisible()) void get().refresh() }, POLL_MS)
      perfTrack('intervals', 1)
      const mine = pollTimer
      w.__trialPoll = () => { clearInterval(mine); perfTrack('intervals', -1) }
      unsubscribeDocuments = useWaveformStore.subscribe((state, previous) => {
        if (state.documents === previous.documents) return
        clearTimeout(catalogTimer)
        catalogTimer = setTimeout(() => { void get().writeCatalog() }, CATALOG_DEBOUNCE_MS)
      })
      void get().refresh()
    },
    stopPolling: () => {
      if (pollTimer !== undefined) { (window as unknown as { __trialPoll?: () => void }).__trialPoll?.(); (window as unknown as { __trialPoll?: () => void }).__trialPoll = undefined }
      pollTimer = undefined
      clearTimeout(catalogTimer); catalogTimer = undefined
      unsubscribeDocuments?.(); unsubscribeDocuments = undefined
      set({ polling: false })
    },
    writeCatalog: async () => {
      const folder = get().folder
      if (!folder || folder.root !== useWaveformStore.getState().folder?.root) return
      try { await folder.writeCatalog(buildCatalog(useWaveformStore.getState().documents, CURRENT_STUDIO_VERSION, localIsoString(new Date()))) }
      catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
    },
    saveRating: (trialId, rating, onFailure) => {
      const t0 = performance.now()
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      // Sound trials are rated on their own axes (SOUND_DIMENSIONS, incl. length), never in dimensions.json.
      const error = ratingError(rating, record.trial, trialTarget(record.trial) === 'sound' ? SOUND_DIMENSIONS.map(d => d.id) : (get().dimensions ?? SEED_DIMENSIONS).dimensions.map(d => d.id))
      if (error) throw new Error(error)
      // What rating.json will hold (the previous rating moves to history), shown before it is written.
      const previous = record.rating, s = sync
      const shownRating: RatingFile = { ...rating, history: previous ? [...previous.history ?? [], (({ history: _h, ...body }) => body)(previous)] : [] }
      s.inFlight.set(trialId, (s.inFlight.get(trialId) ?? 0) + 1)
      apply(folder, [[trialId, current => current ? { ...current, rating: shownRating } : null]])
      // A later save of this trial replaces what is shown; an earlier write finishing then leaves it alone.
      const stillShown = (current: TrialRecord | undefined) => current?.rating === shownRating
      const run = (ratingWrites.get(trialId) ?? Promise.resolve())
        .then(() => mutate(folder, [trialId], async () => {
          const file = await folder.saveRating(record.month, rating)
          // Written as shown (the usual case): the list keeps its record, nothing re-renders.
          const same = JSON.stringify(file) === JSON.stringify(shownRating)
          return [[trialId, current => current ? stillShown(current) && !same ? { ...current, rating: file } : current : null]]
        }))
        .catch(error => {
          onFailure?.()
          apply(folder, [[trialId, current => current ? stillShown(current) ? { ...current, rating: previous } : current : null]])
          throw error
        })
        .finally(() => {
          const n = (s.inFlight.get(trialId) ?? 1) - 1
          if (n > 0) s.inFlight.set(trialId, n); else s.inFlight.delete(trialId)
          perfTiming('trials.save', performance.now() - t0)
        })
      const settled = run.catch(() => {})
      ratingWrites.set(trialId, settled)
      void settled.then(() => { if (ratingWrites.get(trialId) === settled) ratingWrites.delete(trialId) })
      return run
    },
    setDismissed: async (trialId, dismissed) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      const at = localIsoString(new Date())
      await mutate(folder, [trialId], async () => {
        if (dismissed) await folder.dismissTrial(record.month, trialId, at)
        else await folder.restoreTrial(record.month, trialId)
        return [[trialId, current => current ? withDismissed(current, dismissed ? at : undefined) : null]]
      })
    },
    dismissMany: async trialIds => {
      const folder = get().folder
      if (!folder) throw new Error('No editor folder is open')
      const at = localIsoString(new Date())
      const records = trialIds.flatMap(id => get().trials.filter(r => r.trial.id === id))
      await mutate(folder, records.map(r => r.trial.id), async () => {
        for (const record of records) await folder.dismissTrial(record.month, record.trial.id, at)
        return records.map((r): Update => [r.trial.id, current => current ? withDismissed(current, at) : null])
      })
    },
    tidyAudio: async (keep, trialIds) => {
      const folder = get().folder
      if (!folder) throw new Error('No editor folder is open')
      const only = trialIds && new Set(trialIds)
      const records = only ? get().trials.filter(r => only.has(r.trial.id)) : get().trials
      const jobs = [...lowRatedAudio(records, keep).map(j => ({ ...j, archive: true })), ...audioToRestore(records, keep).map(j => ({ ...j, archive: false }))]
      const moved: string[] = [], restored: string[] = [], failures: string[] = []
      let bytes = 0
      if (!jobs.length) return { moved, restored, bytes, failures }
      await mutate(folder, [...new Set(jobs.map(j => j.trialId))], async () => {
        const done = new Map<string, { archived: string[]; back: string[] }>()
        for (const { month, trialId, candidateId, archive } of jobs) {
          const key = `${trialId}/${candidateId}`, entry = done.get(trialId) ?? { archived: [], back: [] }
          try {
            if (archive) { bytes += await folder.archiveCandidateAudio(month, trialId, candidateId); entry.archived.push(candidateId); moved.push(key) }
            else { await folder.restoreCandidateAudio(month, trialId, candidateId); entry.back.push(candidateId); restored.push(key) }
            done.set(trialId, entry)
          } catch (error) { failures.push(`${key}: ${message(error)}`) }
        }
        return [...done].map(([trialId, { archived, back }]): Update => [trialId, current => {
          if (!current) return null
          const ids = [...new Set([...current.archivedAudio ?? [], ...archived])].filter(id => !back.includes(id)).sort()
          const { archivedAudio: _a, ...rest } = current
          return ids.length ? { ...rest, archivedAudio: ids } : rest
        }])
      })
      return { moved, restored, bytes, failures }
    },
    loadCandidateAudio: async (trialId, candidateId) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      if (record.archivedAudio?.includes(candidateId)) throw new Error(`The audio of "${candidateId}" was moved to haptic-knowledge/_archive/ (move it back into the trial's audio/ folder to listen again)`)
      return decodeAudioFile(await folder.readCandidateAudio(record.month, trialId, candidateId))
    },
    adoptCandidate: async (trialId, candidateId) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      const requested = record.trial.candidates.find(c => c.id === candidateId)
      const spec = record.candidates.find(c => c.id === candidateId)?.spec ?? requested
      if (!requested || !spec) throw new Error(`Candidate "${candidateId}" is not in trial "${trialId}"`)
      const base = { name: requested.label, description: `trial:${trialId}/${candidateId}`, project: record.trial.project }
      const source = spec.source
      let clipId: string | null
      if (source.kind === 'clip') {
        const clip = useWaveformStore.getState().documents.find(d => d.clip.id === source.clipId)?.clip
        if (!clip) throw new Error(`Source clip "${source.clipId}" is no longer in the editor`)
        clipId = useWaveformStore.getState().addDerivedClip({ ...base, originalBuffer: source.use === 'working' ? clip.buffer : clip.originalBuffer, exportSampleRate: clip.exportSampleRate, sourceFileName: clip.sourceFileName, sourceGroupId: sourceGroup(clip), sourceSha256: clip.sourceSha256, provenance: clip.provenance }, spec.effects)
      } else if (source.kind === 'file') {
        const bytes = await (await folder.readAgentFile(source.path)).arrayBuffer()
        // Hash before decoding: decodeAudioData may detach the buffer.
        const sourceSha256 = await sha256Hex(bytes)
        const buffer = await decodeAudioFile(bytes)
        if (buffer.numberOfChannels > 2) throw new Error(`${source.path}: only mono / stereo audio is supported`)
        clipId = useWaveformStore.getState().addDerivedClip({ ...base, originalBuffer: buffer, exportSampleRate: 48000, sourceFileName: source.path.split('/').pop(), sourceSha256 }, spec.effects)
      } else {
        const recipe = source.recipe as Recipe
        const getClip = inboxDeps().getClip
        const samples = await loadRecipeSamples(recipe, { readAgentFile: path => readAgentBytes(folder, path), getClip: (id, use) => getClip(id, use)?.buffer ?? null, decodeAudio: decodeAudioFile })
        const { data, sampleRate } = renderRecipe(recipe, samples)
        clipId = useWaveformStore.getState().addDerivedClip({ ...base, originalBuffer: monoBuffer(data, sampleRate), exportSampleRate: recipe.sampleRate, sourceFileName: `recipe:${trialId}/${candidateId}`, recipe }, spec.effects)
      }
      if (!clipId) throw new Error('The editor is busy or has no folder open; try again')
      // Render the candidate's chain now so "Edited", catalog features and exports match what was auditioned.
      await useWaveformStore.getState().applyEffects()
      return { clipId, name: base.name }
    },
    selectTrial: selectedTrialId => set({ selectedTrialId }),
    startAudition: (target, buffer) => {
      useWaveformStore.getState().setSelectedRegion(null)
      set({ audition: { ...target, buffer }, playRequested: false })
    },
    clearAudition: () => { if (get().audition || get().playRequested) set({ audition: null, playRequested: false }) },
    requestAudition: async (trialId, candidateId, play, focus = true) => {
      const record = get().trials.find(r => r.trial.id === trialId)
      const candidate = record?.candidates.find(c => c.id === candidateId)
      if (!record) throw new Error(`Trial "${trialId}" is not loaded`)
      if (!candidate) throw new Error(`Candidate "${candidateId}" is not in trial "${trialId}"`)
      if (!candidate.audio || candidate.error) throw new Error(`Candidate "${candidateId}" has no rendered audio${candidate.error ? `: ${candidate.error}` : ''}`)
      const buffer = await get().loadCandidateAudio(trialId, candidateId)
      useWaveformStore.getState().setSelectedRegion(null)
      set({ audition: { trialId, candidateId, buffer }, selectedTrialId: trialId, focusRequest: get().focusRequest + (focus ? 1 : 0), playRequested: play })
    },
    clearPlayRequest: () => set({ playRequested: false }),
    submitTrial: trial => exclusive(async () => {
      const folder = await openFolder()
      const result = await submitTrialRequest(folder, trial, inboxDeps())
      if (result.ok) await addAccepted(folder, [result.trialId])
      return result
    }),
    sendAgentMessage: async message => {
      const folder = await openFolder()
      const now = new Date()
      return writeOutboxMessage(folder.agent, buildAgentMessage({ ...message, createdAt: localIsoString(now) }), outboxFileName(now))
    },
    appendInsight: (statement, evidence) => exclusive(async () => {
      await (await openFolder()).appendInsight(statement, evidence, localIsoString(new Date()))
    }),
  }
})
