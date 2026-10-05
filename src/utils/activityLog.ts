/**
 * Studio's operation log: what saving a rating did (materials added, reserves, what was left out and why,
 * failures), as one JSON object per line in `.hapbeat-editor/activity-log.jsonl` of the editor folder,
 * plus console.info. Appends are serialized; the file is only ever extended.
 */
export const ACTIVITY_LOG = 'activity-log.jsonl'

export interface ActivityEntry {
  at: string
  kind: 'rated' | 'dismissed' | 'decided' | 'material-updated'
  trialId?: string
  /** decided / material-updated: the events and the WAV. */
  events?: string[]
  file?: string
  note?: string
  shortId?: string
  /** WAVs added to the event's material pool. */
  added?: string[]
  /** Candidates kept as reserves (★3). */
  reserved?: string[]
  /** Candidates not added, with the reason. */
  excluded?: { candidate: string; reason: string }[]
  /** What could not be done. */
  failures?: string[]
}

let queue: Promise<void> = Promise.resolve()

/** Appends one entry (read + write back: the browser commits the new text on close, so readers never see half a line). */
export function appendActivity(root: FileSystemDirectoryHandle, entry: ActivityEntry): Promise<void> {
  console.info('[activity]', entry)
  const job = queue.then(async () => {
    const dir = await root.getDirectoryHandle('.hapbeat-editor', { create: true })
    const handle = await dir.getFileHandle(ACTIVITY_LOG, { create: true })
    const before = await (await handle.getFile()).text()
    const stream = await handle.createWritable()
    try { await stream.write(`${before}${JSON.stringify(entry)}\n`); await stream.close() }
    catch (error) { await stream.abort().catch(() => {}); throw error }
  })
  queue = job.catch(() => {})
  return job
}
