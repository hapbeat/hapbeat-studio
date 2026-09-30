import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerMessage } from '@/types/manager'
import { sha256Hex, isSha256Hex } from './sha256'
import { helperRequest, type HelperChannel } from './helperRequest'
import {
  effectNote, lookupMaterials, provenanceLine, registerExportedDerived, summarizeResolve,
  validateProvenance, writeKitCredits, type MaterialProvenance,
} from './materials'

/** Fake helper: `reply` maps a request to the result payload (requestId is echoed automatically). */
function fakeHelper(reply: (message: ManagerMessage) => { type: string; payload: Record<string, unknown> } | null) {
  const listeners = new Set<(message: ManagerMessage) => void>()
  const sent: ManagerMessage[] = []
  const channel: HelperChannel = {
    send: message => {
      sent.push(message)
      const response = reply(message)
      if (response) queueMicrotask(() => { for (const l of listeners) l({ type: response.type, payload: { ...response.payload, requestId: message.payload.requestId } }) })
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { channel, sent, listeners }
}

const material = (site: string, needsReview = false) => ({
  sha256: 'c'.repeat(64), site, referrerUrl: `https://${site}/page/`, hostUrl: null, originalName: 'a.wav', storePath: 'store/x/a.wav',
  license: { id: 'CC-BY-4.0', name: `${site} (CC BY 4.0)`, url: 'https://example.invalid/', creditText: site, attributionRequired: true, redistributionNote: null, verified: true },
  needsReview,
})

afterEach(() => { vi.useRealTimers() })

describe('sha256Hex', () => {
  it('matches the standard test vector', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(isSha256Hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe(true)
    expect(isSha256Hex('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD')).toBe(false)
  })
})

describe('helperRequest', () => {
  it('resolves only with the result carrying the same requestId', async () => {
    const helper = fakeHelper(() => null)
    const pending = helperRequest(helper.channel, 'material_lookup', { sha256s: [] }, 'material_lookup_result')
    const requestId = helper.sent[0].payload.requestId
    for (const l of helper.listeners) l({ type: 'material_lookup_result', payload: { requestId: 'other', results: { stale: true } } })
    for (const l of helper.listeners) l({ type: 'material_lookup_result', payload: { requestId, results: {} } })
    await expect(pending).resolves.toMatchObject({ requestId, results: {} })
    expect(helper.listeners.size).toBe(0)
  })
  it('times out after 10 s and unsubscribes', async () => {
    vi.useFakeTimers()
    const helper = fakeHelper(() => null)
    const pending = helperRequest(helper.channel, 'material_credits', {}, 'material_credits_result')
    const assertion = expect(pending).rejects.toThrow(/no response/)
    vi.advanceTimersByTime(10_000)
    await assertion
    expect(helper.listeners.size).toBe(0)
  })
})

describe('provenance summary', () => {
  it('summarises material, derived and unknown results', () => {
    expect(summarizeResolve({ kind: 'material', originals: [material('maou.audio')] })).toEqual({
      kind: 'material', site: 'maou.audio', referrerUrl: 'https://maou.audio/page/',
      license: { id: 'CC-BY-4.0', name: 'maou.audio (CC BY 4.0)', creditText: 'maou.audio' }, needsReview: false,
    })
    const derived = summarizeResolve({ kind: 'derived', originals: [material('otologic.jp'), material('freesound.org', true)] })
    expect(derived).toMatchObject({ kind: 'derived', site: 'otologic.jp', needsReview: true })
    expect(summarizeResolve({ kind: 'unknown', originals: [] })).toEqual({ kind: 'unknown', site: null, referrerUrl: null, license: null, needsReview: false })
    expect(summarizeResolve({ kind: 'bogus' })).toBeNull()
    expect(validateProvenance(derived)).toBe(true)
    expect(validateProvenance({ ...derived, needsReview: 'yes' })).toBe(false)
  })
  it('picks the display line', () => {
    const known: MaterialProvenance = { kind: 'material', site: 'maou.audio', referrerUrl: null, license: { id: 'CC-BY-4.0', name: 'CC BY 4.0', creditText: null }, needsReview: true }
    expect(provenanceLine({})).toEqual({ key: 'none' })
    expect(provenanceLine({ sourceSha256: 'a'.repeat(64) })).toEqual({ key: 'notLooked' })
    expect(provenanceLine({ provenance: { ...known, kind: 'unknown', site: null } })).toEqual({ key: 'unknown' })
    expect(provenanceLine({ provenance: known })).toEqual({ key: 'known', site: 'maou.audio', license: 'CC BY 4.0', needsReview: true })
  })
})

describe('helper calls', () => {
  it('looks up hashes in batches of at most 500', async () => {
    const shas = Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(64, '0'))
    const helper = fakeHelper(message => ({ type: 'material_lookup_result', payload: {
      results: Object.fromEntries((message.payload.sha256s as string[]).map(sha => [sha, { kind: 'material', originals: [material('kenney.nl')] }])),
    } }))
    const found = await lookupMaterials(helper.channel, [...shas, shas[0], 'not-a-hash'])
    expect(helper.sent.map(m => (m.payload.sha256s as string[]).length)).toEqual([500, 1])
    expect(found.size).toBe(501)
    expect(found.get(shas[500])?.site).toBe('kenney.nl')
  })
  it('registers an exported WAV as derived from the clip source', async () => {
    const helper = fakeHelper(() => ({ type: 'material_register_derived_result', payload: { ok: true } }))
    const effects = [
      { id: '1', enabled: true, params: { type: 'lpf' as const, frequency: 200, Q: 1 } },
      { id: '2', enabled: false, params: { type: 'gain' as const, gainDb: 3 } },
    ]
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    expect(await registerExportedDerived(helper.channel, { blob, parentSha256: 'd'.repeat(64), name: 'hit', effects })).toBe(true)
    expect(helper.sent[0]).toMatchObject({ type: 'material_register_derived', payload: {
      sha256: await sha256Hex(await blob.arrayBuffer()), parents: ['d'.repeat(64)], tool: 'hapbeat-studio-editor', name: 'hit', note: 'lpf 200Hz',
    } })
    expect(await registerExportedDerived(null, { blob, parentSha256: 'd'.repeat(64), name: 'hit' })).toBe(false)
    expect(await registerExportedDerived(helper.channel, { blob, name: 'hit' })).toBe(false)
    expect(helper.sent).toHaveLength(1)
    expect(effectNote([{ id: '1', enabled: true, params: { type: 'am', rateHz: 18, depth: 1, shape: 'sine', jitter: 0, seed: 1 } }])).toBe('am 18Hz')
  })
})

describe('writeKitCredits', () => {
  const sources = () => [new Blob(['a']), new Blob(['a']), new Blob(['b'])]
  it('writes the helper markdown for the distinct source hashes', async () => {
    const helper = fakeHelper(() => ({ type: 'material_credits_result', payload: { markdown: '# Credits\n' } }))
    const write = vi.fn(async (_markdown: string) => {})
    expect(await writeKitCredits({ channel: helper.channel, sources: sources(), write })).toBe('written')
    expect(helper.sent[0].payload.sha256s).toHaveLength(2)
    expect(helper.sent[0].payload.toolName).toBe('hapbeat-studio')
    expect(write).toHaveBeenCalledWith('# Credits\n')
  })
  it('writes nothing without a helper or without sources', async () => {
    const write = vi.fn(async (_markdown: string) => {})
    expect(await writeKitCredits({ channel: null, sources: sources(), write })).toBe('no-helper')
    const helper = fakeHelper(() => ({ type: 'material_credits_result', payload: { markdown: 'x' } }))
    expect(await writeKitCredits({ channel: helper.channel, sources: [], write })).toBe('no-sources')
    expect(write).not.toHaveBeenCalled()
    expect(helper.sent).toHaveLength(0)
  })
  it('fails without writing when the helper returns no markdown', async () => {
    const helper = fakeHelper(() => ({ type: 'material_credits_result', payload: {} }))
    const write = vi.fn(async (_markdown: string) => {})
    await expect(writeKitCredits({ channel: helper.channel, sources: sources(), write })).rejects.toThrow(/no markdown/)
    expect(write).not.toHaveBeenCalled()
  })
})
