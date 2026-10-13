import { describe, expect, it } from 'vitest'
import { buildCatalog, type ArrayParam } from './agentGuide'
import { trialRequestError } from './agentProtocol'
import type { ParamRange } from './effectRanges'

/** A value inside `range` (the middle of a bounded range, the first enum value, true). */
function inside(range: ParamRange): unknown {
  if (range.kind === 'boolean') return true
  if (range.enum) return range.enum[0]
  if (range.values) return range.values[0]
  const min = range.min ?? 0, mid = range.max === undefined ? min + 1 : (min + range.max) / 2
  return range.kind === 'integer' ? Math.round(mid) : mid
}
const isArrayParam = (p: ParamRange | ArrayParam): p is ArrayParam => 'items' in p

/** An effect object built only from what catalog.json says about the type. */
function fromCatalog(type: string, params: Record<string, ParamRange | ArrayParam>): Record<string, unknown> {
  const out: Record<string, unknown> = { type }
  for (const [key, p] of Object.entries(params)) {
    if (!isArrayParam(p)) { out[key] = inside(p); continue }
    // Items spread from each field's min to max (envelope times 0 … 1 strictly increasing).
    const n = Math.max(2, p.minItems)
    out[key] = Array.from({ length: n }, (_, i) => Object.fromEntries(Object.entries(p.items).map(([f, r]) =>
      [f, r.min !== undefined && r.max !== undefined ? r.min + (r.max - r.min) * i / (n - 1) : inside(r)])))
  }
  // The one cross-field rule the ranges cannot say: a trim / cut range ends after it starts.
  if ('start' in out && 'end' in out) out.end = (out.start as number) + 1
  return out
}
const trialWith = (effect: unknown) => ({
  format: 'hapbeat-trial@1', id: 'catalog-shape', intent: 'create', prompt: 'catalog shape', terms: ['test'],
  candidates: [{ id: 'A', label: 'A', source: { kind: 'file', path: 'sources/a.wav' }, effects: [effect] }],
})

describe('catalog.json effectTypes', () => {
  const { effectTypes } = buildCatalog([], '0.0.0', '2026-10-14T00:00:00+09:00')

  it('every effect type, written the way catalog.json describes it, passes trial validation', () => {
    for (const [type, entry] of Object.entries(effectTypes)) {
      expect([type, trialRequestError(trialWith(entry.example))]).toEqual([type, null])
      expect([type, trialRequestError(trialWith(fromCatalog(type, entry.params)))]).toEqual([type, null])
    }
  })

  it('describes array fields as arrays (eq bands, envelope points), not as flat fields', () => {
    expect(effectTypes.eq.params).toEqual({ bands: expect.objectContaining({ minItems: 1, items: expect.objectContaining({ frequency: expect.anything(), gain: expect.anything(), Q: expect.anything() }) }) })
    expect(trialRequestError(trialWith({ type: 'eq', frequency: 90, gain: 6, Q: 0.8 }))).not.toBeNull()
    expect(trialRequestError(trialWith({ type: 'eq', bands: [{ frequency: 90, gain: 6, Q: 0.8 }] }))).toBeNull()
    expect(effectTypes.envelope.params).toEqual({ points: expect.objectContaining({ minItems: 2 }) })
  })
})
