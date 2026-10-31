import { create } from 'zustand'

/**
 * How this PC plays a Scene project (haptic video projects, contracts scene-recording §3.3): kept in this browser only
 * (per PC, like pcTiming), never in a project, the Scene settings or the cue table.
 * - `output`: 'clip' streams the mixed PCM through hapbeat-helper (SceneHapticMixer); 'fire' sends PLAY by Event ID and
 *   the Hapbeat plays its installed Kit's copy (SceneKitFire).
 * - `allDevices`: every selected Hapbeat plays every route, whatever its position (contracts cue-table §4.5 substitution).
 * - `fireOffsetMs`: FIRE's own sound / haptics offset (one datagram, none of the stream's lead buffer), same sign as
 *   pcTiming: + = the haptic later.
 * - `videoVolume`: the video's own soundtrack (0..1); it plays only with the Scene PC sound on.
 * - `overallGain`: this PC's overall haptic multiplier (0..2, default 1; the strength panel's 「全体（この PC）」): every
 *   haptic the runtime sends (FIRE and CLIP, one-shots and loops) is multiplied by it, before the send clamp. Not part of
 *   the project, the cue table or the timeline's bars.
 */
export type SceneOutput = 'clip' | 'fire'
export interface ScenePlaybackSettings { output: SceneOutput; allDevices: boolean; fireOffsetMs: number; videoVolume: number; overallGain: number }

export const SCENE_PLAYBACK_STORAGE_KEY = 'hapbeat-scene-playback'
export const FIRE_OFFSET_MIN = -300
export const FIRE_OFFSET_MAX = 300
export const DEFAULT_SCENE_PLAYBACK: ScenePlaybackSettings = { output: 'clip', allDevices: false, fireOffsetMs: 0, videoVolume: 1, overallGain: 1 }
export const clampFireOffset = (ms: number) => Number.isFinite(ms) ? Math.max(FIRE_OFFSET_MIN, Math.min(FIRE_OFFSET_MAX, Math.round(ms))) : 0
const clampVolume = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
export const OVERALL_GAIN_MAX = 2
export const clampOverallGain = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(OVERALL_GAIN_MAX, v)) : 1

/** Valid fields of `data` over the defaults (anything else, a broken or foreign value, falls back to its default). */
export function parseScenePlayback(data: unknown): ScenePlaybackSettings {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return {
    output: d.output === 'fire' ? 'fire' : 'clip',
    allDevices: d.allDevices === true,
    fireOffsetMs: typeof d.fireOffsetMs === 'number' ? clampFireOffset(d.fireOffsetMs) : 0,
    videoVolume: typeof d.videoVolume === 'number' ? clampVolume(d.videoVolume) : 1,
    overallGain: typeof d.overallGain === 'number' ? clampOverallGain(d.overallGain) : 1,
  }
}

function read(): ScenePlaybackSettings {
  try { return parseScenePlayback(JSON.parse(localStorage.getItem(SCENE_PLAYBACK_STORAGE_KEY) ?? 'null')) } catch { return { ...DEFAULT_SCENE_PLAYBACK } }
}

/**
 * The FIRE Kit on the target devices (SceneKitStatus checks it with kit_list; not saved): 'none' = not checked (output
 * CLIP, no device), 'checking' until every device answered, 'ready' = installed everywhere with the project's version,
 * 'differs' = installed but another version somewhere, 'unreachable' = a device the helper could not ask, 'missing' =
 * not installed (or lacking some of the cue table's clips) on some device, or the cue table names no Kit.
 */
export type SceneKitState = 'none' | 'checking' | 'ready' | 'differs' | 'unreachable' | 'missing'

/**
 * The output the runtime plays by: FIRE only once the Kit is known to be on the devices (another version or a device
 * that could not be asked: FIRE, with a warning); else the whole playback streams from this PC (the status chip says
 * so). A recheck keeps the last settled state (useSceneKitCheck), so it does not flip the output while playing.
 */
export const effectiveOutput = (s: Pick<ScenePlayback, 'output' | 'kitState'>): SceneOutput =>
  s.output === 'fire' && (s.kitState === 'ready' || s.kitState === 'differs' || s.kitState === 'unreachable') ? 'fire' : 'clip'

export interface ScenePlayback extends ScenePlaybackSettings {
  kitState: SceneKitState
  update: (patch: Partial<ScenePlaybackSettings>) => void
  setKitState: (kitState: SceneKitState) => void
}

export const useScenePlayback = create<ScenePlayback>((set, get) => ({
  ...read(),
  kitState: 'none',
  setKitState: kitState => set({ kitState }),
  update: patch => {
    const { output, allDevices, fireOffsetMs, videoVolume, overallGain } = get()
    const next = parseScenePlayback({ output, allDevices, fireOffsetMs, videoVolume, overallGain, ...patch })
    set(next)
    try { localStorage.setItem(SCENE_PLAYBACK_STORAGE_KEY, JSON.stringify(next)) } catch { /* a preference must not stop work */ }
  },
}))
