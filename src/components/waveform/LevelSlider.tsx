import { useEffect, useMemo, useRef } from 'react'
import { useEventStore } from '@/stores/eventStore'
import { LevelCommit, levelText } from '@/utils/levelCommit'

/**
 * A strength slider (0..1, dB shown too) for `levelKey`: a move applies at once — the editor reads `liveLevel`
 * for the playback gain (PC GainNode, device stream gain) and the "edited" drawing scale; `onSave` runs on release
 * or 500 ms after the last move (LevelCommit) and must update what `saved` reads synchronously, so the level never
 * jumps back when the live value is dropped. Nothing is rendered or decoded for it.
 * Keyboard: a click on the label focuses the slider; ←/→ step 0.01, Shift+←/→ 0.1. Only the thumb drags: a press on the
 * track elsewhere just focuses (no jump in strength).
 */
/** Half the width of the slider thumb (px) plus a little slack: a press within it of the thumb's centre drags the thumb. */
const THUMB_HALF = 9
/** The press at `clientX` is on the thumb of range `el` (0..1) showing `value`. */
function onThumb(el: HTMLInputElement, clientX: number, value: number): boolean {
  const r = el.getBoundingClientRect(), centre = r.left + THUMB_HALF + value * Math.max(0, r.width - 2 * THUMB_HALF)
  return Math.abs(clientX - centre) <= THUMB_HALF + 2
}

export function LevelSlider({ levelKey: key, saved, onSave, label, title, className }: {
  levelKey: string; saved: number; onSave: (value: number) => void; label: string; title: string; className?: string
}) {
  const live = useEventStore(state => state.liveLevel?.key === key ? state.liveLevel.value : null)
  const save = useRef(onSave); save.current = onSave
  const commit = useMemo(() => new LevelCommit(value => {
    save.current(value)
    if (useEventStore.getState().liveLevel?.key === key) useEventStore.getState().setLiveLevel(null)
  }), [key])
  useEffect(() => () => commit.flush(), [commit])
  const value = live ?? saved
  const input = useRef<HTMLInputElement>(null)
  const set = (v: number) => { const next = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100; useEventStore.getState().setLiveLevel({ key, value: next }); commit.input(next) }
  return <label className={`editor-intensity ${className ?? ''}`} title={title}
    onMouseDown={e => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus() } }}>
    {label}
    <input ref={input} type="range" min={0} max={1} step={0.01} value={value} aria-label={label}
      onChange={e => set(parseFloat(e.target.value))}
      onMouseDown={e => { if (!onThumb(e.currentTarget, e.clientX, value)) { e.preventDefault(); e.currentTarget.focus() } }}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault(); e.stopPropagation()
        set(value + (e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01))
      }}
      onPointerUp={() => commit.flush()} onKeyUp={() => commit.flush()} onBlur={() => commit.flush()} />
    <span className="editor-intensity-value">{levelText(value)}</span>
  </label>
}
