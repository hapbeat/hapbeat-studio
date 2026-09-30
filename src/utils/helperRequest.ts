import type { ManagerMessage } from '@/types/manager'

/** The part of `useHelperConnection()` needed for request / response calls. */
export interface HelperChannel {
  send: (message: ManagerMessage) => void
  subscribe: (listener: (message: ManagerMessage) => void) => () => void
}

export const HELPER_REQUEST_TIMEOUT_MS = 10_000

/**
 * Sends `type` with a fresh `requestId` and resolves with the payload of the
 * first `resultType` message that echoes the same id. Rejects on timeout or
 * when the helper answers with an `error` string.
 */
export function helperRequest(
  channel: HelperChannel,
  type: string,
  payload: Record<string, unknown>,
  resultType: string,
  timeoutMs = HELPER_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); unsubscribe() }
    const unsubscribe = channel.subscribe(message => {
      if (message.type !== resultType || message.payload?.requestId !== requestId) return
      finish()
      const error = message.payload.error
      if (typeof error === 'string' && error) reject(new Error(`${type}: ${error}`))
      else resolve(message.payload)
    })
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`${type}: no response from helper within ${timeoutMs} ms`)) }, timeoutMs)
    try { channel.send({ type, payload: { ...payload, requestId } }) }
    catch (error) { finish(); reject(error) }
  })
}

/**
 * The helper connection lives in React context; stores (Kit save, editor
 * export) run outside it. The provider publishes the channel here while the
 * helper is connected and clears it on disconnect.
 */
let activeChannel: HelperChannel | null = null
export function setActiveHelperChannel(channel: HelperChannel | null) { activeChannel = channel }
export function getActiveHelperChannel(): HelperChannel | null { return activeChannel }
