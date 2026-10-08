import type { MessageId, MessageParams } from '@/i18n/messages'
import type { LoopStretch } from './loopStretch'

/**
 * What the waveform panel draws: the material file once (`starts` null), or the material placed once per firing of
 * its event (`starts`: offsets from the first firing — the representative scene run, a repeating cue, an emit cue's
 * generated firings; DEC-085 / DEC-088), or a loop cue's material looped while its layer is active (`loop`: the active
 * segments and the recorded level line; loopStretch). `materialSec` is the file's own length either way.
 */
export interface ShownLayout { materialSec: number; starts: number[] | null; loop?: Pick<LoopStretch, 'segments' | 'envelope'> | null }

/** One span per placed copy of the material, in time order (empty for the file shown once). */
export function layoutPlacements(layout: ShownLayout): { start: number; end: number }[] {
  if (!layout.starts) return []
  return [...layout.starts].sort((a, b) => a - b).map(start => ({ start, end: start + layout.materialSec }))
}

/** The fixed status line: "one material file (0.12 s)", "placed at the firings (6 times, material 0.12 s)" or "loop (material 2.00 s repeated, …)". */
export function layoutStatus(layout: ShownLayout): { id: MessageId; params: MessageParams } {
  const sec = layout.materialSec.toFixed(2)
  if (layout.loop) return { id: 'editor.shown.loop', params: { sec } }
  return layout.starts ? { id: 'editor.shown.sequence', params: { count: layout.starts.length, sec } } : { id: 'editor.shown.single', params: { sec } }
}
