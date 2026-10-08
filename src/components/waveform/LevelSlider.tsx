import { useEffect, useMemo, useRef } from 'react'
import { useEventStore } from '@/stores/eventStore'
import { LevelCommit, levelText } from '@/utils/levelCommit'
import { onPageHide } from '@/utils/pageHide'

/**
 * A strength slider (0..1, dB shown too) for `levelKey`: a move applies at once — the editor reads `liveLevel`
 * for the playback gain (PC GainNode, device stream gain) and the "edited" drawing scale; `onSave` runs on release
 * or 500 ms after the last move (LevelCommit; at once when the page is hidden / unloaded) and must update what `saved` reads synchronously, so the level never
 * jumps back when the live value is dropped. Nothing is rendered or decoded for it.
 * Keyboard: a click on the label focuses the slider; ←/→ step 0.01, Shift+←/→ 0.1. A press anywhere on the track moves
 * the thumb there and keeps dragging.
 */
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
  // Unmount cleanups do not run on a reload / close: a value moved within the 500 ms is saved then too.
  useEffect(() => onPageHide(() => commit.flush()), [commit])
  const value = live ?? saved
  const input = useRef<HTMLInputElement>(null)
  const set = (v: number) => { const next = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100; useEventStore.getState().setLiveLevel({ key, value: next }); commit.input(next) }
  return <label className={`editor-intensity ${className ?? ''}`} title={title}
    onMouseDown={e => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus() } }}>
    {label}
    <input ref={input} type="range" min={0} max={1} step={0.01} value={value} aria-label={label}
      onChange={e => set(parseFloat(e.target.value))}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
        e.preventDefault(); e.stopPropagation()
        set(value + (e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01))
      }}
      onPointerUp={() => commit.flush()} onKeyUp={() => commit.flush()} onBlur={() => commit.flush()} />
    <span className="editor-intensity-value">{levelText(value)}</span>
  </label>
}
