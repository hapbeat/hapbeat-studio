/** A strength slider saves its value this long after the last move (or at once when released). */
export const LEVEL_SAVE_DELAY_MS = 500

/**
 * Saving of a strength slider (DEC-086 intensity). The caller applies every move live — the playback
 * gain (PC GainNode, device stream gain) and the drawing scale; this only saves, `delayMs` after the
 * last move or at once on `flush` (release, blur, unmount). Saving never re-renders or restarts anything.
 */
export class LevelCommit {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: number | null = null
  constructor(private save: (value: number) => void, private delayMs = LEVEL_SAVE_DELAY_MS) {}
  input(value: number) {
    this.pending = value
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending === null) return
    const value = this.pending
    this.pending = null
    this.save(value)
  }
}

/** "0.50 · −6.0 dB" */
export const levelText = (value: number) => `${value.toFixed(2)} · ${value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dB` : '−∞ dB'}`
