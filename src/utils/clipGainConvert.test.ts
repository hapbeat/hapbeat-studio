import { describe, expect, it } from 'vitest'
import { convertClipGainText } from './clipGainConvert'

describe('convertClipGainText', () => {
  it('renames parameters.intensity in a Kit manifest and keeps the formatting', () => {
    const text = '{\n  "name": "k",\n  "events": {\n    "k.hit": { "clip": "hit.wav", "parameters": { "intensity": 0.5, "loop": false } }\n  },\n  "stream_events": {\n    "k.s": { "clip": "s.wav", "parameters": { "intensity" : 0.2 } }\n  }\n}\n'
    const res = convertClipGainText('manifest', text)
    expect(res).toEqual({ text: text.replace('"intensity": 0.5', '"clip_gain": 0.5').replace('"intensity" : 0.2', '"clip_gain" : 0.2'), count: 2 })
  })

  it('returns null when there is nothing to rename', () => {
    expect(convertClipGainText('manifest', '{"name":"k","events":{"k.hit":{"parameters":{"clip_gain":1}}}}')).toBeNull()
    expect(convertClipGainText('manifest', 'not json')).toBeNull()
  })

  it('skips a file where another "intensity" key has a different meaning', () => {
    const text = '{"name":"k","intensity":3,"events":{"k.hit":{"parameters":{"intensity":0.5}}}}'
    expect(convertClipGainText('manifest', text)).toEqual({ skip: expect.stringMatching(/different meaning/) })
  })

  it('skips an entry that has both keys', () => {
    const text = '{"name":"k","events":{"k.hit":{"parameters":{"intensity":0.5,"clip_gain":0.4}}}}'
    expect(convertClipGainText('manifest', text)).toEqual({ skip: expect.stringMatching(/both/) })
  })

  it('renames kits-meta.json, .studio-kit.json and clips-meta.json keys', () => {
    expect(convertClipGainText('kits-meta', '[{"name":"k","events":[{"eventId":"k.hit","intensity":0.3}]}]'))
      .toEqual({ text: '[{"name":"k","events":[{"eventId":"k.hit","clipGain":0.3}]}]', count: 1 })
    expect(convertClipGainText('kit-authoring', '{"name":"k","events":[{"intensity":0.3}]}'))
      .toEqual({ text: '{"name":"k","events":[{"clipGain":0.3}]}', count: 1 })
    expect(convertClipGainText('clips-meta', '[{"name":"c","libraryIntensity":0.7}]'))
      .toEqual({ text: '[{"name":"c","libraryClipGain":0.7}]', count: 1 })
  })
})
