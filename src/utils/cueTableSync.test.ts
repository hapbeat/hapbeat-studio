import { describe, expect, it } from 'vitest'
import { CueTableSync, mergeCueTables } from './cueTableSync'
import { serializeCueTable, type CueTable } from './sceneCueTable'
import { sampleTable } from './sceneTestFixtures'

const clone = (t: CueTable) => structuredClone(t)
/** An in-memory cue table file another program can rewrite. */
function file(initial: CueTable) {
  const disk = { text: serializeCueTable(initial), mtime: 1, writes: 0 }
  const io = {
    read: async () => ({ text: disk.text, mtime: disk.mtime }),
    write: async (table: CueTable) => { disk.text = serializeCueTable(table); disk.mtime++; disk.writes++; return disk.mtime },
  }
  return { disk, io, external: (change: (t: CueTable) => void) => { const t = JSON.parse(disk.text) as CueTable; change(t); disk.text = serializeCueTable(t); disk.mtime++ } }
}
const ok = async () => [] as string[]

describe('cue table autosave', () => {
  it('"OK" (review approved) is written at once', async () => {
    const f = file(sampleTable())
    const sync = new CueTableSync(f.io); sync.reset(f.disk.text, f.disk.mtime)
    const ours = clone(sampleTable()); ours.cues.button.review = { sfx: 'approved' }
    const r = await sync.save(ours, {}, ok)
    expect(r.ok && r.external).toBe(false)
    expect(JSON.parse(f.disk.text).cues.button.review).toEqual({ sfx: 'approved' })
  })

  it('keeps changes made outside Studio (another cue, another field) and applies the Studio edits on top', async () => {
    const f = file(sampleTable())
    const sync = new CueTableSync(f.io); sync.reset(f.disk.text, f.disk.mtime)
    // The agent updates a pool and adds a clip entry while Studio approves button's sound.
    f.external(t => { t.cues.detent.haptics = [{ clips: ['thump', 'click'], at: 'pos_chest', gain: 0.5 }]; t.cues.button.sfx = { sounds: ['Click', 'Clack'], volume: 0.6 }; t.clips.extra = { intensity: 1, loop: false } })
    const ours = clone(sampleTable()); ours.cues.button.review = { sfx: 'approved' }
    const r = await sync.save(ours, {}, ok)
    expect(r.ok && r.external).toBe(true)
    const written = JSON.parse(f.disk.text) as CueTable
    expect(written.cues.detent.haptics![0].clips).toEqual(['thump', 'click'])
    expect(written.cues.button.sfx).toEqual({ sounds: ['Click', 'Clack'], volume: 0.6 })
    expect(written.cues.button.review).toEqual({ sfx: 'approved' })
    expect(written.clips.extra).toBeDefined()
    expect(r.ok && r.conflicts).toEqual([])
  })

  it('a field changed on both sides keeps the Studio value and is reported; variants added on either side survive', () => {
    const base = sampleTable()
    const ours = clone(base); ours.cues.button.sfx = { sound: 'Click', volume: 0.9 }; ours.cues.button.variants = { soft: {} }
    const theirs = clone(base); theirs.cues.button.sfx = { sound: 'Click', volume: 0.3 }; theirs.cues.grab.variants = { firm: { review: { haptics: 'approved' } } }
    const { table, conflicts } = mergeCueTables(base, ours, theirs)
    expect(table.cues.button.sfx).toEqual({ sound: 'Click', volume: 0.9 })
    expect(conflicts).toEqual(['cues.button.sfx'])
    expect(Object.keys(table.cues.button.variants!)).toEqual(['soft'])
    expect(table.cues.grab.variants!.firm).toEqual({ review: { haptics: 'approved' } })
    // Studio removing a variant the file did not touch removes it.
    const withVariant = clone(base); withVariant.cues.button.variants = { soft: {} }
    const removed = mergeCueTables(withVariant, clone(base), clone(withVariant))
    expect(removed.table.cues.button.variants).toBeUndefined()
  })

  it('notices a file changed outside Studio (to reload it when Studio has nothing unsaved)', async () => {
    const f = file(sampleTable())
    const sync = new CueTableSync(f.io); sync.reset(f.disk.text, f.disk.mtime)
    expect(await sync.changedOnDisk()).toBeNull()
    f.external(t => { t.cues.grab.sfx = { sound: 'Clack', volume: 1 } })
    expect(await sync.changedOnDisk()).toContain('"grab"')
  })

  it('merges the sounds map per sound (DEC-086 levels)', () => {
    const base = { ...sampleTable(), sounds: { Click: { intensity: 0.5 } } } as CueTable
    const ours = clone(base); ours.sounds!.Click = { intensity: 0.3 }
    const theirs = clone(base); theirs.sounds!.Clack = { intensity: 0.8 }
    const { table, conflicts } = mergeCueTables(base, ours, theirs)
    expect(table.sounds).toEqual({ Click: { intensity: 0.3 }, Clack: { intensity: 0.8 } })
    expect(conflicts).toEqual([])
  })
})
