import { describe, expect, it } from 'vitest'
import { applyOverrides, overridesFromMessages, readOutboxMessages, readOverrides, removeOverride, resolvedOverrides, setOverride, writeOverrides, type SceneOverride } from './sceneOverrides'
import { buildItems, type SceneData } from './sceneData'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { writeEditorFile } from './editorFolder'

const data = (): SceneData => ({
  fps: 30,
  full: { file: 'full.mp4', levels: [], events: [{ t: 17.367, name: 'footstep', hand: 'both' }, { t: 22.533, name: 'footstep', hand: 'both' }, { t: 48.4, name: 'footstep', hand: 'both' }] },
  clips: [{ file: '07.mp4', name: 'footstep', names: ['footstep'], hand: 'both', at: 22.533, note: '', event: 1, levels: [] }],
})
const subtle = (atSec: number): SceneOverride => ({ from: 'footstep', atSec, to: 'footstep:subtle', requestedAt: '2026-10-06T12:00:00+09:00' })

describe('scene overrides (firings changed until the scene is re-recorded)', () => {
  it('rename the changed firings and the clips cut for them, keeping the recorded name', () => {
    const d = applyOverrides(data(), [subtle(22.533), subtle(48.4)])
    expect(d.full.events.map(e => e.name)).toEqual(['footstep', 'footstep:subtle', 'footstep:subtle'])
    expect(d.full.events[1]).toMatchObject({ from: 'footstep' })
    expect(buildItems(d)[1]).toMatchObject({ name: 'footstep:subtle', names: ['footstep:subtle'], from: 'footstep' })
    expect(applyOverrides(data(), [])).toEqual(data())
    // Set replaces the same firing; to = from or remove drops it.
    let list = setOverride([subtle(22.533)], { ...subtle(22.533), to: 'footstep:other' })
    expect(list).toEqual([{ ...subtle(22.533), to: 'footstep:other' }])
    list = removeOverride(list, 'footstep', 22.533)
    expect(list).toEqual([])
  })

  it('drop themselves once the re-recording has the new event there', () => {
    const rerecorded = data(); rerecorded.full.events[1] = { t: 22.54, name: 'footstep:subtle', hand: 'both' }
    expect(resolvedOverrides(rerecorded, [subtle(22.533), subtle(48.4)])).toEqual([subtle(22.533)])
  })

  it('start from the requests already sent (outbox and _read), per project, and round-trip the file', async () => {
    const root = new MemoryDirectory('folder')
    const outbox = await (await root.getDirectoryHandle('hapbeat-agent', { create: true })).getDirectoryHandle('outbox', { create: true })
    const read = await outbox.getDirectoryHandle('_read', { create: true })
    const msg = (atSec: number, project = 'trex-encounter') => JSON.stringify({ format: 'hapbeat-agent-message@1', createdAt: '2026-10-06T12:00:00+09:00', project, text: '', reassign: { cue: 'footstep', atSec, to: 'footstep:subtle' } })
    await writeEditorFile(read as unknown as FileSystemDirectoryHandle, 'a.json', msg(22.533))
    await writeEditorFile(read as unknown as FileSystemDirectoryHandle, 'b.json', msg(48.4))
    await writeEditorFile(outbox as unknown as FileSystemDirectoryHandle, 'c.json', msg(5, 'other'))
    const messages = await readOutboxMessages(root as unknown as FileSystemDirectoryHandle)
    expect(overridesFromMessages(messages, 'trex-encounter').map(o => o.atSec).sort()).toEqual([22.533, 48.4])
    expect(await readOverrides(root as unknown as FileSystemDirectoryHandle, 'trex-encounter')).toBeNull()
    await writeOverrides(root as unknown as FileSystemDirectoryHandle, 'trex-encounter', [subtle(48.4), subtle(22.533)])
    expect(await readOverrides(root as unknown as FileSystemDirectoryHandle, 'trex-encounter')).toEqual([subtle(22.533), subtle(48.4)])
  })
})
