import { describe, expect, it, vi } from 'vitest'

/** A minimal AudioBuffer (the node test environment has no Web Audio). */
class FakeAudioBuffer {
  readonly numberOfChannels: number; readonly length: number; readonly sampleRate: number; private data: Float32Array[]
  constructor(o: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = o.numberOfChannels; this.length = o.length; this.sampleRate = o.sampleRate
    this.data = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length))
  }
  get duration() { return this.length / this.sampleRate }
  getChannelData(c: number) { return this.data[c] }
}
vi.stubGlobal('AudioBuffer', FakeAudioBuffer)
vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } })

describe('A material opened from the Scene tab is shown as the plain file (EventPreview.plain)', () => {
  it('openEventDefault(key, true) marks it plain; picking it again in the Events panel ends the mode', async () => {
    const { useSceneStore } = await import('@/stores/sceneStore')
    const { useEventStore } = await import('@/stores/eventStore')
    const { openEventDefault, openEventHaptic } = await import('./eventAudio')
    useSceneStore.setState({ table: { clips: { b: { intensity: 1, loop: false } }, sounds: {}, cues: { bite: { sfx: null, haptics: [{ clip: 'b', at: 'hand', gain: 1 }] } } } as never,
      pcm: { b: new Float32Array(1600) } })
    useEventStore.setState({ preview: null })
    openEventDefault('bite', true)
    const shown = useEventStore.getState().preview!
    expect(shown.plain).toBe(true); expect(shown.material).toBe('b'); expect(shown.buffer.duration).toBeCloseTo(0.1)
    // The same material from the Events panel (a row / material click): scene timing again, the same buffer kept.
    openEventHaptic('bite', 'b', 'hand')
    expect(useEventStore.getState().preview!.plain).toBeUndefined(); expect(useEventStore.getState().preview!.buffer).toBe(shown.buffer)
    // From the Scene tab again, then the event row (openEventDefault without plain).
    openEventDefault('bite', true); expect(useEventStore.getState().preview!.plain).toBe(true)
    openEventDefault('bite'); expect(useEventStore.getState().preview!.plain).toBeUndefined()
  })
})
