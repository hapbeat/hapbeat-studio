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
export class EditorPlayback {
  /** The device stream's gain (DEC-086 intensity) at `time` (seconds of the player), read for every chunk sent: a change applies mid-stream without restarting. */
  level: ((time: number) => number) | null = null
  /** Read at every play; null or 0 s = start at once. */
  preRoll: (() => PlaybackPreRoll | null) | null = null
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
    const repeat = range && this.loop && !this.once && this.player.getCurrentTime() >= range.end - .002
    this.range = null
    this.cancel()
    const revision = this.revision
    if (repeat) {
      this.pending = true; this.changed(true)
      const restart = () => {
        this.loopTimer = null
        if (this.revision !== revision || !this.loop) return
        const next = this.selectedRange()
        if (next.end <= next.start) {this.stop(); return}
        void this.play(next.start, next.end).catch(this.failed)
      }
      if (this.loopDelay > 0) this.loopTimer = setTimeout(restart, this.loopDelay)
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
    this.player.prepare?.()
    const duration = this.player.getDuration()
    start = Math.max(0, Math.min(duration, start)); end = Math.max(start, Math.min(duration, end ?? duration))
    if (end <= start) return Promise.resolve()
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
      const preRoll = override !== undefined ? override : this.preRoll?.()
      if (preRoll && preRoll.seconds > 0) {
        preRoll.begin(start)
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, preRoll.seconds * 1000)
          const abort = () => { clearTimeout(timer); preRoll.cancel(); resolve() }
          controller.signal.addEventListener('abort', abort, {once: true})
        })
        if (controller.signal.aborted) return
      }
      if (!this.targets.length) {
        this.pending = false; this.changed(false)
        await this.player.play(start, end)
        return
      }
      const range = this.range!
      const blob = await this.encode(range.start, range.end)
      if (controller.signal.aborted) return
      this.seek(start)
      await this.stream(blob, message => {
        if (controller.signal.aborted && message.type !== 'stream_end') return
        this.send({type: message.type, payload: {...message.payload, targets: this.targets}})
        if (message.type === 'stream_begin') {
          this.pending = false; this.changed(false)
          void this.player.play(start, end).catch(error => {
            if (this.controller === controller) { this.stop(); this.failed(error) }
          })
        }
      }, {signal: controller.signal, control: {consumeSeek: () => {const seek = this.seekRequest; this.seekRequest = null; return seek}, getIntensity: at => this.level?.(range.start + at) ?? 1}})
    } catch (error) {
      if (!controller.signal.aborted) {
        if (this.controller === controller) this.stop()
        throw error
      }
    } finally {
      if (this.controller === controller) {this.controller = null; this.pending = false; this.changed(false)}
    }
  }
}
