import { routeClips, type CueTable } from './sceneCueTable'
import { effectiveEvent, eventKey, MaterialPicker, resolveEventName, type Shot } from './cueEvents'
import type { SceneLib } from './sceneData'
import { mapLevel, type LevelMap } from './levelMap'

/**
 * Scene tab haptics: one stream per Hapbeat through hapbeat-helper, every
 * source mixed per device (hapbeat-contracts sdk-multi-stream: 16 kHz stereo
 * PCM16, gain applied before the mix, the device's full address as the
 * STREAM_BEGIN `target`, exact unicast via `targets`). Gains follow the Unreal
 * SDK: WAV × clip intensity × route gain × cue gain (one-shots) or × the
 * recorded layer level through the route's levelMap (loops, DEC-090). Ported from the standalone haptic clip viewer.
 */

export const RATE = 16000
export const CHUNK = 256
/** How far ahead of the wall clock chunks are sent. */
export const LEAD_MS = 60
/** Cues are fired this far (seconds of video) before the playhead reaches them. */
export const LOOKAHEAD = 0.12
/** Streams close after this long without playback or pending voices. */
export const QUIET_END_MS = 3000

export const WRIST = { left: '*/pos_l_wrist', right: '*/pos_r_wrist' }

/** contracts device-addressing: segments, whole-segment '*', prefix match. */
export function matchesAddress(target: string, address: string): boolean {
  if (!target) return true
  const t = target.split('/'), a = address.split('/')
  return t.length <= a.length && t.every((s, i) => s === '*' || s === a[i])
}

/** Device targets of a route position; `hand` = the acting hand's wrist (both wrists when both / none). */
export function targetsOf(at: string, hand?: string): string[] {
  if (at === 'hand') return hand === 'left' ? [WRIST.left] : hand === 'right' ? [WRIST.right] : [WRIST.left, WRIST.right]
  if (at === 'both') return [WRIST.left, WRIST.right]
  return [`*/${at}`]
}

/** Every device target the table routes to, variants included (for the coverage read-out and device matching). */
export function tableTargets(table: CueTable): string[] {
  const out = new Set<string>()
  for (const cue of Object.values(table.cues)) {
    const routes = [...(cue.haptics ?? []), ...Object.values(cue.variants ?? {}).flatMap(v => v.haptics ?? [])]
    for (const r of routes) for (const t of targetsOf(r.at)) out.add(t)
  }
  return [...out]
}

export interface OneShotVoice { pcm: Float32Array; targets: string[]; gain: number; start: number; cue?: boolean }
/** `levelMap`: the route's level → multiplier (DEC-090; absent = the level). */
export interface LoopVoice { clip: string; targets: string[]; gain: number; levelMap?: LevelMap; layer: number; side: number; phase: Record<string, number> }
/** Replay time `t` was at wall time `wall` (ms), advancing at `rate`. */
export interface PlayClock { t: number; rate: number; wall: number }
export type LevelFn = (t: number, layer: number, side: number) => [number, number]

/** Continuous-layer voices: per loop cue route, one per hand for `hand` routes, else one following the louder hand. */
export function buildLoopVoices(table: CueTable, lib: SceneLib): LoopVoice[] {
  const out: LoopVoice[] = []
  lib.layers.forEach(({ cue: name }, layer) => {
    for (const r of table.cues[name]?.haptics ?? []) {
      // A loop does not re-pick while it plays: a multi-clip route loops its first clip.
      const clipName = routeClips(r)[0], clip = clipName === undefined ? undefined : table.clips[clipName]
      if (!clip || clipName === undefined) continue
      const add = (targets: string[], side: number) => out.push({ clip: clipName, targets, gain: clip.intensity * r.gain, levelMap: r.levelMap, layer, side, phase: {} })
      if (r.at === 'hand') { add([WRIST.left], 0); add([WRIST.right], 1) } else add(targetsOf(r.at), -1)
    }
  })
  return out
}

/**
 * Voices for one cue occurrence (`ev.name` = `cue` or `cue:variant`, resolved
 * like the game: an unknown variant plays the cue): its one-shot routes,
 * starting at `start` (ms). A multi-clip route plays one clip picked by the
 * event's `variation.pick`; `jitter` is this firing's gain factor (shared with its sound).
 */
export function cueVoices(table: CueTable, pcm: Record<string, Float32Array>, ev: { name: string; hand: string; gain?: number }, start: number,
  opts: { picker?: MaterialPicker; jitter?: number } = {}): OneShotVoice[] {
  const resolved = resolveEventName(table, ev.name), e = resolved && effectiveEvent(table, resolved.ref)
  if (!e) return []
  const picker = opts.picker ?? new MaterialPicker(), out: OneShotVoice[] = []
  e.haptics.forEach((r, i) => {
    const name = picker.pick(`${eventKey(e.ref)}#${i}`, routeClips(r), e.variation?.pick), clip = name === undefined ? undefined : table.clips[name]
    if (name === undefined || !pcm[name] || !clip || clip.loop) return
    out.push({ pcm: pcm[name], targets: targetsOf(r.at, ev.hand), gain: clip.intensity * r.gain * (ev.gain ?? 1) * (opts.jitter ?? 1), start, cue: true })
  })
  return out
}

/** Linear resample of a clip by `rate` (> 1 = faster: higher and shorter). */
export function resampleClip(data: Float32Array, rate: number): Float32Array {
  if (rate === 1 || !data.length) return data
  const out = new Float32Array(Math.max(1, Math.floor((data.length - 1) / rate) + 1))
  for (let i = 0; i < out.length; i++) { const p = i * rate, j = Math.floor(p), f = p - j; out[i] = j + 1 < data.length ? data[j] + (data[j + 1] - data[j]) * f : data[j] }
  return out
}

/** Voices of one firing (fireShot): its picked one-shot clips at the shot's rate, clip intensity × route gain (× jitter) × cue gain. */
export function shotVoices(table: CueTable, pcm: Record<string, Float32Array>, shot: Shot, hand: string, cueGain: number, start: number): OneShotVoice[] {
  return shot.routes.flatMap(r => {
    const clip = table.clips[r.clip], data = pcm[r.clip]
    if (!clip || !data || clip.loop) return []
    return [{ pcm: resampleClip(data, shot.rate), targets: targetsOf(r.at, hand), gain: clip.intensity * r.gain * cueGain, start, cue: true }]
  })
}

/**
 * One CHUNK of a device's mix at wall time `wall` (ms): every voice whose
 * targets match the device address, plus the loop voices scaled by the
 * recorded layer level (through each voice's levelMap) while the video plays. Returns interleaved stereo PCM16
 * (L = R). Loop phases advance per device ip.
 */
export function renderChunk(opts: { ip: string; address: string; wall: number; voices: OneShotVoice[]; loopVoices: LoopVoice[]; clock: PlayClock | null; pcm: Record<string, Float32Array>; level: LevelFn }): Int16Array {
  const { ip, address, wall, voices, loopVoices, clock, pcm, level } = opts
  const out = new Float32Array(CHUNK)
  for (const x of voices) if (x.targets.some(tg => matchesAddress(tg, address))) {
    const o = Math.round((wall - x.start) * RATE / 1000)
    for (let k = Math.max(0, -o); k < CHUNK && o + k < x.pcm.length; k++) out[k] += x.pcm[o + k] * x.gain
  }
  if (clock) {
    const t0 = clock.t + (wall - clock.wall) / 1000 * clock.rate, t1 = t0 + CHUNK / RATE * clock.rate
    for (const x of loopVoices) {
      const p = pcm[x.clip]
      if (!p || !p.length || !x.targets.some(tg => matchesAddress(tg, address))) continue
      const [l0, r0] = level(t0, x.layer, x.side), [l1] = level(t1, x.layer, x.side), g0 = mapLevel(x.levelMap, l0), g1 = mapLevel(x.levelMap, l1)
      let ph = x.phase[ip] || 0
      if (g0 > 0 || g1 > 0) for (let k = 0; k < CHUNK; k++) { out[k] += p[Math.floor(ph) % p.length] * (g0 + (g1 - g0) * k / CHUNK) * x.gain; ph += r0 }
      x.phase[ip] = ph % p.length
    }
  }
  const pcm16 = new Int16Array(CHUNK * 2)
  for (let k = 0; k < CHUNK; k++) pcm16[2 * k] = pcm16[2 * k + 1] = Math.max(-32768, Math.min(32767, Math.round(out[k] * 32767)))
  return pcm16
}

export function bytesToBase64(buffer: ArrayBuffer): string {
  const u = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export interface HapticDevice { ipAddress: string; address: string; name?: string }
export type HelperSend = (type: string, payload: Record<string, unknown>) => void
/** The helper's reply to stream_begin (hapbeat-helper `stream_ack`). */
export interface StreamAck { stream_id?: string; status?: string; targets?: string[]; deferred?: string[]; message?: string }

/** A BEGIN without a `stream_ack` within this long counts as lost. */
export const ACK_TIMEOUT_MS = 1000
/** Wait before a device's next BEGIN after a rejected / lost one (at most one retry per second per device). */
export const RETRY_MS = 1000

/**
 * Keeps one helper stream per matching device open while there is something
 * to play, and feeds it CHUNK by CHUNK slightly ahead of the wall clock.
 * The caller drives it with `pump()` every ~10 ms and passes the helper's
 * `stream_ack`s to `onAck()`: a BEGIN the helper rejects (`no_target`, the ip
 * deferred or not among `targets`) or does not acknowledge within
 * ACK_TIMEOUT_MS drops that device's session, and the next `pump()` after
 * RETRY_MS opens a new one with a new stream_id (instead of sending DATA the
 * helper drops).
 */
export class SceneHapticMixer {
  private sessions = new Map<string, { id: string; address: string; wall: number; bytes: number; begun: number; acked: boolean }>()
  /** Per device ip: no BEGIN before this time (ms, the pump clock). */
  private retryAt = new Map<string, number>()
  private sid = 0
  private quietSince = 0
  voices: OneShotVoice[] = []
  loopVoices: LoopVoice[] = []
  clock: PlayClock | null = null

  constructor(private send: HelperSend, private log: (text: string) => void = () => {}) {}

  get streaming() { return this.sessions.size > 0 }
  /** Whether `streamId` is one of this mixer's open sessions (its acks belong here). */
  owns(streamId: string | undefined) { return !!streamId && [...this.sessions.values()].some(s => s.id === streamId) }

  /** Drops cue voices that were scheduled but not yet due (they belong to the old position after a seek / stop). */
  flush(now: number) { this.voices = this.voices.filter(x => !x.cue || x.start <= now) }

  endSessions() {
    for (const [ip, s] of this.sessions) { this.send('stream_end', { stream_id: s.id, targets: [ip] }); this.log(`stream_end ${s.id} → ${ip}`) }
    this.sessions.clear()
    this.retryAt.clear()
  }

  /** A `stream_ack` from the helper (acks of other streams are ignored). */
  onAck(ack: StreamAck, now: number) {
    for (const [ip, s] of this.sessions) {
      if (s.id !== ack.stream_id) continue
      if (ack.status === 'ok' && ack.targets?.includes(ip) && !ack.deferred?.includes(ip)) { s.acked = true; continue }
      this.drop(ip, now, `${ack.status ?? '?'}${ack.deferred?.includes(ip) ? ', deferred' : ''}${ack.status === 'ok' && !ack.targets?.includes(ip) ? ', not in targets' : ''}`)
    }
  }

  private drop(ip: string, now: number, why: string) {
    const s = this.sessions.get(ip)
    if (!s) return
    this.sessions.delete(ip)
    this.retryAt.set(ip, now + RETRY_MS)
    this.log(`stream drop ${s.id} → ${ip} (${why}); retry in ${RETRY_MS} ms`)
  }

  /**
   * `enabled` false (haptic send off / helper down) closes the streams and
   * drops the voices. `devices` are the selected, online devices whose
   * address matches a table target.
   */
  pump(now: number, o: { enabled: boolean; playing: boolean; devices: HapticDevice[]; leadMs: number; pcm: Record<string, Float32Array>; level: LevelFn }) {
    if (!o.enabled) { this.endSessions(); this.voices = []; return }
    if (o.playing || this.voices.length) this.quietSince = now
    if (now - this.quietSince > QUIET_END_MS) { this.endSessions(); return }
    // A BEGIN the helper never acknowledged: end it (harmless if it never started) and retry.
    for (const [ip, s] of this.sessions) if (!s.acked && now - s.begun > ACK_TIMEOUT_MS) {
      this.send('stream_end', { stream_id: s.id, targets: [ip] })
      this.drop(ip, now, 'no ack')
    }
    for (const d of o.devices) {
      if (!d.ipAddress || this.sessions.has(d.ipAddress) || (this.retryAt.get(d.ipAddress) ?? -Infinity) > now) continue
      const id = `scene-${Date.now().toString(36)}-${++this.sid}`
      this.send('stream_begin', { stream_id: id, targets: [d.ipAddress], target: d.address, sample_rate: RATE, channels: 2, format: 'pcm16', total_samples: 0, gain: 1.0 })
      this.sessions.set(d.ipAddress, { id, address: d.address, wall: now, bytes: 0, begun: now, acked: false })
      this.log(`stream_begin ${id} → ${d.name ?? ''} ${d.ipAddress} (${d.address})`)
    }
    for (const [ip, s] of this.sessions) {
      if (!o.devices.some(d => d.ipAddress === ip)) { this.send('stream_end', { stream_id: s.id, targets: [ip] }); this.sessions.delete(ip); this.log(`stream_end ${s.id} → ${ip}`); continue }
      if (s.wall < now - 200) s.wall = now // throttled tab: skip ahead instead of bursting
      while (s.wall < now + LEAD_MS) {
        const chunk = renderChunk({ ip, address: s.address, wall: s.wall + o.leadMs, voices: this.voices, loopVoices: this.loopVoices, clock: this.clock, pcm: o.pcm, level: o.level })
        this.send('stream_data', { stream_id: s.id, targets: [ip], offset: s.bytes, data: bytesToBase64(chunk.buffer as ArrayBuffer) })
        s.bytes += chunk.byteLength
        s.wall += CHUNK / RATE * 1000
      }
    }
    this.voices = this.voices.filter(x => (now - x.start) / 1000 * RATE < x.pcm.length)
  }
}
