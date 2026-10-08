/**
 * Picks up agent trial requests from hapbeat-agent/inbox/, renders each
 * candidate and records it under haptic-knowledge/trials/. AudioBuffer-bound
 * operations are injected (InboxDeps) so the flow is testable in Node.
 */
import type { EffectParams } from '@/types/waveform'
import { parseTrialRequest, trialRequestError, CANDIDATE_FORMAT, type CandidateFile, type CandidateSource, type TrialCandidate, type TrialFile, type TrialRequest } from '@/utils/agentProtocol'
import { computeFeatures, mixToMono } from '@/utils/hapticFeatures'
import { localIsoString, monthOf, type KnowledgeFolder } from '@/utils/hapticKnowledge'
import { loadRecipeSamples, type Recipe, type RecipeSamples } from '@/utils/recipe'
import type { CueTable } from '@/utils/sceneCueTable'
import { unknownContextCues } from '@/utils/trialContext'

export const OUTPUT_RATE = 48000
/** A request file must be unchanged this long before it is read (agents may still be writing). */
export const SETTLE_MS = 1500
const NORMALIZE_PEAK = 0.98

export interface InboxDeps {
  studioVersion: string
  now: () => Date
  getClip: (clipId: string, use: 'original' | 'working') => { buffer: AudioBuffer; name: string } | null
  decodeAudio: (bytes: ArrayBuffer) => Promise<AudioBuffer>
  /** `samples` holds the material of the recipe's sample layers (loadRecipeSamples). */
  renderRecipe: (recipe: unknown, samples: RecipeSamples) => { data: Float32Array; sampleRate: number }
  createBuffer: (data: Float32Array, sampleRate: number) => AudioBuffer
  applyEffect: (buffer: AudioBuffer, params: EffectParams) => Promise<AudioBuffer>
  resample: (buffer: AudioBuffer, sampleRate: number) => Promise<AudioBuffer>
  encodeWav: (data: Float32Array, sampleRate: number) => Blob
  /** The cue table of Scene project `project` when it is the one open (null = not known here): `scene.context` is checked against it. */
  sceneCueTable?: (project: string) => CueTable | null
}
export interface InboxResult { accepted: string[]; rejected: { file: string; error: string }[] }

/** 16-bit PCM mono WAV (pure; no resampling). */
export function encodePcm16Wav(data: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + data.length * 2), view = new DataView(bytes)
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, data.length * 2, true)
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true) }
  return new Blob([bytes], { type: 'audio/wav' })
}

/** Returns a normalized copy when the peak exceeds 1.0; never mutates the input. */
export function normalizeOverPeak(data: Float32Array): { data: Float32Array; gainDb: number | null } {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  if (peak <= 1) return { data, gainDb: null }
  const gain = NORMALIZE_PEAK / peak
  return { data: data.map(v => v * gain), gainDb: Math.round(20 * Math.log10(gain) * 100) / 100 }
}

/** Bytes of a file below hapbeat-agent/ (path already validated by isSafeAgentPath). */
export async function readAgentBytes(folder: KnowledgeFolder, path: string): Promise<ArrayBuffer> {
  let file: File
  try { file = await folder.readAgentFile(path) }
  catch { throw new Error(`File not found: hapbeat-agent/${path}`) }
  return file.arrayBuffer()
}

const channelsOf = (buffer: AudioBuffer) => Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch))

async function loadSource(source: CandidateSource, folder: KnowledgeFolder, deps: InboxDeps): Promise<{ buffer: AudioBuffer; clipName?: string }> {
  switch (source.kind) {
    case 'clip': {
      const clip = deps.getClip(source.clipId, source.use ?? 'original')
      if (!clip) throw new Error(`Clip "${source.clipId}" is not in the editor (see catalog.json)`)
      return { buffer: clip.buffer, clipName: clip.name }
    }
    case 'file':
      return { buffer: await deps.decodeAudio(await readAgentBytes(folder, source.path)) }
    case 'recipe': {
      const samples = await loadRecipeSamples(source.recipe as Recipe, {
        readAgentFile: path => readAgentBytes(folder, path),
        getClip: (clipId, use) => deps.getClip(clipId, use)?.buffer ?? null,
        decodeAudio: deps.decodeAudio,
      })
      const rendered = deps.renderRecipe(source.recipe, samples)
      return { buffer: deps.createBuffer(rendered.data, rendered.sampleRate) }
    }
  }
}

/** source → mono → effects in order → 48 kHz → peak guard. */
export async function renderCandidate(candidate: TrialCandidate, folder: KnowledgeFolder, deps: InboxDeps) {
  const { buffer: source, clipName } = await loadSource(candidate.source, folder, deps)
  const resolved = { clipName, sourceSampleRate: source.sampleRate, sourceChannels: source.numberOfChannels, sourceDurationSec: Math.round(source.duration * 1e4) / 1e4 }
  let buffer = source.numberOfChannels > 1 ? deps.createBuffer(mixToMono(channelsOf(source)), source.sampleRate) : source
  for (const params of candidate.effects) buffer = await deps.applyEffect(buffer, params)
  if (buffer.sampleRate !== OUTPUT_RATE) buffer = await deps.resample(buffer, OUTPUT_RATE)
  const mono = mixToMono(channelsOf(buffer))
  if (!mono.length) throw new Error('Rendered audio is empty')
  if (!mono.every(Number.isFinite)) throw new Error('Rendered audio contains invalid samples')
  const { data, gainDb } = normalizeOverPeak(mono)
  return { data, resolved, autoNormalizedDb: gainDb }
}

export type AcceptResult = { ok: true; trialId: string; month: string; candidates: CandidateFile[] } | { ok: false; error: string }

/**
 * Records and renders one validated request. Shared by the inbox and submitTrialRequest (MCP)
 * so both produce the same trial folder; `storeRequest` writes request.json last.
 */
export async function acceptTrial(folder: KnowledgeFolder, request: TrialRequest, deps: InboxDeps, storeRequest: (month: string) => Promise<void>): Promise<AcceptResult> {
  const table = request.scene?.context?.length ? deps.sceneCueTable?.(request.scene.project) ?? null : null
  const unknown = table && request.scene?.context ? unknownContextCues(table, request.scene.context) : []
  if (unknown.length) return { ok: false, error: `scene.context names cues the "${request.scene!.project}" cue table does not have: ${unknown.join(', ')}` }
  const state = await folder.trialState(request.id)
  if (state.state === 'complete') return { ok: false, error: `Trial id "${request.id}" already exists; submit under a new id` }
  const now = deps.now()
  // An incomplete trial (Studio stopped mid-import) is re-rendered in place.
  const month = state.state === 'incomplete' ? state.month : monthOf(now)
  const trial: TrialFile = { ...request, receivedAt: localIsoString(now), studioVersion: deps.studioVersion }
  await folder.writeTrial(month, trial)
  const candidates: CandidateFile[] = []
  for (const candidate of trial.candidates) {
    const base = { format: CANDIDATE_FORMAT, trialId: trial.id, id: candidate.id, label: candidate.label, hypothesis: candidate.hypothesis, spec: { source: candidate.source, effects: candidate.effects } } as const
    let record: CandidateFile, wav: Blob | null = null
    try {
      const rendered = await renderCandidate(candidate, folder, deps)
      wav = deps.encodeWav(rendered.data, OUTPUT_RATE)
      record = { ...base, resolved: rendered.resolved, audio: `audio/${candidate.id}.wav`, sampleRate: OUTPUT_RATE,
        ...(rendered.autoNormalizedDb === null ? {} : { autoNormalizedDb: rendered.autoNormalizedDb }),
        features: computeFeatures(rendered.data, OUTPUT_RATE), renderedAt: localIsoString(deps.now()) }
    } catch (e) {
      record = { ...base, features: null, error: e instanceof Error ? e.message : String(e), renderedAt: localIsoString(deps.now()) }
    }
    await folder.writeCandidate(month, record, wav)
    candidates.push(record)
  }
  await storeRequest(month)
  return { ok: true, trialId: trial.id, month, candidates }
}

export async function processInbox(folder: KnowledgeFolder, deps: InboxDeps): Promise<InboxResult> {
  const result: InboxResult = { accepted: [], rejected: [] }
  const now = deps.now()
  for (const { name, file } of await folder.listInbox()) {
    if (now.getTime() - file.lastModified < SETTLE_MS) continue
    const id = name.replace(/\.json$/i, '')
    const parsed = parseTrialRequest(await file.text(), id)
    const accepted = parsed.ok ? await acceptTrial(folder, parsed.trial, deps, month => folder.finishInbox(name, month, id)) : parsed
    if (!accepted.ok) {
      await folder.rejectInbox(name, accepted.error)
      result.rejected.push({ file: name, error: accepted.error })
      continue
    }
    result.accepted.push(accepted.trialId)
  }
  return result
}

/** Direct submission (MCP `submit_trial`): same validation and rendering as the inbox, request.json written from the object. */
export async function submitTrialRequest(folder: KnowledgeFolder, data: unknown, deps: InboxDeps): Promise<AcceptResult> {
  const error = trialRequestError(data)
  if (error) return { ok: false, error }
  const request = data as TrialRequest
  return acceptTrial(folder, request, deps, month => folder.writeRequest(month, request.id, request))
}
