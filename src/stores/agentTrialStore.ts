import { create } from 'zustand'
import { useWaveformStore } from '@/stores/waveformStore'
import { applyEffect, resample } from '@/utils/audioDsp'
import { decodeAudioFile } from '@/utils/wavIO'
import { renderRecipe, type Recipe } from '@/utils/recipe'
import { CURRENT_STUDIO_VERSION } from '@/utils/studioVersions'
import { ratingError, type RatingBody } from '@/utils/agentProtocol'
import { processInbox, encodePcm16Wav, type InboxDeps, type InboxResult } from '@/utils/agentInbox'
import { buildCatalog } from '@/utils/agentGuide'
import { KnowledgeFolder, localIsoString, trialSlugs, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'

const POLL_MS = 2000
const CATALOG_DEBOUNCE_MS = 2000

interface AgentTrialState {
  /** Knowledge / agent folders of the editor folder currently open in useWaveformStore. */
  folder: KnowledgeFolder | null
  /** Newest first. */
  trials: TrialRecord[]
  dimensions: DimensionsDoc | null
  polling: boolean
  lastResult: InboxResult | null
  error: string | null
  /** Binds to the open editor folder, imports inbox requests and reloads trials. */
  refresh: () => Promise<void>
  /** Polls every 2 s (skipped while the page is hidden) and keeps catalog.json in sync with editor documents. */
  startPolling: () => void
  stopPolling: () => void
  /** Writes hapbeat-agent/catalog.json from the current editor documents now. */
  writeCatalog: () => Promise<void>
  saveRating: (trialId: string, rating: RatingBody) => Promise<void>
  loadCandidateAudio: (trialId: string, candidateId: string) => Promise<AudioBuffer>
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let catalogTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeDocuments: (() => void) | undefined
let running: Promise<void> | null = null

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
  renderRecipe: recipe => renderRecipe(recipe as Recipe),
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
    if (!root) { if (current) set({ folder: null, trials: [], dimensions: null }); return null }
    if (current?.root === root) return current
    const folder = await KnowledgeFolder.open(root)
    await folder.writeScaffold(CURRENT_STUDIO_VERSION)
    set({ folder, trials: [], dimensions: null })
    await get().writeCatalog()
    return folder
  }
  const readDimensions = async (folder: KnowledgeFolder) => {
    try { return await folder.readDimensions() }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return null }
  }
  return {
    folder: null, trials: [], dimensions: null, polling: false, lastResult: null, error: null,
    refresh: async () => {
      if (running) return running
      running = (async () => {
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
      })()
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
      const error = ratingError(rating, record.trial, dimensions.dimensions.map(d => d.id))
      if (error) throw new Error(error)
      await folder.saveRating(record.month, rating)
      const records = await folder.listTrials()
      await folder.regenerate(records, dimensions, trialSlugs(record.trial, dimensions))
      set({ trials: newestFirst(records), dimensions, error: null })
    },
    loadCandidateAudio: async (trialId, candidateId) => {
      const folder = get().folder, record = get().trials.find(r => r.trial.id === trialId)
      if (!folder || !record) throw new Error(`Trial "${trialId}" is not loaded`)
      return decodeAudioFile(await folder.readCandidateAudio(record.month, trialId, candidateId))
    },
  }
})
