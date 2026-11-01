import type { SceneKitState } from '@/stores/scenePlayback'
import type { ExportFile } from './kitExporter'
import { dirAt, isNotFound } from './sceneProject'
import { clampNumber, type KitClipGains } from './sceneCueTable'

/**
 * The Kit a haptic video project's FIRE output plays (contracts scene-recording §1): the cue table's `kit`, kept in
 * the project folder as Studio saves a Kit (`<kit>-manifest.json`, `install-clips/`, `stream-clips/`). SceneKitStatus
 * compares it with what each Hapbeat reports (`kit_list`) and installs it (`deploy_kit_data`). Its manifest is also
 * where the project's haptic clips get their material strength (clip_gain, contracts cue-table §9.1; sceneStore.projectKit).
 */

export interface ProjectKit {
  kit: string
  /** The Kit folder, relative to the project root. */
  folder: string
  /** The manifest's file name in `folder`. */
  manifest: string
  /** The manifest's `version`; null when it has none (nothing to compare). */
  version: string | null
  /** The material strength of each clip the Kit has (kitClipGains): what the Scene plays, the cue table holding a copy. */
  clipGains: KitClipGains
}

const MANIFEST_NAMES = (kit: string) => [`${kit}-manifest.json`, 'manifest.json']

/**
 * A Kit manifest's clip gains (contracts cue-table §9.1, kit-format `clip_gain`): per Event ID `<kit>.<clip>`, its
 * `parameters.clip_gain` in `events`, else in `stream_events` (absent = 1; kept to 0..1, the cue table's range). Event
 * IDs of another category are not clips of this Kit.
 */
export function kitClipGains(manifest: unknown, kit: string): Record<string, number> {
  const out: Record<string, number> = {}
  const m = (manifest ?? {}) as { events?: unknown; stream_events?: unknown }
  // stream_events first, so an `events` entry of the same clip wins.
  for (const bucket of [m.stream_events, m.events]) {
    if (!bucket || typeof bucket !== 'object') continue
    for (const [id, entry] of Object.entries(bucket as Record<string, unknown>)) {
      if (!id.startsWith(`${kit}.`)) continue
      const gain = (entry as { parameters?: { clip_gain?: unknown } } | null)?.parameters?.clip_gain
      out[id.slice(kit.length + 1)] = typeof gain === 'number' && Number.isFinite(gain) ? clampNumber(gain, 0, 1) : 1
    }
  }
  return out
}

/**
 * The project's folder of Kit `kit`: `kits/<kit>/`, else the parent of the clip folder (`clipsPath`, viewer-lib
 * `paths.clips`) when that folder is named `kit`; a folder counts once it holds `<kit>-manifest.json` or `manifest.json`.
 * Null when neither is there; throws on a manifest that is not JSON.
 */
export async function locateProjectKit(root: FileSystemDirectoryHandle, kit: string, clipsPath: string): Promise<ProjectKit | null> {
  const parts = clipsPath.split('/').filter(Boolean), parent = parts.slice(0, -1)
  const folders = [`kits/${kit}`, ...(parent.length && parent[parent.length - 1] === kit ? [parent.join('/')] : [])]
  for (const folder of [...new Set(folders)]) {
    let dir: FileSystemDirectoryHandle
    try { dir = await dirAt(root, folder) } catch (error) { if (isGone(error)) continue; throw error }
    for (const manifest of MANIFEST_NAMES(kit)) {
      let text: string
      try { text = await (await (await dir.getFileHandle(manifest)).getFile()).text() } catch (error) { if (isGone(error)) continue; throw error }
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch (error) { throw new Error(`${folder}/${manifest}: ${error instanceof Error ? error.message : String(error)}`) }
      const version = parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string' ? (parsed as { version: string }).version : null
      return { kit, folder, manifest, version, clipGains: kitClipGains(parsed, kit) }
    }
  }
  return null
}
/** Not there (or a file where a folder was expected). */
const isGone = (error: unknown) => isNotFound(error) || (error instanceof DOMException && error.name === 'TypeMismatchError')

/**
 * What one Hapbeat answered to kit_list about the project's Kit: `events` = the clip names it holds (null when it did
 * not list them); `error` = the helper could not ask it (its TCP query failed: nothing known about its Kit).
 */
export interface DeviceKitAnswer { ip: string; installed: boolean; version: string | null; events: string[] | null; error: string | null }
/** A `kit_list_result` payload ({device: ip, kits: [{kit_id, version?, events?}]} or {device, error}) → `kit` on that device; null when it is not one. */
export function parseKitList(payload: unknown, kit: string): DeviceKitAnswer | null {
  const p = (payload ?? {}) as { device?: unknown; kits?: unknown; error?: unknown }
  if (typeof p.device !== 'string' || !p.device) return null
  if (!Array.isArray(p.kits) && typeof p.error === 'string') return { ip: p.device, installed: false, version: null, events: null, error: p.error }
  const found = (Array.isArray(p.kits) ? p.kits : []).find(k => k && typeof k === 'object' && (k as { kit_id?: unknown }).kit_id === kit) as { version?: unknown; events?: unknown } | undefined
  // Events are `<kit>.<clip>` (or bare names), as strings (old firmware) or {name}.
  const events = Array.isArray(found?.events) ? found.events.map(e => typeof e === 'string' ? e : e && typeof e === 'object' ? (e as { name?: unknown }).name : null)
    .filter((n): n is string => typeof n === 'string').map(n => n.startsWith(`${kit}.`) ? n.slice(kit.length + 1) : n) : null
  return { ip: p.device, installed: !!found, version: typeof found?.version === 'string' ? found.version : null, events, error: null }
}

/** The cue table's clips (FIRE plays `<kit>.<clip>`) the device's Kit does not hold; none when it did not list its events. */
export function missingClips(answer: DeviceKitAnswer | undefined, clips: readonly string[]): string[] {
  const events = answer?.installed ? answer.events : null
  return events ? clips.filter(c => !events.includes(c)) : []
}

export type DeviceKitState = 'checking' | 'unreachable' | 'installed' | 'differs' | 'incomplete' | 'missing'
/**
 * One device's state against the project's version (a version missing on either side counts as the same) and the cue
 * table's clips (`incomplete`: its Kit lacks some, which FIRE would leave silent).
 */
export function deviceKitState(answer: DeviceKitAnswer | undefined, version: string | null, clips: readonly string[]): DeviceKitState {
  if (!answer) return 'checking'
  if (answer.error !== null) return 'unreachable'
  if (!answer.installed) return 'missing'
  if (missingClips(answer, clips).length) return 'incomplete'
  return version && answer.version && answer.version !== version ? 'differs' : 'installed'
}
/**
 * The whole FIRE Kit state (scenePlayback.kitState) from the target devices' states; `states` null = the cue table
 * names no Kit. A Kit missing or lacking clips anywhere wins, then a device not answered yet, then one the helper could
 * not ask, then another version.
 */
export function kitStateOf(states: readonly DeviceKitState[] | null): SceneKitState {
  if (!states) return 'missing'
  if (!states.length) return 'none'
  if (states.includes('missing') || states.includes('incomplete')) return 'missing'
  if (states.includes('checking')) return 'checking'
  if (states.includes('unreachable')) return 'unreachable'
  return states.includes('differs') ? 'differs' : 'ready'
}

/** The files a deploy sends (buildKitZip under `<kit>/`): the manifest and every WAV under `install-clips/`. */
export async function readKitFiles(root: FileSystemDirectoryHandle, kit: ProjectKit): Promise<ExportFile[]> {
  const dir = await dirAt(root, kit.folder)
  const file = (path: string, blob: Blob): ExportFile => ({ path, blob, outputHash: null, cached: false })
  const out = [file(kit.manifest, await (await dir.getFileHandle(kit.manifest)).getFile())]
  const walk = async (d: FileSystemDirectoryHandle, path: string) => {
    for await (const [name, handle] of d.entries()) {
      if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`)
      else if (/\.wav$/i.test(name)) out.push(file(`${path}/${name}`, await (handle as FileSystemFileHandle).getFile()))
    }
  }
  try { await walk(await dir.getDirectoryHandle('install-clips'), 'install-clips') } catch (error) { if (!isGone(error)) throw error }
  return out
}
