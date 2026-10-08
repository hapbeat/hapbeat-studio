/**
 * Stream ids of this tab's `streamClip` streams (editor audition, Kit preview,
 * streaming test) between their BEGIN and their END / abort. The Scene mixer
 * reads it to hold a device a same-client stream took (helper
 * `stream_displaced` with `same_client`) until that stream ends.
 */
const open = new Set<string>()
export function markStreamOpen(streamId: string) { open.add(streamId) }
export function markStreamClosed(streamId: string) { open.delete(streamId) }
export function isStreamOpen(streamId: string) { return open.has(streamId) }
