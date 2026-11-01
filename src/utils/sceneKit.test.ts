import { describe, expect, it } from 'vitest'
import { StaleClipGainKeyError } from './sceneCueTable'
import { deviceKitState, kitClipGains, kitStateOf, locateProjectKit, missingClips, parseKitList, readKitFiles, type DeviceKitAnswer } from './sceneKit'
import { effectiveOutput } from '@/stores/scenePlayback'

/** A folder tree as a File System Access directory handle (only what sceneKit reads). */
type Tree = { [name: string]: Tree | string }
function dir(tree: Tree): FileSystemDirectoryHandle {
  const missing = () => new DOMException('missing', 'NotFoundError')
  const handle = (name: string, node: Tree | string) => typeof node === 'string'
    ? { kind: 'file', name, getFile: async () => new File([node], name) } : Object.assign(dir(node), { kind: 'directory', name })
  return {
    kind: 'directory',
    getDirectoryHandle: async (name: string) => { const n = tree[name]; if (n === undefined) throw missing(); if (typeof n === 'string') throw new DOMException('file', 'TypeMismatchError'); return dir(n) },
    getFileHandle: async (name: string) => { const n = tree[name]; if (typeof n !== 'string') throw missing(); return handle(name, n) },
    entries: async function* () { for (const [name, node] of Object.entries(tree)) yield [name, handle(name, node)] },
  } as unknown as FileSystemDirectoryHandle
}
const manifest = (version?: string) => JSON.stringify({ schema_version: '2.0.0', ...(version ? { version } : {}), name: 'sports-kit', events: {} })

describe('the project Kit folder', () => {
  it('kits/<kit>/ with <kit>-manifest.json first, also manifest.json', async () => {
    const root = dir({ kits: { 'sports-kit': { 'sports-kit-manifest.json': manifest('1.0.0') } } })
    expect(await locateProjectKit(root, 'sports-kit', 'haptics/clips')).toEqual({ kit: 'sports-kit', folder: 'kits/sports-kit', manifest: 'sports-kit-manifest.json', version: '1.0.0', clipGains: { fire: {}, clip: {} } })
    const plain = dir({ kits: { 'sports-kit': { 'manifest.json': manifest() } } })
    expect(await locateProjectKit(plain, 'sports-kit', 'haptics/clips')).toEqual({ kit: 'sports-kit', folder: 'kits/sports-kit', manifest: 'manifest.json', version: null, clipGains: { fire: {}, clip: {} } })
  })

  it('else the clip folder\'s parent when it is named after the Kit; none found is null', async () => {
    const root = dir({ assets: { 'sports-kit': { 'stream-clips': {}, 'sports-kit-manifest.json': manifest('2.0.0') } } })
    expect(await locateProjectKit(root, 'sports-kit', 'assets/sports-kit/stream-clips')).toMatchObject({ folder: 'assets/sports-kit', version: '2.0.0' })
    expect(await locateProjectKit(root, 'sports-kit', 'assets/other/stream-clips')).toBeNull()
    expect(await locateProjectKit(dir({ kits: { 'sports-kit': {} } }), 'sports-kit', 'kits/sports-kit/stream-clips')).toBeNull()
    await expect(locateProjectKit(dir({ kits: { 'sports-kit': { 'manifest.json': '{' } } }), 'sports-kit', 'x/y')).rejects.toThrow(/manifest.json/)
  })

  it('the deploy files: the manifest and every WAV under install-clips/ (not stream-clips)', async () => {
    const root = dir({ kits: { k: { 'k-manifest.json': manifest('1'), 'install-clips': { 'a.wav': 'a', sub: { 'b.WAV': 'b' }, 'notes.txt': 'x' }, 'stream-clips': { 'c.wav': 'c' } } } })
    const files = await readKitFiles(root, { kit: 'k', folder: 'kits/k', manifest: 'k-manifest.json', version: '1', clipGains: { fire: {}, clip: {} } })
    expect(files.map(f => f.path)).toEqual(['k-manifest.json', 'install-clips/a.wav', 'install-clips/sub/b.WAV'])
  })

  it('the clip gains per output: FIRE events, CLIP stream_events, the other bucket when only there; absent = 1; another category is not a clip', async () => {
    const m = {
      events: { 'sports-kit.kick': { clip: 'kick.wav', parameters: { clip_gain: 0.3, loop: false } }, 'sports-kit.whistle': { clip: 'w.wav', parameters: { loop: false } }, 'other.kick': { parameters: { clip_gain: 0.9 } } },
      stream_events: { 'sports-kit.kick': { clip: 'kick.wav', parameters: { clip_gain: 0.7 } }, 'sports-kit.crowd': { clip: 'crowd.wav', parameters: { clip_gain: 0.45, loop: true } } },
    }
    const both = { fire: { kick: 0.3, whistle: 1, crowd: 0.45 }, clip: { kick: 0.7, whistle: 1, crowd: 0.45 } }
    expect(kitClipGains(m, 'sports-kit')).toEqual(both)
    expect(kitClipGains({ events: { 'k.a': { parameters: { clip_gain: 3 } } } }, 'k')).toEqual({ fire: { a: 1 }, clip: { a: 1 } })
    const root = dir({ kits: { 'sports-kit': { 'sports-kit-manifest.json': JSON.stringify({ version: '1.0.0', ...m }) } } })
    expect((await locateProjectKit(root, 'sports-kit', 'haptics/clips'))?.clipGains).toEqual(both)
  })

  it('a manifest still carrying parameters.intensity (no clip_gain) is not read: it throws, naming the file and the entries', async () => {
    const m = { events: { 'k.a': { parameters: { intensity: 0.3 } }, 'k.b': { parameters: { clip_gain: 0.4 } }, 'k.c': { parameters: { intensity: 0.2, clip_gain: 0.2 } } },
      stream_events: { 'k.d': { parameters: { intensity: 0.5 } } } }
    expect(() => kitClipGains(m, 'k')).toThrow(StaleClipGainKeyError)
    expect(() => kitClipGains(m, 'k')).toThrow(/events\.k\.a, stream_events\.k\.d/)
    // The entries with clip_gain (with or without the old key besides) read as before.
    expect(kitClipGains({ events: { 'k.b': m.events['k.b'], 'k.c': m.events['k.c'] } }, 'k')).toEqual({ fire: { b: 0.4, c: 0.2 }, clip: { b: 0.4, c: 0.2 } })
    const root = dir({ kits: { k: { 'k-manifest.json': JSON.stringify(m) } } })
    await expect(locateProjectKit(root, 'k', 'x/y')).rejects.toThrow(/kits\/k\/k-manifest\.json.*dec103_rename_local_data\.py/)
  })
})

describe('the Kit on each Hapbeat (kit_list_result)', () => {
  const answer = (o: Partial<DeviceKitAnswer>): DeviceKitAnswer => ({ ip: 'a', installed: true, version: null, events: null, error: null, ...o })

  it('reads whether the Kit is there, its version and its clips', () => {
    expect(parseKitList({ device: '10.0.0.4', kits: [{ kit_id: 'other' }, { kit_id: 'sports-kit', version: '1.0.0', events: ['sports-kit.kick', { name: 'sports-kit.crowd', mode: 'command' }, 'bare'] }] }, 'sports-kit'))
      .toEqual({ ip: '10.0.0.4', installed: true, version: '1.0.0', events: ['kick', 'crowd', 'bare'], error: null })
    expect(parseKitList({ device: '10.0.0.4', kits: [{ kit_id: 'other' }] }, 'sports-kit')).toEqual({ ip: '10.0.0.4', installed: false, version: null, events: null, error: null })
    expect(parseKitList({ kits: [] }, 'sports-kit')).toBeNull()
  })

  it('a device the helper could not ask is unreachable, not "missing"', () => {
    const a = parseKitList({ device: '10.0.0.4', error: 'no response' }, 'sports-kit')
    expect(a).toEqual({ ip: '10.0.0.4', installed: false, version: null, events: null, error: 'no response' })
    expect(deviceKitState(a!, '1.0.0', [])).toBe('unreachable')
  })

  it('compares with the project version (a version missing on either side counts as the same) and the cue table clips', () => {
    expect(deviceKitState(undefined, '1.0.0', [])).toBe('checking')
    expect(deviceKitState(answer({ installed: false }), '1.0.0', [])).toBe('missing')
    expect(deviceKitState(answer({ version: '1.0.0' }), '1.0.0', [])).toBe('installed')
    expect(deviceKitState(answer({ version: '0.9.0' }), '1.0.0', [])).toBe('differs')
    expect(deviceKitState(answer({}), '1.0.0', [])).toBe('installed')
    expect(deviceKitState(answer({ version: '0.9.0' }), null, [])).toBe('installed')
    // A clip of the table the device's Kit lacks: FIRE would leave it silent.
    expect(deviceKitState(answer({ version: '1.0.0', events: ['kick'] }), '1.0.0', ['kick', 'crowd'])).toBe('incomplete')
    expect(missingClips(answer({ events: ['kick'] }), ['kick', 'crowd'])).toEqual(['crowd'])
    expect(deviceKitState(answer({ events: null }), null, ['kick'])).toBe('installed') // not listed: not checked
  })

  it('sums the devices up: missing or lacking clips (or no Kit name) wins, then checking, then unreachable, then another version', () => {
    expect(kitStateOf(null)).toBe('missing')
    expect(kitStateOf([])).toBe('none')
    expect(kitStateOf(['installed', 'checking', 'missing'])).toBe('missing')
    expect(kitStateOf(['installed', 'incomplete'])).toBe('missing')
    expect(kitStateOf(['installed', 'checking', 'differs'])).toBe('checking')
    expect(kitStateOf(['unreachable', 'differs'])).toBe('unreachable')
    expect(kitStateOf(['installed', 'differs'])).toBe('differs')
    expect(kitStateOf(['installed', 'installed'])).toBe('ready')
  })

  it('the runtime plays FIRE only once the Kit is known to be there (else the whole playback streams from the PC)', () => {
    for (const kitState of ['none', 'checking', 'missing'] as const) expect(effectiveOutput({ output: 'fire', kitState })).toBe('clip')
    for (const kitState of ['ready', 'differs', 'unreachable'] as const) expect(effectiveOutput({ output: 'fire', kitState })).toBe('fire')
    expect(effectiveOutput({ output: 'clip', kitState: 'ready' })).toBe('clip')
  })
})
