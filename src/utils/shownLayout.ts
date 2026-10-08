import type { MessageId, MessageParams } from '@/i18n/messages'
import { loopPhaseAt, type LoopStretch } from './loopStretch'

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

/**
 * The scene-timed playback folded onto the material file drawn once (「発生に合わせて並べる」 off): `starts` are the firings
 * the material plays at (playback seconds), or `loop` a loop cue's segments (the material tiled at the recorded rate).
 */
export interface FoldView { materialSec: number; starts: readonly number[]; loop: Pick<LoopStretch, 'segments' | 'level'> | null }

/** The material time playing at playback time `playSec`: since the latest firing, or a loop's phase; null in a gap (after a firing's material, between segments). */
export function foldTime(view: FoldView, playSec: number): number | null {
  if (view.loop) return loopPhaseAt(view.loop, view.materialSec, playSec)
  let start: number | null = null
  for (const s of view.starts) if (s <= playSec + 1e-9 && (start === null || s > start)) start = s
  if (start === null) return null
  const t = playSec - start
  return t <= view.materialSec + 1e-9 ? Math.min(view.materialSec, t) : null
}

/** The playback time of material time `t` (a click, a seek on the drawn file): the first firing (a loop's first segment) + `t`. */
export function unfoldTime(view: FoldView, t: number): number {
  const first = view.loop ? view.loop.segments[0]?.start ?? 0 : view.starts.length ? Math.min(...view.starts) : 0
  return first + t
}
