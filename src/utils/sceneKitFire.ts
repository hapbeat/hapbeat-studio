import type { CueTable } from './sceneCueTable'
import type { Shot } from './cueEvents'
import { mapLevel } from './levelMap'
import { matchesAddress, routeTargets, type HapticDevice, type HelperSend, type LevelFn, type LoopVoice } from './sceneHaptics'
import { markSceneFireSend } from './sceneFireAcks'

/**
 * The Scene tab's FIRE output: the cue table's Kit is installed on the Hapbeats, and Studio sends PLAY by Event ID
 * (`<kit>.<clip>`, contracts event-id) through hapbeat-helper (`play_event` / `stop_event`, unicast to the matching
 * devices' IPs, never broadcast) instead of streaming PCM. The firmware ignores the manifest intensity, so the gain
 * sent is the whole product: clip intensity × route gain (× the firing's jitter and variant multipliers, in the Shot)
 * × cue gain, clamped to 0..1. What a Kit clip cannot do here: the firing's haptic rate (the device plays its copy
 * as is), a gain change while it plays (a re-PLAY restarts it), more than 2 one-shots + 1 loop at once (firmware).
 * STOP_ALL also ends a device's stream session, so the runtime never runs this and the CLIP mixer together.
 */

/** A playing loop is re-sent when its gain moved this much since the last send... */
export const LOOP_RESEND_DB = 1.5
/** ...and at most this often (each re-PLAY restarts the loop on the device). */
export const LOOP_RESEND_MS = 250
/** A ▶ test of a loop clip stops after this long. */
export const TEST_LOOP_MS = 1000

export const kitEventId = (kit: string, clip: string) => `${kit}.${clip}`
const clamp01 = (g: number) => Math.max(0, Math.min(1, g))

export interface KitFireDeps {
  send: HelperSend
  /** ms, the same clock as performance.now() (the quiet-ack marker compares against it). */
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  log?: (text: string) => void
}

/** The loop one device plays (the firmware has a single loop voice: a new loop PLAY replaces the running one). */
interface DeviceLoop { id: string; target: string; gain: number; sentAt: number }

export class SceneKitFire {
  /** Scheduled one-shot PLAYs → their cue's wall time (without the FIRE offset). */
  private pending = new Map<unknown, number>()
  /** The loop playing on each device, by IP: its stop goes to that IP even after the device left the target list. */
  private loops = new Map<string, DeviceLoop>()
  /** IPs that got a PLAY since the last STOP_ALL (stopAll sends it to them, wherever they are now). */
  private played = new Set<string>()
  private noted = new Set<string>()

  constructor(private deps: KitFireDeps) {}

  private note(key: string, text: string) {
    if (this.noted.has(key)) return
    this.noted.add(key)
    this.deps.log?.(text)
  }
  private kitOf(table: CueTable): string | null {
    if (table.kit) return table.kit
    this.note('kit', 'FIRE: the cue table names no Kit (`kit`), so there is no Event ID to send')
    return null
  }
  private ipsOf(target: string, devices: HapticDevice[]): string[] {
    return devices.filter(d => d.ipAddress && matchesAddress(target, d.address)).map(d => d.ipAddress)
  }
  /** PLAY to `ips` (none: nothing is sent, never a broadcast). */
  private play(eventId: string, target: string, gain: number, ips: string[]) {
    if (!ips.length) return
    this.deps.send('play_event', { event_id: eventId, target, gain: clamp01(gain), targets: ips })
    markSceneFireSend(this.deps.now())
    for (const ip of ips) this.played.add(ip)
  }
  /** stop_event to `ips`: by Event ID, or STOP_ALL without one. */
  private stop(eventId: string | undefined, target: string, ips: string[]) {
    if (!ips.length) return
    this.deps.send('stop_event', { ...(eventId === undefined ? {} : { event_id: eventId }), target, targets: ips })
    markSceneFireSend(this.deps.now())
  }

  /**
   * One firing (fireShot): a PLAY per one-shot route and device target, `delayMs` (the video's delay to the cue) +
   * `offsetMs` (the FIRE offset) from now, at once when that is < 0. Loop clips are layer driven (loopTick). `all`: see
   * routeTargets.
   */
  shot(o: { table: CueTable; shot: Shot; hand: string; cueGain: number; delayMs: number; offsetMs: number; devices: HapticDevice[]; all: boolean }) {
    const kit = this.kitOf(o.table)
    if (!kit) return
    if (o.shot.rate !== 1) this.note('rate', 'FIRE: a firing\'s haptic rate is not applied (the Hapbeat plays its Kit clip as is)')
    const sends = o.shot.routes.flatMap(r => {
      const clip = o.table.clips[r.clip]
      if (!clip || clip.loop) return []
      const gain = clip.intensity * r.gain * o.cueGain
      return routeTargets(r.at, o.hand, o.all).map(target => ({ id: kitEventId(kit, r.clip), target, gain }))
    })
    if (!sends.length) return
    const handle = this.deps.setTimer(() => {
      this.pending.delete(handle)
      for (const x of sends) this.play(x.id, x.target, x.gain, this.ipsOf(x.target, o.devices))
    }, Math.max(0, o.delayMs + o.offsetMs))
    this.pending.set(handle, this.deps.now() + Math.max(0, o.delayMs))
  }

  /**
   * Loops, every tick while the video plays, at replay time `t` (already shifted by the FIRE offset): per loop voice
   * (buildLoopVoices) the gain the mixer would use, mapLevel(levelMap, level) × intensity × route gain. A device has one
   * loop voice, so each device plays its loudest voice (the others are dropped, logged once). Rising above 0 starts it,
   * a change of LOOP_RESEND_DB or more (or another loop taking over) re-sends it, at most every LOOP_RESEND_MS (the
   * device restarts the loop, accepted); a device with no voice above 0 left, or gone from `devices`, is stopped.
   */
  loopTick(o: { table: CueTable; voices: LoopVoice[]; t: number; level: LevelFn; devices: HapticDevice[] }) {
    const kit = this.kitOf(o.table)
    if (!kit) return
    const now = this.deps.now(), seen = new Set<string>(), want = new Map<string, { voice: string; id: string; target: string; gain: number }>()
    for (const v of o.voices) {
      // Identical voices (same layer, side, clip and targets) are one loop on the device.
      const key = `${v.layer}|${v.side}|${v.clip}|${v.targets.join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      const gain = clamp01(mapLevel(v.levelMap, o.level(o.t, v.layer, v.side)[0]) * v.gain)
      if (gain <= 0) continue
      for (const target of v.targets) for (const ip of this.ipsOf(target, o.devices)) {
        const cur = want.get(ip)
        if (cur && cur.voice !== key) this.note('loops', 'FIRE: a Hapbeat has one loop voice, so where loops overlap only the loudest plays')
        if (!cur || gain > cur.gain) want.set(ip, { voice: key, id: kitEventId(kit, v.clip), target, gain })
      }
    }
    const plays = new Map<string, { id: string; target: string; gain: number; ips: string[] }>()
    for (const [ip, w] of want) {
      const st = this.loops.get(ip)
      if (st && (now - st.sentAt < LOOP_RESEND_MS || (st.id === w.id && Math.abs(20 * Math.log10(w.gain / st.gain)) < LOOP_RESEND_DB))) continue
      const k = `${w.id}|${w.target}|${w.gain}`
      const group = plays.get(k) ?? { id: w.id, target: w.target, gain: w.gain, ips: [] }
      plays.set(k, group)
      group.ips.push(ip)
    }
    for (const x of plays.values()) {
      this.play(x.id, x.target, x.gain, x.ips)
      for (const ip of x.ips) this.loops.set(ip, { id: x.id, target: x.target, gain: x.gain, sentAt: now })
    }
    const gone = [...this.loops.keys()].filter(ip => !want.has(ip))
    if (gone.length) this.stopLoops(gone)
  }
  /** Stops the loops of `ips` by their Event ID (one-shots play on). */
  private stopLoops(ips: string[]) {
    const stops = new Map<string, { id: string; target: string; ips: string[] }>()
    for (const ip of ips) {
      const st = this.loops.get(ip)
      if (!st) continue
      const k = `${st.id}|${st.target}`
      const group = stops.get(k) ?? { id: st.id, target: st.target, ips: [] }
      stops.set(k, group)
      group.ips.push(ip)
      this.loops.delete(ip)
    }
    for (const x of stops.values()) this.stop(x.id, x.target, x.ips)
  }

  /**
   * Seek, loop jump, pause, another item: cancels the scheduled PLAYs whose cue the video has not reached and stops the
   * running loops by Event ID, like the CLIP mixer's flush (started and passed one-shots play out; the next loopTick
   * restarts the loops that are on at the new position). With the helper offline nothing can be sent, so the loops are
   * kept and stopped once it is back.
   */
  flush(connected: boolean) {
    const now = this.deps.now()
    for (const [h, cueAt] of this.pending) if (cueAt > now) { this.deps.clearTimer(h); this.pending.delete(h) }
    if (connected) this.stopLoops([...this.loops.keys()])
  }

  /**
   * Output switched, haptics off, stop / dispose: cancels every scheduled PLAY and, when anything played since the
   * last STOP_ALL, sends one (stop_event without event_id) to every device that got a PLAY and every device in
   * `devices`. With the helper offline it stays owed and a later call sends it.
   */
  stopAll(connected: boolean, devices: HapticDevice[]) {
    for (const h of this.pending.keys()) this.deps.clearTimer(h)
    this.pending.clear()
    if (!connected || (!this.played.size && !this.loops.size)) return
    this.stop(undefined, '', [...new Set([...this.played, ...this.loops.keys(), ...devices.map(d => d.ipAddress).filter(Boolean)])])
    this.played.clear()
    this.loops.clear()
  }

  /**
   * ▶ in the Haptics panel: one PLAY of `clip` at clip intensity × route gain (a loop clip stops after TEST_LOOP_MS).
   * Not cancelled by flush (the paused runtime flushes every tick). Returns how many devices it reached.
   */
  test(o: { table: CueTable; clip: string; at: string; gain: number; devices: HapticDevice[]; all: boolean }): number {
    const kit = this.kitOf(o.table), clip = o.table.clips[o.clip]
    if (!kit || !clip) return 0
    const id = kitEventId(kit, o.clip), reached = new Set<string>()
    const sends = routeTargets(o.at, undefined, o.all).map(target => ({ target, ips: this.ipsOf(target, o.devices) }))
    for (const x of sends) { this.play(id, x.target, clip.intensity * o.gain, x.ips); for (const ip of x.ips) reached.add(ip) }
    if (clip.loop && reached.size) this.deps.setTimer(() => { for (const x of sends) this.stop(id, x.target, x.ips) }, TEST_LOOP_MS)
    return reached.size
  }
}
