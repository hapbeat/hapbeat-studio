import { levelAt, type SceneLayer, type SceneLib } from './sceneData'
import { sfxSounds, soundIntensity, type CueTable } from './sceneCueTable'

/**
 * The Scene tab's loop-cue sounds (lib.loop_cue_sounds, docs/haptic-authoring-cue-table.md
 * "ループ cue の音"): while the replay plays, each loop cue with an `sfx` loops its
 * first sound (a loop does not re-pick or vary) at the recorded level of its layer,
 * like the haptic loop layers. Gain = recorded level × sfx.volume × the sound's
 * intensity (DEC-086); a layer with a rate column sets the playback rate.
 */
export interface LoopSound { layer: number; sound: string; gain: number }

/** One entry per lib.layers loop cue that has a sound; none unless the project plays loop-cue sounds. */
export function buildLoopSounds(table: CueTable, lib: SceneLib): LoopSound[] {
  if (!lib.loop_cue_sounds) return []
  const out: LoopSound[] = []
  lib.layers.forEach(({ cue }, layer) => {
    const sfx = table.cues[cue]?.sfx, sound = sfxSounds(sfx)[0]
    if (sfx && sound !== undefined) out.push({ layer, sound, gain: sfx.volume * soundIntensity(table, sound) })
  })
  return out
}

/**
 * A loop sound's recorded level at replay time `t`: the louder hand's gain and its
 * rate (levelAt, side -1). The rate column reads 0 on frames where the layer is off,
 * so between an off frame and an on frame the on frame's rate is used (no pitch
 * swoop into or out of silence).
 */
export function loopSoundLevel(levels: number[][], fps: number, layer: SceneLayer, t: number): { gain: number; rate: number } {
  const [gain, rate] = levelAt(levels, fps, layer, t, -1)
  if (gain <= 0 || !layer.rate) return { gain: Math.max(0, gain), rate }
  const i = Math.floor(t * fps), loud = (row: number[]) => Math.max(row[layer.gain[0]], row[layer.gain[1]])
  const on = loud(levels[i]) <= 0 ? levels[i + 1] : loud(levels[i + 1]) <= 0 ? levels[i] : null
  return { gain, rate: on ? on[layer.rate[on[layer.gain[1]] > on[layer.gain[0]] ? 1 : 0]] : rate }
}

/** The Web Audio members the player uses. */
export type LoopAudio = Pick<BaseAudioContext, 'currentTime' | 'destination' | 'createBufferSource' | 'createGain'>

/** Glide time constant (s) of gain and rate changes: ~95 % of a change after 3τ = 45 ms, no zipper noise. */
export const LOOP_SOUND_TAU = 0.015
/** Fade before a loop sound stops (s); the gain falls with τ = a sixth of it. */
export const LOOP_SOUND_FADE = 0.06
/** Smaller changes than this are not rescheduled (a tick every 10 ms). */
const EPS = 1e-4

interface Voice { sound: string; buffer: AudioBuffer; src: AudioBufferSourceNode; g: GainNode; gain: number; rate: number }

/** The looping sources, one per layer: started when its level rises above 0, followed each tick, faded out at 0. */
export class LoopSoundPlayer {
  private voices = new Map<number, Voice>()

  /** Layers whose sound is playing now. */
  get active(): number[] { return [...this.voices.keys()] }

  /**
   * One tick while the replay plays (and PC sound is on): `level(layer)` is the
   * layer's recorded level at the current replay time. `audio` is only asked for
   * when a sound starts, follows or stops.
   */
  update(audio: () => LoopAudio, sounds: LoopSound[], buffers: Record<string, AudioBuffer>, level: (layer: number) => { gain: number; rate: number }) {
    const live = new Set<number>()
    for (const x of sounds) {
      const buffer = buffers[x.sound], at = level(x.layer), gain = at.gain * x.gain
      let v = this.voices.get(x.layer)
      // Another sound (a table edit) or a re-decoded buffer: start over with it.
      if (v && (v.sound !== x.sound || v.buffer !== buffer)) { this.release(audio(), x.layer); v = undefined }
      if (!buffer || !(gain > 0)) { if (v) this.release(audio(), x.layer); continue }
      live.add(x.layer)
      const ctx = audio(), now = ctx.currentTime
      if (!v) {
        const src = ctx.createBufferSource(), g = ctx.createGain()
        src.buffer = buffer; src.loop = true; src.playbackRate.value = at.rate
        g.gain.setValueAtTime(0, now); g.gain.setTargetAtTime(gain, now, LOOP_SOUND_TAU)
        src.connect(g).connect(ctx.destination)
        src.onended = () => { src.disconnect(); g.disconnect() }
        src.start(now)
        this.voices.set(x.layer, { sound: x.sound, buffer, src, g, gain, rate: at.rate })
        continue
      }
      if (Math.abs(gain - v.gain) > EPS) { v.g.gain.setTargetAtTime(gain, now, LOOP_SOUND_TAU); v.gain = gain }
      if (Math.abs(at.rate - v.rate) > EPS) { v.src.playbackRate.setTargetAtTime(at.rate, now, LOOP_SOUND_TAU); v.rate = at.rate }
    }
    // A layer no longer in the list (the table or project changed).
    for (const layer of this.active) if (!live.has(layer)) this.release(audio(), layer)
  }

  /** Fades every sound out (pause, seek, another moment, playback end, PC sound off). */
  stopAll(ctx: LoopAudio) { for (const layer of this.active) this.release(ctx, layer) }

  private release(ctx: LoopAudio, layer: number) {
    const v = this.voices.get(layer)
    if (!v) return
    this.voices.delete(layer)
    const now = ctx.currentTime
    v.g.gain.setTargetAtTime(0, now, LOOP_SOUND_FADE / 6)
    try { v.src.stop(now + LOOP_SOUND_FADE) } catch { /* already stopped */ }
  }
}
