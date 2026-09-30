/**
 * Material provenance (helper material ledger, see
 * docs/instructions-material-provenance). Studio only hashes files and asks the
 * helper; the ledger, license rules and credit text live in the helper.
 */
import type { EffectEntry } from '@/types/waveform'
import { helperRequest, type HelperChannel } from './helperRequest'
import { isSha256Hex, sha256Hex } from './sha256'

/** Stored per clip in project.json so the line still shows without the helper. */
export interface MaterialProvenance {
  kind: 'material' | 'derived' | 'unknown'
  site: string | null
  referrerUrl: string | null
  license: { id: string; name: string; creditText: string | null } | null
  needsReview: boolean
}

export const EDITOR_TOOL_NAME = 'hapbeat-studio-editor'
export const KIT_CREDITS_TOOL_NAME = 'hapbeat-studio'
export const KIT_CREDITS_FILENAME = 'CREDITS.md'
const LOOKUP_BATCH = 500
const MAX_TEXT = 2048

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === 'string' && value.length <= MAX_TEXT ? value : null
const isText = (value: unknown) => typeof value === 'string' && value.length <= MAX_TEXT
const isNullableText = (value: unknown) => value === null || isText(value)

export function validateProvenance(value: unknown): value is MaterialProvenance {
  if (!isRecord(value)) return false
  if (!['material', 'derived', 'unknown'].includes(value.kind as string)) return false
  if (!isNullableText(value.site) || !isNullableText(value.referrerUrl) || typeof value.needsReview !== 'boolean') return false
  const license = value.license
  return license === null || (isRecord(license) && isText(license.id) && isText(license.name) && isNullableText(license.creditText))
}

/**
 * Reduces one helper `resolve` result to the clip summary. The first original
 * supplies site / license; `needsReview` is true when any original needs review.
 * Returns null for a malformed result.
 */
export function summarizeResolve(result: unknown): MaterialProvenance | null {
  if (!isRecord(result) || !['material', 'derived', 'unknown'].includes(result.kind as string)) return null
  const originals = Array.isArray(result.originals) ? result.originals.filter(isRecord) : []
  const first = originals[0]
  if (result.kind === 'unknown' || !first) return { kind: 'unknown', site: null, referrerUrl: null, license: null, needsReview: false }
  const license = isRecord(first.license) && text(first.license.id) !== null
    ? { id: text(first.license.id)!, name: text(first.license.name) ?? text(first.license.id)!, creditText: text(first.license.creditText) }
    : null
  return {
    kind: result.kind as MaterialProvenance['kind'],
    site: text(first.site),
    referrerUrl: text(first.referrerUrl),
    license,
    needsReview: originals.some(original => original.needsReview === true),
  }
}

export type ProvenanceLine =
  | { key: 'none' }
  | { key: 'notLooked' }
  | { key: 'unknown' }
  | { key: 'known'; site: string; license: string; needsReview: boolean }

/** What the fixed-height provenance line of a clip shows. */
export function provenanceLine(clip: { sourceSha256?: string; provenance?: MaterialProvenance }): ProvenanceLine {
  const p = clip.provenance
  if (!p) return clip.sourceSha256 ? { key: 'notLooked' } : { key: 'none' }
  if (p.kind === 'unknown' || !p.site) return { key: 'unknown' }
  return { key: 'known', site: p.site, license: p.license?.name ?? '?', needsReview: p.needsReview }
}

/** `material_lookup` for up to any number of hashes (batched ≤500 per request). */
export async function lookupMaterials(channel: HelperChannel, sha256s: string[]): Promise<Map<string, MaterialProvenance>> {
  const unique = [...new Set(sha256s.filter(isSha256Hex))]
  const found = new Map<string, MaterialProvenance>()
  for (let i = 0; i < unique.length; i += LOOKUP_BATCH) {
    const batch = unique.slice(i, i + LOOKUP_BATCH)
    const reply = await helperRequest(channel, 'material_lookup', { sha256s: batch }, 'material_lookup_result')
    const results = isRecord(reply.results) ? reply.results : {}
    for (const sha of batch) {
      const summary = summarizeResolve(results[sha])
      if (summary) found.set(sha, summary)
    }
  }
  return found
}

function round(value: number) { return Number(value.toFixed(2)) }

/** Short human summary of the enabled effect chain, e.g. "lpf 200Hz, am 18Hz". */
export function effectNote(effects: EffectEntry[] | undefined): string {
  return (effects ?? []).filter(effect => effect.enabled).map(({ params: p }) => {
    switch (p.type) {
      case 'lpf': case 'hpf': case 'bpf': return `${p.type} ${round(p.frequency)}Hz`
      case 'am': return `am ${round(p.rateHz)}Hz`
      case 'gain': return `gain ${round(p.gainDb)}dB`
      case 'repitch': case 'pitch-shift': return `${p.type} ${round(p.semitones)}st`
      case 'time-stretch': return `time-stretch x${round(p.rate)}`
      case 'freq-shift': return `freq-shift ${round(p.shiftHz)}Hz`
      case 'trim': case 'cut': return `${p.type} ${round(p.start)}-${round(p.end)}s`
      default: return p.type
    }
  }).join(', ')
}

/**
 * After an editor export: registers the written WAV as derived from the clip's
 * source. Returns false (nothing sent, nothing hashed) without a helper or a
 * known source hash.
 */
export async function registerExportedDerived(
  channel: HelperChannel | null,
  exported: { blob: Blob; parentSha256?: string; name: string; effects?: EffectEntry[] },
  hash: (bytes: ArrayBuffer) => Promise<string> = sha256Hex,
): Promise<boolean> {
  if (!channel || !isSha256Hex(exported.parentSha256)) return false
  const sha256 = await hash(await exported.blob.arrayBuffer())
  const note = effectNote(exported.effects)
  const reply = await helperRequest(channel, 'material_register_derived', {
    sha256, parents: [exported.parentSha256], tool: EDITOR_TOOL_NAME, name: exported.name, ...(note ? { note } : {}),
  }, 'material_register_derived_result')
  if (reply.ok !== true) throw new Error('material_register_derived: helper did not accept the record')
  return true
}

export type KitCreditsOutcome = 'written' | 'no-helper' | 'no-sources'

/**
 * Kit save: asks the helper for CREDITS.md covering every source WAV and hands
 * it to `write`. Without a helper nothing is written (an existing CREDITS.md
 * stays untouched). Throws when the helper request fails.
 */
export async function writeKitCredits(deps: {
  channel: HelperChannel | null
  sources: Blob[]
  write: (markdown: string) => Promise<void>
  hash?: (bytes: ArrayBuffer) => Promise<string>
}): Promise<KitCreditsOutcome> {
  if (!deps.channel) return 'no-helper'
  if (deps.sources.length === 0) return 'no-sources'
  const hash = deps.hash ?? sha256Hex
  const sha256s = [...new Set(await Promise.all([...new Set(deps.sources)].map(async blob => hash(await blob.arrayBuffer()))))]
  const reply = await helperRequest(deps.channel, 'material_credits', { sha256s, toolName: KIT_CREDITS_TOOL_NAME }, 'material_credits_result')
  if (typeof reply.markdown !== 'string') throw new Error('material_credits: helper returned no markdown')
  await deps.write(reply.markdown)
  return 'written'
}
