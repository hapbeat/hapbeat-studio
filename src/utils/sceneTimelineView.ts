/**
 * The Scene timeline's visible stretch: `start` (s) and `zoom` (px per s) for one moment (`key`); `fit` = the whole
 * moment, `span` = the window of a loop cue's span playing (SceneRuntime.playSpan) not yet zoomed or panned by hand.
 */
export type TimelineView = { key: string; start: number; zoom: number; fit: boolean; span: boolean }

/**
 * The window a playing loop cue span fills the timeline with: its part (span start − lead to span end + post, video
 * seconds) within the moment; null when no span plays or the part is empty.
 */
export function spanWindow(part: [number, number] | null, duration: number): [number, number] | null {
  if (!part) return null
  const a = Math.max(0, part[0]), b = Math.min(duration, part[1])
  return b > a ? [a, b] : null
}

/**
 * Updates `vw` for one frame. Another moment (or a span starting / ending) shows the whole moment, or the span's
 * `window` filling `width` while it plays (kept on resize until Ctrl + wheel / wheel changes it). The whole moment
 * until zoomed; while playing outside a span window, the playhead (`time`) is kept in view.
 */
export function stepView(vw: TimelineView, key: string, window: [number, number] | null, width: number, duration: number, maxZoom: number, playing: boolean, time: number) {
  const fit = width / duration
  if (vw.key !== key) { vw.key = key; vw.span = !!window; vw.fit = !window; vw.start = 0; vw.zoom = fit }
  if (window && vw.span) { vw.start = window[0]; vw.zoom = Math.min(maxZoom, Math.max(fit, width / (window[1] - window[0]))); vw.fit = false }
  else if (vw.fit || vw.zoom < fit) { vw.span = false; vw.zoom = fit; vw.start = 0; vw.fit = true }
  const shown = width / vw.zoom
  if (playing && !vw.span && (time < vw.start || time > vw.start + shown)) vw.start = Math.max(0, Math.min(duration - shown, time - shown * 0.1))
  vw.start = Math.max(0, Math.min(Math.max(0, duration - shown), vw.start))
}

/** What a left click on the timeline does: seek to `t`, select the marker's event (and seek to it), or play a band's span. */
export type TimelineClick = { kind: 'seek'; t: number } | { kind: 'select'; name: string; t: number } | { kind: 'span'; run: [number, number] }

/**
 * A plain click only seeks (to the clicked time `t`, also over a marker or a band), so tuning one cue never switches to
 * another by a mis-click; Ctrl (Cmd on mac) + click switches: a `marker` selects its event, a `band`'s run plays that span.
 */
export function timelineClick(switching: boolean, marker: { name: string; t: number } | null, band: [number, number] | null, t: number): TimelineClick {
  if (switching && marker) return { kind: 'select', name: marker.name, t: marker.t }
  if (switching && band) return { kind: 'span', run: band }
  return { kind: 'seek', t }
}
