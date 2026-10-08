import { effectsPending, useWaveformStore } from '@/stores/waveformStore'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { useSceneStore, type SceneNotice } from '@/stores/sceneStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { levelKey, useEventStore, type DecideResult, type DecideSource, type DecideTarget } from '@/stores/eventStore'
import { resample } from '@/utils/audioDsp'
import { encodePcm16Wav, isLoopCue } from '@/utils/sceneCueTable'
import { readProjectFile, writeProjectFile } from '@/utils/sceneProject'
import { RATE } from '@/utils/sceneHaptics'
import { addEventMark, applyHapticDecision, applySoundDecision, defaultAt, effectiveEvent, nextWavName, parseEventKey, safeWavName, sameBytes, wavBaseName } from '@/utils/cueEvents'
import { routeClips, setSoundIntensity, sfxSounds } from '@/utils/sceneCueTable'
import { intensityForPeak, normalizeGain, peakOf } from '@/utils/materialLevel'
import { sameSound } from '@/utils/wavCompare'
import { appendActivity } from '@/utils/activityLog'
import { localIsoString } from '@/utils/hapticKnowledge'
import { initialIntensity } from '@/utils/agentTrialUi'

/**
 * The strength the rating chose for an AI candidate (its rating form value, unsaved too, else the saved rating's
 * `intensity`, else the trial's proposed starting `intensity`); 1 for an editor clip. Multiplied into the new material's intensity (intensityForPeak).
 */
export function ratedIntensity(source: DecideSource): number {
  if (source.kind !== 'candidate') return 1
  const form = useEventStore.getState().levels[levelKey.candidate(source.trialId, source.candidateId)]
  if (form !== undefined) return form
  const record = useAgentTrialStore.getState().trials.find(r => r.trial.id === source.trialId)
  const rated = record?.rating?.candidates[source.candidateId]
  if (rated) return rated.intensity ?? 1
  return initialIntensity(record?.trial.candidates.find(c => c.id === source.candidateId))
}

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

/** Haptic: 16 kHz mono PCM16 (the Kit clip format); sound: 48 kHz PCM16 with the source's channels. As is (no normalization). */
export async function encodeDecided(buffer: AudioBuffer, target: DecideTarget): Promise<ArrayBuffer> {
  return (await encodeMaterial(buffer, target, false)).wav
}
/**
 * A material WAV (DEC-086): the shape at full scale (peak −0.5 dBFS) when `normalize`; `peak` is the peak before
 * (at the material's rate / channels) and `gain` the factor applied (1 without normalizing).
 */
export async function encodeMaterial(buffer: AudioBuffer, target: DecideTarget, normalize = true): Promise<{ wav: ArrayBuffer; peak: number; gain: number }> {
  const rate = target === 'haptic' ? RATE : SOUND_RATE
  const b = await resample(buffer, rate), ch = b.numberOfChannels
  const channels = target === 'haptic' ? [(() => { const mono = new Float32Array(b.length); for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) mono[i] += d[i] / ch } return mono })()]
    : Array.from({ length: ch }, (_, c) => b.getChannelData(c))
  const peak = peakOf(channels), gain = normalize ? normalizeGain(peak) : 1
  const n = channels[0].length, out = new Float32Array(n * channels.length)
  for (let c = 0; c < channels.length; c++) { const d = channels[c]; for (let i = 0; i < n; i++) out[i * channels.length + c] = d[i] * gain }
  return { wav: encodePcm16Wav(out, rate, channels.length), peak, gain }
}

/** Texts a decided WAV is named after: the editor clip's name and source file, or the candidate's label, source clip and file. */
export function sourceNames(source: DecideSource): string[] {
  if (source.kind === 'clip') {
    const clip = useWaveformStore.getState().documents.find(d => d.clip.id === source.clipId)?.clip
    return [clip?.name, clip?.sourceFileName].filter((x): x is string => !!x)
  }
  const record = useAgentTrialStore.getState().trials.find(r => r.trial.id === source.trialId)
  const requested = record?.trial.candidates.find(c => c.id === source.candidateId)
  const file = record?.candidates.find(c => c.id === source.candidateId)
  const src = file?.spec.source ?? requested?.source
  return [requested?.label, file?.resolved?.clipName, src?.kind === 'file' ? src.path : undefined].filter((x): x is string => !!x)
}

const dirOf = (target: DecideTarget) => { const lib = useSceneStore.getState().lib!; return target === 'haptic' ? lib.paths.clips : lib.paths.sounds }
/** Bytes of an existing clip / sound WAV of the open project, or null. */
export async function existingWav(target: DecideTarget, name: string): Promise<ArrayBuffer | null> {
  const s = useSceneStore.getState()
  if (!s.root || !s.lib || !(target === 'haptic' ? s.clipFiles : s.soundFiles).includes(name)) return null
  try { return await (await readProjectFile(s.root, `${dirOf(target)}/${name}.wav`)).arrayBuffer() } catch { return null }
}

/**
 * A name that is free or already holds these bytes; a clip entry of the other loop kind counts as taken.
 * An AI candidate is named `<cue>_<shortId>_<candidateId>` (roar_T45_A; a variant's ":" becomes "_"; clips in
 * lower case), never after its label; an editor clip after its name / source file.
 */
export function autoWavName(target: DecideTarget, source: DecideSource, wav: ArrayBuffer, events: string[]) {
  const s = useSceneStore.getState(), lib = s.lib!, ref = parseEventKey(events[0])
  const kind = target === 'haptic' ? 'clip' : 'sound', pattern = target === 'haptic' ? lib.clip_name : lib.sound_name
  const short = source.kind === 'candidate' ? useAgentTrialStore.getState().trials.find(r => r.trial.id === source.trialId)?.shortId : undefined
  const candidateName = source.kind === 'candidate' && short ? safeWavName(`${events[0].replace(/:/g, '_')}_${short}_${source.candidateId}`, kind, pattern) : ''
  const base = candidateName || wavBaseName(sourceNames(source), kind, pattern, ref)
  const loop = isLoopCue(lib, ref.cue)
  const taken = (name: string) => target === 'haptic' ? (!!s.table?.clips[name] && s.table.clips[name].loop !== loop) : lib.loop_sounds.includes(name)
  return nextWavName(base, wav, name => existingWav(target, name), taken)
}

/** The event material (clip / sound name) that holds the same sound as `wav` (sameSound), if any. */
async function sameAsEventMaterial(target: DecideTarget, wav: ArrayBuffer, events: string[]): Promise<string | null> {
  const table = useSceneStore.getState().table
  if (!table) return null
  const names = new Set(events.flatMap(key => {
    const e = effectiveEvent(table, parseEventKey(key))
    return !e ? [] : target === 'haptic' ? e.haptics.flatMap(routeClips) : sfxSounds(e.sfx)
  }))
  for (const name of names) {
    const bytes = await existingWav(target, name)
    if (bytes && (sameBytes(bytes, wav) || sameSound(bytes, wav))) return name
  }
  return null
}

export interface DecisionInput {
  target: DecideTarget
  source: DecideSource
  /** Event keys; one WAV is assigned to all of them in one table write (one undo). */
  events: string[]
  /** WAV name, or null = automatic (source name, numbered on a content clash, reused when identical). */
  name: string | null
  /** For events without a haptic route; null = the project's default position (scene multiplier 1). */
  at: string | null
  /** Pre-encoded WAV (the dialog encodes once to suggest a name). */
  wav?: ArrayBuffer
  /** The intensity of a new material written from `wav` (its size before normalizing × the rated strength). */
  intensity?: number
}

/**
 * "Decide": writes the WAV into the project's clip / sound folder (skipped when
 * that name already holds the same bytes) and points the events at it in the
 * cue table (validated like the Scene tab save). Keeps what it replaced (table
 * text, overwritten WAV bytes) for "Undo", marks the clip / candidate in the
 * clip list, and publishes the result (Events panel / trial notices).
 */
export async function runDecision(input: DecisionInput): Promise<{ ok: true; result: DecideResult } | { ok: false; notice: SceneNotice }> {
  // Written normalized; the candidate's / clip's own size × its rated strength becomes the new material's intensity (DEC-086).
  const encoded = input.wav ? { wav: input.wav, intensity: input.intensity ?? 1 } : await (async () => {
    const m = await encodeMaterial(await decideSourceBuffer(input.source), input.target)
    return { wav: m.wav, intensity: intensityForPeak(m.peak, ratedIntensity(input.source)) }
  })()
  const wav = encoded.wav
  const before = useSceneStore.getState()
  if (!before.table || !before.lib || !input.events.length) return { ok: false, notice: { id: 'scene.save.noProject', error: true } }
  const lib = before.lib
  // The same sound as a material the event already has (an AI candidate that just re-renders it): nothing to add.
  const duplicate = await sameAsEventMaterial(input.target, wav, input.events)
  if (duplicate) return { ok: false, notice: { id: 'events.decide.duplicate', params: { name: duplicate } } }
  const picked = input.name ? { name: input.name, same: false } : await autoWavName(input.target, input.source, wav, input.events)
  const previous = await existingWav(input.target, picked.name)
  const same = picked.same || (!!previous && sameBytes(previous, wav))
  const table = useSceneStore.getState().table!
  let next = table
  for (const key of input.events) {
    const ref = parseEventKey(key)
    next = input.target === 'haptic'
      ? applyHapticDecision(next, lib, { ref, clip: picked.name, at: input.at ?? defaultAt(lib, ref.cue), gain: 1, intensity: encoded.intensity })
      : applySoundDecision(next, ref, picked.name)
  }
  // A new sound gets its base level; one already in the table keeps its own.
  if (input.target === 'sound' && !next.sounds?.[picked.name]) next = setSoundIntensity(next, picked.name, encoded.intensity)
  const kind = input.target === 'haptic' ? 'clips' : 'sounds'
  // A WAV overwritten under the same name with other bytes is kept in _archive first (never lost).
  if (previous && !same && before.root) await writeProjectFile(before.root, `_archive/${dirOf(input.target)}/${picked.name}_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, previous)
  const committed = await useSceneStore.getState().commitDecision(next, { clips: {}, sounds: {}, [kind]: same ? {} : { [picked.name]: wav } })
  if (!committed.ok) return committed
  const subject = input.source.kind === 'clip' ? input.source.clipId : `${input.source.trialId}/${input.source.candidateId}`
  let marks = useEditorSettings.getState().eventMarks
  for (const key of input.events) marks = addEventMark(marks, subject, { project: lib.project_name, event: key, target: input.target })
  useEditorSettings.getState().update({ eventMarks: marks })
  const result: DecideResult = { id: Date.now(), events: input.events, target: input.target, name: picked.name, file: `${dirOf(input.target)}/${picked.name}.wav`,
    importCommand: lib.import_command, reused: same }
  const root = useWaveformStore.getState().folder?.root
  if (root) void appendActivity(root, { at: localIsoString(new Date()), kind: 'decided', events: input.events, file: result.file, note: `${input.target}${same ? ' (same bytes, reused)' : ''}; import: ${lib.import_command}` }).catch(() => {})
  return { ok: true, result }
}
