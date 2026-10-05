/**
 * Dictation into the AI trials comment fields (Web Speech API). The browser sends the audio to its
 * speech service (Chrome: Google, Edge: Microsoft). One recognition runs at a time: starting another
 * stops the previous one.
 */

type Handler = (() => void) | null
/** The part of SpeechRecognition used here (the DOM lib does not type it). */
export interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: Handler
  onstart?: Handler
  onaudiostart?: Handler
  onspeechstart?: Handler
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
  /** Ended (stopped, silence, another field started, or after an error) — always called once per start. */
  onEnd: () => void
  onError: (code: string) => void
}

/** Errors after which the recognition cannot go on (it is stopped at once; onend then resets the field). */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'])
const debug = (...args: unknown[]) => console.debug('[speech]', ...args)

let active: { recognition: Recognition; handlers: DictationHandlers; ended: boolean } | null = null

/** Starts dictation (ja-JP, continuous, interim results), stopping any other one first. Returns the stop function. */
export function startDictation(Ctor: RecognitionCtor, handlers: DictationHandlers): () => void {
  stopDictation()
  const recognition = new Ctor()
  recognition.lang = 'ja-JP'
  recognition.continuous = true
  recognition.interimResults = true
  const session = { recognition, handlers, ended: false }
  const end = () => {
    if (session.ended) return
    session.ended = true
    if (active === session) active = null
    handlers.onInterim('')
    handlers.onEnd()
  }
  recognition.onstart = () => debug('start')
  recognition.onaudiostart = () => debug('audiostart')
  recognition.onspeechstart = () => debug('speechstart')
  recognition.onresult = event => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i], text = result[0]?.transcript ?? ''
      debug('result', { final: result.isFinal, text })
      if (result.isFinal) handlers.onFinal(text); else interim += text
    }
    handlers.onInterim(interim)
  }
  recognition.onerror = event => {
    debug('error', event.error)
    if (event.error === 'aborted') return
    handlers.onError(event.error)
    if (FATAL.has(event.error)) { try { recognition.stop() } catch { /* already ended */ } end() }
  }
  recognition.onend = () => { debug('end'); end() }
  active = session
  try { recognition.start() } catch (error) { handlers.onError(error instanceof Error ? error.message : String(error)); end() }
  return () => { if (active === session) stopDictation() }
}

/** Stops the running dictation; its onEnd is called here (once). */
export function stopDictation() {
  const current = active
  if (!current) return
  active = null
  try { current.recognition.stop() } catch { /* already ended */ }
  if (!current.ended) { current.ended = true; current.handlers.onInterim(''); current.handlers.onEnd() }
}

export const LONG_PRESS_MS = 300

/**
 * What one comment field's 🎤 does, apart from the DOM: a short press toggles, a long press (> 300 ms)
 * records while held; leaving the field stops only when the focus is on neither the field nor its 🎤.
 * `permission` asks for the microphone first (getUserMedia; the track is stopped at once).
 */
export class DictationControl {
  listening = false
  interim = ''
  error: string | null = null
  private stopFn: (() => void) | null = null
  private press: { at: number; started: boolean } | null = null
  private listeners = new Set<() => void>()
  constructor(private Ctor: RecognitionCtor, private insert: (text: string) => void,
    private permission: () => Promise<void> = async () => {}, private now: () => number = () => Date.now()) {}

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed() { for (const l of this.listeners) l() }

  async start() {
    if (this.listening) return
    this.error = null
    this.listening = true
    this.changed()
    try { await this.permission() } catch (error) {
      const name = (error as { name?: string })?.name
      this.error = name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : name === 'NotFoundError' ? 'audio-capture' : String(name ?? error)
      this.listening = false
      this.changed()
      return
    }
    if (!this.listening) return // stopped while asking
    this.stopFn = startDictation(this.Ctor, {
      onInterim: text => { this.interim = text; this.changed() },
      onFinal: text => this.insert(text),
      onEnd: () => { this.stopFn = null; this.listening = false; this.interim = ''; this.changed() },
      onError: code => { this.error = code; this.changed() },
    })
  }
  stop() {
    if (this.stopFn) this.stopFn()
    this.stopFn = null
    if (this.listening) { this.listening = false; this.interim = ''; this.changed() }
  }
  toggle() { if (this.listening) this.stop(); else void this.start() }
  /** Pointer down on 🎤: starts (a long press then records while held), or marks a press that will stop. */
  pressStart() {
    this.press = { at: this.now(), started: !this.listening }
    if (!this.listening) void this.start()
  }
  /** Pointer up: a press that started and was held > 300 ms stops; a press on a running one stops (toggle). */
  pressEnd() {
    const press = this.press
    this.press = null
    if (!press) return
    if (!press.started || this.now() - press.at > LONG_PRESS_MS) this.stop()
  }
  /** The field lost focus to `next` (null = left the page): stops unless it went to the field or its 🎤. */
  blur(nextIsFieldOrMic: boolean) { if (this.listening && !nextIsFieldOrMic) this.stop() }
  dispose() { this.stop(); this.listeners.clear() }
}

/** Asks for the microphone once before recognizing (the first-use prompt), releasing it at once. */
export async function askMicrophone() {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media?.getUserMedia) return
  const stream = await media.getUserMedia({ audio: true })
  stream.getTracks().forEach(track => track.stop())
}
