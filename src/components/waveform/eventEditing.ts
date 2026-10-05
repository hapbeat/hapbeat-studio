import { useEffect, useRef } from 'react'
import { useWaveformStore } from '@/stores/waveformStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { readProjectFile, writeProjectFile } from '@/utils/sceneProject'
import { materialUsers, parseEventKey, sameBytes, setReview } from '@/utils/cueEvents'
import type { MaterialLink } from '@/utils/editorUiSettings'
import { appendActivity } from '@/utils/activityLog'
import { localIsoString } from '@/utils/hapticKnowledge'
import { encodeDecided, existingWav } from './eventDecide'
import { ADJUST_FORMAT, hasMaterialAdjust, readMaterialAdjust, writeMaterialAdjust, writeMaterialOriginal, type MaterialAdjust } from '@/utils/materialAdjust'
import { decodeAudioFile } from '@/utils/wavIO'
import type { EffectEntry, SampleRate } from '@/types/waveform'

/**
 * "Adjust" on an event material (Events panel): the material is edited in place with the editor's effects.
 * Each material has one editor document — the original audio (the WAV as it was) plus its effect chain —
 * linked to the WAV (`materialLinks`) and hidden from the clip list. The versioned copy is
 * adjust/<project>/<sound|haptic>/<material>.json + .original.wav (materialAdjust); `.hapbeat-editor`
 * only caches the decoded document and is rebuilt from adjust/ when it is gone. Whatever the chain renders is written back to the WAV
 * (useMaterialWriteBack); an empty chain gives the original back.
 */
export async function openMaterialForAdjust(event: string, target: DecideTarget, wav: string): Promise<void> {
  const scene = useSceneStore.getState()
  if (!scene.root || !scene.lib) throw new Error('No game project is open')
  const lib = scene.lib, editor = useWaveformStore.getState()
  if (!editor.folder) throw new Error('Choose an editor folder first')
  const root = editor.folder.root
  const links = useEditorSettings.getState().materialLinks
  const existing = Object.entries(links).find(([id, l]) => l.project === lib.project_name && l.target === target && l.wav === wav && editor.documents.some(d => d.clip.id === id))
  useEventStore.getState().clearPreview()
  if (existing) { editor.selectClip(existing[0]); return }
  const link: MaterialLink = { project: lib.project_name, event, target, wav }
  const saved = await readMaterialAdjust(root, lib.project_name, target, wav)
  let clipId: string | null
  if (saved) {
    // Rebuilt from adjust/ (the versioned copy): the original plus the chain, not yet applied.
    const original = await decodeAudioFile(saved.original.slice(0))
    clipId = editor.addDerivedClip({ name: wav, originalBuffer: original, exportSampleRate: saved.data.exportSampleRate, sourceFileName: `${wav}.wav`, project: lib.project_name, description: `material:${event} (${target})` },
      saved.data.effects.filter(e => e.enabled).map(e => e.params))
    if (!clipId) throw new Error('The editor is busy')
  } else {
    const dir = target === 'haptic' ? lib.paths.clips : lib.paths.sounds
    const bytes = await (await readProjectFile(scene.root, `${dir}/${wav}.wav`)).arrayBuffer()
    // The original is kept in adjust/ (versioned) and in the game project's _archive (non-destructive).
    await writeProjectFile(scene.root, `_archive/${dir}/${wav}_original_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, bytes)
    await writeMaterialOriginal(root, lib.project_name, target, wav, bytes)
    await editor.loadFiles([new File([bytes], `${wav}.wav`, { type: 'audio/wav' })])
    const clip = useWaveformStore.getState().clip
    if (!clip || clip.sourceFileName !== `${wav}.wav`) throw new Error(useWaveformStore.getState().error ?? `Could not load ${dir}/${wav}.wav`)
    useWaveformStore.getState().updateClipInfo(clip.id, { project: lib.project_name, description: `material:${event} (${target})` })
    if (target === 'haptic') useWaveformStore.getState().setExportSampleRate(16000)
    clipId = clip.id
    await writeMaterialAdjust(root, adjustData(link, [], target === 'haptic' ? 16000 : useWaveformStore.getState().clip!.exportSampleRate))
  }
  const settings = useEditorSettings.getState()
  settings.update({ materialLinks: { ...settings.materialLinks, [clipId]: link } })
}

const adjustData = (link: MaterialLink, effects: EffectEntry[], exportSampleRate: SampleRate): MaterialAdjust =>
  ({ format: ADJUST_FORMAT, ...link, effects, exportSampleRate, updatedAt: localIsoString(new Date()) })

/**
 * The adjusted material's chain is kept in adjust/<project>/<target>/<material>.json (versioned) 0.5 s after
 * it changes; on the first run every linked document without its adjust/ copy is migrated (original + chain).
 */
export function useAdjustPersistence() {
  const folder = useWaveformStore(s => s.folder)
  const clipId = useWaveformStore(s => s.clip?.id ?? null)
  const effects = useWaveformStore(s => s.effects)
  const rate = useWaveformStore(s => s.clip?.exportSampleRate ?? null)
  const link = useEditorSettings(s => clipId ? s.materialLinks[clipId] : undefined)
  const first = useRef<string | null>(null)
  useEffect(() => {
    if (!folder || !link || !clipId || rate === null) return
    if (first.current !== clipId) { first.current = clipId; return } // just opened: nothing changed yet
    const timer = setTimeout(() => void writeMaterialAdjust(folder.root, adjustData(link, effects, rate)).catch(error => useWaveformStore.getState().setError(error)), 500)
    return () => clearTimeout(timer)
  }, [folder, clipId, link, effects, rate])
  // Migration of adjustments made before adjust/ existed (they lived only in .hapbeat-editor).
  const documents = useWaveformStore(s => s.documents)
  const links = useEditorSettings(s => s.materialLinks)
  const migrated = useRef<FileSystemDirectoryHandle | null>(null)
  useEffect(() => {
    if (!folder || migrated.current === folder.root || !documents.length) return
    migrated.current = folder.root
    void (async () => {
      for (const doc of documents) {
        const l = links[doc.clip.id]
        if (!l || await hasMaterialAdjust(folder.root, l.project, l.target, l.wav)) continue
        await writeMaterialOriginal(folder.root, l.project, l.target, l.wav, await encodeDecided(doc.clip.originalBuffer, l.target))
        await writeMaterialAdjust(folder.root, adjustData(l, doc.effects, doc.clip.exportSampleRate))
        console.info('[adjust] migrated', `${l.project}/${l.target}/${l.wav}`)
      }
    })().catch(error => useWaveformStore.getState().setError(error))
  }, [folder, documents, links])
}

/**
 * The material being adjusted is written back 1 s after what its chain renders changes (`rendered`: the
 * live preview of the chain, or the clip itself without pending changes). Writes only when the game project
 * is open and the render succeeded (`renderError` is reported instead); the previous WAV goes to
 * `_archive/` and every event using it goes back to "tentative". Logged; only failures are shown.
 */
export function useMaterialWriteBack(rendered: AudioBuffer | null, renderError: string | null) {
  const clipId = useWaveformStore(s => s.clip?.id ?? null)
  const link = useEditorSettings(s => clipId ? s.materialLinks[clipId] : undefined)
  const seen = useRef<{ clipId: string | null; buffer: AudioBuffer | null }>({ clipId: null, buffer: null })
  useEffect(() => {
    if (!link || !clipId) { seen.current = { clipId, buffer: rendered }; return }
    if (renderError) { useWaveformStore.getState().setError(`${link.wav}.wav: ${renderError}`); return }
    const first = seen.current.clipId !== clipId
    const changed = !first && !!rendered && rendered !== seen.current.buffer
    seen.current = { clipId, buffer: rendered }
    if (!changed || !rendered) return // just opened, or still rendering
    const timer = setTimeout(() => void writeBack(rendered, link), 1000)
    return () => clearTimeout(timer)
  }, [clipId, link, rendered, renderError])
}

async function writeBack(buffer: AudioBuffer, link: MaterialLink) {
  const scene = useSceneStore.getState(), editor = useWaveformStore.getState()
  try {
    if (!scene.root || !scene.lib || !scene.table || scene.lib.project_name !== link.project) throw new Error(`open the game project ${link.project} to update ${link.wav}.wav`)
    const wav = await encodeDecided(buffer, link.target)
    const current = await existingWav(link.target, link.wav)
    if (current && sameBytes(current, wav)) return
    const { archived } = await scene.replaceMaterial(link.target, link.wav, wav)
    const field = link.target === 'haptic' ? 'haptics' : 'sfx'
    const users = materialUsers(useSceneStore.getState().table!, link.target === 'haptic' ? 'clip' : 'sound', link.wav)
    useSceneStore.getState().edit(tb => users.reduce((t, key) => setReview(t, parseEventKey(key), field, 'tentative'), tb))
    if (editor.folder) void appendActivity(editor.folder.root, { at: localIsoString(new Date()), kind: 'material-updated', events: users, file: `${link.wav}.wav`, note: `previous → ${archived}` }).catch(() => {})
  } catch (error) {
    useWaveformStore.getState().setError(`${link.wav}.wav: ${error instanceof Error ? error.message : String(error)}`)
  }
}
