import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWaveformStore as store } from './waveformStore'
import { EditorFolder } from '@/utils/editorFolder'
import type { WaveformClip } from '@/types/waveform'
vi.mock('@/utils/audioDsp', () => ({ cropBuffer: vi.fn(), deleteRegion: vi.fn(), applyEffect: vi.fn() }))
import { loadDirectoryHandle, saveDirectoryHandle } from '@/utils/localDirectory'
import { MemoryDirectory } from '@/utils/memoryDirectory.testutil'
vi.mock('@/utils/localDirectory', () => ({loadDirectoryHandle: vi.fn(), saveDirectoryHandle: vi.fn()}))
import { applyEffect, cropBuffer } from '@/utils/audioDsp'
const makeBuffer = (length: number) => ({length, sampleRate: 16000, duration: length / 16000, numberOfChannels: 1}) as AudioBuffer
const makeClip = (id: string): WaveformClip => {
  const audio = makeBuffer(16000)
  return { id, name: id, buffer: audio, originalBuffer: audio, exportSampleRate: 48000 }
}
let initial: ReturnType<typeof store.getState>
beforeEach(() => {
  vi.useFakeTimers()
  initial = store.getInitialState()
  store.setState(initial, true)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })
function seed() {
  const clip = makeClip('first'), second = makeClip('second')
  store.setState({clip, documents: [clip, second].map(c => ({clip: c, effects: [], exportAsMono: false}))})
  return clip
}
describe('editor session state', () => {
  it('keeps repeated extraction and duplication in the original source group', () => {
    const source = seed()
    vi.mocked(cropBuffer).mockReturnValue(makeBuffer(4000))
    store.getState().setSelectedRegion({start: 0, end: .25})
    store.getState().extractSelection()
    expect(store.getState().clip?.sourceGroupId).toBe(source.id)
    store.getState().updateClipInfo(store.getState().clip!.id, {name: 'Renamed cut'})
    store.getState().setSelectedRegion({start: 0, end: .1})
    store.getState().extractSelection()
    expect(store.getState().clip?.sourceGroupId).toBe(source.id)
    store.getState().duplicateClip()
    expect(store.getState().clip?.sourceGroupId).toBe(source.id)
    expect(store.getState().documents[0].clip.id).toBe(source.id)
  })
  it('renames an unselected material without switching clips or losing source metadata', () => {
    seed()
    store.getState().updateClipInfo('second', {name: 'Confirm pulse', description: 'UI feedback'})
    expect(store.getState().clip?.id).toBe('first')
    expect(store.getState().documents[1].clip.name).toBe('Confirm pulse')
    store.getState().selectClip('second')
    expect(store.getState().clip?.description).toBe('UI feedback')
    expect(store.getState().clip?.originalBuffer.length).toBe(16000)
  })

  it('rebuilds from the original when changing or removing an applied effect', async () => {
    const original = seed(), rendered = makeBuffer(16000), changed = makeBuffer(16000)
    store.getState().addEffect('gain'); const id = store.getState().effects[0].id
    vi.mocked(applyEffect).mockResolvedValueOnce(rendered)
    await store.getState().applyEffects()
    store.getState().updateEffect(id, {type: 'gain', gainDb: -12})
    vi.mocked(applyEffect).mockResolvedValueOnce(changed)
    await store.getState().applyEffects()
    expect(applyEffect).toHaveBeenLastCalledWith(original.originalBuffer, {type: 'gain', gainDb: -12})
    expect(store.getState().effects).toHaveLength(1)
    store.getState().removeEffect(id); await store.getState().applyEffects()
    expect(store.getState().clip?.buffer).toBe(original.originalBuffer)
    store.getState().undo()
    expect(store.getState().clip?.buffer).toBe(changed)
    expect(store.getState().effects[0].params).toEqual({type: 'gain', gainDb: -12})
    expect(store.getState().effects[0].applied).toBe(true)
  })
  it('retains trim as a reversible step after the effects that precede it', async () => {
    const original = seed(), filtered = makeBuffer(16000), trimmed = makeBuffer(4000)
    store.getState().addEffect('lpf')
    vi.mocked(applyEffect).mockResolvedValueOnce(filtered)
    await store.getState().applyEffects()
    vi.mocked(applyEffect).mockResolvedValueOnce(filtered).mockResolvedValueOnce(trimmed)
    store.getState().setSelectedRegion({start: .25, end: .5}); store.getState().cropToRegion()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(store.getState().effects.map(e => e.params.type)).toEqual(['lpf','trim'])
    expect(store.getState().clip?.buffer).toBe(trimmed)
    store.getState().removeEffect(store.getState().effects[0].id)
    vi.mocked(applyEffect).mockResolvedValueOnce(trimmed)
    await store.getState().applyEffects()
    expect(applyEffect).toHaveBeenLastCalledWith(original.originalBuffer, {type: 'trim', start: .25, end: .5})
  })

  it('selects and extracts the original beyond the shortened edited duration', () => {
    const source = seed(), extracted = makeBuffer(4000)
    store.getState().replaceBuffer(makeBuffer(4000), 'Trim')
    vi.mocked(cropBuffer).mockReturnValueOnce(extracted)
    store.getState().setSelectedRegion({start: .5, end: .75}, true)
    expect(store.getState().selectedRegion).toEqual({start: .5, end: .75})
    store.getState().extractSelection()
    expect(cropBuffer).toHaveBeenLastCalledWith(source.originalBuffer, .5, .75)
    expect(store.getState().clip?.originalBuffer).toBe(extracted)
    expect(store.getState().documents[0].clip.buffer.length).toBe(4000)
  })
  it('keeps independent edits, settings and undo while switching clips', () => {
    const original = seed(), edited = makeBuffer(8000)
    store.getState().replaceBuffer(edited, 'Trim')
    store.getState().setClipName('Edited first')
    store.getState().addEffect('lpf')
    store.getState().selectClip('second')
    expect(store.getState().effects).toEqual([])
    store.getState().selectClip('first')
    expect(store.getState().clip?.buffer).toBe(edited)
    expect(store.getState().clip?.name).toBe('Edited first')
    expect(store.getState().effects[0].params.type).toBe('lpf')
    store.getState().undo()
    expect(store.getState().clip?.buffer).toBe(original.buffer)
    store.getState().redo()
    expect(store.getState().clip?.buffer).toBe(edited)
  })
  it('extracts a selected range as an independent, automatically selected clip', () => {
    const source = seed(), extracted = makeBuffer(4000)
    vi.mocked(cropBuffer).mockReturnValueOnce(extracted)
    store.getState().setSelectedRegion({start: .25, end: .5})
    store.getState().extractSelection()
    const state = store.getState()
    expect(state.documents).toHaveLength(3)
    expect(state.clip?.id).not.toBe(source.id)
    expect(state.clip?.buffer).toBe(extracted)
    expect(state.clip?.originalBuffer).toBe(extracted)
    expect(state.effects).toEqual([])
    expect(state.documents[0].clip.buffer).toBe(source.buffer)
    expect(state.selectedRegion).toBeNull()
  })
  it('automatically restores the remembered folder only with granted permission', async () => {
    const root = {name: 'SFX', queryPermission: vi.fn().mockResolvedValue('granted'), getDirectoryHandle: vi.fn().mockResolvedValue({})} as unknown as FileSystemDirectoryHandle
    vi.mocked(loadDirectoryHandle).mockResolvedValue(root)
    const clip = makeClip('restored')
    const folder = {root} as EditorFolder
    vi.spyOn(EditorFolder, 'open').mockResolvedValue({folder, documents: [{clip, effects: [], exportAsMono: false}]})
    await store.getState().restoreFolder()
    expect(loadDirectoryHandle).toHaveBeenCalledWith('editordir')
    expect(store.getState().clip?.id).toBe('restored')
    await store.getState().restoreFolder()
    expect(EditorFolder.open).toHaveBeenCalledTimes(1)
  })
  it('retains the remembered name and waits for a gesture when permission expired', async () => {
    const root = {name: 'SFX', queryPermission: vi.fn().mockResolvedValue('prompt'), requestPermission: vi.fn()} as unknown as FileSystemDirectoryHandle
    vi.mocked(loadDirectoryHandle).mockResolvedValue(root)
    const open = vi.spyOn(EditorFolder, 'open')
    await store.getState().restoreFolder()
    expect(store.getState().rememberedFolder?.name).toBe('SFX')
    expect(store.getState().folder).toBeNull()
    expect(root.requestPermission).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
  it('duplicate edits do not modify the comparison source', () => {
    seed()
    store.getState().duplicateClip()
    const copyId = store.getState().clip!.id
    store.getState().replaceBuffer(makeBuffer(4000), 'Edit copy')
    store.getState().selectClip('first')
    expect(store.getState().clip?.buffer.length).toBe(16000)
    store.getState().selectClip(copyId)
    expect(store.getState().clip?.buffer.length).toBe(4000)
  })
  it('blocks clip switching and edits during effect rendering', async () => {
    seed(); store.getState().addEffect('lpf')
    let finish!: (buffer: AudioBuffer) => void
    vi.mocked(applyEffect).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const job = store.getState().applyEffects()
    store.getState().selectClip('second'); store.getState().setClipName('wrong')
    expect(store.getState().clip?.id).toBe('first')
    expect(store.getState().clip?.name).toBe('first')
    const output = makeBuffer(16000)
    finish(output); await job
    expect(store.getState().clip?.buffer).toBe(output)
    expect(store.getState().effects[0].applied).toBe(true)
    expect(store.getState().undoStack).toHaveLength(1)
    await store.getState().applyEffects()
    expect(store.getState().undoStack).toHaveLength(1)
    store.getState().undo()
    expect(store.getState().effects).toEqual([])
  })
  it('keeps the waveform and queue when rendering fails', async () => {
    const clip = seed(); store.getState().addEffect('lpf')
    vi.mocked(applyEffect).mockRejectedValueOnce(new Error('render failed'))
    await store.getState().applyEffects()
    expect(store.getState().clip?.buffer).toBe(clip.buffer)
    expect(store.getState().effects).toHaveLength(1)
    expect(store.getState().error).toBe('render failed')
    expect(store.getState().isProcessing).toBe(false)
  })
  it('serializes saves and does not mark newer edits saved by an old write', async () => {
    seed()
    let finish!: () => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve})).mockResolvedValue(undefined)
    store.setState({ folder: {save} as unknown as EditorFolder })
    const job = store.getState().save()
    await Promise.resolve()
    store.getState().setClipName('Newer edit')
    finish(); await job
    expect(store.getState().saveStatus).toBe('pending')
    await store.getState().save()
    expect(store.getState().saveStatus).toBe('saved')
    expect(save.mock.calls[1][0][0].clip.name).toBe('Newer edit')
  })
  it('failed save remains visibly unsaved', async () => {
    seed()
    store.setState({folder: {save: async () => {throw new Error('disk full')}} as unknown as EditorFolder})
    await expect(store.getState().save()).rejects.toThrow('disk full')
    expect(store.getState().saveStatus).toBe('error')
    expect(store.getState().documents).toHaveLength(2)
  })
})
describe('derived clips', () => {
  it('adds a new clip on the given original with an unapplied effect chain', () => {
    const source = seed()
    store.setState({folder: {save: vi.fn()} as unknown as EditorFolder})
    store.getState().addDerivedClip({name: 'A', description: 'trial:t1/A', originalBuffer: source.originalBuffer, exportSampleRate: 48000, sourceGroupId: source.id}, [{type: 'gain', gainDb: -3}])
    const {clip, effects, documents} = store.getState()
    expect(documents).toHaveLength(3)
    expect(clip).toMatchObject({name: 'A', description: 'trial:t1/A', sourceGroupId: source.id, renderedEffects: []})
    expect(clip?.buffer).toBe(source.originalBuffer)
    expect(effects).toMatchObject([{params: {type: 'gain', gainDb: -3}, enabled: true, applied: false}])
    expect(documents[0].clip).toBe(source)
  })
})
describe('material provenance', () => {
  const sha = 'b'.repeat(64)
  const provenance = {kind: 'material' as const, site: 'maou.audio', referrerUrl: 'https://maou.audio/se/', license: {id: 'CC-BY-4.0', name: 'CC BY 4.0', creditText: '魔王魂'}, needsReview: false}
  it('inherits the source hash and provenance into duplicated, extracted and derived clips', () => {
    const source = {...makeClip('first'), sourceSha256: sha, provenance}
    store.setState({clip: source, documents: [{clip: source, effects: [], exportAsMono: false}], folder: {save: vi.fn()} as unknown as EditorFolder})
    store.getState().duplicateClip()
    expect(store.getState().clip).toMatchObject({sourceSha256: sha, provenance})
    vi.mocked(cropBuffer).mockReturnValueOnce(makeBuffer(4000))
    store.getState().setSelectedRegion({start: 0, end: .25})
    store.getState().extractSelection()
    expect(store.getState().clip).toMatchObject({sourceSha256: sha, provenance})
    store.getState().addDerivedClip({name: 'A', originalBuffer: source.originalBuffer, exportSampleRate: 48000, sourceSha256: sha, provenance}, [])
    expect(store.getState().clip).toMatchObject({sourceSha256: sha, provenance})
  })
  it('applies lookup results only to clips with a matching source hash and skips unchanged results', () => {
    const first = {...makeClip('first'), sourceSha256: sha}, second = makeClip('second')
    store.setState({clip: first, documents: [first, second].map(clip => ({clip, effects: [], exportAsMono: false})), saveStatus: 'saved'})
    store.getState().setProvenance(new Map([[sha, provenance]]))
    expect(store.getState().documents[0].clip.provenance).toEqual(provenance)
    expect(store.getState().clip?.provenance).toEqual(provenance)
    expect(store.getState().documents[1].clip.provenance).toBeUndefined()
    store.setState({saveStatus: 'saved'})
    const documents = store.getState().documents
    store.getState().setProvenance(new Map([[sha, {...provenance}]]))
    expect(store.getState().documents).toBe(documents)
    expect(store.getState().saveStatus).toBe('saved')
  })
})

describe('editor folder confirmation', () => {
  const granted = (dir: MemoryDirectory) => Object.assign(dir, { queryPermission: vi.fn().mockResolvedValue('granted') }) as unknown as FileSystemDirectoryHandle
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const pick = (root: FileSystemDirectoryHandle) => { (window as unknown as {showDirectoryPicker: unknown}).showDirectoryPicker = vi.fn().mockResolvedValue(root) }
  afterEach(() => { delete (window as unknown as {showDirectoryPicker?: unknown}).showDirectoryPicker; vi.mocked(saveDirectoryHandle).mockClear() })

  it('writes nothing in a restored folder without haptic-knowledge/ until the user answers', async () => {
    const dir = new MemoryDirectory('hapbeat-demos')
    vi.mocked(loadDirectoryHandle).mockResolvedValue(granted(dir))
    const restoring = store.getState().restoreFolder()
    await settle()
    expect(store.getState().folderPrompt?.name).toBe('hapbeat-demos')
    expect(dir.dirs.size + dir.files.size).toBe(0)
    expect(store.getState().folder).toBeNull()
    store.getState().folderPrompt!.answer(false)
    await restoring
    expect(dir.dirs.size + dir.files.size).toBe(0)
    expect(store.getState().folder).toBeNull()
    expect(store.getState().folderPrompt).toBeNull()
    expect(saveDirectoryHandle).not.toHaveBeenCalled()
  })

  it('No keeps the previous folder and the remembered handle; nothing is written in the picked folder', async () => {
    const previous = new MemoryDirectory('studio-editor')
    await previous.getDirectoryHandle('haptic-knowledge', { create: true })
    pick(granted(previous))
    await store.getState().openFolder()
    const kept = store.getState().folder
    expect(kept?.root).toBe(previous)
    vi.mocked(saveDirectoryHandle).mockClear()
    const wrong = new MemoryDirectory('UnrealProject')
    pick(granted(wrong))
    const opening = store.getState().openFolder()
    await settle()
    expect(store.getState().folderPrompt?.name).toBe('UnrealProject')
    store.getState().folderPrompt!.answer(false)
    await opening
    expect(wrong.dirs.size + wrong.files.size).toBe(0)
    expect(store.getState().folder).toBe(kept)
    expect(store.getState().rememberedFolder).toBe(previous)
    expect(saveDirectoryHandle).not.toHaveBeenCalled()
  })

  it('Yes opens the folder and creates the editor files', async () => {
    const dir = new MemoryDirectory('new-editor')
    pick(granted(dir))
    const opening = store.getState().openFolder()
    await settle()
    expect(dir.dirs.size).toBe(0)
    store.getState().folderPrompt!.answer(true)
    await opening
    expect(store.getState().folder?.root).toBe(dir)
    expect(dir.dirs.has('.hapbeat-editor')).toBe(true)
    expect(saveDirectoryHandle).toHaveBeenCalledWith(dir, 'editordir')
  })

  it('opens a folder that already has haptic-knowledge/ without asking', async () => {
    const dir = new MemoryDirectory('studio-editor')
    await dir.getDirectoryHandle('haptic-knowledge', { create: true })
    vi.mocked(loadDirectoryHandle).mockResolvedValue(granted(dir))
    await store.getState().restoreFolder()
    expect(store.getState().folderPrompt).toBeNull()
    expect(store.getState().folder?.root).toBe(dir)
  })
})
