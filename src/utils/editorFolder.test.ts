import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { encodeEditorBuffer, decodeEditorBuffer, parseEditorIndex, EditorFolder, isProjectName, normalizeProjectName, type EditorDocument } from './editorFolder'
import { cropBuffer, deleteRegion, fadeIn, fadeOut, noiseGate, normalize, applyEnvelope, applyEffect } from './audioDsp'

class TestBuffer {
  numberOfChannels: number; sampleRate: number; length: number; duration: number
  private channels: Float32Array[]
  constructor(options: AudioBufferOptions) {
    this.numberOfChannels = options.numberOfChannels ?? 1; this.sampleRate = options.sampleRate; this.length = options.length
    this.duration = this.length / this.sampleRate
    this.channels = Array.from({length: this.numberOfChannels}, () => new Float32Array(this.length))
  }
  getChannelData(ch: number) { return this.channels[ch] }
  copyToChannel(data: Float32Array, ch: number) { this.channels[ch].set(data) }
}
function buffer(channels: number[][], rate = 16000): AudioBuffer {
  const result = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: rate })
  channels.forEach((values, ch) => result.copyToChannel(Float32Array.from(values), ch))
  return result
}
function directory() {
  const files = new Map<string, Blob>()
  const writes: string[] = []
  let failure: string | null = null
  const handle = {
    name: 'editor-test', getDirectoryHandle: async () => handle,
    getFileHandle: async (name: string, options?: {create?: boolean}) => {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return {
        getFile: async () => files.get(name)!,
        createWritable: async () => {
          let pending: Blob
          return {
            write: async (value: Blob | string) => {
              if (failure === name) throw new Error('Disk full')
              pending = typeof value === 'string' ? new Blob([value]) : value
            },
            close: async () => { files.set(name, pending); writes.push(name) },
            abort: async () => {},
          }
        },
      }
    },
  } as unknown as FileSystemDirectoryHandle
  return { handle, files, writes, fail: (name: string | null) => { failure = name } }
}
function doc(audio: AudioBuffer): EditorDocument {
  return { clip: { id: 'clip-1', name: 'Impact', buffer: audio, originalBuffer: audio, exportSampleRate: 48000 }, effects: [{ id: 'gate-1', enabled: true, params: {type: 'noise-gate', thresholdDb: -40, attackMs: 2, releaseMs: 60} }], exportAsMono: false }
}
beforeEach(() => {
  vi.stubGlobal('AudioBuffer', TestBuffer)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<void>) => callback() } })
})
afterEach(() => vi.unstubAllGlobals())

describe('waveform DSP', () => {
  it('trims stereo exactly, bounds selection, and leaves source intact', () => {
    const source = buffer([[0,1,2,3], [4,5,6,7]])
    expect(Array.from(cropBuffer(source, 1/16000, 3/16000).getChannelData(1))).toEqual([5,6])
    expect(cropBuffer(source, -1, 100).length).toBe(4)
    expect(Array.from(source.getChannelData(0))).toEqual([0,1,2,3])
  })
  it('cuts a middle range and rejects removing the whole buffer', () => {
    const source = buffer([[0,1,2,3]])
    expect(Array.from(deleteRegion(source, 1/16000, 3/16000).getChannelData(0))).toEqual([0,3])
    expect(deleteRegion(source, 0, 10)).toBe(source)
    expect(deleteRegion(source, 3/16000, 1/16000).length).toBe(4)
  })
  it('fade and envelope endpoints reach zero exactly', () => {
    const source = buffer([[1,1,1,1]])
    expect(Array.from(fadeIn(source, 100).getChannelData(0))).toEqual([0, expect.closeTo(1/3), expect.closeTo(2/3), 1])
    expect(fadeOut(source, 100).getChannelData(0)[3]).toBe(0)
    expect(applyEnvelope(source, [{time:0,value:1},{time:1,value:0}]).getChannelData(0)[3]).toBe(0)
  })
  it('noise gate suppresses quiet residuals and preserves stereo ratios', () => {
    const quiet = buffer([Array(100).fill(.001)])
    expect(noiseGate(quiet, -40, 2, 60).getChannelData(0).every(v => v === 0)).toBe(true)
    const source = buffer([Array(1000).fill(.5), Array(1000).fill(.25)])
    const gated = noiseGate(source, -40, 2, 60)
    expect(gated.getChannelData(0)[999]).toBeCloseTo(.5)
    expect(gated.getChannelData(1)[40] / gated.getChannelData(0)[40]).toBeCloseTo(.5)
  })
  it('normalizes global stereo peak without changing relative levels or silence', () => {
    const source = buffer([[.2,-.4],[.1,-.2]])
    const output = normalize(source, .8)
    expect(output.getChannelData(0)[1]).toBeCloseTo(-.8)
    expect(output.getChannelData(1)[1]).toBeCloseTo(-.4)
    expect(normalize(buffer([[0,0]]), .8).getChannelData(0)[0]).toBe(0)
  })
})

describe('editor lossless local project', () => {
  it('preserves source metadata and exports the card name with collision suffixes', async () => {
    const dir = directory(), source = doc(buffer([[.1,.2]])), {folder} = await EditorFolder.open(dir.handle)
    source.clip.name = 'Confirm'; source.clip.sourceFileName = 'original.wav'; source.clip.description = 'Button feedback'; source.clip.sourceGroupId = 'import-identity'
    await folder.save([source])
    const restored = (await EditorFolder.open(dir.handle)).documents[0]
    expect(restored.clip.sourceGroupId).toBe('import-identity')
    expect(restored.clip.name).toBe('Confirm'); expect(restored.clip.sourceFileName).toBe('original.wav'); expect(restored.clip.description).toBe('Button feedback')
    expect(await folder.export(restored.clip.name, new Blob(['first']))).toBe('Confirm.wav')
    expect(await folder.export(restored.clip.name, new Blob(['second']))).toBe('Confirm (2).wav')
    expect(await dir.files.get('Confirm.wav')!.text()).toBe('first')
  })

  it('restores a reversible gain and trim chain and removes gain without losing trim', async () => {
    const dir = directory(), source = doc(buffer([[.1,.2,.3,.4]])), {folder} = await EditorFolder.open(dir.handle)
    source.effects = [
      {id: 'gain', enabled: true, applied: true, params: {type: 'gain', gainDb: -6}},
      {id: 'trim', enabled: true, applied: true, params: {type: 'trim', start: 1/16000, end: 3/16000}},
    ]
    let rendered = source.clip.originalBuffer
    for (const effect of source.effects) rendered = await applyEffect(rendered, effect.params)
    source.clip.buffer = rendered
    source.clip.renderedEffects = source.effects
    await folder.save([source])
    const restored = (await EditorFolder.open(dir.handle)).documents[0]
    expect(restored.effects).toEqual(source.effects)
    expect(restored.clip.renderedEffects).toEqual(source.effects)
    const withoutGain = await applyEffect(restored.clip.originalBuffer, restored.effects[1].params)
    expect(Array.from(withoutGain.getChannelData(0))).toEqual([expect.closeTo(.2),expect.closeTo(.3)])
    expect(Array.from(restored.clip.buffer.getChannelData(0))).toEqual([expect.closeTo(.2 * 10 ** (-6/20)),expect.closeTo(.3 * 10 ** (-6/20))])
    await expect(applyEffect(withoutGain, {type: 'trim', start: 10, end: 11})).rejects.toThrow('Edit range')
  })

  it('roundtrips stereo floats and original rate without clipping', async () => {
    const source = buffer([[.1234567, -1.2],[.9, .3333333]], 44100)
    const result = decodeEditorBuffer(await encodeEditorBuffer(source).arrayBuffer())
    expect(result.sampleRate).toBe(44100)
    expect(result.getChannelData(0)).toEqual(source.getChannelData(0))
    expect(result.getChannelData(1)).toEqual(source.getChannelData(1))
  })
  it('rejects truncated or nonfinite float audio', async () => {
    expect(() => decodeEditorBuffer(new ArrayBuffer(2))).toThrow()
    const encoded = await encodeEditorBuffer(buffer([[NaN]])).arrayBuffer()
    expect(() => decodeEditorBuffer(encoded)).toThrow('Invalid audio sample')
  })
  it('supports more than two minutes without size or duration restrictions', async () => {
    const source = new AudioBuffer({ numberOfChannels: 1, sampleRate: 16000, length: 16000 * 121 })
    const result = decodeEditorBuffer(await encodeEditorBuffer(source).arrayBuffer())
    expect(result.duration).toBe(121)
  })
  it('commits buffers before index, reuses buffers and restores pending settings', async () => {
    const dir = directory(), source = doc(buffer([[.1,.2,.3]]))
    const { folder } = await EditorFolder.open(dir.handle)
    await folder.save([source])
    expect(dir.writes[dir.writes.length-1]).toBe('project.json')
    expect(dir.writes.filter(n => n.endsWith('.f32'))).toHaveLength(1)
    await folder.save([{ ...source, clip: {...source.clip, name: 'Variant'} }])
    expect(dir.writes.filter(n => n.endsWith('.f32'))).toHaveLength(1)
    const restored = await EditorFolder.open(dir.handle)
    expect(restored.documents[0].clip.name).toBe('Variant')
    expect(restored.documents[0].effects).toEqual(source.effects)
    expect(restored.documents[0].clip.buffer.getChannelData(0)).toEqual(source.clip.buffer.getChannelData(0))
  })
  it('preserves the old index after a failed commit and allows retry', async () => {
    const dir = directory(), source = doc(buffer([[.1,.2]])), { folder } = await EditorFolder.open(dir.handle)
    await folder.save([source])
    const old = await dir.files.get('project.json')!.text()
    dir.fail('project.json')
    await expect(folder.save([{...source, clip: {...source.clip, name: 'New'}}])).rejects.toThrow('Disk full')
    expect(await dir.files.get('project.json')!.text()).toBe(old)
    dir.fail(null)
    await folder.save([{...source, clip: {...source.clip, name: 'New'}}])
    expect((await EditorFolder.open(dir.handle)).documents[0].clip.name).toBe('New')
  })
  it('reacquires child directories after writes invalidate their handles', async () => {
    const dir = directory()
    const root = { ...dir.handle, getDirectoryHandle: async () => {
      let valid = true
      return { ...dir.handle, getFileHandle: async (name: string, options?: {create?: boolean}) => {
        if (!valid) throw new DOMException('stale directory', 'InvalidStateError')
        const file = await dir.handle.getFileHandle(name, options)
        return { ...file, createWritable: async () => {
          const writer = await file.createWritable()
          return { ...writer, close: async () => { await writer.close(); valid = false } }
        } }
      } }
    } } as unknown as FileSystemDirectoryHandle
    const {folder} = await EditorFolder.open(root)
    const source = doc(buffer([[1,2]]))
    await folder.save([source])
    await folder.save([{...source, clip: {...source.clip, buffer: buffer([[3]])}}])
    expect((await EditorFolder.open(root)).documents[0].clip.buffer.length).toBe(1)
  })
  it('rejects a stale writer before writing files', async () => {
    const dir = directory(), first = await EditorFolder.open(dir.handle), second = await EditorFolder.open(dir.handle)
    await first.folder.save([doc(buffer([[.2]]))])
    const count = dir.writes.length
    await expect(second.folder.save([])).rejects.toThrow('another tab')
    expect(dir.writes).toHaveLength(count)
  })
  it('recovers a previous index and can save after recovery', async () => {
    const dir = directory(), {folder} = await EditorFolder.open(dir.handle), source = doc(buffer([[.2]]))
    await folder.save([source]); await folder.save([source])
    dir.files.set('project.json', new Blob(['{damaged']))
    const restored = await EditorFolder.open(dir.handle)
    expect(restored.folder.recovered).toBe(true)
    await restored.folder.save(restored.documents)
    expect(parseEditorIndex(await dir.files.get('project.json')!.text()).clips).toHaveLength(1)
  })
  it('never replaces a newer project version with an older backup', async () => {
    const dir = directory(), {folder} = await EditorFolder.open(dir.handle)
    await folder.save([]); await folder.save([])
    dir.files.set('project.json', new Blob([JSON.stringify({version: 2, revision: 'newer', clips: []})]))
    await expect(EditorFolder.open(dir.handle)).rejects.toThrow('Unsupported editor project version')
  })
  it('never turns a damaged project or missing audio into an empty project', async () => {
    const dir = directory()
    dir.files.set('project.json', new Blob(['{}']))
    await expect(EditorFolder.open(dir.handle)).rejects.toThrow()
    dir.files.clear()
    const {folder} = await EditorFolder.open(dir.handle)
    await folder.save([doc(buffer([[1]]))])
    for (const name of dir.files.keys()) if (name.endsWith('.f32')) dir.files.delete(name)
    await expect(EditorFolder.open(dir.handle)).rejects.toThrow('missing')
  })
  it('rejects traversal and invalid effect settings in the index', () => {
    const index = { version: 1, revision: 'r', clips: [{id:'a',name:'a',original:'../bad.f32',working:'x.f32',exportSampleRate:48000,exportAsMono:false,effects:[]}] }
    expect(() => parseEditorIndex(JSON.stringify(index))).toThrow()
    index.clips[0].original = 'good.f32'
    expect(parseEditorIndex(JSON.stringify(index)).version).toBe(1)
    const broken = {...index, clips: [{...index.clips[0], effects: [{id:'x',enabled:true,params:{type:'time-stretch',rate:0}}]}]}
    expect(() => parseEditorIndex(JSON.stringify(broken))).toThrow()
  })
  it('roundtrips the optional project label and loads projects saved without one', async () => {
    const dir = directory(), source = doc(buffer([[.1,.2]])), other = doc(buffer([[.3]])), {folder} = await EditorFolder.open(dir.handle)
    source.clip.project = 'UI sounds'; other.clip.id = 'clip-2'
    await folder.save([source, other])
    const [restored, plain] = (await EditorFolder.open(dir.handle)).documents
    expect(restored.clip.project).toBe('UI sounds')
    expect(plain.clip.project).toBeUndefined()
    const clip = {id:'a',name:'a',original:'good.f32',working:'x.f32',exportSampleRate:48000,exportAsMono:false,effects:[]}
    expect(parseEditorIndex(JSON.stringify({version: 1, revision: 'r', clips: [clip]})).clips[0].project).toBeUndefined()
    for (const bad of ['', ' padded', 'x'.repeat(81), 'tab	here', 3]) expect(() => parseEditorIndex(JSON.stringify({version: 1, revision: 'r', clips: [{...clip, project: bad}]}))).toThrow()
  })
  it('reads, writes and keeps UI settings next to the project without deleting anything', async () => {
    const dir = directory(), {folder} = await EditorFolder.open(dir.handle)
    expect(await folder.readUiSettings()).toBeNull()
    await folder.writeUiSettings('{"format":"hapbeat-editor-ui@1"}')
    expect(await folder.readUiSettings()).toBe('{"format":"hapbeat-editor-ui@1"}')
    const kept = await folder.keepUiSettingsCopy('{broken')
    expect(kept).toMatch(/^ui-settings\.unreadable-.+\.json$/)
    expect(await dir.files.get(kept)!.text()).toBe('{broken')
    expect(dir.files.has('ui-settings.json')).toBe(true)
  })
  it('normalizes typed project names', () => {
    expect(normalizeProjectName('  Game   UI ')).toBe('Game UI')
    expect(normalizeProjectName('   ')).toBeUndefined()
    expect(normalizeProjectName('x'.repeat(100))).toHaveLength(80)
    expect(isProjectName(normalizeProjectName('a	b'))).toBe(true)
  })
  it('accepts optional material provenance fields and rejects malformed ones', () => {
    const clip = {id:'a',name:'a',original:'good.f32',working:'x.f32',exportSampleRate:48000,exportAsMono:false,effects:[]}
    const withProvenance = {...clip, sourceSha256: 'a'.repeat(64), provenance: {kind: 'material', site: 'maou.audio', referrerUrl: null, license: {id: 'CC-BY-4.0', name: 'CC BY 4.0', creditText: null}, needsReview: false}}
    expect(parseEditorIndex(JSON.stringify({version: 1, revision: 'r', clips: [withProvenance]})).clips[0].sourceSha256).toBe('a'.repeat(64))
    expect(() => parseEditorIndex(JSON.stringify({version: 1, revision: 'r', clips: [{...clip, sourceSha256: 'A'.repeat(64)}]}))).toThrow()
    expect(() => parseEditorIndex(JSON.stringify({version: 1, revision: 'r', clips: [{...withProvenance, provenance: {kind: 'material'}}]}))).toThrow()
  })
})
