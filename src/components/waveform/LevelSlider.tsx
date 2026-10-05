import { useEffect, useMemo, useRef } from 'react'
import { useEventStore } from '@/stores/eventStore'
import { LevelCommit, levelText } from '@/utils/levelCommit'

/**
 * A strength slider (0..1, dB shown too) for `levelKey`: a move applies at once — the editor reads `liveLevel`
 * for the playback gain (PC GainNode, device stream gain) and the "edited" drawing scale; `onSave` runs on release
 * or 500 ms after the last move (LevelCommit) and must update what `saved` reads synchronously, so the level never
 * jumps back when the live value is dropped. Nothing is rendered or decoded for it.
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
  const value = live ?? saved
  return <label className={`editor-intensity ${className ?? ''}`} title={title}>
    {label}
    <input type="range" min={0} max={1} step={0.01} value={value} aria-label={label}
      onChange={e => { const v = parseFloat(e.target.value); useEventStore.getState().setLiveLevel({ key, value: v }); commit.input(v) }}
      onPointerUp={() => commit.flush()} onKeyUp={() => commit.flush()} onBlur={() => commit.flush()} />
    <span className="editor-intensity-value">{levelText(value)}</span>
  </label>
}
