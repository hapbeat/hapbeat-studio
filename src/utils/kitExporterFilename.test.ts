import { describe, it, expect } from 'vitest'
import { claimOutputFilename } from './kitExporter'

describe('claimOutputFilename', () => {
  it('shares the first WAV when encoded audio is identical', () => {
    const used = new Set<string>()
    const names = new Map<string, string>()

    expect(claimOutputFilename('impact.wav', 'same-hash', used, names))
      .toEqual({ filename: 'impact.wav', shouldWrite: true })
    expect(claimOutputFilename('renamed.wav', 'same-hash', used, names))
      .toEqual({ filename: 'impact.wav', shouldWrite: false })
  })

  it('suffixes only same-name WAVs whose bytes differ', () => {
    const used = new Set<string>()
    const names = new Map<string, string>()

    expect(claimOutputFilename('impact.wav', 'hash-a', used, names))
      .toEqual({ filename: 'impact.wav', shouldWrite: true })
    expect(claimOutputFilename('impact.wav', 'hash-b', used, names))
      .toEqual({ filename: 'impact_2.wav', shouldWrite: true })
  })
})
