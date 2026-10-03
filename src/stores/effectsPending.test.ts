import { describe, expect, it } from 'vitest'
import type { EffectEntry, WaveformClip } from '@/types/waveform'
import { effectsPending } from './waveformStore'

const original = {} as AudioBuffer, rendered = {} as AudioBuffer
const clip = (buffer: AudioBuffer): WaveformClip => ({ id: 'c', name: 'c', buffer, originalBuffer: original, exportSampleRate: 48000 })
const gain = (applied: boolean): EffectEntry => ({ id: 'e', enabled: true, applied, params: { type: 'gain', gainDb: -3 } })

describe('effectsPending', () => {
  it('flags a chain that has not been rendered into the clip (e.g. an adopted AI candidate)', () => {
    expect(effectsPending(clip(original), [gain(false)])).toBe(true)
    expect(effectsPending(clip(rendered), [gain(true)])).toBe(false)
  })
  it('flags a rendered buffer whose effects were all removed', () => {
    expect(effectsPending(clip(rendered), [])).toBe(true)
    expect(effectsPending(clip(original), [])).toBe(false)
    expect(effectsPending(null, [gain(false)])).toBe(false)
  })
})
