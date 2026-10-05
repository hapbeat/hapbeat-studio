import { describe, expect, it, vi } from 'vitest'
import { CompanionSound, type SoundSource } from './companionSound'

const buffer = (duration: number) => ({ duration }) as AudioBuffer

describe('CompanionSound (decided sound under the editor playback)', () => {
  it('a store refresh with the same buffer / volume does not stop the playing sound (the roar cut-off)', () => {
    const stops: string[] = []
    const start = vi.fn((_s: SoundSource, offset: number) => ({ stop: () => stops.push(`stop@${offset}`) }))
    const roar = buffer(7.2), c = new CompanionSound(start)
    c.setSource({ buffer: roar, volume: 0.55 })
    c.play(0)
    // Polls every 2 s rebuild the objects around the same buffer and volume.
    for (let i = 0; i < 5; i++) c.setSource({ buffer: roar, volume: 0.55 })
    expect(stops).toEqual([])
    expect(c.isPlaying).toBe(true)
    // A real change stops it.
    c.setSource({ buffer: roar, volume: 0.3 })
    expect(stops).toEqual(['stop@0'])
    expect(c.isPlaying).toBe(false)
  })

  it('starts from the playback position, not past the end; loops wrap', () => {
    const start = vi.fn((_s: SoundSource, _offset: number) => ({ stop: () => {} }))
    const c = new CompanionSound(start)
    c.setSource({ buffer: buffer(2), volume: 1 })
    c.play(1.5); c.play(3)
    expect(start.mock.calls.map(call => call[1])).toEqual([1.5])
    c.setSource({ buffer: buffer(2), volume: 1, loop: true })
    c.play(5)
    expect(start.mock.calls[start.mock.calls.length - 1][1]).toBe(1)
  })
})
