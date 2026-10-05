import { useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { readProjectFile } from '@/utils/sceneProject'
import { trialSceneOptions } from '@/utils/trialScene'
import { addEventMark, decidedSubjects, eventSceneCues, materialUsers, parseEventKey, sameBytes, setReview } from '@/utils/cueEvents'
import { useEffect, useRef } from 'react'
import type { MaterialLink } from '@/utils/editorUiSettings'
import { appendActivity } from '@/utils/activityLog'
import { localIsoString } from '@/utils/hapticKnowledge'
import { encodeDecided, existingWav } from './eventDecide'

/**
 * "Edit as a clip" on an assigned sound / haptic of an event: opens the editor
 * clip it was decided from (with its effect chain) when that is known — the
 * clip itself, or the clip adopted from the AI candidate (adopting it now if
 * needed) — else imports the event's WAV as a new clip, tagged with the game
 * project and linked to the event's recorded moment. The clip stays linked to
 * the WAV: its edits are written back to it (useMaterialWriteBack).
 */
export async function openEventMaterialForEditing(event: string, target: DecideTarget, wavName: string): Promise<'clip' | 'candidate' | 'wav'> {
  const opened = await openForEditing(event, target, wavName)
  // The clip now edits that WAV: its edits are written back (useMaterialWriteBack).
  const clipId = useWaveformStore.getState().clip?.id, project = useSceneStore.getState().lib?.project_name
  if (clipId && project) {
    const settings = useEditorSettings.getState()
    settings.update({ materialLinks: { ...settings.materialLinks, [clipId]: { project, event, target, wav: wavName } } })
  }
  return opened
}

async function openForEditing(event: string, target: DecideTarget, wavName: string): Promise<'clip' | 'candidate' | 'wav'> {
  const scene = useSceneStore.getState()
  if (!scene.root || !scene.lib || !scene.table) throw new Error('No game project is open')
  const lib = scene.lib, editor = useWaveformStore.getState()
  if (!editor.folder) throw new Error('Choose an editor folder first')
  const subjects = decidedSubjects(useEditorSettings.getState().eventMarks, lib.project_name, event, target)
  const docs = editor.documents
  const clipSubject = subjects.find(s => docs.some(d => d.clip.id === s))
  if (clipSubject) { editor.selectClip(clipSubject); return 'clip' }
  for (const subject of subjects.filter(s => s.includes('/'))) {
    const adopted = docs.find(d => d.clip.description === `trial:${subject}`)
    if (adopted) { editor.selectClip(adopted.clip.id); return 'candidate' }
    const [trialId, candidateId] = subject.split('/')
    if (useAgentTrialStore.getState().trials.some(r => r.trial.id === trialId)) {
      const { clipId } = await useAgentTrialStore.getState().adoptCandidate(trialId, candidateId)
      useWaveformStore.getState().selectClip(clipId)
      return 'candidate'
    }
  }
  const dir = target === 'haptic' ? lib.paths.clips : lib.paths.sounds
  const file = await readProjectFile(scene.root, `${dir}/${wavName}.wav`)
  await editor.loadFiles([new File([await file.arrayBuffer()], `${wavName}.wav`, { type: 'audio/wav' })])
  const clip = useWaveformStore.getState().clip
  if (!clip || clip.sourceFileName !== `${wavName}.wav`) throw new Error(useWaveformStore.getState().error ?? `Could not load ${dir}/${wavName}.wav`)
  useWaveformStore.getState().updateClipInfo(clip.id, { project: lib.project_name, description: `event:${event} (${target})` })
  if (target === 'haptic') useWaveformStore.getState().setExportSampleRate(16000)
  // The clip shows the event's moment in the Scene video panel and "→ Event" defaults to it.
  const settings = useEditorSettings.getState()
  const moment = scene.data ? trialSceneOptions(scene.data, eventSceneCues(scene.table, event))[0] : undefined
  settings.update({
    ...(moment ? { clipScenes: { ...settings.clipScenes, [clip.id]: { project: lib.project_name, file: moment.file } } } : {}),
    eventMarks: addEventMark(settings.eventMarks, clip.id, { project: lib.project_name, event, target }),
  })
  useEventStore.getState().clearPreview()
  return 'wav'
}

/**
 * Edits of a clip linked to an event material go back to that WAV, 1 s after the clip's audio last changed:
 * the previous file is archived (`_archive/…`), the new bytes written, and the review of every event using it
 * goes back to "tentative". Logged; only failures are shown.
 */
export function useMaterialWriteBack() {
  const documents = useWaveformStore(s => s.documents)
  const links = useEditorSettings(s => s.materialLinks)
  const seen = useRef(new Map<string, AudioBuffer>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    for (const doc of documents) {
      const link = links[doc.clip.id], buffer = doc.clip.buffer
      if (!link) continue
      const before = seen.current.get(doc.clip.id)
      seen.current.set(doc.clip.id, buffer)
      if (!before || before === buffer) continue // first sight (just opened / loaded) or unchanged
      const timer = timers.current.get(doc.clip.id)
      if (timer) clearTimeout(timer)
      timers.current.set(doc.clip.id, setTimeout(() => { timers.current.delete(doc.clip.id); void writeBack(doc.clip.id, link) }, 1000))
    }
  }, [documents, links])
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer) }, [])
}

async function writeBack(clipId: string, link: MaterialLink) {
  const scene = useSceneStore.getState(), editor = useWaveformStore.getState()
  const clip = editor.documents.find(d => d.clip.id === clipId)?.clip
  if (!clip) return
  try {
    if (!scene.root || !scene.lib || !scene.table || scene.lib.project_name !== link.project) throw new Error(`open the game project ${link.project} to update ${link.wav}.wav`)
    const wav = await encodeDecided(clip.buffer, link.target)
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
