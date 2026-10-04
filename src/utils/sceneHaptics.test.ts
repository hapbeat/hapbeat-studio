import { describe, expect, it } from 'vitest'
import { buildLoopVoices, CHUNK, cueVoices, LEAD_MS, matchesAddress, QUIET_END_MS, renderChunk, SceneHapticMixer, tableTargets, targetsOf, WRIST } from './sceneHaptics'
import { sampleLib, sampleTable } from './sceneTestFixtures'

const ones = (n: number) => new Float32Array(n).fill(0.5)

describe('scene haptic routing', () => {
  it('matches device addresses by segment with * wildcards', () => {
    expect(matchesAddress('*/pos_l_wrist', 'player_1/pos_l_wrist')).toBe(true)
    expect(matchesAddress('*/pos_l_wrist', 'player_1/pos_l_wrist/group_1')).toBe(true)
    expect(matchesAddress('*/pos_l_wrist', 'player_1/pos_r_wrist')).toBe(false)
    expect(matchesAddress('*/pos_neck', 'pos_neck')).toBe(false)
  })

  it('resolves route positions to wrist / body targets', () => {
    expect(targetsOf('hand', 'left')).toEqual([WRIST.left])
    expect(targetsOf('hand', 'both')).toEqual([WRIST.left, WRIST.right])
    expect(targetsOf('both')).toEqual([WRIST.left, WRIST.right])
    expect(targetsOf('pos_chest')).toEqual(['*/pos_chest'])
    expect(tableTargets(sampleTable()).sort()).toEqual(['*/pos_chest', WRIST.left, WRIST.right].sort())
  })

  it('builds one-shot voices with clip intensity × route gain × cue gain', () => {
    const pcm = { click: ones(10), thump: ones(10), hum: ones(10) }
    const v = cueVoices(sampleTable(), pcm, { name: 'detent', hand: 'right', gain: 0.5 }, 100)
    expect(v).toHaveLength(1)
    expect(v[0].gain).toBeCloseTo(0.5 * 0.5 * 0.5)
    expect(v[0].targets).toEqual(['*/pos_chest'])
    expect(cueVoices(sampleTable(), pcm, { name: 'feed_loop', hand: 'right' }, 0)).toEqual([]) // loop clips are layer-driven
  })

  it('builds one loop voice per hand for hand routes', () => {
    const v = buildLoopVoices(sampleTable(), sampleLib())
    expect(v.map(x => [x.targets[0], x.side, x.gain])).toEqual([[WRIST.left, 0, 0.8], [WRIST.right, 1, 0.8]])
  })
})

describe('scene per-device mix', () => {
  const pcm = { click: ones(CHUNK * 2), hum: ones(4) }

  it('mixes only the voices whose targets match the device', () => {
    const voices = [{ pcm: pcm.click, targets: [WRIST.left], gain: 1, start: 0 }, { pcm: pcm.click, targets: ['*/pos_chest'], gain: 1, start: 0 }]
    const left = renderChunk({ ip: 'a', address: 'p1/pos_l_wrist', wall: 0, voices, loopVoices: [], clock: null, pcm, level: () => [0, 1] })
    expect(left[0]).toBe(Math.round(0.5 * 32767))
    expect(left[1]).toBe(left[0])
    const neck = renderChunk({ ip: 'b', address: 'p1/pos_neck', wall: 0, voices, loopVoices: [], clock: null, pcm, level: () => [0, 1] })
    expect(neck.every(s => s === 0)).toBe(true)
  })

  it('scales loop voices by the recorded level only while the clock runs', () => {
    const loopVoices = buildLoopVoices(sampleTable(), sampleLib())
    const opts = { ip: 'a', address: 'p1/pos_r_wrist', wall: 0, voices: [], loopVoices, pcm, level: () => [1, 1] as [number, number] }
    expect(renderChunk({ ...opts, clock: null }).every(s => s === 0)).toBe(true)
    const out = renderChunk({ ...opts, clock: { t: 0, rate: 1, wall: 0 } })
    expect(out[0]).toBe(Math.round(0.5 * 0.8 * 32767))
    expect(loopVoices[1].phase.a).toBe(CHUNK % 4)
  })

  it('clips the sum to PCM16', () => {
    const voices = [0, 1, 2].map(() => ({ pcm: ones(CHUNK), targets: [WRIST.left], gain: 1, start: 0 }))
    expect(renderChunk({ ip: 'a', address: 'x/pos_l_wrist', wall: 0, voices, loopVoices: [], clock: null, pcm, level: () => [0, 1] })[0]).toBe(32767)
  })
})

describe('scene haptic streams', () => {
  const device = { ipAddress: '10.0.0.2', address: 'p1/pos_l_wrist', name: 'left' }
  const run = () => {
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    const mixer = new SceneHapticMixer((type, payload) => sent.push({ type, payload }))
    const pump = (now: number, o: Partial<Parameters<SceneHapticMixer['pump']>[1]> = {}) =>
      mixer.pump(now, { enabled: true, playing: true, devices: [device], leadMs: 0, pcm: {}, level: () => [0, 1], ...o })
    return { sent, mixer, pump }
  }

  it('opens one 16 kHz stereo stream per device and feeds it ahead of the clock', () => {
    const { sent, pump } = run()
    pump(1000)
    expect(sent[0]).toEqual({ type: 'stream_begin', payload: expect.objectContaining({ targets: ['10.0.0.2'], target: 'p1/pos_l_wrist', sample_rate: 16000, channels: 2, format: 'pcm16' }) })
    const data = sent.filter(m => m.type === 'stream_data')
    expect(data.length).toBe(Math.ceil(LEAD_MS / (CHUNK / 16)))
    expect(data.map(m => m.payload.offset)).toEqual(data.map((_, i) => i * CHUNK * 4))
  })

  it('sends nothing while disabled and closes streams after a quiet while', () => {
    const { sent, pump } = run()
    pump(1000, { enabled: false })
    expect(sent).toEqual([])
    pump(1000)
    pump(1000 + QUIET_END_MS + 1, { playing: false })
    expect(sent[sent.length - 1]?.type).toBe('stream_end')
  })

  it('ends a device stream when the device leaves the selection', () => {
    const { sent, pump } = run()
    pump(1000)
    pump(1010, { devices: [] })
    expect(sent[sent.length - 1]).toEqual({ type: 'stream_end', payload: expect.objectContaining({ targets: ['10.0.0.2'] }) })
  })
})
