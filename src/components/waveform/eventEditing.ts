import { useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { readProjectFile } from '@/utils/sceneProject'
import { trialSceneOptions } from '@/utils/trialScene'
import { addEventMark, decidedSubjects, eventSceneCues } from '@/utils/cueEvents'

/**
 * "Edit as a clip" on an assigned sound / haptic of an event: opens the editor
 * clip it was decided from (with its effect chain) when that is known — the
 * clip itself, or the clip adopted from the AI candidate (adopting it now if
 * needed) — else imports the event's WAV as a new clip, tagged with the game
 * project and linked to the event's recorded moment. Its "→ Event" then assigns
 * the edited result back to the same event.
 */
export async function openEventMaterialForEditing(event: string, target: DecideTarget, wavName: string): Promise<'clip' | 'candidate' | 'wav'> {
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
