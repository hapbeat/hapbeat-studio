import { describe, expect, it } from 'vitest'
import { rewriteViewerDataGains } from './viewerDataGains'

/** Written like the recorder (Python json.dump, indent 2, CRLF, non-ASCII kept, `13.0`). */
const FILE = [
  '{',
  '  "schema_version": 1,',
  '  "fps": 60,',
  '  "video": "a.mp4",',
  '  "events": [',
  '    {',
  '      "t": 0.55,',
  '      "name": "bound_toss",',
  '      "gain": 0.588',
  '    },',
  '    {',
  '      "t": 13.0,',
  '      "name": "stroke_weak",',
  '      "note": "打つ \\"強く\\""',
  '    },',
  '    {"t": 14, "name": "x"}',
  '  ],',
  '  "levels": {"columns": ["a:level"], "rows": [[0.0], [1.0]]}',
  '}',
  '',
].join('\r\n')

describe('rewriteViewerDataGains', () => {
  it('changes only the gain value, keeping every other byte', () => {
    const r = rewriteViewerDataGains(FILE, [{ index: 0, name: 'bound_toss', t: 0.55, gain: 0.294 }])
    expect(r).toEqual({ ok: true, text: FILE.replace('"gain": 0.588', '"gain": 0.294') })
  })
  it('writes the value it is given exactly (an undo restores 0.8234567, not 0.823); the same number in another form stays', () => {
    const r = rewriteViewerDataGains(FILE, [{ index: 0, name: 'bound_toss', t: 0.55, gain: 0.8234567 }])
    expect(r).toEqual({ ok: true, text: FILE.replace('"gain": 0.588', '"gain": 0.8234567') })
    const one = FILE.replace('"gain": 0.588', '"gain": 1.0')
    expect(rewriteViewerDataGains(one, [{ index: 0, name: 'bound_toss', t: 0.55, gain: 1 }])).toEqual({ ok: true, text: one })
  })
  it('inserts an absent gain after the last member in its style (indentation, line ending)', () => {
    const r = rewriteViewerDataGains(FILE, [{ index: 1, name: 'stroke_weak', t: 13, gain: 0.5 }, { index: 2, name: 'x', t: 14, gain: 2 }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe(FILE
      .replace('"note": "打つ \\"強く\\""', '"note": "打つ \\"強く\\"",\r\n      "gain": 0.5')
      .replace('{"t": 14, "name": "x"}', '{"t": 14, "name": "x", "gain": 2}'))
    expect(r.text.endsWith('}\r\n')).toBe(true)
    expect(r.text).toContain('"t": 13.0,')
    expect(JSON.parse(r.text).events.map((e: { gain?: number }) => e.gain)).toEqual([0.588, 0.5, 2])
  })
  it('an absent gain that is still 1 stays absent; a present one is written as 1', () => {
    expect(rewriteViewerDataGains(FILE, [{ index: 1, name: 'stroke_weak', t: 13, gain: 1 }])).toEqual({ ok: true, text: FILE })
    const r = rewriteViewerDataGains(FILE, [{ index: 0, name: 'bound_toss', t: 0.55, gain: 1 }])
    expect(r.ok && r.text.includes('"gain": 1\r\n')).toBe(true)
  })
  it('refuses when the firing at the index is not the one read (name, time, index)', () => {
    expect(rewriteViewerDataGains(FILE, [{ index: 0, name: 'stroke_weak', t: 0.55, gain: 0.5 }])).toEqual({ ok: false, reason: 'mismatch', index: 0 })
    expect(rewriteViewerDataGains(FILE, [{ index: 0, name: 'bound_toss', t: 0.6, gain: 0.5 }])).toEqual({ ok: false, reason: 'mismatch', index: 0 })
    expect(rewriteViewerDataGains(FILE, [{ index: 9, name: 'x', t: 1, gain: 0.5 }])).toEqual({ ok: false, reason: 'mismatch', index: 9 })
  })
  it('a file it cannot read is refused, not rewritten', () => {
    expect(rewriteViewerDataGains('{"events": [', [{ index: 0, name: 'x', t: 0, gain: 2 }]).ok).toBe(false)
    expect(rewriteViewerDataGains('{"fps": 1}', [])).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
