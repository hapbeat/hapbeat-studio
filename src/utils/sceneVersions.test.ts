import { describe, expect, it } from 'vitest'
import { applyTableGains, archiveVersion, listVersions, localIso, readVersion, versionId, versionSlug, writeVersion, VERSIONS_DIR, ARCHIVED_VERSIONS_DIR } from './sceneVersions'
import { memoryFolder, sampleTable } from './sceneTestFixtures'
import type { CueTable } from './sceneCueTable'

const date = new Date(2026, 10, 6, 23, 44, 5)
const snap = { edits: '{"schema_version":1,"firings":[]}\n', table: '{"cues":{}}\n', tableFile: 'cues.json', firings: 0 }

describe('version names', () => {
  it('local time, then the label\'s ASCII words', () => {
    expect(versionId(date, '')).toBe('20261106-234405')
    expect(versionId(date, 'Mix A / louder!')).toBe('20261106-234405-mix-a-louder')
    expect(versionId(date, '編集前')).toBe('20261106-234405')
    expect(versionSlug('x'.repeat(40))).toHaveLength(32)
    expect(localIso(date)).toMatch(/^2026-11-06T23:44:05\.000[+-]\d\d:\d\d$/)
  })
})

describe('versions in the project folder', () => {
  it('writes, lists newest first, reads back; a taken name gets -2; the same files as the newest are skipped when asked', async () => {
    const folder = memoryFolder({})
    const a = await writeVersion(folder.handle, snap, 'before-edit', 'Before editing', date)
    const b = await writeVersion(folder.handle, { ...snap, edits: null, firings: 0 }, 'manual', '', date)
    expect(a).toBe('20261106-234405-before-editing')
    expect(b).toBe('20261106-234405')
    // Saved later in the same second: still newest (savedAt has milliseconds), its name taken: -2.
    const c = await writeVersion(folder.handle, snap, 'manual', '', new Date(date.getTime() + 500))
    expect(c).toBe('20261106-234405-2')
    expect(JSON.parse(folder.read(`${VERSIONS_DIR}/${a}/version.json`)!)).toMatchObject({ format: 'hapbeat-scene-version@1', label: 'Before editing', reason: 'before-edit', firings: 0 })
    expect(folder.read(`${VERSIONS_DIR}/${a}/cues.json`)).toBe(snap.table)
    expect(folder.exists(`${VERSIONS_DIR}/${b}/viewer-edits.json`)).toBe(false)
    expect((await listVersions(folder.handle)).map(v => v.id)).toEqual([c, a, b])
    expect(await readVersion(folder.handle, b!, 'cues.json')).toMatchObject({ edits: null, table: snap.table, version: { reason: 'manual' } })
    // The newest (c) keeps the same texts: nothing is written.
    expect(await writeVersion(folder.handle, snap, 'before-edit', 'x', new Date(2026, 10, 7), true)).toBeNull()
    expect(await writeVersion(folder.handle, { ...snap, table: '{}\n' }, 'before-edit', 'x', new Date(2026, 10, 7), true)).not.toBeNull()
  })
  it('「消す」 moves the folder to _archive/versions (copied, then the original removed)', async () => {
    const folder = memoryFolder({})
    const id = (await writeVersion(folder.handle, snap, 'manual', '', date))!
    expect(await archiveVersion(folder.handle, id)).toBe(`${ARCHIVED_VERSIONS_DIR}/${id}`)
    expect(folder.read(`${ARCHIVED_VERSIONS_DIR}/${id}/cues.json`)).toBe(snap.table)
    expect(folder.read(`${ARCHIVED_VERSIONS_DIR}/${id}/version.json`)).not.toBeNull()
    expect(await listVersions(folder.handle)).toEqual([])
    // The same name archived again: -2.
    const again = (await writeVersion(folder.handle, snap, 'manual', '', date))!
    expect(await archiveVersion(folder.handle, again)).toBe(`${ARCHIVED_VERSIONS_DIR}/${id}-2`)
  })
})

describe('the strength values of a version\'s cue table', () => {
  it('sets route gains (same number of routes), sfx volumes and variant gains; says what it could not set', () => {
    const current = sampleTable()
    current.cues.button.variants = { hard: { hapticsGain: 1.5 }, soft: { sfxVolume: 0.4 } }
    const source = JSON.parse(JSON.stringify(sampleTable())) as CueTable
    source.cues.button.haptics![0].gain = 0.3
    source.cues.button.sfx!.volume = 0.9
    source.cues.button.variants = { hard: { sfxVolume: 0.2 }, gone: {} }
    source.cues.detent.haptics = [...source.cues.detent.haptics!, { clip: 'click', at: 'hand', gain: 2 }]
    source.cues.removed = { sfx: null, haptics: [] }
    const { table, skipped } = applyTableGains(current, source)
    expect(table.cues.button.haptics![0].gain).toBe(0.3)
    expect(table.cues.button.sfx!.volume).toBe(0.9)
    expect(table.cues.button.variants!.hard).toEqual({ sfxVolume: 0.2 })
    expect(table.cues.button.variants!.soft).toEqual({ sfxVolume: 0.4 })
    expect(table.cues.detent.haptics![0].gain).toBe(0.5)
    expect(skipped.sort()).toEqual(['button:gone', 'detent', 'removed'])
    expect(current.cues.button.haptics![0].gain).toBe(1)
    expect(applyTableGains(current, current).table).toBe(current)
  })
})
