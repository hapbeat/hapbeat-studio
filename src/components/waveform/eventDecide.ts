import { effectsPending, useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useSceneStore, type SceneNotice } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import type { DecideResult, DecideSource, DecideTarget } from '@/stores/eventStore'
import { resample } from '@/utils/audioDsp'
import { encodePcm16Wav } from '@/utils/sceneCueTable'
import { RATE } from '@/utils/sceneHaptics'
import { addEventMark, applyHapticDecision, applySoundDecision, parseEventKey } from '@/utils/cueEvents'

/** Cue sounds are written at 48 kHz (the Scene tab's sound writer). */
export const SOUND_RATE = 48000

/**
 * The audio a decision writes: an editor clip as "Edited" shows it (a pending
 * effect chain of the selected clip is rendered first, like Export WAV), or an
 * AI candidate's rendered audio.
 */
export async function decideSourceBuffer(source: DecideSource): Promise<AudioBuffer> {
  if (source.kind === 'candidate') return useAgentTrialStore.getState().loadCandidateAudio(source.trialId, source.candidateId)
  const editor = useWaveformStore.getState()
  if (!editor.documents.some(d => d.clip.id === source.clipId)) throw new Error(`Clip "${source.clipId}" is no longer in the editor`)
  if (editor.clip?.id === source.clipId && effectsPending(editor.clip, editor.effects)) {
    await editor.applyEffects()
    const error = useWaveformStore.getState().error
    if (error) throw new Error(error)
  }
  const now = useWaveformStore.getState()
  const clip = now.clip?.id === source.clipId ? now.clip : now.documents.find(d => d.clip.id === source.clipId)?.clip
  if (!clip) throw new Error(`Clip "${source.clipId}" is no longer in the editor`)
  return clip.buffer
}

/** Haptic: 16 kHz mono PCM16 (the Kit clip format); sound: 48 kHz PCM16 with the source's channels. */
export async function encodeDecided(buffer: AudioBuffer, target: DecideTarget): Promise<ArrayBuffer> {
  const rate = target === 'haptic' ? RATE : SOUND_RATE
  const b = await resample(buffer, rate), ch = b.numberOfChannels
  if (target === 'haptic') {
    const mono = new Float32Array(b.length)
    for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) mono[i] += d[i] / ch }
    return encodePcm16Wav(mono, rate, 1)
  }
  const inter = new Float32Array(b.length * ch)
  for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) inter[i * ch + c] = d[i] }
  return encodePcm16Wav(inter, rate, ch)
}

export interface DecisionInput { target: DecideTarget; source: DecideSource; event: string; name: string; at: string; gain: number }

/**
 * "Decide": writes the WAV into the project's clip / sound folder and points the
 * event at it in the cue table (validated like the Scene tab save), then marks
 * the clip / candidate in the clip list. The Scene tab shows the result at once (same store).
 */
export async function runDecision(input: DecisionInput): Promise<{ ok: true; result: DecideResult } | { ok: false; notice: SceneNotice }> {
  const wav = await encodeDecided(await decideSourceBuffer(input.source), input.target)
  const scene = useSceneStore.getState()
  if (!scene.table || !scene.lib) return { ok: false, notice: { id: 'scene.save.noProject', error: true } }
  const lib = scene.lib, ref = parseEventKey(input.event)
  const next = input.target === 'haptic'
    ? applyHapticDecision(scene.table, lib, { ref, clip: input.name, at: input.at, gain: input.gain })
    : applySoundDecision(scene.table, ref, input.name)
  const committed = await scene.commitDecision(next, input.target === 'haptic' ? { clips: { [input.name]: wav }, sounds: {} } : { clips: {}, sounds: { [input.name]: wav } })
  if (!committed.ok) return committed
  const subject = input.source.kind === 'clip' ? input.source.clipId : `${input.source.trialId}/${input.source.candidateId}`
  const settings = useEditorSettings.getState()
  settings.update({ eventMarks: addEventMark(settings.eventMarks, subject, { project: lib.project_name, event: input.event, target: input.target }) })
  const dir = input.target === 'haptic' ? lib.paths.clips : lib.paths.sounds
  return { ok: true, result: { event: input.event, target: input.target, name: input.name, file: `${dir}/${input.name}.wav`, importCommand: lib.import_command } }
}
