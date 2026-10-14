import type { ManagerMessage } from '@/types/manager'
import { encodeWavBlob } from './wavIO'

/**
 * The test pattern for this PC's sound / haptics offset (DEC-093): a short haptic pulse every second streamed to the
 * devices and a click on the PC at the same moments, the click moved by the offset (− E: + = the haptic later). The
 * user moves the offset until both are felt and heard at once — a person is the sensor (an actuator's own sound is
 * not when its vibration is felt). The offset is read for every click, so a change applies within a quarter second.
 */
export const TEST_RATE = 16000
export const TEST_PERIOD_SEC = 1
/** The first pulse (s into each stream): room for a click up to this much before it. */
export const TEST_FIRST_SEC = .5
export const TEST_PULSES = 20
const SCHEDULE_AHEAD_SEC = .25

/** The haptic: TEST_PULSES pulses of an 80 Hz sine at full scale from its first sample, decaying over ~40 ms. */
export function testHaptic(rate = TEST_RATE): Float32Array {
  const out = new Float32Array(Math.ceil((TEST_FIRST_SEC + TEST_PULSES * TEST_PERIOD_SEC) * rate))
  const len = Math.round(.06 * rate)
  for (let k = 0; k < TEST_PULSES; k++) {
    const start = Math.round((TEST_FIRST_SEC + k * TEST_PERIOD_SEC) * rate)
    for (let i = 0; i < len && start + i < out.length; i++) out[start + i] = .9 * Math.sin(2 * Math.PI * 80 * i / rate + Math.PI / 2) * Math.exp(-i / rate / .015)
  }
  return out
}

/** The click: a 2 kHz tone at full scale from its first sample, decaying over ~4 ms. */
export function testClick(rate: number): Float32Array {
  const out = new Float32Array(Math.round(.02 * rate))
  for (let i = 0; i < out.length; i++) out[i] = .6 * Math.sin(2 * Math.PI * 2000 * i / rate) * Math.exp(-i / rate / .004)
  return out
}

/** Context times of the clicks of pulses `fromPulse`.. that fall before `untilSec`: pulse k at t0 + FIRST + k × PERIOD − offset. */
export function clickTimes(t0: number, offsetMs: number, fromPulse: number, untilSec: number): { pulse: number; at: number }[] {
  const out: { pulse: number; at: number }[] = []
  for (let k = fromPulse; k < TEST_PULSES; k++) {
    const at = t0 + TEST_FIRST_SEC + k * TEST_PERIOD_SEC - offsetMs / 1000
    if (at > untilSec) break
    out.push({ pulse: k, at })
  }
  return out
}

type Stream = (blob: Blob, send: (message: ManagerMessage) => void, options: { signal: AbortSignal; cacheKey: string }) => Promise<void>

/** Runs the pattern until stop(): the haptic to `targets` (one stream per TEST_PULSES, again and again), the clicks on its own AudioContext. */
export class PcTimingTest {
  private controller: AbortController | null = null
  private ctx: AudioContext | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly send: (message: ManagerMessage) => void, private readonly stream: Stream, private readonly offsetMs: () => number) {}
  get running() { return this.controller !== null }
  async start(targets: readonly string[]) {
    this.stop()
    const controller = new AbortController(); this.controller = controller
    const ctx = new AudioContext(); this.ctx = ctx
    const click = ctx.createBuffer(1, Math.round(.02 * ctx.sampleRate), ctx.sampleRate)
    click.getChannelData(0).set(testClick(ctx.sampleRate))
    const haptic = new AudioBuffer({ numberOfChannels: 1, length: testHaptic().length, sampleRate: TEST_RATE })
    haptic.getChannelData(0).set(testHaptic())
    const blob = await encodeWavBlob(haptic, TEST_RATE)
    let t0: number | null = null, next = 0
    this.timer = setInterval(() => {
      if (t0 === null) return
      for (const c of clickTimes(t0, this.offsetMs(), next, ctx.currentTime + SCHEDULE_AHEAD_SEC)) {
        next = c.pulse + 1
        if (c.at < ctx.currentTime) continue
        const source = ctx.createBufferSource(); source.buffer = click; source.connect(ctx.destination); source.start(c.at)
      }
    }, 50)
    try {
      while (!controller.signal.aborted) {
        t0 = null; next = 0
        await this.stream(blob, message => {
          if (controller.signal.aborted && message.type !== 'stream_end') return
          // The first DATA goes right after BEGIN: the pattern's 0 s leaves the PC now.
          if (message.type === 'stream_begin') t0 = ctx.currentTime
          this.send({ type: message.type, payload: { ...message.payload, targets: [...targets] } })
        }, { signal: controller.signal, cacheKey: 'pc-timing-test' })
      }
    } catch (error) {
      if (!controller.signal.aborted) { this.stop(); throw error }
    }
  }
  stop() {
    this.controller?.abort(); this.controller = null
    if (this.timer) clearInterval(this.timer); this.timer = null
    if (this.ctx) void this.ctx.close(); this.ctx = null
  }
}
