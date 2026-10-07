import { create } from 'zustand'
import { sourceGroup } from '@/utils/editorWaveform'
import type { EffectEntry, EffectParams, WaveformClip, WaveformRegion, SampleRate } from '@/types/waveform'
import { getDefaultParams } from '@/types/waveform'
import { decodeAudioFile, encodeWavBlob, encodeMonoWavBlob } from '@/utils/wavIO'
import { cropBuffer, applyEffect } from '@/utils/audioDsp'
import { loadDirectoryHandle, saveDirectoryHandle } from '@/utils/localDirectory'
import { EditorFolder, type EditorDocument } from '@/utils/editorFolder'
import { assignProject } from '@/utils/clipProjects'
import { loadRecipeSamples, renderRecipe, type Recipe } from '@/utils/recipe'
import { readAgentBytes } from '@/utils/agentInbox'
import { hasKnowledgeFolder, type KnowledgeFolder } from '@/utils/hapticKnowledge'
import { derivedEffectChain } from '@/utils/agentTrialUi'
import { sha256Hex } from '@/utils/sha256'
import { getActiveHelperChannel } from '@/utils/helperRequest'
import { registerExportedDerived, type MaterialProvenance } from '@/utils/materials'

interface History { buffer: AudioBuffer; effects: EffectEntry[]; label: string }
/** True while the effect chain differs from what `clip.buffer` was rendered with (the editor then shows a live render). */
export const effectsPending = (clip: WaveformClip | null, effects: EffectEntry[]): boolean =>
  !!clip && (effects.length ? !effects.every(e => e.applied) : clip.buffer !== clip.originalBuffer)
interface EditorState {
  rememberedFolder: FileSystemDirectoryHandle | null
  restored: boolean
  restoreFolder: () => Promise<void>
  /**
   * The editor folder for writing (outbox) from anywhere, e.g. the Scene tab: the open one, else the remembered one
   * (IndexedDB) — restored silently when permitted, else permission asked (call it from a user action). False when
   * none is remembered or permission is refused (then offer openFolder).
   */
  ensureFolder: () => Promise<boolean>
  reconnectFolder: () => Promise<void>
  /**
   * The confirmed editor folder. Every writer into the editor folder (project, UI settings sync, activity log,
   * rating drafts, material adjust, agent guide / knowledge / outbox, scene overrides) goes through this, so it is
   * the single "editor folder ready" guard: it is set only after the folder is confirmed as an editor folder.
   */
  folder: EditorFolder | null
  /** Pending "make this folder an editor folder?" question (a folder without haptic-knowledge/); answer() settles it. */
  folderPrompt: { name: string; answer: (yes: boolean) => void } | null
  documents: EditorDocument[]
  clip: WaveformClip | null
  effects: EffectEntry[]
  exportAsMono: boolean
  selectionOriginal: boolean
  selectedRegion: WaveformRegion | null
  isProcessing: boolean
  zoom: number
  undoStack: History[]
  redoStack: History[]
  saveStatus: 'empty' | 'pending' | 'saving' | 'saved' | 'error'
  error: string | null
  openFolder: () => Promise<void>
  save: () => Promise<void>
  loadFiles: (files: File[]) => Promise<void>
  /**
   * Renders `recipe` into a new clip (never modifies existing clips). Sample-layer files are read
   * from `agentFolder` (hapbeat-agent/ of the open editor folder). Failures are reported through `error`.
   */
  addRecipeClip: (recipe: Recipe, name: string, sourceFileName: string, agentFolder: KnowledgeFolder | null) => Promise<void>
  /** Adds a clip built on `clip.originalBuffer` with `effects` as a not-yet-applied chain (never modifies existing clips). Returns its id, or null when no folder is open or the editor is busy. */
  addDerivedClip: (clip: Pick<WaveformClip, 'name' | 'originalBuffer' | 'exportSampleRate'> & Partial<Pick<WaveformClip, 'description' | 'project' | 'sourceFileName' | 'sourceGroupId' | 'sourceSha256' | 'provenance' | 'recipe'>>, effects: EffectParams[]) => string | null
  selectClip: (id: string) => void
  duplicateClip: () => void
  extractSelection: () => void
  updateClipInfo: (id: string, patch: {name?: string; description?: string; project?: string | undefined}) => void
  /** Sets (or clears) the explicit project of several clips in one save. */
  setClipsProject: (ids: string[], project: string | undefined) => void
  /** Applies helper lookup results to every clip whose `sourceSha256` is in `found`; saves only when something changed. */
  setProvenance: (found: Map<string, MaterialProvenance>) => void
  setClipName: (name: string) => void
  setExportSampleRate: (rate: SampleRate) => void
  setExportAsMono: (mono: boolean) => void
  addEffect: (type: EffectParams['type']) => void
  updateEffect: (id: string, params: EffectParams) => void
  removeEffect: (id: string) => void
  toggleEffect: (id: string) => void
  applyEffects: () => Promise<void>
  setSelectedRegion: (region: WaveformRegion | null, original?: boolean, duration?: number) => void
  cropToRegion: () => void
  deleteRegion: () => void
  undo: () => void
  redo: () => void
  replaceBuffer: (buffer: AudioBuffer, label: string) => void
  setZoom: (zoom: number) => void
  exportWav: () => Promise<string>
  revertToOriginal: () => void
  setError: (error: unknown) => void
}
let timer: ReturnType<typeof setTimeout> | undefined
let saveChain: Promise<void> = Promise.resolve()
const histories = new Map<string, { undoStack: History[]; redoStack: History[] }>()
function bounded(stack: History[]): History[] {
  let bytes = 0
  return stack.slice(-30).reverse().filter(item => {
    bytes += item.buffer.length * item.buffer.numberOfChannels * 4
    return bytes <= 64 * 1024 * 1024
  }).reverse()
}
export const useWaveformStore = create<EditorState>((set, get) => {
  const dirty = (patch: Partial<EditorState>) => {
    const next = { ...get(), ...patch }
    const documents = patch.documents ?? next.documents.map(d => d.clip.id === next.clip?.id
      ? { clip: next.clip!, effects: next.effects, exportAsMono: next.exportAsMono } : d)
    set({ ...patch, documents, saveStatus: 'pending', error: null })
    clearTimeout(timer)
    timer = setTimeout(() => { void get().save().catch(() => {}) }, 700)
  }
  /** Asks before a folder that is not yet an editor folder (no haptic-knowledge/) gets any editor files. */
  const confirmEditorFolder = async (root: FileSystemDirectoryHandle): Promise<boolean> => {
    if (await hasKnowledgeFolder(root)) return true
    return new Promise<boolean>(resolve => set({ folderPrompt: { name: root.name, answer: yes => { set({ folderPrompt: null }); resolve(yes) } } }))
  }
  /** Opens `root` as the editor folder; false (nothing written, current folder kept) when the user declines. */
  const adoptFolder = async (root: FileSystemDirectoryHandle): Promise<boolean> => {
    if (!await confirmEditorFolder(root)) return false
    const { folder, documents } = await EditorFolder.open(root)
    histories.clear()
    const first = documents[0]
    set({ folder, rememberedFolder: root, documents, clip: first?.clip ?? null, effects: first?.effects ?? [], exportAsMono: first?.exportAsMono ?? false,
      undoStack: [], redoStack: [], selectedRegion: null, saveStatus: 'saved', error: folder.recovered ? 'Recovered previous saved project. The latest index was damaged.' : null })
    return true
  }
  return {
    rememberedFolder: null, restored: false,
    restoreFolder: async () => {
      if (get().restored || get().isProcessing || get().folder) return
      set({ restored: true, isProcessing: true })
      try {
        const root = await loadDirectoryHandle('editordir')
        set({ rememberedFolder: root })
        if (root && await root.queryPermission({mode: 'readwrite'}) === 'granted') await adoptFolder(root)
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    ensureFolder: async () => {
      if (get().folder) return true
      if (!get().restored) await get().restoreFolder()
      if (get().folder) return true
      const root = get().rememberedFolder ?? await loadDirectoryHandle('editordir').catch(() => null)
      if (!root) return false
      set({ rememberedFolder: root })
      await get().reconnectFolder()
      return !!get().folder
    },
    reconnectFolder: async () => {
      const root = get().rememberedFolder
      if (!root || get().isProcessing || get().folder) return
      set({ isProcessing: true })
      try {
        if (await root.requestPermission({mode: 'readwrite'}) === 'granted') await adoptFolder(root)
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    folder: null, folderPrompt: null, documents: [], clip: null, effects: [], exportAsMono: false,
    selectionOriginal: false, selectedRegion: null, isProcessing: false, zoom: 200,
    undoStack: [], redoStack: [], saveStatus: 'empty', error: null,
    setError: error => set({ error: error instanceof Error ? error.message : String(error) }),
    openFolder: async () => {
      if (get().isProcessing) return
      // Picker must be invoked directly in the user gesture, before asynchronous saves.
      let root: FileSystemDirectoryHandle
      set({ isProcessing: true })
      try { root = await window.showDirectoryPicker({ id: 'hapbeat-editor', mode: 'readwrite' }) }
      catch (error) { set({ isProcessing: false }); if (error instanceof DOMException && error.name === 'AbortError') return; get().setError(error); return }
      set({ isProcessing: true })
      try {
        if (get().folder && get().saveStatus !== 'saved') await get().save()
        await saveChain
        if (!await adoptFolder(root)) return
        set({restored: true})
        await saveDirectoryHandle(root, 'editordir')
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    save: async () => {
      clearTimeout(timer)
      const run = async () => {
        const { folder, documents } = get()
        if (!folder) return
        set({ saveStatus: 'saving' })
        try {
          await folder.save(documents)
          set({ saveStatus: get().documents === documents ? 'saved' : 'pending', error: null })
        } catch (error) { set({ saveStatus: 'error' }); get().setError(error); throw error }
      }
      const result = saveChain.then(run, run)
      saveChain = result.catch(() => {})
      return result
    },
    loadFiles: async files => {
      const { folder } = get()
      if (!folder || get().isProcessing) return
      set({ isProcessing: true, error: null })
      try {
        for (const file of files) {
          const bytes = await file.arrayBuffer()
          // Hash before decoding: decodeAudioData may detach the buffer.
          const sourceSha256 = await sha256Hex(bytes)
          const buffer = await decodeAudioFile(bytes)
          if (buffer.numberOfChannels > 2) throw new Error(`${file.name}: only mono / stereo audio is supported`)
          const id = crypto.randomUUID()
          await folder.keepImport(id, file)
          const clip: WaveformClip = { id, name: file.name.replace(/\.[^.]+$/, ''), sourceFileName: file.name, sourceGroupId: id, sourceSha256, buffer, originalBuffer: buffer, exportSampleRate: 48000 }
          if (get().clip) histories.set(get().clip!.id, { undoStack: get().undoStack, redoStack: get().redoStack })
          dirty({ documents: [...get().documents, { clip, effects: [], exportAsMono: false }], clip, effects: [], exportAsMono: false, selectedRegion: null, undoStack: [], redoStack: [] })
        }
        await get().save()
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    addRecipeClip: async (recipe, name, sourceFileName, agentFolder) => {
      if (!get().folder || get().isProcessing) return
      set({ isProcessing: true, error: null })
      try {
        const samples = await loadRecipeSamples(recipe, {
          readAgentFile: path => agentFolder ? readAgentBytes(agentFolder, path) : Promise.reject(new Error(`Cannot read hapbeat-agent/${path}: no editor folder is open`)),
          getClip: (clipId, use) => {
            const clip = get().documents.find(d => d.clip.id === clipId)?.clip
            return clip ? (use === 'working' ? clip.buffer : clip.originalBuffer) : null
          },
          decodeAudio: decodeAudioFile,
        })
        const { data, sampleRate } = renderRecipe(recipe, samples)
        const buffer = new AudioBuffer({ numberOfChannels: 1, length: data.length, sampleRate })
        buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
        const id = crypto.randomUUID()
        const clip: WaveformClip = { id, name, sourceFileName, sourceGroupId: id, buffer, originalBuffer: buffer, exportSampleRate: recipe.sampleRate, recipe }
        if (get().clip) histories.set(get().clip!.id, { undoStack: get().undoStack, redoStack: get().redoStack })
        dirty({ documents: [...get().documents, { clip, effects: [], exportAsMono: false }], clip, effects: [], exportAsMono: false, selectedRegion: null, undoStack: [], redoStack: [] })
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    addDerivedClip: (source, effects) => {
      if (!get().folder || get().isProcessing) return null
      const id = crypto.randomUUID()
      const clip: WaveformClip = { ...source, id, sourceGroupId: source.sourceGroupId ?? id, buffer: source.originalBuffer, renderedEffects: [] }
      const chain = derivedEffectChain(effects)
      if (get().clip) histories.set(get().clip!.id, { undoStack: get().undoStack, redoStack: get().redoStack })
      dirty({ documents: [...get().documents, { clip, effects: chain, exportAsMono: false }], clip, effects: chain, exportAsMono: false, selectedRegion: null, undoStack: [], redoStack: [] })
      return id
    },
    selectClip: id => {
      if (get().isProcessing || get().clip?.id === id) return
      const doc = get().documents.find(d => d.clip.id === id)
      if (!doc) return
      if (get().clip) histories.set(get().clip!.id, { undoStack: get().undoStack, redoStack: get().redoStack })
      set({ ...doc, selectedRegion: null, ...(histories.get(id) ?? { undoStack: [], redoStack: [] }) })
    },
    duplicateClip: () => {
      const { clip, effects, exportAsMono } = get()
      if (!clip || get().isProcessing) return
      histories.set(clip.id, { undoStack: get().undoStack, redoStack: get().redoStack })
      const copy = { ...clip, sourceGroupId: sourceGroup(clip), id: crypto.randomUUID(), name: `${clip.name} — copy` }
      dirty({ documents: [...get().documents, { clip: copy, effects, exportAsMono }], clip: copy, undoStack: [], redoStack: [], selectedRegion: null })
    },
    extractSelection: () => {
      const { clip, selectedRegion, exportAsMono } = get()
      if (!clip || !selectedRegion || get().isProcessing) return
      const source = get().selectionOriginal ? clip.originalBuffer : clip.buffer
      const buffer = cropBuffer(source, selectedRegion.start, selectedRegion.end)
      if (!buffer || Math.floor(selectedRegion.end * source.sampleRate) <= Math.floor(selectedRegion.start * source.sampleRate)) return
      histories.set(clip.id, {undoStack: get().undoStack, redoStack: get().redoStack})
      const extracted: WaveformClip = { ...clip, sourceGroupId: sourceGroup(clip), id: crypto.randomUUID(), name: `${clip.name} [${selectedRegion.start.toFixed(3)}–${selectedRegion.end.toFixed(3)}s]`, buffer, originalBuffer: buffer, renderedEffects: [], recipe: undefined }
      dirty({clip: extracted, effects: [], documents: [...get().documents, {clip: extracted, effects: [], exportAsMono}], selectedRegion: null, undoStack: [], redoStack: []})
    },
    updateClipInfo: (id, patch) => {
      if (get().isProcessing) return
      const documents = get().documents.map(doc => doc.clip.id === id ? {...doc, clip: {...doc.clip, ...patch}} : doc)
      dirty({documents, clip: documents.find(doc => doc.clip.id === get().clip?.id)?.clip ?? get().clip})
    },
    setClipsProject: (ids, project) => {
      if (get().isProcessing) return
      const documents = assignProject(get().documents, ids, project)
      if (documents.every((doc, index) => doc === get().documents[index])) return
      dirty({documents, clip: documents.find(doc => doc.clip.id === get().clip?.id)?.clip ?? get().clip})
    },
    setProvenance: found => {
      let changed = false
      const documents = get().documents.map(doc => {
        const next = doc.clip.sourceSha256 ? found.get(doc.clip.sourceSha256) : undefined
        if (!next || JSON.stringify(next) === JSON.stringify(doc.clip.provenance)) return doc
        changed = true
        return {...doc, clip: {...doc.clip, provenance: next}}
      })
      if (changed) dirty({documents, clip: documents.find(doc => doc.clip.id === get().clip?.id)?.clip ?? get().clip})
    },
    setClipName: name => { if (get().clip && !get().isProcessing) dirty({ clip: { ...get().clip!, name } }) },
    setExportSampleRate: exportSampleRate => { if (get().clip && !get().isProcessing) dirty({ clip: { ...get().clip!, exportSampleRate } }) },
    setExportAsMono: exportAsMono => { if (!get().isProcessing) dirty({ exportAsMono }) },
    addEffect: type => { if (!get().isProcessing) dirty({ effects: [...get().effects.map(e => ({...e, applied: false})), { id: crypto.randomUUID(), enabled: true, params: getDefaultParams(type) }] }) },
    updateEffect: (id, params) => { if (!get().isProcessing) dirty({ effects: get().effects.map(e => e.id === id ? { ...e, params, applied: false } : {...e, applied: false}) }) },
    removeEffect: id => { if (!get().isProcessing) dirty({ effects: get().effects.filter(e => e.id !== id).map(e => ({...e, applied: false})) }) },
    toggleEffect: id => { if (!get().isProcessing) dirty({ effects: get().effects.map(e => e.id === id ? { ...e, enabled: !e.enabled, applied: false } : {...e, applied: false}) }) },
    applyEffects: async () => {
      const { clip, effects } = get()
      if (!clip || get().isProcessing || !effectsPending(clip, effects)) return
      set({ isProcessing: true, error: null })
      try {
        let buffer = clip.originalBuffer
        for (const effect of effects.filter(e => e.enabled)) buffer = await applyEffect(buffer, effect.params)
        dirty({ clip: { ...clip, buffer, renderedEffects: effects.map(e => ({ ...e, applied: true })) }, effects: effects.map(e => ({ ...e, applied: true })), selectedRegion: null,
          undoStack: bounded([...get().undoStack, { buffer: clip.buffer, effects: clip.renderedEffects ?? [], label: 'Effects' }]), redoStack: [] })
      } catch (error) { get().setError(error) }
      finally { set({ isProcessing: false }) }
    },
    setSelectedRegion: (selectedRegion, original = false, duration) => {
      const buffer = original ? get().clip?.originalBuffer : get().clip?.buffer
      if (!buffer || !selectedRegion) { set({ selectedRegion: null }); return }
      const start = Math.max(0, Math.min(duration ?? buffer.duration, selectedRegion.start))
      const end = Math.max(start, Math.min(duration ?? buffer.duration, selectedRegion.end))
      set({ selectionOriginal: original, selectedRegion: Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null })
    },
    replaceBuffer: (buffer, label) => {
      const { clip, undoStack, isProcessing } = get()
      if (!clip || isProcessing || buffer === clip.buffer) return
      dirty({ clip: { ...clip, buffer }, selectedRegion: null, undoStack: bounded([...undoStack, { buffer: clip.buffer, effects: get().effects, label }]), redoStack: [] })
    },
    cropToRegion: () => {
      const { clip, selectedRegion } = get()
      if (clip && selectedRegion && !get().selectionOriginal && !get().isProcessing) {
        get().addEffect('trim')
        get().updateEffect(get().effects[get().effects.length - 1].id, {type: 'trim', ...selectedRegion})
        void get().applyEffects()
      }
    },
    deleteRegion: () => {
      const { clip, selectedRegion } = get()
      if (clip && selectedRegion && !get().selectionOriginal && !get().isProcessing) {
        get().addEffect('cut')
        get().updateEffect(get().effects[get().effects.length - 1].id, {type: 'cut', ...selectedRegion})
        void get().applyEffects()
      }
    },
    undo: () => {
      const { clip, undoStack, redoStack } = get(), previous = undoStack[undoStack.length - 1]
      if (!clip || !previous || get().isProcessing) return
      dirty({ clip: { ...clip, buffer: previous.buffer, renderedEffects: previous.effects }, effects: previous.effects, selectedRegion: null, undoStack: undoStack.slice(0,-1), redoStack: bounded([...redoStack, { buffer: clip.buffer, effects: clip.renderedEffects ?? get().effects, label: 'Redo' }]) })
    },
    redo: () => {
      const { clip, undoStack, redoStack } = get(), next = redoStack[redoStack.length - 1]
      if (!clip || !next || get().isProcessing) return
      dirty({ clip: { ...clip, buffer: next.buffer, renderedEffects: next.effects }, effects: next.effects, selectedRegion: null, redoStack: redoStack.slice(0,-1), undoStack: bounded([...undoStack, { buffer: clip.buffer, effects: clip.renderedEffects ?? get().effects, label: 'Undo' }]) })
    },
    setZoom: zoom => set({ zoom: Math.max(1, Math.min(200000, zoom)) }),
    exportWav: async () => {
      if (!get().clip || !get().folder || get().isProcessing) throw new Error('Select a clip first')
      // Export what "Edited" shows: render a pending effect chain first.
      if (effectsPending(get().clip, get().effects)) {
        await get().applyEffects()
        if (get().error) throw new Error(get().error!)
      }
      const { clip, folder, exportAsMono } = get()
      if (!clip || !folder) throw new Error('Select a clip first')
      set({ isProcessing: true })
      try {
        await get().save()
        const blob = await (exportAsMono ? encodeMonoWavBlob : encodeWavBlob)(clip.buffer, clip.exportSampleRate)
        const filename = await folder.export(clip.name, blob)
        // Ledger record is best effort: the WAV is already on disk.
        void registerExportedDerived(getActiveHelperChannel(), { blob, parentSha256: clip.sourceSha256, name: clip.name, effects: clip.renderedEffects })
          .catch(error => console.warn('[editor] material_register_derived failed', error))
        return filename
      } finally { set({ isProcessing: false }) }
    },
    revertToOriginal: () => {
      const {clip, effects, undoStack} = get()
      if (!clip || get().isProcessing || (clip.buffer === clip.originalBuffer && effects.length === 0)) return
      dirty({clip: {...clip, buffer: clip.originalBuffer, renderedEffects: []}, effects: [], selectedRegion: null,
        undoStack: bounded([...undoStack, {buffer: clip.buffer, effects: clip.renderedEffects ?? effects, label: 'Restore original'}]), redoStack: []})
    },
  }
})
