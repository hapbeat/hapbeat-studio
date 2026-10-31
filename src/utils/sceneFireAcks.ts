/**
 * The helper answers every play_event / stop_event with a `write_result` without `cmd` ("play sent — …" / "stop sent —
 * …"). The Scene tab's FIRE output sends hundreds of them while a video plays, so HelperFailureToastListener skips the
 * success toast for those while a Scene FIRE send is recent. Failures are always shown.
 */
export const QUIET_FIRE_ACK_MS = 2000
let lastFireSend = -Infinity

/** Called for every Scene FIRE send (performance.now() time base). */
export function markSceneFireSend(now = performance.now()) { lastFireSend = now }

/** Whether a successful `write_result` message is an acknowledgement of a recent Scene FIRE send. */
export function isQuietSceneFireAck(message: string, now = performance.now()): boolean {
  return now - lastFireSend <= QUIET_FIRE_ACK_MS && /^(play|stop) sent/.test(message)
}
