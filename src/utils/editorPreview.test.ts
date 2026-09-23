import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorPreviewRenderer } from './editorPreview'
import type { EffectEntry } from '@/types/waveform'
const entry = (gainDb: number): EffectEntry => ({id: 'gain', enabled: true, params: {type: 'gain', gainDb}})
const tick = async () => {for (let i = 0; i < 12; i++) await Promise.resolve()}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers())
describe('non-committing effect preview', () => {
  it('always processes the original and bypasses a disabled effect', async () => {
    const original = {} as AudioBuffer, rendered = {} as AudioBuffer, ready = vi.fn(), failed = vi.fn()
    const apply = vi.fn().mockResolvedValue(rendered), renderer = new EditorPreviewRenderer(apply)
    renderer.request(original, [entry(-6)], ready, failed); await vi.advanceTimersByTimeAsync(150)
    expect(ready).toHaveBeenLastCalledWith(rendered)
    renderer.request(original, [entry(-12)], ready, failed); await vi.advanceTimersByTimeAsync(150)
    expect(apply).toHaveBeenLastCalledWith(original, {type: 'gain', gainDb: -12})
    renderer.request(original, [{...entry(-12), enabled: false}], ready, failed); await vi.advanceTimersByTimeAsync(150)
    expect(ready).toHaveBeenLastCalledWith(original); expect(apply).toHaveBeenCalledTimes(2)
  })
  it('discards obsolete renders and serializes newer parameter changes', async () => {
    const original = {} as AudioBuffer, stale = {} as AudioBuffer, fresh = {} as AudioBuffer, ready = vi.fn()
    let finish!: (buffer: AudioBuffer) => void
    const apply = vi.fn().mockImplementationOnce(() => new Promise<AudioBuffer>(resolve => {finish = resolve})).mockResolvedValue(fresh)
    const renderer = new EditorPreviewRenderer(apply)
    renderer.request(original, [entry(-6)], ready, vi.fn()); await vi.advanceTimersByTimeAsync(150)
    renderer.request(original, [entry(-12)], ready, vi.fn()); await vi.advanceTimersByTimeAsync(150)
    expect(apply).toHaveBeenCalledTimes(1)
    finish(stale); await tick()
    expect(ready).toHaveBeenCalledOnce(); expect(ready).toHaveBeenLastCalledWith(fresh)
  })
  it('cancels a pending preview and reports render failure without publishing a buffer', async () => {
    const ready = vi.fn(), failed = vi.fn(), renderer = new EditorPreviewRenderer(vi.fn().mockRejectedValue(new Error('failed')))
    renderer.request({} as AudioBuffer, [entry(1)], ready, failed); renderer.cancel(); await vi.advanceTimersByTimeAsync(150)
    expect(ready).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled()
    renderer.request({} as AudioBuffer, [entry(1)], ready, failed); await vi.advanceTimersByTimeAsync(150)
    expect(failed).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled()
  })
})
