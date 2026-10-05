import type { SceneClip, SceneData, SceneEvent } from './sceneData'
import { writeEditorFile } from './editorFolder'
import { AGENT_DIR } from './hapticKnowledge'
import { OUTBOX_DIR } from './agentOutbox'

/**
 * Firings the user asked to make another event ("Change" in the Scene tab, outbox `reassign`): until the game is
 * changed and the scene re-recorded, Studio treats them as the new event already — rows, timeline, Scene playback,
 * marks and the editor's representative stretch all read the recording through these. Kept per game project in
 * the editor folder (versioned, not `.hapbeat-editor`): `scene-overrides/<project>.json`.
 */
export const OVERRIDES_FORMAT = 'hapbeat-scene-overrides@1'
export const OVERRIDES_DIR = 'scene-overrides'
/** A recorded firing (`from` at `atSec` of the full recording) shown and played as `to`. */
export interface SceneOverride { from: string; atSec: number; to: string; requestedAt: string }
export interface OverridesFile { format: typeof OVERRIDES_FORMAT; project: string; overrides: SceneOverride[] }
/** A firing of the recording matches an override within this (recorded times have 3 decimals). */
const SAME_TIME = 0.005
const at = (o: SceneOverride, name: string, t: number) => o.from === name && Math.abs(o.atSec - t) < SAME_TIME
/** A recorded event shown as another one keeps its recorded name in `from`. */
export type OverriddenEvent = SceneEvent & { from?: string }
export type OverriddenClip = SceneClip & { from?: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isOverride = (v: unknown): v is SceneOverride => isRecord(v) && typeof v.from === 'string' && typeof v.to === 'string' && typeof v.atSec === 'number' && Number.isFinite(v.atSec) && typeof v.requestedAt === 'string'

export function parseOverrides(text: string | null): SceneOverride[] {
  if (!text) return []
  try { const v = JSON.parse(text) as unknown; return isRecord(v) && v.format === OVERRIDES_FORMAT && Array.isArray(v.overrides) ? v.overrides.filter(isOverride) : [] } catch { return [] }
}
export const serializeOverrides = (project: string, overrides: readonly SceneOverride[]) =>
  `${JSON.stringify({ format: OVERRIDES_FORMAT, project, overrides: [...overrides].sort((a, b) => a.atSec - b.atSec) } satisfies OverridesFile, null, 2)}\n`

/** Adds / replaces the override of one recorded firing (`to` equal to `from` removes it). */
export function setOverride(list: readonly SceneOverride[], o: SceneOverride): SceneOverride[] {
  const rest = list.filter(x => !(x.from === o.from && Math.abs(x.atSec - o.atSec) < SAME_TIME))
  return o.to === o.from ? rest : [...rest, o]
}
export const removeOverride = (list: readonly SceneOverride[], from: string, atSec: number) => list.filter(x => !at(x, from, atSec))

/** The recording as Studio uses it: overridden firings (events and the clips cut for them) renamed, their recorded name kept in `from`. */
export function applyOverrides(data: SceneData, list: readonly SceneOverride[]): SceneData {
  if (!list.length) return data
  const events: OverriddenEvent[] = data.full.events.map(e => { const o = list.find(x => at(x, e.name, e.t)); return o ? { ...e, name: o.to, from: e.name } : e })
  const clips: OverriddenClip[] = data.clips.map(c => {
    const o = list.find(x => at(x, c.name, c.at))
    return o ? { ...c, name: o.to, names: c.names.map(n => n === c.name ? o.to : n), from: c.name } : c
  })
  return { ...data, clips, full: { ...data.full, events } }
}

/** Overrides the new recording already plays as wished (the firing at that time now carries `to`): no longer needed. */
export function resolvedOverrides(data: SceneData, list: readonly SceneOverride[]): SceneOverride[] {
  return list.filter(o => data.full.events.some(e => e.name === o.to && Math.abs(e.t - o.atSec) < 0.05))
}

/** Requests already sent (outbox and outbox/_read `reassign` of `project`) as overrides — the start of a project's file. */
export function overridesFromMessages(messages: readonly unknown[], project: string): SceneOverride[] {
  let out: SceneOverride[] = []
  for (const m of messages) {
    if (!isRecord(m) || m.project !== project || !isRecord(m.reassign)) continue
    const r = m.reassign
    if (typeof r.cue !== 'string' || typeof r.to !== 'string' || typeof r.atSec !== 'number') continue
    out = setOverride(out, { from: r.cue, atSec: r.atSec, to: r.to, requestedAt: typeof m.createdAt === 'string' ? m.createdAt : '' })
  }
  return out
}

// ── The file in the editor folder ──

const fileName = (project: string) => `${project.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.json`
/** The project's overrides; null when it has no file yet. */
export async function readOverrides(root: FileSystemDirectoryHandle, project: string): Promise<SceneOverride[] | null> {
  try {
    const dir = await root.getDirectoryHandle(OVERRIDES_DIR)
    return parseOverrides(await (await (await dir.getFileHandle(fileName(project))).getFile()).text())
  } catch { return null }
}
export async function writeOverrides(root: FileSystemDirectoryHandle, project: string, list: readonly SceneOverride[]): Promise<void> {
  const dir = await root.getDirectoryHandle(OVERRIDES_DIR, { create: true })
  await writeEditorFile(dir, fileName(project), serializeOverrides(project, list))
}
/** Every message in `hapbeat-agent/outbox/` and its `_read/` (unreadable files skipped). */
export async function readOutboxMessages(root: FileSystemDirectoryHandle): Promise<unknown[]> {
  const out: unknown[] = []
  const readDir = async (dir: FileSystemDirectoryHandle) => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      try { out.push(JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text())) } catch { /* not a message */ }
    }
  }
  try {
    const outbox = await (await root.getDirectoryHandle(AGENT_DIR)).getDirectoryHandle(OUTBOX_DIR)
    await readDir(outbox)
    try { await readDir(await outbox.getDirectoryHandle('_read')) } catch { /* none read yet */ }
  } catch { /* no outbox */ }
  return out
}
