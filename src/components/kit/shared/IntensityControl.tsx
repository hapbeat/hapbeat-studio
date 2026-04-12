import { useEffect, useRef, useState } from 'react'
import { useElementSize } from '../hooks/useElementSize'
import './IntensityControl.css'

export interface IntensityControlProps {
  value: number
  onChange: (v: number) => void
  label?: string
}

/**
 * Amp (intensity) control that auto-adapts to its cell width.
 * - Wide cell (>= COMPACT_THRESHOLD): inline slider with range input
 * - Narrow cell: compact "Amp NN%" button that opens a popover with the slider
 *
 * The outer wrapper always flex-grows (flex: 1, min-width: 0) so its width
 * is driven by the parent grid/flex, not by its own contents. That prevents
 * the slider→button→slider flicker that would happen if width were
 * content-driven.
 *
 * 70px is deliberately low: at the Clips panel's min-width (280px), the
 * amp cell is still large enough for a usable slider, so we never want to
 * collapse there. The popover only kicks in on extremely cramped parents.
 */
const COMPACT_THRESHOLD = 70

export function IntensityControl({ value, onChange, label = 'Amp' }: IntensityControlProps) {
  const { ref, width } = useElementSize<HTMLDivElement>()
  // Hysteresis: switch to compact if clearly below threshold, back to inline
  // only once clearly above. Avoids jitter right at the boundary.
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (width === 0) return
    if (width < COMPACT_THRESHOLD - 10) setCompact(true)
    else if (width > COMPACT_THRESHOLD + 10) setCompact(false)
  }, [width])

  return (
    <div ref={ref} className="intensity-control">
      {compact
        ? <IntensityPopoverButton value={value} onChange={onChange} label={label} />
        : <IntensityInlineSlider value={value} onChange={onChange} label={label} />}
    </div>
  )
}

function IntensityInlineSlider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [focused, setFocused] = useState(false)
  return (
    <label
      className={`intensity-inline ${focused ? 'focused' : ''}`}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      title="クリックしてフォーカス、矢印キーで微調整"
    >
      <span className="intensity-inline-label">{label}</span>
      <input
        type="range"
        min={0} max={1} step={0.05}
        value={value}
        draggable={false}
        onChange={(e) => onChange(Number(e.target.value))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <span className="intensity-inline-val">{Math.round(value * 100)}%</span>
    </label>
  )
}

function IntensityPopoverButton({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  return (
    <div className="intensity-popover-wrap" ref={ref}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}>
      <button className="intensity-popover-trigger"
        onClick={() => setOpen(!open)}
        title={`${label} — click to edit`}>
        <span className="intensity-popover-label">{label}</span>
        <span className="intensity-popover-val">{Math.round(value * 100)}%</span>
      </button>
      {open && (
        <div className="intensity-popover-panel">
          <span className="intensity-inline-label">{label}</span>
          <input type="range" min={0} max={1} step={0.05} value={value}
            autoFocus
            draggable={false}
            onChange={(e) => onChange(Number(e.target.value))}
            onMouseDown={(e) => e.stopPropagation()} />
          <span className="intensity-inline-val">{Math.round(value * 100)}%</span>
        </div>
      )}
    </div>
  )
}
