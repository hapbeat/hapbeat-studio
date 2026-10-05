import { writeEditorFile } from './editorFolder'

/**
 * Messages from the editor to the user's agent session (`hapbeat-agent/outbox/`).
 * The agent watches the folder, reads each `*.json` and moves it to
 * `outbox/_read/`; Studio only adds files and never removes them.
 *
 * A message is written as `<name>.json.tmp` first and then renamed to
 * `<name>.json` (FileSystemFileHandle.move), so a watcher never sees a half
 * written `.json`. Where `move` is missing the `.json` is written directly: the
 * browser commits a writable only on close (swap file), which is also atomic.
 */
export const MESSAGE_FORMAT = 'hapbeat-agent-message@1'
export const OUTBOX_DIR = 'outbox'

export interface AgentMessage {
  format: typeof MESSAGE_FORMAT
  createdAt: string
  text: string
  project?: string
  trialIds?: string[]
  shortIds?: string[]
  /** "This firing should be another event / variant" (Scene tab, DEC-085): a request to change the game's routing (Director). */
  reassign?: Reassign
}
/** One firing of `cue` (a cue or `cue:variant`) at `atSec` of the full recording, proposed to become `to`. */
export interface Reassign { cue: string; atSec: number; to: string; comment?: string }

export function buildAgentMessage(o: { text: string; createdAt: string; project?: string; trialIds?: string[]; shortIds?: string[]; reassign?: Reassign }): AgentMessage {
  const text = o.text.trim()
  if (!text) throw new Error('message text is empty')
  if (text.length > 4000) throw new Error('message text is longer than 4000 characters')
  return {
    format: MESSAGE_FORMAT, createdAt: o.createdAt, text,
    ...(o.project ? { project: o.project } : {}),
    ...(o.trialIds?.length ? { trialIds: [...o.trialIds] } : {}),
    ...(o.shortIds?.length ? { shortIds: [...o.shortIds] } : {}),
    ...(o.reassign ? { reassign: { cue: o.reassign.cue, atSec: Math.round(o.reassign.atSec * 1000) / 1000, to: o.reassign.to, ...(o.reassign.comment?.trim() ? { comment: o.reassign.comment.trim().slice(0, 1000) } : {}) } } : {}),
  }
}

/** `<YYYYMMDD-HHmmss>-<rand>.json` in local time; names sort by time. */
export function outboxFileName(date: Date, random: () => number = Math.random): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  const rand = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')
  return `${stamp}-${rand}.json`
}

type MovableHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> }

/** Writes one message into `<agent dir>/outbox/` and returns its file name. */
export async function writeOutboxMessage(agentDir: FileSystemDirectoryHandle, message: AgentMessage, name: string): Promise<string> {
  const outbox = await agentDir.getDirectoryHandle(OUTBOX_DIR, { create: true })
  await outbox.getDirectoryHandle('_read', { create: true })
  const text = `${JSON.stringify(message, null, 2)}\n`
  const tmp = await outbox.getFileHandle(`${name}.tmp`, { create: true }) as MovableHandle
  if (typeof tmp.move === 'function') {
    const stream = await tmp.createWritable()
    try { await stream.write(text); await stream.close() } catch (error) { await stream.abort().catch(() => {}); throw error }
    await tmp.move(name)
  } else {
    // No rename: the temporary entry is Studio's own empty file; write the final name directly (committed on close).
    await outbox.removeEntry(`${name}.tmp`).catch(() => {})
    await writeEditorFile(outbox, name, text)
  }
  return name
}
