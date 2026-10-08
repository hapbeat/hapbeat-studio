import { perfTrack } from './perfRegistry'
/** Audio output is independent of waveform redraws and offline preview rendering. */
export class EditorBufferPlayer {
  private desired: AudioBuffer | null
  private buffer: AudioBuffer | null
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private offset = 0
  private began = 0
  private end = 0
  private muted = false
  /** The material's strength (DEC-086 intensity) as the output gain: changed live, the buffer is never re-rendered for it. */
  private level = 1
  /** Connected to the PC speakers (off while a haptic is auditioned: it only goes to the devices). */
  private output = true
  private disposed = false
  private revision = 0
  private listeners = new Map<string, Set<(time: number) => void>>()
  constructor(buffer: AudioBuffer | null, private createContext = () => new AudioContext(), private failed: (error: unknown) => void = console.error) {this.desired = buffer; this.buffer = buffer}
  on(event: 'play' | 'pause' | 'finish' | 'timeupdate' | 'seeking', listener: (time: number) => void) {
    const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners)
    return () => {listeners.delete(listener)}
  }
  private emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(this.getCurrentTime()) }
  setBuffer(buffer: AudioBuffer | null) { this.desired = buffer }
  prepare() { this.buffer = this.desired }
  getBuffer() { return this.buffer }
  getDuration() { return this.desired?.duration ?? 0 }
  getCurrentTime() { return this.source && this.context ? Math.min(this.end, this.offset + this.context.currentTime - this.began) : this.offset }
  isPlaying() { return this.source !== null }
  setMuted(muted: boolean) { this.muted = muted; this.applyGain() }
  /** Sets the playback gain at once, also while playing (nothing restarts). */
  setLevel(level: number) { this.level = Math.max(0, level); this.applyGain() }
  getLevel() { return this.level }
  private applyGain() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.level }
  /** Connects / disconnects the PC output; playback (time, events, the device stream) runs either way. */
  setOutput(on: boolean) {
    if (on === this.output) return
    this.output = on
    if (!this.gain || !this.context) return
    if (on) this.gain.connect(this.context.destination); else this.gain.disconnect()
  }
  async unlock() {
    if (this.disposed) throw new Error('Editor player was closed')
    if (!this.context) {
      this.context = this.createContext(); perfTrack('audioContexts', 1); this.gain = this.context.createGain()
      this.applyGain()
      if (this.output) this.gain.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
  }
  private halt() {
    const time = this.getCurrentTime(), source = this.source
    this.source = null; this.offset = time
    if (source) { source.onended = null; source.stop(); source.disconnect() }
    if (this.timer) clearInterval(this.timer); this.timer = null
  }
  pause() { this.revision++; const wasPlaying = this.isPlaying(); this.halt(); if (wasPlaying) this.emit('pause') }
  setTime(time: number) {
    this.revision++
    const playing = this.isPlaying(), end = this.end
    this.halt(); this.offset = Math.max(0, Math.min((playing ? this.buffer : this.desired)?.duration ?? 0, time))
    this.emit('seeking'); this.emit('timeupdate')
    if (playing) {
      if (this.offset < end) void this.play(this.offset, end).catch(error => {this.emit('pause'); this.failed(error)})
      else this.emit('pause')
    }
  }
  async play(start = 0, end = this.buffer?.duration ?? 0) {
    const revision = ++this.revision
    await this.unlock()
    if (revision !== this.revision || this.disposed || !this.buffer) return
    this.halt()
    this.offset = Math.max(0, Math.min(this.buffer.duration, start)); this.end = Math.min(this.buffer.duration, end)
    if (this.end <= this.offset) {this.emit('pause'); return}
    const source = this.context!.createBufferSource(); source.buffer = this.buffer; source.connect(this.gain!)
    this.source = source; this.began = this.context!.currentTime
    source.onended = () => this.ended(source, true)
    source.start(0, this.offset, this.end - this.offset)
    // The 16 ms tick usually reaches the end before the node's 'ended' (the node starts a render quantum or more after
    // `began`). Either way it is the natural end ('pause' + 'finish'): a bare 'pause' is a user stop (onUserStop), which
    // stopped the sounds and the Scene video a loop repeat had just started again.
    this.timer = setInterval(() => { if (this.getCurrentTime() >= this.end) this.ended(source, false); else this.emit('timeupdate') }, 16)
    this.emit('timeupdate'); this.emit('play')
  }
  /** The natural end of `source`'s pass. `done`: its 'ended' fired; else it may still sound its last ms and disconnects itself then. */
  private ended(source: AudioBufferSourceNode, done: boolean) {
    if (this.source !== source) return
    this.source = null; this.offset = this.end
    if (done) source.disconnect(); else source.onended = () => source.disconnect()
    if (this.timer) clearInterval(this.timer); this.timer = null
    this.emit('timeupdate'); this.emit('pause'); this.emit('finish')
  }
  activate() { this.disposed = false }
  dispose() { this.disposed = true; this.pause(); this.listeners.clear(); const context = this.context; this.context = null; this.gain = null; if (context) { perfTrack('audioContexts', -1); void context.close() } }
}
