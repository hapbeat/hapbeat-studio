import type { EffectEntry } from '@/types/waveform'
import { applyEffect } from './audioDsp'
/** Debounced, serialized rendering. Stale results never replace the current preview. */
export class EditorPreviewRenderer {
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()
  constructor(private render = applyEffect, private delay = 150) {}
  cancel() { this.revision++; if (this.timer) clearTimeout(this.timer); this.timer = null }
  request(original: AudioBuffer, effects: EffectEntry[], ready: (buffer: AudioBuffer) => void, failed: (error: unknown) => void) {
    this.cancel(); const revision = this.revision
    this.timer = setTimeout(() => {
      this.timer = null
      this.chain = this.chain.then(async () => {
        if (revision !== this.revision) return
        try {
          let buffer = original
          for (const effect of effects) {
            if (effect.enabled) buffer = await this.render(buffer, effect.params)
            if (revision !== this.revision) return
          }
          ready(buffer)
        } catch (error) { if (revision === this.revision) failed(error) }
      })
    }, this.delay)
  }
}
