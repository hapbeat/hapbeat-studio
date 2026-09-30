/**
 * MCP bridge: `agent_request` messages relayed by hapbeat-helper from its MCP server
 * (`hapbeat-helper mcp`) are dispatched here. Params are validated in this file; Studio
 * state is reached only through AgentBridgeDeps so the dispatch is testable in Node.
 */
import { CANDIDATE_ID, TRIAL_ID } from '@/utils/agentProtocol'
import type { AcceptResult } from '@/utils/agentInbox'
import { aggregateTerm, buildIndex, canonicalTerm, knownSlugs, type DimensionsDoc, type TrialRecord } from '@/utils/hapticKnowledge'

export const STUDIO_NOT_READY = 'STUDIO_NOT_READY: Open Hapbeat Studio → Waveform editor and open a folder.'
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Relay limit for one message payload (helper side enforces the same). */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const EVIDENCE = /^[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,16}$/

export interface AgentBridgeDeps {
  studioVersion: string
  /** null while the editor has no folder open (every method then answers STUDIO_NOT_READY). */
  folderName: () => string | null
  clipCount: () => number
  loadTrials: () => Promise<TrialRecord[]>
  loadDimensions: () => Promise<DimensionsDoc>
  readInsights: () => Promise<string>
  guide: () => string
  catalog: () => unknown
  submitTrial: (trial: unknown) => Promise<AcceptResult>
  audition: (trialId: string, candidateId: string, play: boolean) => Promise<void>
  adopt: (trialId: string, candidateId: string) => Promise<{ clipId: string; name: string }>
  appendInsight: (statement: string, evidence: string[]) => Promise<void>
}
export type AgentResponse = { ok: true; result: unknown } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function id(params: Record<string, unknown>, key: string, pattern: RegExp): string {
  const v = params[key]
  if (typeof v !== 'string' || !pattern.test(v)) throw new Error(`${key} must match ${pattern}`)
  return v
}
function optBool(params: Record<string, unknown>, key: string): boolean {
  const v = params[key]
  if (v !== undefined && typeof v !== 'boolean') throw new Error(`${key} must be a boolean`)
  return v === true
}
async function findTrial(deps: AgentBridgeDeps, trialId: string) {
  const record = (await deps.loadTrials()).find(r => r.trial.id === trialId)
  if (!record) throw new Error(`Trial "${trialId}" not found`)
  return record
}

type Handler = (params: Record<string, unknown>, deps: AgentBridgeDeps) => Promise<unknown>
const handlers: Record<string, Handler> = {
  status: async (_, deps) => {
    const trials = await deps.loadTrials()
    return {
      studioVersion: deps.studioVersion, folderName: deps.folderName(), clipCount: deps.clipCount(),
      trialCount: trials.length, unratedCount: trials.filter(r => !r.rating).length,
      dimensions: (await deps.loadDimensions()).dimensions.map(d => d.id),
    }
  },
  get_guide: async (_, deps) => ({ markdown: deps.guide() }),
  get_catalog: async (_, deps) => deps.catalog(),
  get_knowledge: async (params, deps) => {
    const term = params.term
    if (term !== undefined && (typeof term !== 'string' || !term.trim() || term.length > 40)) throw new Error('term must be a non-empty string of at most 40 characters')
    const [records, dimensions] = [await deps.loadTrials(), await deps.loadDimensions()]
    const slugs = knownSlugs(dimensions, records)
    if (term !== undefined) {
      const { slug } = canonicalTerm(term, dimensions)
      return { term: slugs.includes(slug) ? aggregateTerm(slug, dimensions, records) : null, dimensions }
    }
    return { index: buildIndex(records, slugs.map(slug => aggregateTerm(slug, dimensions, records))), dimensions, insights: await deps.readInsights() }
  },
  submit_trial: async (params, deps) => {
    if (!isObject(params.trial)) throw new Error('trial must be a hapbeat-trial@1 object (see get_guide)')
    const result = await deps.submitTrial(params.trial)
    if (!result.ok) throw new Error(result.error)
    return {
      trialId: result.trialId, month: result.month,
      candidates: result.candidates.map(c => ({ id: c.id, features: c.features, ...(c.autoNormalizedDb === undefined ? {} : { autoNormalizedDb: c.autoNormalizedDb }), ...(c.error === undefined ? {} : { error: c.error }) })),
    }
  },
  get_trial: async (params, deps) => {
    const { trial, candidates, rating } = await findTrial(deps, id(params, 'trialId', TRIAL_ID))
    return { trial, candidates, rating }
  },
  list_trials: async (params, deps) => {
    const limit = params.limit ?? 20
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('limit must be an integer 1-100')
    const unratedOnly = optBool(params, 'unratedOnly')
    // buildIndex lists trials newest first with exactly the fields list_trials returns.
    const trials = buildIndex(await deps.loadTrials(), []).trials.filter(t => !unratedOnly || !t.rated)
    return { trials: trials.slice(0, limit as number) }
  },
  audition: async (params, deps) => {
    const trialId = id(params, 'trialId', TRIAL_ID), candidateId = id(params, 'candidateId', CANDIDATE_ID), play = optBool(params, 'play')
    await deps.audition(trialId, candidateId, play)
    return { auditioning: true, played: play }
  },
  adopt: async (params, deps) => deps.adopt(id(params, 'trialId', TRIAL_ID), id(params, 'candidateId', CANDIDATE_ID)),
  propose_insight: async (params, deps) => {
    const { statement, evidence } = params
    if (typeof statement !== 'string' || !statement.trim() || statement.length > 1000) throw new Error('statement must be a non-empty string of at most 1000 characters')
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 20 || !evidence.every(e => typeof e === 'string' && EVIDENCE.test(e))) throw new Error('evidence must be 1-20 strings of the form "trialId/candidateId"')
    await deps.appendInsight(statement, evidence)
    return { appended: true }
  },
}
export const AGENT_METHODS = Object.keys(handlers)

/** Runs one relayed request. Never throws: every failure becomes `{ ok: false, error }`. */
export async function handleAgentRequest(method: unknown, params: unknown, deps: AgentBridgeDeps): Promise<AgentResponse> {
  const handler = typeof method === 'string' && Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined
  if (!handler) return { ok: false, error: `Unknown method "${String(method)}"; available: ${AGENT_METHODS.join(', ')}` }
  if (params !== undefined && params !== null && !isObject(params)) return { ok: false, error: 'params must be an object' }
  if (!deps.folderName()) return { ok: false, error: STUDIO_NOT_READY }
  try { return { ok: true, result: await handler(params ?? {}, deps) } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

/** `agent_response` payload, replaced by an error when the result would exceed the relay limit. */
export function agentResponsePayload(requestId: string, response: AgentResponse): Record<string, unknown> {
  const payload = { requestId, ...response }
  const size = new TextEncoder().encode(JSON.stringify(payload)).length
  return size <= MAX_PAYLOAD_BYTES ? payload : { requestId, ok: false, error: `RESPONSE_TOO_LARGE: ${size} bytes exceeds ${MAX_PAYLOAD_BYTES}; narrow the request (for example get_knowledge with a term, or a smaller limit)` }
}
