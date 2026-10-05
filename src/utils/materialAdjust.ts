import type { EffectEntry, SampleRate } from '@/types/waveform'
import { validateEffects, writeEditorFile } from './editorFolder'

/**
 * "Adjust" data of an event material, kept in the editor folder under version control (`.hapbeat-editor`
 * only caches decoded audio and can be rebuilt from here):
 *   adjust/<project>/<sound|haptic>/<material>.json          the effect chain and what it belongs to
 *   adjust/<project>/<sound|haptic>/<material>.original.wav  the material as it was (16-bit WAV)
 */
export const ADJUST_DIR = 'adjust'
export const ADJUST_FORMAT = 'hapbeat-material-adjust@1'

export interface MaterialAdjust {
  format: typeof ADJUST_FORMAT
  project: string
  event: string
  target: 'sound' | 'haptic'
  /** The material's WAV name (without .wav) in the game project. */
  wav: string
  effects: EffectEntry[]
  exportSampleRate: SampleRate
  updatedAt: string
}

const safe = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')

async function dirFor(root: FileSystemDirectoryHandle, project: string, target: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await root.getDirectoryHandle(ADJUST_DIR, { create })
  for (const part of [safe(project), target]) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

export function parseMaterialAdjust(text: string): MaterialAdjust | null {
  try {
    const v = JSON.parse(text) as Partial<MaterialAdjust>
    if (v.format !== ADJUST_FORMAT || typeof v.project !== 'string' || typeof v.event !== 'string' || typeof v.wav !== 'string'
      || (v.target !== 'sound' && v.target !== 'haptic') || !validateEffects(v.effects) || ![16000, 24000, 44100, 48000].includes(v.exportSampleRate as number)) return null
    return { format: ADJUST_FORMAT, project: v.project, event: v.event, target: v.target, wav: v.wav, effects: v.effects!, exportSampleRate: v.exportSampleRate as SampleRate, updatedAt: String(v.updatedAt ?? '') }
  } catch { return null }
}

/** The material's adjust data and original WAV bytes, or null when it was never adjusted (or is unreadable). */
export async function readMaterialAdjust(root: FileSystemDirectoryHandle, project: string, target: 'sound' | 'haptic', wav: string): Promise<{ data: MaterialAdjust; original: ArrayBuffer } | null> {
  try {
    const dir = await dirFor(root, project, target, false)
    const data = parseMaterialAdjust(await (await (await dir.getFileHandle(`${safe(wav)}.json`)).getFile()).text())
    if (!data) return null
    const original = await (await (await dir.getFileHandle(`${safe(wav)}.original.wav`)).getFile()).arrayBuffer()
    return { data, original }
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return null
    throw error
  }
}

export async function writeMaterialAdjust(root: FileSystemDirectoryHandle, data: MaterialAdjust): Promise<void> {
  const dir = await dirFor(root, data.project, data.target, true)
  await writeEditorFile(dir, `${safe(data.wav)}.json`, `${JSON.stringify(data, null, 2)}\n`)
}
export async function writeMaterialOriginal(root: FileSystemDirectoryHandle, project: string, target: 'sound' | 'haptic', wav: string, bytes: ArrayBuffer): Promise<void> {
  const dir = await dirFor(root, project, target, true)
  await writeEditorFile(dir, `${safe(wav)}.original.wav`, new Blob([bytes]))
}
export async function hasMaterialAdjust(root: FileSystemDirectoryHandle, project: string, target: 'sound' | 'haptic', wav: string): Promise<boolean> {
  try { await (await dirFor(root, project, target, false)).getFileHandle(`${safe(wav)}.json`); return true }
  catch { return false }
}
