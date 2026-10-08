import { describe, expect, it } from 'vitest'
import { ACK_TIMEOUT_MS, buildLoopVoices, CHUNK, RETRY_MS, cueVoices, LEAD_MS, matchesAddress, QUIET_END_MS, renderChunk, SceneHapticMixer, tableTargets, targetsOf, WRIST } from './sceneHaptics'
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

  /** The helper's stream_ack checks: a rejected / lost / partial BEGIN re-opens the stream (new stream_id) after the back-off. */
  const begins = (sent: { type: string; payload: Record<string, unknown> }[]) => sent.filter(m => m.type === 'stream_begin').map(m => m.payload.stream_id as string)

  it('an ok ack keeps the stream: no retry, DATA keeps flowing on the same stream_id', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    mixer.onAck({ stream_id: id, status: 'ok', targets: ['10.0.0.2'] }, 1005)
    pump(1000 + ACK_TIMEOUT_MS + RETRY_MS + 10)
    expect(begins(sent)).toEqual([id])
    expect(sent[sent.length - 1]).toEqual({ type: 'stream_data', payload: expect.objectContaining({ stream_id: id }) })
  })

  it('a no_target ack drops the session and BEGINs again with a new stream_id after the back-off', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    mixer.onAck({ stream_id: id, status: 'no_target' }, 1005)
    expect(mixer.streaming).toBe(false)
    const before = sent.length
    pump(1010); pump(1005 + RETRY_MS - 1)
    expect(sent.length).toBe(before) // nothing sent during the back-off (no DATA for a dead session)
    pump(1005 + RETRY_MS)
    const again = begins(sent)
    expect(again).toHaveLength(2); expect(again[1]).not.toBe(id)
  })

  it('an ok ack that defers the device, or leaves it out of targets, is retried too', () => {
    for (const ack of [{ status: 'ok', targets: [], deferred: ['10.0.0.2'] }, { status: 'ok', targets: ['10.0.0.9'] }]) {
      const { sent, mixer, pump } = run()
      pump(1000)
      mixer.onAck({ stream_id: begins(sent)[0], ...ack }, 1000)
      expect(mixer.streaming).toBe(false)
      pump(1000 + RETRY_MS)
      expect(begins(sent)).toHaveLength(2)
    }
  })

  it('a BEGIN without an ack within ACK_TIMEOUT_MS is ended and retried', () => {
    const { sent, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    pump(1000 + ACK_TIMEOUT_MS)
    expect(begins(sent)).toHaveLength(1)
    pump(1000 + ACK_TIMEOUT_MS + 1)
    expect(sent.some(m => m.type === 'stream_end' && m.payload.stream_id === id)).toBe(true)
    pump(1000 + ACK_TIMEOUT_MS + 1 + RETRY_MS)
    expect(begins(sent)).toHaveLength(2)
  })

  it('a no_session ack while the stream plays drops it and BEGINs again after the back-off', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    mixer.onAck({ stream_id: id, status: 'ok', targets: ['10.0.0.2'] }, 1005)
    mixer.onAck({ stream_id: id, status: 'no_session' }, 1100)
    expect(mixer.streaming).toBe(false)
    pump(1100 + RETRY_MS - 1)
    expect(begins(sent)).toHaveLength(1)
    pump(1100 + RETRY_MS)
    expect(begins(sent)).toHaveLength(2)
  })

  it('a no_session ack after the stream ended (stopped, duplicate END) is ignored', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    pump(1000 + QUIET_END_MS + 1, { playing: false })
    expect(mixer.owns(id)).toBe(false)
    mixer.onAck({ stream_id: id, status: 'no_session' }, 1000 + QUIET_END_MS + 2)
    pump(1000 + QUIET_END_MS + 2 + RETRY_MS, { playing: false })
    expect(begins(sent)).toEqual([id])
  })

  it('displaced by another client: drop, then BEGIN again after the back-off', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    const [id] = begins(sent)
    mixer.onAck({ stream_id: id, status: 'ok', targets: ['10.0.0.2'] }, 1005)
    mixer.onDisplaced({ stream_id: id, targets: ['10.0.0.2'], by: 'other-tab', same_client: false }, 1200)
    expect(mixer.streaming).toBe(false)
    const before = sent.length
    pump(1200 + RETRY_MS - 1)
    expect(sent.length).toBe(before)
    pump(1200 + RETRY_MS)
    expect(begins(sent)).toHaveLength(2)
  })

  it('displaced by a stream of this tab: no BEGIN while it is open, BEGIN once it ended', () => {
    const open = new Set(['studio-1'])
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    const mixer = new SceneHapticMixer((type, payload) => sent.push({ type, payload }), () => {}, id => open.has(id))
    const pump = (now: number) => mixer.pump(now, { enabled: true, playing: true, devices: [device], leadMs: 0, pcm: {}, level: () => [0, 1] })
    pump(1000)
    const [id] = begins(sent)
    mixer.onAck({ stream_id: id, status: 'ok', targets: ['10.0.0.2'] }, 1005)
    mixer.onDisplaced({ stream_id: id, targets: ['10.0.0.2'], by: 'studio-1', same_client: true }, 1200)
    expect(mixer.streaming).toBe(false)
    const before = sent.length
    pump(1200 + RETRY_MS); pump(1200 + 5 * RETRY_MS)
    expect(sent.length).toBe(before) // nothing sent while the editor audition holds the device
    open.delete('studio-1')
    pump(1200 + 5 * RETRY_MS + 10)
    expect(begins(sent)).toHaveLength(2)
  })

  it('displacement notices for other streams are ignored', () => {
    const { mixer, pump } = run()
    pump(1000)
    mixer.onDisplaced({ stream_id: 'editor-1', targets: ['10.0.0.2'], by: 'x', same_client: false }, 1005)
    expect(mixer.streaming).toBe(true)
  })

  it('acks of other streams (the editor, another tab) are ignored', () => {
    const { sent, mixer, pump } = run()
    pump(1000)
    mixer.onAck({ stream_id: 'editor-1', status: 'no_target' }, 1005)
    expect(mixer.streaming).toBe(true)
    expect(mixer.owns(begins(sent)[0])).toBe(true); expect(mixer.owns('editor-1')).toBe(false)
  })
})
