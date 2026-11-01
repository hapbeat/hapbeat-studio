import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kitEventId, LOOP_RESEND_MS, SceneKitFire, TEST_LOOP_MS } from './sceneKitFire'
import { isQuietSceneFireAck, QUIET_FIRE_ACK_MS } from './sceneFireAcks'
import { buildLoopVoices, WRIST, type HapticDevice, type LoopVoice } from './sceneHaptics'
import type { CueTable } from './sceneCueTable'
import type { Shot } from './cueEvents'
import { sampleLib } from './sceneTestFixtures'

const table = { kit: 'sports-kit', clips: { kick: { clip_gain: 0.5, loop: false }, crowd: { clip_gain: 0.8, loop: true } }, sounds: {},
  cues: { kick: { sfx: null, haptics: [{ clip: 'kick', at: 'both', gain: 1 }] } } } as unknown as CueTable
const devices: HapticDevice[] = [{ ipAddress: '10.0.0.2', address: 'p1/pos_l_wrist' }, { ipAddress: '10.0.0.3', address: 'p1/pos_r_wrist' }, { ipAddress: '10.0.0.4', address: 'p1/pos_chest' }]
const shot = (routes: Shot['routes'], rate = 1): Shot => ({ sound: null, soundGain: 0, pitchSt: 0, jitterDb: 0, rate, routes })
const chest = (delayMs = 0, offsetMs = 0) => ({ table, shot: shot([{ clip: 'kick', at: 'pos_chest', gain: 1 }]), hand: 'right', cueGain: 1, delayMs, offsetMs, devices, all: false })

let now = 1000
let sent: { type: string; payload: Record<string, unknown> }[] = []
let logs: string[] = []
const make = () => new SceneKitFire({ send: (type, payload) => sent.push({ type, payload }), now: () => now, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>), log: t => logs.push(t) })
/** Advances the fake timers and the FIRE clock together. */
const advance = (ms: number) => { now += ms; vi.advanceTimersByTime(ms) }

beforeEach(() => { vi.useFakeTimers(); now = 1000; sent = []; logs = [] })
afterEach(() => vi.useRealTimers())

describe('FIRE one-shots: PLAY by Event ID through the helper', () => {
  it('sends <kit>.<clip> at clip_gain × route gain × cue gain, clamped, unicast per wrist target', () => {
    const fire = make()
    fire.shot({ table, shot: shot([{ clip: 'kick', at: 'both', gain: 1.5 }]), hand: 'right', cueGain: 0.8, delayMs: 0, offsetMs: 0, devices, all: false })
    expect(sent).toEqual([]) // scheduled, not sent inline
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([
      { type: 'play_event', payload: { event_id: 'sports-kit.kick', target: WRIST.left, gain: 0.5 * 1.5 * 0.8, targets: ['10.0.0.2'] } },
      { type: 'play_event', payload: { event_id: 'sports-kit.kick', target: WRIST.right, gain: 0.5 * 1.5 * 0.8, targets: ['10.0.0.3'] } },
    ])
    sent = []
    fire.shot({ ...chest(), shot: shot([{ clip: 'kick', at: 'pos_chest', gain: 4 }]) })
    vi.advanceTimersByTime(0)
    expect(sent.map(m => m.payload.gain)).toEqual([1]) // clamped
    expect(kitEventId('k', 'c')).toBe('k.c')
  })

  it('sent = clamp(clip_gain × app_gain, 0, 1), with the Kit\'s clip_gain in a project with a Kit (DEC-103)', () => {
    const fire = make()
    // clip_gain from the Kit (kick 0.5 in the cue table copy; the Kit's value is used) × route gain × cue gain.
    const send = (kit: Record<string, number> | null, routeGain: number, cueGain: number, clips = table.clips) => {
      sent = []
      fire.shot({ ...chest(), table: { ...table, clips } as CueTable, kit, shot: shot([{ clip: 'kick', at: 'pos_chest', gain: routeGain }]), cueGain })
      vi.advanceTimersByTime(0)
      return sent[0]?.payload.gain
    }
    expect(send({ kick: 0.5 }, 1, 1)).toBeCloseTo(0.5)
    expect(send({ kick: 0.5 }, 2, 1)).toBeCloseTo(1)
    expect(send({ kick: 0.8 }, 2, 1)).toBe(1) // clamped
    expect(send({ kick: 0.5 }, 0, 1)).toBe(0)
    expect(send({ kick: 0.8 }, 1.5, 0.5)).toBeCloseTo(0.6) // route gain 1.5 × cue gain 0.5 × clip_gain 0.8
    expect(send({ kick: 0.25 }, 1, 1)).toBeCloseTo(0.25) // the Kit wins over the copy (0.5)
    expect(send({ other: 0.1 }, 1, 1)).toBeCloseTo(0.5) // a clip the Kit lacks: the cue table's
    // clip_gain unknown (no Kit, the cue table entry without one) × 1.5: 1 × 1.5, clamped.
    expect(send(null, 1.5, 1, { kick: { loop: false } } as unknown as CueTable['clips'])).toBe(1)
    // The ▶ test too.
    sent = []
    fire.test({ table, kit: { kick: 0.3 }, clip: 'kick', at: 'pos_chest', gain: 2, devices, all: false })
    expect(sent[0].payload.gain).toBeCloseTo(0.6)
  })

  it('a hand route goes to the acting wrist; no matching device: nothing sent (never broadcast); loop clips are skipped', () => {
    const fire = make()
    fire.shot({ ...chest(), shot: shot([{ clip: 'kick', at: 'hand', gain: 1 }, { clip: 'crowd', at: 'both', gain: 1 }]), hand: 'left' })
    vi.advanceTimersByTime(0)
    expect(sent.map(m => [m.payload.target, m.payload.targets])).toEqual([[WRIST.left, ['10.0.0.2']]])
    sent = []
    fire.shot({ ...chest(), shot: shot([{ clip: 'kick', at: 'pos_neck', gain: 1 }]) })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([])
  })

  it('all devices: one PLAY with target "" to every device', () => {
    const fire = make()
    fire.shot({ ...chest(), shot: shot([{ clip: 'kick', at: 'both', gain: 1 }]), all: true })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual([{ type: 'play_event', payload: { event_id: 'sports-kit.kick', target: '', gain: 0.5, targets: ['10.0.0.2', '10.0.0.3', '10.0.0.4'] } }])
  })

  it('sends at the cue delay + the FIRE offset from now (at once when negative)', () => {
    const fire = make()
    fire.shot(chest(100, 20))
    vi.advanceTimersByTime(119); expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(1); expect(sent).toHaveLength(1)
    fire.shot(chest(30, -80))
    vi.advanceTimersByTime(0); expect(sent).toHaveLength(2)
  })

  it('logs once that the haptic rate cannot be applied, and once that a table without kit sends nothing', () => {
    const fire = make()
    for (let i = 0; i < 3; i++) fire.shot({ ...chest(), shot: shot([{ clip: 'kick', at: 'pos_chest', gain: 1 }], 1.1) })
    const noKit = { ...table, kit: undefined } as CueTable
    for (let i = 0; i < 2; i++) fire.shot({ ...chest(), table: noKit })
    vi.advanceTimersByTime(0)
    expect(logs).toHaveLength(2); expect(sent).toHaveLength(3)
  })
})

describe('FIRE flush (seek, loop jump, pause) and stopAll (output switch, haptics off, stop)', () => {
  it('flush cancels the PLAYs whose cue is still ahead but lets a passed cue (held back by the offset) play; no STOP_ALL', () => {
    const fire = make()
    fire.shot(chest(100, 200)) // cue in 100 ms, sent in 300 ms
    fire.shot(chest(150))
    advance(120) // the first cue has passed, its PLAY waits for the offset
    fire.flush(true)
    advance(500)
    expect(sent.map(m => m.type)).toEqual(['play_event'])
  })

  it('stopAll cancels every scheduled PLAY and sends one STOP_ALL to the devices played and the current ones', () => {
    const fire = make()
    fire.shot(chest())
    fire.shot(chest(100))
    vi.advanceTimersByTime(10)
    fire.stopAll(true, devices.slice(0, 1))
    vi.advanceTimersByTime(500)
    expect(sent.map(m => m.type)).toEqual(['play_event', 'stop_event'])
    expect(sent[1].payload).toEqual({ target: '', targets: ['10.0.0.4', '10.0.0.2'] })
    // Nothing since: nothing to stop.
    fire.stopAll(true, devices); expect(sent).toHaveLength(2)
    fire.shot(chest(100)); fire.stopAll(true, devices); vi.advanceTimersByTime(500); expect(sent).toHaveLength(2)
  })

  it('with the helper offline the STOP_ALL is owed, and sent to the played device once it is back (even with no device listed)', () => {
    const fire = make()
    fire.shot(chest()); vi.advanceTimersByTime(0); sent = []
    fire.stopAll(false, []); expect(sent).toEqual([])
    fire.stopAll(true, []); expect(sent).toEqual([{ type: 'stop_event', payload: { target: '', targets: ['10.0.0.4'] } }])
  })
})

describe('FIRE loops follow the recorded level', () => {
  const loopTable = { kit: 'mill-kit', clips: { feed_loop: { clip_gain: 0.8, loop: true }, crowd: { clip_gain: 1, loop: true } }, sounds: {},
    cues: { feed_loop: { loop: true, sfx: null, haptics: [{ clip: 'feed_loop', at: 'both', gain: 1 }] } } } as unknown as CueTable
  const voices: LoopVoice[] = buildLoopVoices(loopTable, sampleLib())
  const run = (fire: SceneKitFire, level: number, vs = voices, ds = devices) => fire.loopTick({ table: loopTable, voices: vs, t: 1, level: () => [level, 1], devices: ds })

  it('starts on the rising edge, re-sends on a ≥ 1.5 dB change at most every 250 ms, stops at 0', () => {
    const fire = make()
    run(fire, 0); expect(sent).toEqual([])
    run(fire, 0.5)
    expect(sent).toEqual([
      { type: 'play_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.left, gain: 0.4, targets: ['10.0.0.2'] } },
      { type: 'play_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.right, gain: 0.4, targets: ['10.0.0.3'] } },
    ])
    sent = []
    now += LOOP_RESEND_MS; run(fire, 0.52); expect(sent).toEqual([]) // +0.34 dB: kept
    run(fire, 0.7); expect(sent).toHaveLength(2) // +2.9 dB, 250 ms since the last send
    sent = []
    now += 100; run(fire, 1); expect(sent).toEqual([]) // rate limited
    now += 150; run(fire, 1); expect(sent.map(m => m.payload.gain)).toEqual([0.8, 0.8])
    sent = []
    run(fire, 0)
    expect(sent).toEqual([
      { type: 'stop_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.left, targets: ['10.0.0.2'] } },
      { type: 'stop_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.right, targets: ['10.0.0.3'] } },
    ])
  })

  it('flush stops the playing loops by Event ID (one-shots play on), and the next tick starts them again', () => {
    const fire = make()
    run(fire, 0.5); sent = []
    fire.flush(true)
    expect(sent.map(m => [m.type, m.payload.event_id])).toEqual([['stop_event', 'mill-kit.feed_loop'], ['stop_event', 'mill-kit.feed_loop']])
    sent = []; run(fire, 0.5); expect(sent.map(m => m.type)).toEqual(['play_event', 'play_event'])
  })

  it('a device that leaves the target list is stopped at its IP; with the helper offline the loop is kept to stop later', () => {
    const fire = make()
    run(fire, 0.5); sent = []
    run(fire, 0.5, voices, devices.slice(1)) // the left wrist was unticked
    expect(sent).toEqual([{ type: 'stop_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.left, targets: ['10.0.0.2'] } }])
    sent = []
    fire.flush(false); fire.stopAll(false, []); expect(sent).toEqual([]) // helper gone: nothing sent, nothing forgotten
    fire.flush(true); expect(sent).toEqual([{ type: 'stop_event', payload: { event_id: 'mill-kit.feed_loop', target: WRIST.right, targets: ['10.0.0.3'] } }])
  })

  it('a loop whose voice is gone (all devices switched on) gives way to the new one on each device', () => {
    const fire = make()
    run(fire, 0.5); sent = []
    now += LOOP_RESEND_MS
    run(fire, 0.5, buildLoopVoices(loopTable, sampleLib(), true))
    // Same Event ID, same gain on the wrists: kept; the chest starts.
    expect(sent).toEqual([{ type: 'play_event', payload: { event_id: 'mill-kit.feed_loop', target: '', gain: 0.4, targets: ['10.0.0.4'] } }])
  })

  it('one loop voice per device: the loudest loop plays there, logged once', () => {
    const fire = make()
    const crowd: LoopVoice = { ...voices[0], clip: 'crowd', gain: 1, layer: 1 }
    run(fire, 0.5, [voices[0], crowd])
    expect(sent.map(m => [m.payload.event_id, m.payload.targets])).toEqual([['mill-kit.crowd', ['10.0.0.2']], ['mill-kit.crowd', ['10.0.0.3']]])
    expect(logs).toHaveLength(1)
  })
})

describe('FIRE ▶ test', () => {
  it('plays the clip once (a loop clip stops after 1 s), survives a flush and returns the reached device count', () => {
    const fire = make()
    expect(fire.test({ table, clip: 'kick', at: 'both', gain: 1, devices, all: false })).toBe(2)
    fire.flush(true); expect(sent.map(m => m.type)).toEqual(['play_event', 'play_event']) // not a playback send
    sent = []
    expect(fire.test({ table, clip: 'crowd', at: 'pos_chest', gain: 0.5, devices, all: false })).toBe(1)
    expect(sent[0].payload).toEqual({ event_id: 'sports-kit.crowd', target: '*/pos_chest', gain: 0.4, targets: ['10.0.0.4'] })
    vi.advanceTimersByTime(TEST_LOOP_MS)
    expect(sent[1]).toEqual({ type: 'stop_event', payload: { event_id: 'sports-kit.crowd', target: '*/pos_chest', targets: ['10.0.0.4'] } })
    expect(fire.test({ table, clip: 'kick', at: 'pos_neck', gain: 1, devices, all: true })).toBe(3)
  })
})

describe('Scene FIRE acks are quiet', () => {
  it('a play / stop "sent" ack within 2 s of a FIRE send is quiet; other messages and older acks are not', () => {
    const fire = make()
    now = 5000
    fire.test({ table, clip: 'kick', at: 'pos_chest', gain: 1, devices, all: false })
    expect(isQuietSceneFireAck('play sent — 1 device', 5100)).toBe(true)
    expect(isQuietSceneFireAck('stop sent — 1 device', 5000 + QUIET_FIRE_ACK_MS)).toBe(true)
    expect(isQuietSceneFireAck('play sent — 1 device', 5001 + QUIET_FIRE_ACK_MS)).toBe(false)
    expect(isQuietSceneFireAck('name written', 5100)).toBe(false)
  })
})
