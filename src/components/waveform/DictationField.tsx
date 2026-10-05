import { useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { insertDictation, speechRecognitionCtor, startDictation } from '@/utils/speechInput'

/**
 * A comment textarea with 🎤 dictation laid over its right edge (no extra row). The button (or Ctrl+M in the
 * field) starts / stops; Esc or leaving the field stops. Interim text shows faintly inside the field; final
 * text is inserted at the caret through `onChange`, like typing (drafts save as usual). Hidden where the
 * browser has no speech recognition.
 */
export function DictationField({ value, onChange, className, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  // The latest value / onChange for results arriving later.
  const latest = useRef({ value, onChange }); latest.current = { value, onChange }
  const Ctor = speechRecognitionCtor()
  // Grows with the text (the comment fields are one or two lines at rest).
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [value])
  useEffect(() => () => stopRef.current?.(), [])
  const stop = () => stopRef.current?.()
  const start = () => {
    if (!Ctor) return
    setError(null)
    ref.current?.focus()
    stopRef.current = startDictation(Ctor, {
      onInterim: setInterim,
      onFinal: text => {
        const el = ref.current, { value: v, onChange: change } = latest.current
        const at = el && document.activeElement === el ? el.selectionStart : v.length
        const end = el && document.activeElement === el ? el.selectionEnd : v.length
        const next = insertDictation(v, at, end, text)
        change(next.value)
        requestAnimationFrame(() => { if (el && document.activeElement === el) el.setSelectionRange(next.caret, next.caret) })
      },
      onEnd: () => { stopRef.current = null; setListening(false) },
      onError: code => setError(code),
    })
    setListening(true)
  }
  const toggle = () => { if (listening) stop(); else start() }
  const title = [t(listening ? 'editor.dictation.stop' : 'editor.dictation.start'), t('editor.dictation.privacy'), ...(error ? [t('editor.dictation.error', { code: error })] : [])].join('\n')
  return <div className={`dictation-field ${Ctor ? 'has-mic' : ''}`}>
    <textarea ref={ref} className={className} {...rest} value={value} onChange={e => onChange(e.target.value)}
      onBlur={() => { if (listening) stop() }}
      onKeyDown={e => {
        if (e.key === 'Escape' && listening) { e.preventDefault(); stop() }
        else if (Ctor && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); toggle() }
      }} />
    {interim && <span className="dictation-interim" aria-hidden="true">{interim}</span>}
    {Ctor && <button type="button" className={`dictation-mic ${listening ? 'on' : ''} ${error ? 'error' : ''}`} aria-pressed={listening} aria-label={t(listening ? 'editor.dictation.stop' : 'editor.dictation.start')} title={title}
      // Keep the focus in the field (leaving it stops dictation).
      onMouseDown={e => e.preventDefault()} onClick={toggle}>🎤</button>}
  </div>
}
