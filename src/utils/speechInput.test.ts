import { afterEach, describe, expect, it, vi } from 'vitest'
import { DictationControl, insertDictation, speechRecognitionCtor, startDictation, stopDictation, type Recognition } from './speechInput'

class MockRecognition implements Recognition {
  static instances: MockRecognition[] = []
  lang = ''; continuous = false; interimResults = false
  onresult: Recognition['onresult'] = null
  onerror: Recognition['onerror'] = null
  onend: Recognition['onend'] = null
  started = false; stopped = false
  constructor() { MockRecognition.instances.push(this) }
  start() { this.started = true }
  stop() { this.stopped = true; this.onend?.() }
  result(resultIndex: number, items: [string, boolean][]) {
    this.onresult?.({ resultIndex, results: items.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) })
  }
}
const last = () => MockRecognition.instances[MockRecognition.instances.length - 1]
const handlers = () => ({ onInterim: vi.fn(), onFinal: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
afterEach(() => { stopDictation(); vi.restoreAllMocks() })
vi.spyOn(console, 'debug').mockImplementation(() => {})

describe('dictation', () => {
  it('finds the API (standard or webkit), or none', () => {
    expect(speechRecognitionCtor({ webkitSpeechRecognition: MockRecognition })).toBe(MockRecognition)
    expect(speechRecognitionCtor({ SpeechRecognition: MockRecognition, webkitSpeechRecognition: Object })).toBe(MockRecognition)
    expect(speechRecognitionCtor({})).toBeNull()
  })

  it('inserts at the caret with a separating space after existing text', () => {
    expect(insertDictation('', 0, 0, ' もっと重く ')).toEqual({ value: 'もっと重く', caret: 5 })
    expect(insertDictation('B が近い', 5, 5, 'もっと重く')).toEqual({ value: 'B が近い もっと重く', caret: 11 })
    expect(insertDictation('B が近い。', 0, 0, '全体に')).toEqual({ value: '全体にB が近い。', caret: 3 }) // at the start: no separator
    expect(insertDictation('ab ', 3, 3, 'c')).toEqual({ value: 'ab c', caret: 4 })
    expect(insertDictation('abc', 1, 2, 'X')).toEqual({ value: 'a Xc', caret: 3 })
    expect(insertDictation('abc', 3, 3, '  ')).toEqual({ value: 'abc', caret: 3 })
  })

  it('runs ja-JP continuous with interim results; onend (silence) always ends it once', () => {
    const h = handlers()
    startDictation(MockRecognition, h)
    const r = last()
    expect(r).toMatchObject({ lang: 'ja-JP', continuous: true, interimResults: true, started: true })
    r.result(0, [['もっと', false]])
    expect(h.onInterim).toHaveBeenLastCalledWith('もっと')
    r.result(0, [['もっと重く', true], ['して', false]])
    expect(h.onFinal).toHaveBeenCalledWith('もっと重く')
    expect(h.onInterim).toHaveBeenLastCalledWith('して')
    r.onend?.()
    r.onend?.()
    expect(h.onEnd).toHaveBeenCalledTimes(1)
    expect(h.onInterim).toHaveBeenLastCalledWith('')
  })

  it('one at a time; fatal errors end it; aborted is silent', () => {
    const a = handlers(), b = handlers()
    startDictation(MockRecognition, a)
    const first = last()
    startDictation(MockRecognition, b)
    expect(first.stopped).toBe(true)
    expect(a.onEnd).toHaveBeenCalledTimes(1)
    const second = last()
    second.onerror?.({ error: 'aborted' })
    expect(b.onError).not.toHaveBeenCalled()
    second.onerror?.({ error: 'not-allowed' })
    expect(b.onError).toHaveBeenCalledWith('not-allowed')
    expect(b.onEnd).toHaveBeenCalledTimes(1)
  })
})

describe('dictation control (one field)', () => {
  const make = (now = { t: 0 }, permission: () => Promise<void> = async () => {}) => {
    const inserted: string[] = []
    const control = new DictationControl(MockRecognition, text => inserted.push(text), permission, () => now.t)
    return { control, inserted, now }
  }

  it('asks for the microphone first, then recognizes; a refusal is reported and leaves it stopped', async () => {
    const { control } = make()
    await control.start()
    expect(control.listening).toBe(true)
    expect(last().started).toBe(true)
    const refused = make({ t: 0 }, async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) }).control
    await refused.start()
    expect(refused).toMatchObject({ listening: false, error: 'not-allowed' })
  })

  it('a blur to the field or its 🎤 does not stop it; a blur elsewhere does; onend resets the state', async () => {
    const { control, inserted } = make()
    await control.start()
    control.blur(true)
    expect(control.listening).toBe(true)
    expect(last().stopped).toBe(false)
    last().result(0, [['重く', true]])
    expect(inserted).toEqual(['重く'])
    last().onend?.() // silence: the browser ends it
    expect(control).toMatchObject({ listening: false, interim: '' })
    await control.start()
    control.blur(false)
    expect(control.listening).toBe(false)
    expect(last().stopped).toBe(true)
  })

  it('a short press toggles; a long press (> 300 ms) records while held', async () => {
    const { control, now } = make()
    control.pressStart(); await flush(); now.t = 100; control.pressEnd()
    expect(control.listening).toBe(true) // short: stays on
    now.t = 1000; control.pressStart(); now.t = 1050; control.pressEnd()
    expect(control.listening).toBe(false) // a press on a running one stops
    now.t = 2000; control.pressStart(); await flush(); now.t = 2500; control.pressEnd()
    expect(control.listening).toBe(false) // long: stops on release
  })
})
