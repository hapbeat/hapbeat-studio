import { create } from 'zustand'
import { useWaveformStore } from '@/stores/waveformStore'
import { sourceGroup } from '@/utils/editorWaveform'
import { applyEffect, resample } from '@/utils/audioDsp'
import { decodeAudioFile } from '@/utils/wavIO'
import { sha256Hex } from '@/utils/sha256'
import { loadRecipeSamples, renderRecipe, type Recipe } from '@/utils/recipe'
import { CURRENT_STUDIO_VERSION } from '@/utils/studioVersions'
import { ratingError, trialTarget, type RatingBody } from '@/utils/agentProtocol'
import { SOUND_DIMENSIONS } from '@/utils/agentTrialUi'
import { processInbox, readAgentBytes, submitTrialRequest, encodePcm16Wav, type AcceptResult, type InboxDeps, type InboxResult } from '@/utils/agentInbox'
import { buildCatalog } from '@/utils/agentGuide'
import { buildAgentMessage, outboxFileName, writeOutboxMessage, type Reassign, type Revise } from '@/utils/agentOutbox'
import { KnowledgeFolder, localIsoString, trialSlugs, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'

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
  /** Binds to the open editor folder, imports inbox requests and reloads trials. */
  refresh: () => Promise<void>
  /** Polls every 2 s (skipped while the page is hidden) and keeps catalog.json in sync with editor documents. */
  startPolling: () => void
  stopPolling: () => void
  /** Writes hapbeat-agent/catalog.json from the current editor documents now. */
  writeCatalog: () => Promise<void>
  saveRating: (trialId: string, rating: RatingBody) => Promise<void>
  /** Dismisses (true) or restores (false) a trial: dismissed trials are not rated and stay out of the knowledge. */
  setDismissed: (trialId: string, dismissed: boolean) => Promise<void>
  /** Dismisses several trials at once (one knowledge regeneration). */
  dismissMany: (trialIds: string[]) => Promise<void>
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
  sendAgentMessage: (message: { text: string; project?: string; trialIds?: string[]; shortIds?: string[]; reassign?: Reassign; revise?: Revise }) => Promise<string>
  /** Appends an agent proposal to the "Proposed" section of insights.md. */
  appendInsight: (statement: string, evidence: string[]) => Promise<void>
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let catalogTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeDocuments: (() => void) | undefined
let running: Promise<void> | null = null
/** Serializes inbox imports and direct submissions (both write trials/ and the derived files). */
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
})
const newestFirst = (records: TrialRecord[]) => [...records].sort((a, b) => Date.parse(b.trial.receivedAt) - Date.parse(a.trial.receivedAt) || a.trial.id.localeCompare(b.trial.id))

export const useAgentTrialStore = create<AgentTrialState>((set, get) => {
  /** Opens (and scaffolds) the agent folders when the editor folder changes. */
  const bind = async (): Promise<KnowledgeFolder | null> => {
    const root = useWaveformStore.getState().folder?.root ?? null
    const current = get().folder
    const reset = { trials: [], dimensions: null, selectedTrialId: null, audition: null, playRequested: false }
    if (!root) { if (current) set({ folder: null, ...reset }); return null }
    if (current?.root === root) return current
    const folder = await KnowledgeFolder.open(root)
    await folder.writeScaffold(CURRENT_STUDIO_VERSION)
    set({ folder, ...reset })
    await get().writeCatalog()
    return folder
  }
  const readDimensions = async (folder: KnowledgeFolder) => {
    try { return await folder.readDimensions() }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return null }
  }
  const openFolder = async () => {
    const folder = await bind()
    if (!folder) throw new Error('No editor folder is open')
    return folder
  }
  return {
    folder: null, trials: [], dimensions: null, polling: false, lastResult: null, error: null,
    selectedTrialId: null, audition: null, focusRequest: 0, playRequested: false,
    refresh: async () => {
      if (running) return running
      running = exclusive(async () => {
        try {
          const folder = await bind()
          if (!folder) return
          const lastResult = await processInbox(folder, inboxDeps())
          const records = await folder.listTrials()
          const dimensions = await readDimensions(folder)
          if (dimensions && lastResult.accepted.length) {
            const accepted = records.filter(r => lastResult.accepted.includes(r.trial.id))
            await folder.regenerate(records, dimensions, [...new Set(accepted.flatMap(r => trialSlugs(r.trial, dimensions)))])
          }
          set({ trials: newestFirst(records), dimensions: dimensions ?? get().dimensions, lastResult, ...(dimensions ? { error: null } : {}) })
        } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
        finally { running = null }
      })
      return running
    },
    startPolling: () => {
      if (pollTimer !== undefined) return
      set({ polling: true })
      pollTimer = setInterval(() => { if (!document.hidden) void get().refresh() }, POLL_MS)
      unsubscribeDocuments = useWaveformStore.subscribe((state, previous) => {
        if (state.documents === previous.documents) return
        clearTimeout(catalogTimer)
        catalogTimer = setTimeout(() => { void get().writeCatalog() }, CATALOG_DEBOUNCE_MS)
      })
      void get().refresh()
    },
    stopPolling: () => {
      clearInterval(pollTimer); pollTimer = undefined
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
    saveRating: async (trialId, rating) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      const dimensions = await folder.readDimensions()
      // Sound trials are rated on their own axes (SOUND_DIMENSIONS, incl. length), never in dimensions.json.
      const error = ratingError(rating, record.trial, trialTarget(record.trial) === 'sound' ? SOUND_DIMENSIONS.map(d => d.id) : dimensions.dimensions.map(d => d.id))
      if (error) throw new Error(error)
      await folder.saveRating(record.month, rating)
      const records = await folder.listTrials()
      await folder.regenerate(records, dimensions, trialSlugs(record.trial, dimensions))
      set({ trials: newestFirst(records), dimensions, error: null })
    },
    setDismissed: async (trialId, dismissed) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      if (dismissed) await folder.dismissTrial(record.month, trialId, localIsoString(new Date()))
      else await folder.restoreTrial(record.month, trialId)
      const records = await folder.listTrials()
      const dimensions = await folder.readDimensions()
      await folder.regenerate(records, dimensions, trialSlugs(record.trial, dimensions))
      set({ trials: newestFirst(records), dimensions, error: null })
    },
    dismissMany: async trialIds => {
      const folder = get().folder
      if (!folder) throw new Error('No editor folder is open')
      const at = localIsoString(new Date())
      for (const id of trialIds) { const record = get().trials.find(r => r.trial.id === id); if (record) await folder.dismissTrial(record.month, id, at) }
      const records = await folder.listTrials()
      const dimensions = await folder.readDimensions()
      await folder.regenerate(records, dimensions)
      set({ trials: newestFirst(records), dimensions, error: null })
    },
    loadCandidateAudio: async (trialId, candidateId) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
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
      if (!result.ok) return result
      const records = await folder.listTrials()
      const dimensions = await readDimensions(folder)
      const accepted = records.find(r => r.trial.id === result.trialId)
      if (dimensions && accepted) await folder.regenerate(records, dimensions, trialSlugs(accepted.trial, dimensions))
      set({ trials: newestFirst(records), dimensions: dimensions ?? get().dimensions })
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
