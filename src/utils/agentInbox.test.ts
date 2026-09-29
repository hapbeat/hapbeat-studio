import { describe, expect, it } from 'vitest'
import type { CandidateFile, TrialFile } from './agentProtocol'
import { encodePcm16Wav, normalizeOverPeak, processInbox, SETTLE_MS, type InboxDeps } from './agentInbox'
import { KnowledgeFolder } from './hapticKnowledge'
import { MemoryDirectory } from './memoryDirectory.testutil'

/** Minimal AudioBuffer stand-in; the inbox only touches these members through injected deps. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return { numberOfChannels: channels.length, sampleRate, length: channels[0].length, duration: channels[0].length / sampleRate, getChannelData: (ch: number) => channels[ch] } as unknown as AudioBuffer
}
const sine = (n: number, hz: number, rate: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate))
const NOW = new Date('2026-09-29T15:30:00+09:00')

function deps(): InboxDeps & { effects: string[] } {
  const effects: string[] = []
  const clip = fakeBuffer([sine(4800, 100, 48000), sine(4800, 100, 48000)], 48000)
  return {
    effects,
    studioVersion: '0.8.0-test',
    now: () => NOW,
    getClip: (id, use) => id === 'clip-1' ? { buffer: use === 'working' ? fakeBuffer([sine(4800, 200, 48000)], 48000) : clip, name: 'Cloth' } : null,
    decodeAudio: async () => fakeBuffer([sine(1600, 100, 16000)], 16000),
    renderRecipe: () => ({ data: sine(4800, 60, 48000), sampleRate: 48000 }),
    createBuffer: (data, rate) => fakeBuffer([data], rate),
    applyEffect: async (buffer, params) => {
      effects.push(params.type)
      if (params.type !== 'gain') throw new Error(`unsupported in test: ${params.type}`)
      const g = 10 ** (params.gainDb / 20)
      return fakeBuffer([buffer.getChannelData(0).map(v => v * g)], buffer.sampleRate)
    },
    resample: async (buffer, rate) => fakeBuffer([Float32Array.from({ length: Math.round(buffer.length * rate / buffer.sampleRate) }, (_, i) => buffer.getChannelData(0)[Math.floor(i * buffer.sampleRate / rate)])], rate),
    encodeWav: encodePcm16Wav,
  }
}
const recipe = { format: 'hapbeat-recipe@1', sampleRate: 48000, durationSec: 0.1, seed: 1, layers: [{ source: { type: 'sine', freqHz: 60 } }] }
function request(id: string) {
  return JSON.stringify({
    format: 'hapbeat-trial@1', id, intent: 'modify', prompt: 'ゴワゴワに', terms: ['ごわごわ'],
    candidates: [
      { id: 'A', label: 'boost', source: { kind: 'clip', clipId: 'clip-1' }, effects: [{ type: 'gain', gainDb: 12 }] },
      { id: 'B', label: 'working', source: { kind: 'clip', clipId: 'clip-1', use: 'working' }, effects: [] },
      { id: 'C', label: 'file', source: { kind: 'file', path: 'sources/rain.wav' }, effects: [] },
      { id: 'D', label: 'missing', source: { kind: 'clip', clipId: 'nope' }, effects: [] },
      { id: 'E', label: 'recipe', source: { kind: 'recipe', recipe }, effects: [] },
    ],
  })
}

describe('processInbox', () => {
  it('renders candidates, records errors per candidate, and moves the request', async () => {
    const root = new MemoryDirectory('root')
    const folder = await KnowledgeFolder.open(root.asHandle())
    root.put('hapbeat-agent/inbox/t-01.json', request('t-01'))
    root.put('hapbeat-agent/sources/rain.wav', 'RIFF')
    const d = deps()
    const result = await processInbox(folder, d)
    expect(result).toEqual({ accepted: ['t-01'], rejected: [] })
    const base = 'haptic-knowledge/trials/2026-09/t-01'
    expect(root.has('hapbeat-agent/inbox/t-01.json')).toBe(false)
    expect(await root.json(`${base}/request.json`)).toEqual(JSON.parse(request('t-01')))
    const trial = await root.json<TrialFile>(`${base}/trial.json`)
    expect(trial.studioVersion).toBe('0.8.0-test')
    expect(Date.parse(trial.receivedAt)).toBe(NOW.getTime())
    const a = await root.json<CandidateFile>(`${base}/candidates/A.json`)
    expect(a.resolved).toMatchObject({ clipName: 'Cloth', sourceChannels: 2, sourceSampleRate: 48000 })
    expect(a.autoNormalizedDb).toBeLessThan(0)
    expect(a.features!.peakDb).toBeCloseTo(20 * Math.log10(0.98), 1)
    expect(a.audio).toBe('audio/A.wav')
    expect(root.size(`${base}/audio/A.wav`)).toBe(44 + 4800 * 2)
    expect((await root.json<CandidateFile>(`${base}/candidates/B.json`)).features!.dominantHz).toBeCloseTo(200, -1)
    const c = await root.json<CandidateFile>(`${base}/candidates/C.json`)
    expect(c.sampleRate).toBe(48000)
    expect(c.features!.durationSec).toBeCloseTo(0.1, 2)
    const missing = await root.json<CandidateFile>(`${base}/candidates/D.json`)
    expect(missing.error).toMatch(/not in the editor/)
    expect(missing.features).toBeNull()
    expect(root.has(`${base}/audio/D.wav`)).toBe(false)
    expect((await root.json<CandidateFile>(`${base}/candidates/E.json`)).features!.dominantHz).toBeCloseTo(60, -1)
    expect(d.effects).toEqual(['gain'])
  })

  it('rejects invalid and duplicate requests into _rejected with an error file', async () => {
    const root = new MemoryDirectory('root')
    const folder = await KnowledgeFolder.open(root.asHandle())
    root.put('hapbeat-agent/inbox/t-01.json', request('t-01'))
    root.put('hapbeat-agent/sources/rain.wav', 'RIFF')
    await processInbox(folder, deps())
    root.put('hapbeat-agent/inbox/t-01.json', request('t-01'))
    root.put('hapbeat-agent/inbox/bad.json', '{"format":"hapbeat-trial@1"')
    const result = await processInbox(folder, deps())
    expect(result.accepted).toEqual([])
    expect(result.rejected.map(r => r.file).sort()).toEqual(['bad.json', 't-01.json'])
    expect(await root.text('hapbeat-agent/inbox/_rejected/t-01.error.txt')).toMatch(/already exists/)
    expect(await root.text('hapbeat-agent/inbox/_rejected/bad.error.txt')).toMatch(/Invalid JSON/)
    expect(root.has('hapbeat-agent/inbox/bad.json')).toBe(false)
    // A second rejection with the same name never overwrites the first.
    root.put('hapbeat-agent/inbox/bad.json', '[]')
    await processInbox(folder, deps())
    expect(root.has('hapbeat-agent/inbox/_rejected/bad_2.json')).toBe(true)
    expect(await root.text('hapbeat-agent/inbox/_rejected/bad.error.txt')).toMatch(/Invalid JSON/)
  })

  it('waits until a request file has settled', async () => {
    const root = new MemoryDirectory('root')
    const folder = await KnowledgeFolder.open(root.asHandle())
    root.put('hapbeat-agent/inbox/t-02.json', request('t-02'), NOW.getTime() - SETTLE_MS / 2)
    expect(await processInbox(folder, deps())).toEqual({ accepted: [], rejected: [] })
    expect(root.has('hapbeat-agent/inbox/t-02.json')).toBe(true)
  })
})

describe('inbox helpers', () => {
  it('normalizes only when the peak exceeds 1.0 and never mutates input', () => {
    const quiet = Float32Array.from([0.5, -0.5])
    expect(normalizeOverPeak(quiet)).toEqual({ data: quiet, gainDb: null })
    const loud = Float32Array.from([2, -1])
    const { data, gainDb } = normalizeOverPeak(loud)
    expect(data[0]).toBeCloseTo(0.98)
    expect(loud[0]).toBe(2)
    expect(gainDb).toBeCloseTo(-6.19, 1)
  })

  it('writes a 48 kHz mono 16-bit header', async () => {
    const view = new DataView(await encodePcm16Wav(Float32Array.from([1, -1]), 48000).arrayBuffer())
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })
})
