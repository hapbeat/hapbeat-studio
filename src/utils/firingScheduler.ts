/**
 * Sounds of a scene played at their firing times (DEC-085: the decided sound of the scene's other cues,
 * and the event's own sound on the rated cue's firings during a haptic audition). Every firing gets its
 * own AudioBufferSourceNode, scheduled on the AudioContext clock from the playback position; nothing
 * is mixed into one buffer, so one firing never cuts another.
 *
 * `setFirings` compares by value (times, gains, buffers): recomputing the same list (store refreshes,
 * effects re-run) keeps what is playing; a list that differs only in gains (a strength / volume edited while it
 * plays) keeps it too and gives the firings not started yet their new gain; any other change stops it.
 */
export interface Firing<B = AudioBuffer> { atSec: number; buffer: B; gain: number }

interface SourceLike { buffer: unknown; connect(node: unknown): unknown; start(when: number, offset?: number): void; stop(): void }
interface GainLike { gain: { value: number }; connect(node: unknown): unknown }
export interface AudioContextLike { currentTime: number; destination: unknown; createBufferSource(): SourceLike; createGain(): GainLike }

const sameTimes = <B>(a: readonly Firing<B>[], b: readonly Firing<B>[]) =>
  a.length === b.length && a.every((f, i) => f.atSec === b[i].atSec && f.buffer === b[i].buffer)

export class FiringScheduler<B extends { duration: number } = AudioBuffer> {
  private firings: Firing<B>[] = []
  /** What play() started: each source with its gain node, the firing it plays and when it starts (context time). */
  private playing: { source: SourceLike; gain: GainLike; index: number; when: number }[] = []
  constructor(private readonly context: () => AudioContextLike) {}

  get size() { return this.firings.length }
  setFirings(firings: readonly Firing<B>[]) {
    if (sameTimes(this.firings, firings)) {
      this.firings = [...firings]
      // Only the gains changed: a firing not started yet plays at its new gain (one already sounding keeps its own).
      const now = this.playing.length ? this.context().currentTime : 0
      for (const p of this.playing) if (p.when > now) p.gain.gain.value = this.firings[p.index].gain
      return
    }
    this.stop()
    this.firings = [...firings]
  }
  /** Plays every firing from playback position `fromSec`: later ones are scheduled, one already sounding starts part way. */
  play(fromSec: number) {
    this.stop()
    if (!this.firings.length) return
    const ctx = this.context(), now = ctx.currentTime
    this.firings.forEach((f, index) => {
      if (f.atSec + f.buffer.duration <= fromSec) return
      const source = ctx.createBufferSource(), gain = ctx.createGain(), when = now + Math.max(0, f.atSec - fromSec)
      source.buffer = f.buffer
      gain.gain.value = f.gain
      source.connect(gain); gain.connect(ctx.destination)
      source.start(when, Math.max(0, fromSec - f.atSec))
      this.playing.push({ source, gain, index, when })
    })
  }
  stop() {
    for (const { source } of this.playing) { try { source.stop() } catch { /* not started / ended */ } }
    this.playing = []
  }
}
