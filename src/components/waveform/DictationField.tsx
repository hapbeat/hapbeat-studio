import { useEffect, useMemo, useReducer, useRef, useState, type TextareaHTMLAttributes } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { askMicrophone, DictationControl, insertDictation, speechRecognitionCtor } from '@/utils/speechInput'

/**
 * A comment textarea with 🎤 dictation laid over its right edge (no extra row). A short press (or Ctrl+M in
 * the field) toggles; a long press records while held; Esc or the focus leaving both the field and 🎤
 * stops. "● Listening…" / the interim text shows faintly inside the field; final text is inserted at the
 * caret through `onChange`, like typing (drafts save as usual). Errors show for 3 s under the field
 * (overlaid, no layout shift). Hidden where the browser has no speech recognition.
 */
export function DictationField({ value, onChange, className, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  const mic = useRef<HTMLButtonElement>(null)
  // The latest value / onChange for results arriving later.
  const latest = useRef({ value, onChange }); latest.current = { value, onChange }
  const Ctor = speechRecognitionCtor()
  const control = useMemo(() => Ctor ? new DictationControl(Ctor, text => {
    const el = ref.current, { value: v, onChange: change } = latest.current
    const focused = !!el && el.ownerDocument.activeElement === el
    const next = insertDictation(v, focused ? el.selectionStart : v.length, focused ? el.selectionEnd : v.length, text)
    change(next.value)
    requestAnimationFrame(() => { if (el && el.ownerDocument.activeElement === el) el.setSelectionRange(next.caret, next.caret) })
  }, askMicrophone) : null, [Ctor])
  const [, render] = useReducer((n: number) => n + 1, 0)
  useEffect(() => { if (!control) return; const off = control.subscribe(render); return () => { off(); control.dispose() } }, [control])
  // The error toast stays 3 s.
  const [toast, setToast] = useState<string | null>(null)
  const error = control?.error ?? null
  useEffect(() => { if (!error) return; setToast(error); const timer = setTimeout(() => setToast(null), 3000); return () => clearTimeout(timer) }, [error, control?.listening])
  // Grows with the text (the comment fields are one or two lines at rest).
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [value])
  const listening = !!control?.listening
  const label = t(listening ? 'editor.dictation.stop' : 'editor.dictation.start')
  const title = [label, t('editor.dictation.privacy'), ...(error ? [t('editor.dictation.error', { code: error })] : [])].join('\n')
  return <div className={`dictation-field ${control ? 'has-mic' : ''}`}>
    <textarea ref={ref} className={className} {...rest} value={value} onChange={e => onChange(e.target.value)}
      onBlur={e => control?.blur(e.relatedTarget === mic.current || e.relatedTarget === ref.current)}
      onKeyDown={e => {
        if (e.key === 'Escape' && listening) { e.preventDefault(); control?.stop() }
        else if (control && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); control.toggle() }
      }} />
    {listening && <span className="dictation-interim" aria-live="polite">{control!.interim || t('editor.dictation.listening')}</span>}
    {toast && <span className="dictation-toast" role="status">{t('editor.dictation.error', { code: toast })}</span>}
    {control && <button ref={mic} type="button" className={`dictation-mic ${listening ? 'on' : ''} ${error ? 'error' : ''}`} aria-pressed={listening} aria-label={label} title={title}
      // Keep the focus in the field (the field's blur stops dictation only when the focus leaves both).
      onMouseDown={e => e.preventDefault()}
      onPointerDown={e => { if (e.button !== 0) return; ref.current?.focus(); control.pressStart() }}
      onPointerUp={() => control.pressEnd()}
      onPointerCancel={() => control.pressEnd()}
      // Keyboard activation (Enter / Space on the button) toggles.
      onClick={e => { if (e.detail === 0) control.toggle() }}>🎤</button>}
  </div>
}
