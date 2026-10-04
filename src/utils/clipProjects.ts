/**
 * Clip-list projects: a grouping tag only (not a folder). A clip's effective
 * project is its explicit `project`, else the longest known project name P
 * such that the clip name starts with `P-`. Known names are the explicit
 * values in the folder plus the user's list in the editor settings, so tagging
 * one clip (or listing a name) groups every clip carrying that prefix.
 */
import { normalizeProjectName } from './editorFolder'

interface ProjectClip { id: string; name: string; project?: string }
export interface EffectiveProject {
  /** Undefined = unassigned. */
  project?: string
  /** True when derived from the clip-name prefix rather than set explicitly. */
  auto: boolean
}

/** Distinct, sorted project names from the clips' explicit values and the user's list. */
export function knownProjectNames(explicit: readonly (string | undefined)[], listed: readonly string[]): string[] {
  const names = [...explicit, ...listed].map(value => value === undefined ? undefined : normalizeProjectName(value)).filter((value): value is string => !!value)
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/** Longest known name P such that `clipName` starts with `P-` (exact case). */
export function matchProjectPrefix(clipName: string, known: readonly string[]): string | undefined {
  let best: string | undefined
  for (const name of known) if (clipName.startsWith(`${name}-`) && (!best || name.length > best.length)) best = name
  return best
}

export function effectiveProject(clip: Pick<ProjectClip, 'name' | 'project'>, known: readonly string[]): EffectiveProject {
  if (clip.project) return { project: clip.project, auto: false }
  const project = matchProjectPrefix(clip.name, known)
  return { project, auto: !!project }
}

/** Sets (or clears with `undefined`) the explicit project of every clip in `ids`; untouched documents keep their identity. */
export function assignProject<T extends { clip: ProjectClip }>(documents: readonly T[], ids: readonly string[], project: string | undefined): T[] {
  const targets = new Set(ids)
  return documents.map(doc => targets.has(doc.clip.id) && doc.clip.project !== project ? { ...doc, clip: { ...doc.clip, project } } : doc)
}

/** Adds a typed name to the user's known-project list (normalized, no duplicates). Returns the same array when nothing changes. */
export function addKnownProject(list: readonly string[], input: string): readonly string[] {
  const name = normalizeProjectName(input)
  return !name || list.includes(name) ? list : [...list, name].sort((a, b) => a.localeCompare(b))
}

/** Prefix suggestion for a clip name: everything before its last `-` (empty when it has none). */
export function suggestProjectPrefix(clipName: string): string {
  const cut = clipName.lastIndexOf('-')
  return cut > 0 ? clipName.slice(0, cut) : ''
}

/** Ctrl/Cmd-click: toggles `id` in the selection. */
export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter(item => item !== id) : [...selection, id]
}

/** Shift-click: ids between `anchor` and `target` (inclusive) in display order; just the target when the anchor is not shown. */
export function rangeSelection(order: readonly string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target)
  const start = anchor === null ? -1 : order.indexOf(anchor)
  if (end < 0 || start < 0) return [target]
  return order.slice(Math.min(start, end), Math.max(start, end) + 1)
}
