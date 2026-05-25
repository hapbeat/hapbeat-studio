import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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
      title="スライダで 5% step / 数字をクリックで直接入力"
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
      <IntensityValueEditor
        value={value}
        onChange={onChange}
        className="intensity-inline-val"
      />
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
        <IntensityValueEditor
          value={value}
          onChange={onChange}
          className="intensity-popover-val"
        />
      </button>
      {open && (
        <div className="intensity-popover-panel">
          <span className="intensity-inline-label">{label}</span>
          <input type="range" min={0} max={1} step={0.05} value={value}
            autoFocus
            draggable={false}
            onChange={(e) => onChange(Number(e.target.value))}
            onMouseDown={(e) => e.stopPropagation()} />
          <IntensityValueEditor
            value={value}
            onChange={onChange}
            className="intensity-inline-val"
          />
        </div>
      )}
    </div>
  )
}

/**
 * Click-to-edit value badge for amp / intensity displays.
 *
 * Default render is a plain `<span>` showing `NN%` (rounded to integer).
 * Clicking the span turns it into an inline `<input type="number">`
 * with focus + select-all so the user can type a new percentage
 * directly (e.g. `12` for 12%). Enter / blur commits, Escape cancels.
 *
 * Used in both the inline slider and the popover variants of
 * IntensityControl — the 5%-step slider stays exactly the same, this
 * just adds a "direct typing" path next to it.
 *
 * Commit rules:
 *   - Input is clamped to 0..100 and rounded to integer
 *   - Empty / NaN cancels (preserves previous value)
 *   - onChange receives 0..1 (matches the rest of the API)
 *
 * Event handling:
 *   - `e.stopPropagation()` on click/mousedown so the click doesn't
 *     toggle the parent popover button or move keyboard selection
 *   - `e.stopPropagation()` on keydown so global keyboard shortcuts
 *     (Space play / ↑↓←→ navigation) don't fire while typing
 */
function IntensityValueEditor({
  value, onChange, className, style,
}: {
  value: number
  onChange: (v: number) => void
  className?: string
  style?: CSSProperties
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setDraft(String(Math.round(value * 100)))
    setEditing(true)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed !== '') {
      const n = Number(trimmed)
      if (!Number.isNaN(n)) {
        const clamped = Math.max(0, Math.min(100, Math.round(n)))
        onChange(clamped / 100)
      }
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0} max={100} step={1}
        className={`${className ?? ''} intensity-value-input`}
        style={style}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className={className}
      style={{ cursor: 'text', ...style }}
      title="クリックで直接入力 (0-100)"
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      onClick={startEdit}
    >
      {Math.round(value * 100)}%
    </span>
  )
}
