/**
 * Dictation into the AI trials comment fields (Web Speech API). The browser sends the audio to its
 * speech service (Chrome: Google, Edge: Microsoft). One recognition runs at a time: starting another
 * stops the previous one.
 */

/** The part of SpeechRecognition used here (the DOM lib does not type it). */
export interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
export type RecognitionCtor = new () => Recognition

/** `SpeechRecognition || webkitSpeechRecognition`, or null where the browser has neither. */
export function speechRecognitionCtor(win: unknown = typeof window === 'undefined' ? undefined : window): RecognitionCtor | null {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null
}

/** Inserts `text` at the selection, with a separating space after existing text; returns the new value and caret. */
export function insertDictation(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const piece = text.trim()
  if (!piece) return { value, caret: end }
  const before = value.slice(0, start), after = value.slice(end)
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  const next = `${before}${sep}${piece}${after}`
  return { value: next, caret: before.length + sep.length + piece.length }
}

export interface DictationHandlers {
  /** Not yet final text (shown faintly). */
  onInterim: (text: string) => void
  /** A final piece, to insert at the caret. */
  onFinal: (text: string) => void
  /** Ended (stopped, silence, another field started, or after an error). */
  onEnd: () => void
  onError: (code: string) => void
}

let active: { recognition: Recognition; handlers: DictationHandlers } | null = null

/** Starts dictation (ja-JP, continuous, interim results), stopping any other one first. Returns the stop function. */
export function startDictation(Ctor: RecognitionCtor, handlers: DictationHandlers): () => void {
  stopDictation()
  const recognition = new Ctor()
  recognition.lang = 'ja-JP'
  recognition.continuous = true
  recognition.interimResults = true
  const session = { recognition, handlers }
  recognition.onresult = event => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i], text = result[0]?.transcript ?? ''
      if (result.isFinal) handlers.onFinal(text); else interim += text
    }
    handlers.onInterim(interim)
  }
  recognition.onerror = event => { if (event.error !== 'aborted' && event.error !== 'no-speech') handlers.onError(event.error) }
  recognition.onend = () => { if (active === session) active = null; handlers.onInterim(''); handlers.onEnd() }
  active = session
  try { recognition.start() } catch (error) { active = null; handlers.onError(error instanceof Error ? error.message : String(error)); handlers.onEnd() }
  return () => { if (active === session) stopDictation() }
}

/** Stops the running dictation (its onEnd follows from the recognition's own end event, and is also called here). */
export function stopDictation() {
  const current = active
  if (!current) return
  active = null
  current.recognition.onend = null
  try { current.recognition.stop() } catch { /* already ended */ }
  current.handlers.onInterim('')
  current.handlers.onEnd()
}
