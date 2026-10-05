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

/**
 * "Adjust" on an event material (Events panel): the material is edited in place with the editor's effects.
 * Each material has one editor document — the original audio (the WAV as it was, also copied to
 * `_archive/` once) plus its effect chain, kept in `.hapbeat-editor` like any clip — linked to the WAV
 * (`materialLinks`) and hidden from the clip list. Whatever the chain renders is written back to the WAV
 * (useMaterialWriteBack); an empty chain gives the original back.
 */
export async function openMaterialForAdjust(event: string, target: DecideTarget, wav: string): Promise<void> {
  const scene = useSceneStore.getState()
  if (!scene.root || !scene.lib) throw new Error('No game project is open')
  const lib = scene.lib, editor = useWaveformStore.getState()
  if (!editor.folder) throw new Error('Choose an editor folder first')
  const links = useEditorSettings.getState().materialLinks
  const existing = Object.entries(links).find(([id, l]) => l.project === lib.project_name && l.target === target && l.wav === wav && editor.documents.some(d => d.clip.id === id))
  useEventStore.getState().clearPreview()
  if (existing) { editor.selectClip(existing[0]); return }
  const dir = target === 'haptic' ? lib.paths.clips : lib.paths.sounds
  const bytes = await (await readProjectFile(scene.root, `${dir}/${wav}.wav`)).arrayBuffer()
  // The original stays in the game project too (non-destructive), besides the editor document.
  await writeProjectFile(scene.root, `_archive/${dir}/${wav}_original_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, bytes)
  await editor.loadFiles([new File([bytes], `${wav}.wav`, { type: 'audio/wav' })])
  const clip = useWaveformStore.getState().clip
  if (!clip || clip.sourceFileName !== `${wav}.wav`) throw new Error(useWaveformStore.getState().error ?? `Could not load ${dir}/${wav}.wav`)
  useWaveformStore.getState().updateClipInfo(clip.id, { project: lib.project_name, description: `material:${event} (${target})` })
  if (target === 'haptic') useWaveformStore.getState().setExportSampleRate(16000)
  const settings = useEditorSettings.getState()
  settings.update({ materialLinks: { ...settings.materialLinks, [clip.id]: { project: lib.project_name, event, target, wav } } })
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
