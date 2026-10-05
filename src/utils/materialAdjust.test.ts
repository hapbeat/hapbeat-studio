import { describe, expect, it } from 'vitest'
import { ADJUST_FORMAT, hasMaterialAdjust, readMaterialAdjust, writeMaterialAdjust, writeMaterialOriginal, type MaterialAdjust } from './materialAdjust'
import { MemoryDirectory } from './memoryDirectory.testutil'

describe('material adjust data (versioned, outside .hapbeat-editor)', () => {
  it('keeps the chain and the original under adjust/<project>/<target>/ and reads them back', async () => {
    const root = new MemoryDirectory('editor')
    const data: MaterialAdjust = { format: ADJUST_FORMAT, project: 'trex-encounter', event: 'roar', target: 'sound', wav: 'roar_t50_b',
      effects: [{ id: 'e1', enabled: true, applied: false, params: { type: 'gain', gainDb: -3 } }], exportSampleRate: 48000, updatedAt: '2026-10-05T12:00:00+09:00' }
    expect(await hasMaterialAdjust(root.asHandle(), 'trex-encounter', 'sound', 'roar_t50_b')).toBe(false)
    expect(await readMaterialAdjust(root.asHandle(), 'trex-encounter', 'sound', 'roar_t50_b')).toBeNull()
    await writeMaterialOriginal(root.asHandle(), 'trex-encounter', 'sound', 'roar_t50_b', new TextEncoder().encode('RIFF…').buffer as ArrayBuffer)
    await writeMaterialAdjust(root.asHandle(), data)
    expect(root.has('adjust/trex-encounter/sound/roar_t50_b.json')).toBe(true)
    expect(root.has('adjust/trex-encounter/sound/roar_t50_b.original.wav')).toBe(true)
    expect(root.has('.hapbeat-editor')).toBe(false)
    const back = await readMaterialAdjust(root.asHandle(), 'trex-encounter', 'sound', 'roar_t50_b')
    expect(back?.data).toEqual(data)
    expect(new TextDecoder().decode(back!.original)).toBe('RIFF…')
  })
})
