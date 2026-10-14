import type { ManagerMessage } from '@/types/manager'
import type { StreamOptions } from '@/utils/audioStreamer'
interface Player {
  unlock?(): Promise<void>
  prepare?(): void
  play(start?: number, end?: number): Promise<void>
  pause(): void
  isPlaying(): boolean
  getCurrentTime(): number
  getDuration(): number
}
/**
 * Lead-in before the audio / haptics start (the editor's Scene video panel: the
 * video starts `seconds` before the cue mark so the audition sounds on the mark).
 * `begin` is called when the lead-in starts, `cancel` when Stop interrupts it.
 */
export interface PlaybackPreRoll { seconds: number; begin: (start: number) => void; cancel: () => void }
/**
 * Sounds that start before the play's start (a sound moved earlier than the haptic, DEC-093): `seconds(start)` is how
 * long before the haptic and the playback they must start (0 = none); `begin` starts them that early, `cancel` stops
 * them when Stop interrupts the lead-in. The haptic stream and the playback start `seconds` later, so nothing is cut.
 */
export interface PlaybackLeadIn { seconds: (start: number) => number; begin: (start: number, seconds: number) => void; cancel: () => void }
/** Loop repeats start at least this long apart (a near-zero range or an instant end never spins). */
export const MIN_LOOP_PERIOD_MS = 50
export class EditorPlayback {
  /** The device stream's gain (DEC-086 intensity) at `time` (seconds of the player), read for every chunk sent: a change applies mid-stream without restarting. */
  level: ((time: number) => number) | null = null
  /**
   * The device stream's samples from `time` (seconds of the player), `frames` long at the stream rate, read for every
   * chunk sent: a source mixed again while it plays (a gain edited during a scene audition) reaches the devices from the
   * next chunk. Null (or a null result) = the clip encoded at play.
   */
  samples: ((time: number, frames: number) => Float32Array | null) | null = null
  /** Read at every play; null or 0 s = start at once. */
  preRoll: (() => PlaybackPreRoll | null) | null = null
  /** Read at every play (after the pre-roll, which it shortens: the lead-in is part of the time before the mark); null = none. */
  leadIn: PlaybackLeadIn | null = null
  // Finish the previous stream_end before starting another clip or target set.
  private static settled: Promise<void> = Promise.resolve()
  private controller: AbortController | null = null
  private seekRequest: number | null = null
  private range: {start: number; end: number} | null = null
  private selection: {start: number; end: number} | null = null
  private revision = 0
  private loopTimer: ReturnType<typeof setTimeout> | null = null
  private loopDelay = 0
  loop = false
  pending = false
  /** The current play runs once even with loop on (Scene video click). Reset by every play. */
  private once = false
  /** When the current play was asked for (Date.now()): the next loop repeat waits at least MIN_LOOP_PERIOD_MS from it. */
  private startedAt = -Infinity
  constructor(private player: Player, private encode: (start: number, end: number) => Promise<Blob>, private targets: string[],
    private send: (message: ManagerMessage) => void,
    private stream: (blob: Blob, send: (message: ManagerMessage) => void, options: StreamOptions) => Promise<void>,
    private changed: (pending: boolean) => void = () => {}, private failed: (error: unknown) => void = console.error) {}
  configure(selection: {start: number; end: number} | null, loop: boolean, delaySeconds = 0) {
    this.selection = selection; this.loop = loop; this.loopDelay = Math.max(0, Math.min(60, Number.isFinite(delaySeconds) ? delaySeconds : 0)) * 1000
    if (!loop && !this.range && this.pending) this.stop()
  }
  private selectedRange() {
    const duration = this.player.getDuration()
    if (!this.selection) return {start: 0, end: duration}
    const start = Math.max(0, Math.min(duration, Math.min(this.selection.start, this.selection.end)))
    const end = Math.max(start, Math.min(duration, Math.max(this.selection.start, this.selection.end)))
    return {start, end}
  }
  paused() {
    const range = this.range
    if (!range || this.pending || this.player.isPlaying()) return
    const repeat = this.loop && !this.once && range.end - range.start > 0 && this.player.getCurrentTime() >= range.end - .002
    this.range = null
    this.cancel()
    const revision = this.revision
    if (repeat) {
      this.pending = true; this.changed(true)
      const restart = () => {
        this.loopTimer = null
        if (this.revision !== revision || !this.loop) return
        const next = this.selectedRange()
        // Not `end <= start`: a NaN duration must not restart either.
        if (!(next.end > next.start)) {this.stop(); return}
        void this.play(next.start, next.end).catch(this.failed)
      }
      const wait = Math.max(this.loopDelay, MIN_LOOP_PERIOD_MS - (Date.now() - this.startedAt))
      if (wait > 0) this.loopTimer = setTimeout(restart, wait)
      else queueMicrotask(restart)
    }
  }
  cancel() {
    this.revision++
    if (this.loopTimer) clearTimeout(this.loopTimer); this.loopTimer = null
    this.controller?.abort(); this.controller = null
    this.pending = false; this.changed(false)
  }
  stop() { this.range = null; this.cancel(); this.player.pause() }
  timeUpdated(time: number) {
    // WaveSurfer clears its scheduled stop when seeking, so enforce our range too.
    if (this.range && this.player.isPlaying() && time >= this.range.end) this.player.pause()
  }
  seek(time: number) {
    const range = this.range ?? {start: 0, end: this.player.getDuration()}
    this.seekRequest = Math.max(0, Math.min(1, (time - range.start) / Math.max(.000001, range.end - range.start)))
  }
  toggle() {
    if (this.pending || this.player.isPlaying()) { this.stop(); return Promise.resolve() }
    const range = this.selectedRange()
    const time = this.player.getCurrentTime()
    return this.play(this.selection || time < range.start || time >= range.end ? range.start : time, range.end)
  }
  /** `once`: no loop repeat for this play. `preRoll`: this play's lead-in instead of `this.preRoll` (null = none; Scene video resume). */
  play(start = 0, end?: number, once = false, preRoll?: PlaybackPreRoll | null): Promise<void> {
    this.stop()
    this.once = once
    this.startedAt = Date.now()
    this.player.prepare?.()
    const duration = this.player.getDuration()
    start = Math.max(0, Math.min(duration, start)); end = Math.max(start, Math.min(duration, end ?? duration))
    // Also a NaN / infinite duration: nothing plays (and nothing repeats).
    if (!Number.isFinite(duration) || !(end > start)) return Promise.resolve()
    this.range = {start: this.selection ? this.selectedRange().start : (end !== undefined && end < this.player.getDuration() ? start : 0), end: end ?? this.player.getDuration()}
    const controller = new AbortController()
    this.controller = controller; this.pending = true; this.changed(true)
    const job = this.run(controller, EditorPlayback.settled, start, end, this.player.unlock?.(), preRoll)
    EditorPlayback.settled = job.catch(() => {})
    return job
  }
  private async run(controller: AbortController, previous: Promise<void>, start: number, end?: number, unlocked?: Promise<void>, override?: PlaybackPreRoll | null): Promise<void> {
    try {
      await unlocked
      await previous
      if (controller.signal.aborted) return
      const leadIn = this.leadIn, leadSec = leadIn?.seconds(start) ?? 0
      const preRoll = override !== undefined ? override : this.preRoll?.()
      if (preRoll && preRoll.seconds > 0) {
        preRoll.begin(start)
        await wait(controller.signal, Math.max(0, preRoll.seconds - leadSec), () => preRoll.cancel())
        if (controller.signal.aborted) return
      }
      if (!this.targets.length) {
        if (leadIn && leadSec > 0) {
          leadIn.begin(start, leadSec)
          await wait(controller.signal, leadSec, () => leadIn.cancel())
          if (controller.signal.aborted) return
        }
        this.pending = false; this.changed(false)
        await this.player.play(start, end)
        return
      }
      const range = this.range!
      const blob = await this.encode(range.start, range.end)
      if (controller.signal.aborted) return
      this.seek(start)
      // The lead-in runs from the first stream_begin: the sounds start then, the haptic (the stream waits leadInSec before
      // its data) and the playback leadSec later.
      let leading = leadIn && leadSec > 0 ? leadIn : null, leadTimer: ReturnType<typeof setTimeout> | null = null
      const stopLead = () => { if (leadTimer) { clearTimeout(leadTimer); leadTimer = null; leadIn?.cancel() } }
      controller.signal.addEventListener('abort', stopLead, {once: true})
      const go = () => {
        this.pending = false; this.changed(false)
        void this.player.play(start, end).catch(error => {
          if (this.controller === controller) { this.stop(); this.failed(error) }
        })
      }
      await this.stream(blob, message => {
        if (controller.signal.aborted && message.type !== 'stream_end') return
        this.send({type: message.type, payload: {...message.payload, targets: this.targets}})
        if (message.type === 'stream_begin') {
          if (!leading) { go(); return }
          leading.begin(start, leadSec); leading = null
          leadTimer = setTimeout(() => { leadTimer = null; if (!controller.signal.aborted) go() }, leadSec * 1000)
        }
      }, {signal: controller.signal, leadInSec: leadSec, control: {consumeSeek: () => {const seek = this.seekRequest; this.seekRequest = null; return seek}, getIntensity: at => this.level?.(range.start + at) ?? 1,
        liveChunk: (at, frames) => this.samples?.(range.start + at, frames) ?? null}})
    } catch (error) {
      // The helper took the devices from this stream (audioStreamer StreamLostError): the sound plays on, the notice says why the haptics stopped.
      if (!controller.signal.aborted && error instanceof Error && error.name === 'StreamLostError') { this.failed(error); return }
      if (!controller.signal.aborted) {
        if (this.controller === controller) this.stop()
        throw error
      }
    } finally {
      if (this.controller === controller) {this.controller = null; this.pending = false; this.changed(false)}
    }
  }
}
/** Waits `seconds`, or until `signal` aborts (then `aborted` runs). */
function wait(signal: AbortSignal, seconds: number, aborted: () => void): Promise<void> {
  if (seconds <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, seconds * 1000)
    const abort = () => { clearTimeout(timer); aborted(); resolve() }
    signal.addEventListener('abort', abort, {once: true})
  })
}
