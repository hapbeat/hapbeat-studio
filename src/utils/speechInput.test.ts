import { describe, expect, it, vi } from 'vitest'
import { insertDictation, speechRecognitionCtor, startDictation, type Recognition } from './speechInput'

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

  it('runs ja-JP continuous with interim results; final pieces and interim text go to their handlers', () => {
    const h = handlers()
    startDictation(MockRecognition, h)
    const r = last()
    expect(r).toMatchObject({ lang: 'ja-JP', continuous: true, interimResults: true, started: true })
    r.result(0, [['もっと', false]])
    expect(h.onInterim).toHaveBeenLastCalledWith('もっと')
    r.result(0, [['もっと重く', true], ['して', false]])
    expect(h.onFinal).toHaveBeenCalledWith('もっと重く')
    expect(h.onInterim).toHaveBeenLastCalledWith('して')
    r.onend?.() // silence: the browser ends it
    expect(h.onEnd).toHaveBeenCalledTimes(1)
    expect(h.onInterim).toHaveBeenLastCalledWith('')
  })

  it('one at a time: starting in another field stops the previous one; errors are reported (aborted / no-speech are not)', () => {
    const a = handlers(), b = handlers()
    startDictation(MockRecognition, a)
    const first = last()
    const stopB = startDictation(MockRecognition, b)
    expect(first.stopped).toBe(true)
    expect(a.onEnd).toHaveBeenCalledTimes(1)
    const second = last()
    second.onerror?.({ error: 'no-speech' })
    second.onerror?.({ error: 'not-allowed' })
    expect(b.onError).toHaveBeenCalledTimes(1)
    expect(b.onError).toHaveBeenCalledWith('not-allowed')
    stopB()
    expect(second.stopped).toBe(true)
    expect(b.onEnd).toHaveBeenCalledTimes(1)
  })
})
