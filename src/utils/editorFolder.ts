import type { EffectEntry, SampleRate, WaveformClip } from '@/types/waveform'
import { getDefaultParams, EFFECT_LABELS } from '@/types/waveform'

export interface EditorDocument {
  clip: WaveformClip
  effects: EffectEntry[]
  exportAsMono: boolean
}
interface DiskClip {
  id: string; name: string; original: string; working: string
  sourceFileName?: string; sourceGroupId?: string; description?: string
  renderedEffects?: EffectEntry[]
  effects: EffectEntry[]; exportSampleRate: SampleRate; exportAsMono: boolean
}
interface ProjectIndex { version: 1; revision: string; clips: DiskClip[] }
const INDEX = 'project.json'
const PREVIOUS = 'project.previous.json'
const safePath = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]+\.f32$/.test(value)

/** Private lossless float format; no browser resampling on restoration. */
export function encodeEditorBuffer(buffer: AudioBuffer): Blob {
  const bytes = new ArrayBuffer(16 + buffer.length * buffer.numberOfChannels * 4)
  const view = new DataView(bytes)
  view.setUint32(0, 0x48424531)
  view.setUint32(4, buffer.numberOfChannels, true)
  view.setUint32(8, buffer.sampleRate, true)
  view.setUint32(12, buffer.length, true)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) view.setFloat32(16 + (ch * data.length + i) * 4, data[i], true)
  }
  return new Blob([bytes])
}
export function decodeEditorBuffer(bytes: ArrayBuffer): AudioBuffer {
  const view = new DataView(bytes)
  if (bytes.byteLength < 16 || view.getUint32(0) !== 0x48424531) throw new Error('Invalid editor audio')
  const channels = view.getUint32(4, true), sampleRate = view.getUint32(8, true), length = view.getUint32(12, true)
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 192000 || !length || bytes.byteLength !== 16 + channels * length * 4) throw new Error('Invalid editor audio dimensions')
  const buffer = new AudioBuffer({ numberOfChannels: channels, sampleRate, length })
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const sample = view.getFloat32(16 + (ch * length + i) * 4, true)
      if (!Number.isFinite(sample)) throw new Error('Invalid audio sample')
      data[i] = sample
    }
  }
  return buffer
}
function validateEffects(value: unknown): value is EffectEntry[] {
  if (!Array.isArray(value)) return false
  return value.every(e => {
    if (!e || typeof e.id !== 'string' || typeof e.enabled !== 'boolean' || (e.applied !== undefined && typeof e.applied !== 'boolean') || !e.params || !Object.prototype.hasOwnProperty.call(EFFECT_LABELS, e.params.type)) return false
    const defaults = getDefaultParams(e.params.type)
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = e.params[key]
      if (typeof fallback === 'number' && (!Number.isFinite(field) || Math.abs(field) > 1e6)) return false
    }
    const p = e.params
    switch (p.type) {
      case 'trim': case 'cut': return p.start >= 0 && p.end > p.start
      case 'repitch': case 'pitch-shift': return Math.abs(p.semitones) <= 24
      case 'time-stretch': return p.rate >= .25 && p.rate <= 4
      case 'lpf': case 'hpf': case 'bpf': return p.frequency >= 20 && p.frequency <= 20000 && p.Q >= .1 && p.Q <= 20
      case 'noise-gate': return p.thresholdDb >= -80 && p.thresholdDb <= 0 && p.attackMs >= .1 && p.attackMs <= 100 && p.releaseMs >= 1 && p.releaseMs <= 1000
      case 'gain': return p.gainDb >= -60 && p.gainDb <= 20
      case 'normalize': return p.targetPeak > 0 && p.targetPeak <= 1
      case 'fade-in': case 'fade-out': return p.durationMs >= 0 && p.durationMs <= 600000
      case 'mono-convert': return ['average', 'left', 'right'].includes(p.method)
      case 'eq': return Array.isArray(p.bands) && p.bands.every((b: {frequency: number; gain: number; Q: number}) => Number.isFinite(b.frequency) && b.frequency >= 20 && b.frequency <= 20000 && Number.isFinite(b.gain) && Math.abs(b.gain) <= 24 && Number.isFinite(b.Q) && b.Q >= .1 && b.Q <= 20)
      case 'envelope': return Array.isArray(p.points) && p.points.length >= 2 && p.points[0].time === 0 && p.points.at(-1).time === 1 && p.points.every((v: {time: number; value: number}, i: number) => Number.isFinite(v.time) && Number.isFinite(v.value) && v.value >= 0 && v.value <= 1 && (i === 0 || v.time > p.points[i-1].time))
      default: return p.type === 'reverse'
    }
  })
}
export function parseEditorIndex(text: string): ProjectIndex {
  const data = JSON.parse(text)
  if (data?.version !== 1 || typeof data.revision !== 'string' || !Array.isArray(data.clips)) throw new Error('Unsupported or damaged editor project')
  const ids = new Set<string>()
  for (const c of data.clips) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || typeof c.name !== 'string' || (c.sourceFileName !== undefined && typeof c.sourceFileName !== 'string') || (c.sourceGroupId !== undefined && typeof c.sourceGroupId !== 'string') || (c.description !== undefined && typeof c.description !== 'string') || !safePath(c.original) || !safePath(c.working) || ![16000,24000,44100,48000].includes(c.exportSampleRate) || typeof c.exportAsMono !== 'boolean' || !validateEffects(c.effects) || (c.renderedEffects !== undefined && !validateEffects(c.renderedEffects))) throw new Error('Invalid editor project clip')
    ids.add(c.id)
  }
  return data
}
async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text() }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return null; throw error }
}
export async function writeEditorFile(dir: FileSystemDirectoryHandle, name: string, content: Blob | string) {
  const file = await dir.getFileHandle(name, { create: true })
  const stream = await file.createWritable()
  try { await stream.write(content); await stream.close() }
  catch (error) { await stream.abort().catch(() => {}); throw error }
}
export class EditorFolder {
  private buffers = new WeakMap<AudioBuffer, string>()
  private indexText: string | null = null
  private observedText: string | null = null
  recovered = false
  private constructor(readonly root: FileSystemDirectoryHandle) {}
  private directory() { return this.root.getDirectoryHandle('.hapbeat-editor') }
  static async open(root: FileSystemDirectoryHandle): Promise<{ folder: EditorFolder; documents: EditorDocument[] }> {
    const dir = await root.getDirectoryHandle('.hapbeat-editor', { create: true })
    const folder = new EditorFolder(root)
    const raw = await readText(dir, INDEX)
    folder.observedText = raw
    let index: ProjectIndex | null = null
    if (raw !== null) {
      let version: unknown
      try { version = JSON.parse(raw)?.version } catch { /* malformed JSON can recover below */ }
      if (typeof version === 'number' && version !== 1) throw new Error('Unsupported editor project version')
      try { index = parseEditorIndex(raw); folder.indexText = raw }
      catch (error) {
        const previous = await readText(dir, PREVIOUS)
        if (previous === null) throw error
        index = parseEditorIndex(previous); folder.indexText = previous; folder.recovered = true
      }
    } else {
      const previous = await readText(dir, PREVIOUS)
      if (previous !== null) { index = parseEditorIndex(previous); folder.indexText = previous; folder.recovered = true }
    }
    const loaded = new Map<string, AudioBuffer>()
    const load = async (path: string) => {
      let buffer = loaded.get(path)
      if (!buffer) {
        buffer = decodeEditorBuffer(await (await (await dir.getFileHandle(path)).getFile()).arrayBuffer())
        folder.buffers.set(buffer, path); loaded.set(path, buffer)
      }
      return buffer
    }
    const documents: EditorDocument[] = []
    for (const c of index?.clips ?? []) {
      const originalBuffer = await load(c.original), buffer = await load(c.working)
      documents.push({ clip: { id: c.id, name: c.name, sourceFileName: c.sourceFileName, sourceGroupId: c.sourceGroupId, description: c.description, buffer, originalBuffer, exportSampleRate: c.exportSampleRate, renderedEffects: c.renderedEffects }, effects: c.effects, exportAsMono: c.exportAsMono })
    }
    return { folder, documents }
  }
  async save(documents: EditorDocument[]): Promise<void> {
    const save = async () => {
      const disk = await readText(await this.directory(), INDEX)
      if (disk !== this.observedText) throw new Error('Project changed in another tab. Unsaved edits remain in this tab. Reload to open the disk version.')
      const storeBuffer = async (buffer: AudioBuffer) => {
        const existing = this.buffers.get(buffer)
        if (existing) return existing
        const name = `${crypto.randomUUID()}.f32`
        await writeEditorFile(await this.directory(), name, encodeEditorBuffer(buffer))
        this.buffers.set(buffer, name)
        return name
      }
      const clips: DiskClip[] = []
      for (const { clip, effects, exportAsMono } of documents) clips.push({
        id: clip.id, name: clip.name, sourceFileName: clip.sourceFileName, sourceGroupId: clip.sourceGroupId, description: clip.description, original: await storeBuffer(clip.originalBuffer), working: await storeBuffer(clip.buffer), renderedEffects: clip.renderedEffects, effects, exportSampleRate: clip.exportSampleRate, exportAsMono,
      })
      const index: ProjectIndex = { version: 1, revision: crypto.randomUUID(), clips }
      const text = JSON.stringify(index, null, 2)
      parseEditorIndex(text)
      if (this.indexText !== null) await writeEditorFile(await this.directory(), PREVIOUS, this.indexText)
      await writeEditorFile(await this.directory(), INDEX, text)
      this.indexText = text; this.observedText = text
    }
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(`hapbeat-editor:${this.root.name}`, save)
    else throw new Error('Editor saving requires Web Locks (Chrome / Edge on localhost or HTTPS).')
  }
  async keepImport(id: string, file: File) {
    const sources = await (await this.directory()).getDirectoryHandle('imports', { create: true })
    await writeEditorFile(sources, `${id}-${file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`, file)
  }
  async export(name: string, blob: Blob): Promise<string> {
    const dir = await this.root.getDirectoryHandle('exports', { create: true })
    const base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').replace(/\.wav$/i, '') || 'clip'
    return navigator.locks.request(`hapbeat-editor-export:${this.root.name}`, async () => {
      for (let suffix = 0; ; suffix++) {
        const filename = `${base}${suffix ? ` (${suffix + 1})` : ''}.wav`
        try { await dir.getFileHandle(filename); continue }
        catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error }
        await writeEditorFile(dir, filename, blob)
        return filename
      }
    })
  }
}
