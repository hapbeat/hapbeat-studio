import { writeEditorFile } from './editorFolder'

/**
 * Messages from the editor to the user's agent session (`hapbeat-agent/outbox/`).
 * The agent watches the folder, reads each `*.json` and moves it to
 * `outbox/_read/`; Studio only adds files and never removes them.
 *
 * A message is written straight to `<name>.json`: the browser commits a
 * writable only on close() (a swap file is renamed into place), so a watcher
 * never sees a half written `.json`. No temporary file + move(): Chrome may
 * refuse FileSystemFileHandle.move() in a user-picked local folder.
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
  /** "Remake this material" (Events panel): the user wants another take of one material of an event. */
  revise?: Revise
  haptic?: HapticRequest
  sound?: SoundRequest
}
/** "Go to haptics" (Events panel): make the haptic of `cue`, matching its representative sound (`sound`, null = the cue has no sound). */
export interface HapticRequest { cue: string; sound: string | null; comment?: string }
/** "Request a sound" (Events panel): (more) sound candidates for `cue`, described by the comment. */
export interface SoundRequest { cue: string; comment: string }
/** A material (`material`: WAV name without .wav) of `cue` (a cue or `cue:variant`) to remake, with the user's comment. */
export interface Revise { cue: string; target: 'sound' | 'haptic'; material: string; comment: string }
/** One firing of `cue` (a cue or `cue:variant`) at `atSec` of the full recording, proposed to become `to`. */
export interface Reassign { cue: string; atSec: number; to: string; comment?: string }

export function buildAgentMessage(o: { text: string; createdAt: string; project?: string; trialIds?: string[]; shortIds?: string[]; reassign?: Reassign; revise?: Revise; haptic?: HapticRequest; sound?: SoundRequest }): AgentMessage {
  const text = o.text.trim()
  if (!text) throw new Error('message text is empty')
  if (text.length > 4000) throw new Error('message text is longer than 4000 characters')
  return {
    format: MESSAGE_FORMAT, createdAt: o.createdAt, text,
    ...(o.project ? { project: o.project } : {}),
    ...(o.trialIds?.length ? { trialIds: [...o.trialIds] } : {}),
    ...(o.shortIds?.length ? { shortIds: [...o.shortIds] } : {}),
    ...(o.sound ? { sound: { cue: o.sound.cue, comment: o.sound.comment.trim().slice(0, 1000) } } : {}),
    ...(o.haptic ? { haptic: { cue: o.haptic.cue, sound: o.haptic.sound, ...(o.haptic.comment?.trim() ? { comment: o.haptic.comment.trim().slice(0, 1000) } : {}) } } : {}),
    ...(o.revise ? { revise: { cue: o.revise.cue, target: o.revise.target, material: o.revise.material, comment: o.revise.comment.trim().slice(0, 1000) } } : {}),
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

/** Writes one message into `<agent dir>/outbox/` and returns its file name. Errors name the step that failed. */
export async function writeOutboxMessage(agentDir: FileSystemDirectoryHandle, message: AgentMessage, name: string): Promise<string> {
  const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try { return await run() } catch (error) { throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const outbox = await step(`open hapbeat-agent/${OUTBOX_DIR}/`, () => agentDir.getDirectoryHandle(OUTBOX_DIR, { create: true }))
  await step(`create ${OUTBOX_DIR}/_read/`, () => outbox.getDirectoryHandle('_read', { create: true }))
  await step(`write ${OUTBOX_DIR}/${name}`, () => writeEditorFile(outbox, name, `${JSON.stringify(message, null, 2)}\n`))
  return name
}
