/**
 * A sound that plays on the PC alongside the editor playback (the event's
 * decided sound under a haptic, or a rendered preview sequence). The source is
 * identified by its buffer and volume only: re-setting the same source (a
 * re-render, an AI-trials poll replacing store objects every 2 s) leaves the
 * sound that is playing alone. Before this, each poll rebuilt the source object
 * and its effect cleanup stopped the sound about a second into a 7 s roar.
 */
export interface SoundSource { buffer: AudioBuffer; volume: number; loop?: boolean }
export interface PlayingSound { stop: () => void }
export type StartSound = (source: SoundSource, offsetSec: number) => PlayingSound

export class CompanionSound {
  private source: SoundSource | null = null
  private playing: PlayingSound | null = null
  constructor(private readonly start: StartSound) {}

  /** null = none. The same buffer, volume and loop keep what is playing; anything else stops it. */
  setSource(source: SoundSource | null) {
    const same = source && this.source && source.buffer === this.source.buffer && source.volume === this.source.volume && !!source.loop === !!this.source.loop
    if (same || (!source && !this.source)) return
    this.stop()
    this.source = source
  }
  get loops() { return !!this.source?.loop }
  /** (Re)starts from `timeSec` of the playback (nothing past the end of a non-looping sound). */
  play(timeSec: number) {
    this.stop()
    const s = this.source
    if (!s || (!s.loop && timeSec >= s.buffer.duration)) return
    this.playing = this.start(s, s.loop ? timeSec % s.buffer.duration : Math.max(0, timeSec))
  }
  stop() { try { this.playing?.stop() } catch { /* already ended */ } this.playing = null }
  get isPlaying() { return this.playing !== null }
}
