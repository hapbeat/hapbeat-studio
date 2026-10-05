/**
 * Telling a stop from the natural end. The editor player emits 'pause' and then
 * 'finish' (same task) when the audio runs out, but only 'pause' when the user
 * stops. Things that run alongside the playback — the decided event sound, the
 * Scene video — keep going to their own end after a natural finish (a 7 s roar
 * under a 2.4 s haptic clip), and stop only on a real stop.
 */
interface PlayerEvents { on: (event: 'pause' | 'finish', listener: (time: number) => void) => () => void }

/** Calls `onStop` for a pause that is not followed by 'finish' in the same task. Returns the unsubscribe. */
export function onUserStop(player: PlayerEvents, onStop: () => void): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null
  let finished = false
  const unsubs = [
    player.on('pause', () => {
      finished = false
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => { pending = null; if (!finished) onStop() }, 0)
    }),
    player.on('finish', () => { finished = true }),
  ]
  return () => { unsubs.forEach(unsub => unsub()); if (pending) clearTimeout(pending) }
}
