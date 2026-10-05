import { useSceneStore, sceneVideoUrl } from '@/stores/sceneStore'
import { perfTrack } from '@/utils/perfRegistry'
import { useSceneSettings } from '@/stores/sceneSettings'
import { clipEnd, focusEvent, itemEvents, levelAt, offsetOf, type SceneItem, type VisibleEvent } from '@/utils/sceneData'
import { isLoopCue, routeClips, sfxSounds, type CueRoute, type CueSfx, soundIntensity } from '@/utils/sceneCueTable'
import { effectiveEvent, fireShot, MaterialPicker, resolveEventName } from '@/utils/cueEvents'
import { runPosition } from '@/utils/sceneSegments'
import { buildLoopVoices, shotVoices, LEAD_MS, LOOKAHEAD, matchesAddress, RATE, SceneHapticMixer, targetsOf, type HapticDevice, type HelperSend } from '@/utils/sceneHaptics'

export const SPEEDS = [1, 0.5, 0.25]

/**
 * The Scene tab's playback engine (one per tab, outlives dock panels): the
 * video element (moved into whichever panel shows it), cue sounds via Web Audio
 * scheduled against the video clock, and the per-device haptic streams through
 * hapbeat-helper. A 10 ms tick fires the cues the video is about to reach.
 * Ported from the standalone viewer's tick() / fire() / pumpHaptics().
 */
/** One firing as played: video time, the event's short name (variant or cue) and its sound / clips. */
export interface FiredShot { at: number; name: string; materials: string[]; durSec: number }

export class SceneRuntime {
  readonly video: HTMLVideoElement
  speedIndex = 0
  /** W: loop ±0.5 s around the focused cue. */
  part = false
  partAB: [number, number] | null = null
  private actx: AudioContext | null = null
  private scheduledSfx: { src: AudioBufferSourceNode; at: number }[] = []
  private mixer: SceneHapticMixer
  private helper: { send: HelperSend; connected: boolean; devices: HapticDevice[] } = { send: () => {}, connected: false, devices: [] }
  private cursor: number | null = null
  private lastVt = 0
  private lastItem = -1
  /** Full replay time to start from once its video has loaded (playFull while another moment was shown). */
  private pendingStart: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  /** Multi-material picks (v2 `clips` / `sounds`), per event. */
  private picker = new MaterialPicker()
  /** Called for every firing with its video time, event and what it plays (the overlay's "bite: bite_t51_a"). */
  private firedListeners = new Set<(fired: FiredShot) => void>()
  onFired(listener: (fired: FiredShot) => void) { this.firedListeners.add(listener); return () => { this.firedListeners.delete(listener) } }

  constructor() {
    this.video = document.createElement('video')
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto'
    this.video.className = 'scene-video'
    this.mixer = new SceneHapticMixer((type, payload) => this.helper.send(type, payload), text => useSceneStore.getState().addLog(text))
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 10)
    perfTrack('intervals', 1)
    let prev = useSceneStore.getState()
    this.unsubscribe = useSceneStore.subscribe(state => {
      if (state.cur !== prev.cur || state.items[state.cur]?.file !== prev.items[prev.cur]?.file || (state.items !== prev.items && !state.items.length)) this.loadItem()
      if (state.table !== prev.table || state.lib !== prev.lib) this.rebuildLoops()
      prev = state
    })
    this.rebuildLoops()
    if (useSceneStore.getState().items.length) this.loadItem()
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); perfTrack('intervals', -1) }
    this.timer = null
    this.unsubscribe?.(); this.unsubscribe = null
    this.video.pause()
    this.flush()
    this.mixer.endSessions()
  }
  dispose() { this.stop(); if (this.actx) { void this.actx.close(); perfTrack('audioContexts', -1) } this.actx = null }

  setHelper(helper: { send: HelperSend; connected: boolean; devices: HapticDevice[] }) { this.helper = helper }
  get streaming() { return this.mixer.streaming }

  item(): SceneItem | undefined { const s = useSceneStore.getState(); return s.items[s.cur] }
  events(): VisibleEvent[] {
    const s = useSceneStore.getState(), it = s.items[s.cur]
    return it && s.data ? itemEvents(it, s.data.full.events, s.data.fps) : []
  }

  /** Unlocks Web Audio (call from a user gesture). */
  audio(): AudioContext {
    if (!this.actx) { this.actx = new AudioContext(); perfTrack('audioContexts', 1) }
    if (this.actx.state === 'suspended') void this.actx.resume()
    return this.actx
  }

  private loadItem() {
    const s = useSceneStore.getState(), it = s.items[s.cur], root = s.root, cur = s.cur
    if (!it || !root) { this.video.removeAttribute('src'); this.video.load(); return }
    this.video.loop = this.loopOn()
    this.video.onloadedmetadata = () => {
      this.video.playbackRate = SPEEDS[this.speedIndex]
      const start = this.pendingStart
      this.pendingStart = null
      // Only a user's ▶ (playFull) starts it; loading a moment (reload, opening a project, selecting) leaves it paused.
      if (start !== null) { this.seek(start); void this.video.play().catch(() => {}) }
      else if (this.part) this.setPart(true, false)
    }
    sceneVideoUrl(root, it.file).then(url => { if (useSceneStore.getState().cur === cur && this.video.src !== url) this.video.src = url },
      error => useSceneStore.getState().note({ id: 'scene.video.unreadable', params: { file: it.file, error: error instanceof Error ? error.message : String(error) }, error: true }))
  }
  private loopOn() { return useSceneSettings.getState().loop && !this.part }
  applyLoop() { this.video.loop = this.loopOn() }

  togglePlay() { if (this.video.paused) void this.video.play().catch(() => {}); else this.video.pause() }
  seek(t: number) { this.video.currentTime = Math.max(0, Math.min(t, (this.video.duration || 0) - 0.001)) }
  step(frames: number) {
    const fps = useSceneStore.getState().data?.fps ?? 30
    this.video.pause()
    this.seek((Math.round(this.video.currentTime * fps) + frames + 0.5) / fps)
  }
  cycleSpeed() { this.speedIndex = (this.speedIndex + 1) % SPEEDS.length; this.video.playbackRate = SPEEDS[this.speedIndex] }
  /** W: loop ±0.5 s around the focused cue; `play` false only cues it (a moment just loaded). */
  setPart(on: boolean, play = true) {
    this.part = on
    this.partAB = null
    const it = this.item()
    if (on && it) {
      const e = focusEvent(it, this.events(), this.video.currentTime, useSceneStore.getState().lib?.ticks ?? [])
      if (e) { this.partAB = [Math.max(0, e.t - 0.5), e.t + 0.5]; this.seek(this.partAB[0]); if (play) void this.video.play().catch(() => {}) }
    }
    this.applyLoop()
  }
  /** Plays moment `index` from `leadSec` before its mark (the full replay from its start), loading it first when another is shown. */
  playMoment(index: number, leadSec: number) {
    const s = useSceneStore.getState(), it = s.items[index]
    if (!it) return
    const t = it.kind === 'clip' ? Math.max(0, it.event - leadSec) : 0
    if (s.cur === index && this.video.readyState >= 1) { this.seek(t); void this.video.play().catch(() => {}); return }
    this.pendingStart = t
    s.select(index)
  }
  /** Plays the full replay (moment 0) from replay time `t`, switching to it first when another moment is shown. */
  playFull(t: number) {
    const s = useSceneStore.getState()
    if (s.items[s.cur]?.kind === 'full' && this.video.readyState >= 1) { this.seek(t); void this.video.play().catch(() => {}); return }
    this.pendingStart = t
    const index = s.items.findIndex(it => it.kind === 'full')
    if (index >= 0) s.select(index)
  }
  restart() { this.seek(this.part && this.partAB ? this.partAB[0] : 0); void this.video.play().catch(() => {}) }

  /** Plays one cue sound now (▶ in the Sound panel; its first sound), regardless of the PC sound setting. */
  testSound(sfx: CueSfx) { const sound = sfxSounds(sfx)[0]; if (sound) this.playSfx(sound, sfx.volume, 0, true) }
  /** Sends one route (its first clip) to its devices now (▶ in the Haptics panel). Returns how many devices it reaches. */
  testRoute(r: CueRoute): number {
    const s = useSceneStore.getState(), name = routeClips(r)[0], clip = name === undefined ? undefined : s.table?.clips[name]
    let p = name === undefined ? undefined : s.pcm[name]
    if (!clip || !p) return 0
    if (clip.loop) { const q = new Float32Array(RATE); for (let i = 0; i < RATE; i++) q[i] = p[i % p.length]; p = q }
    this.mixer.voices.push({ pcm: p, targets: targetsOf(r.at), gain: clip.intensity * r.gain, start: performance.now() + LEAD_MS })
    return this.helper.devices.filter(d => targetsOf(r.at).some(tg => matchesAddress(tg, d.address))).length
  }

  private playSfx(sound: string, volume: number, delay: number, force: boolean, rate = 1) {
    const b = useSceneStore.getState().sfx[sound]
    if (!b || (!force && !useSceneSettings.getState().pcSound)) return
    const c = this.audio(), src = c.createBufferSource(), g = c.createGain()
    // WAV × the sound's base level × the scene multiplier (sfx.volume, with this firing's jitter) — DEC-086.
    const table = useSceneStore.getState().table
    src.buffer = b; src.playbackRate.value = rate; g.gain.value = volume * (table ? soundIntensity(table, sound) : 1); src.connect(g).connect(c.destination)
    const at = c.currentTime + delay
    src.start(at)
    if (!force) this.scheduledSfx.push({ src, at }) // cue sounds are cancelled on seek; a ▶ test is not
  }
  /**
   * One cue occurrence (`cue` or `cue:variant`): one firing (fireShot, shared with
   * the editor's preview sequence) — picks per `variation.pick`, one gain jitter
   * for sound and haptics, the sound's pitch jitter as its playback rate and the
   * haptic rate jitter. Loop cues are layer driven (no cue sound here).
   */
  private fire(ev: VisibleEvent | { name: string; hand: string; gain?: number }, delay: number) {
    const s = useSceneStore.getState(), resolved = s.table && resolveEventName(s.table, ev.name), e = resolved && s.table && effectiveEvent(s.table, resolved.ref)
    if (!e || !s.table || !s.lib) return
    const loop = isLoopCue(s.lib, e.ref.cue)
    // A variant's ramp (rampTo / rampCurve / rampSteps) by which firing of its run this is in the recording.
    const shot = fireShot(e, loop, this.picker, Math.random, 't' in ev && s.data ? runPosition(s.data.full.events, ev) : undefined, 'dist' in ev ? ev.dist : undefined)
    if (shot.sound && !loop) this.playSfx(shot.sound, shot.soundGain, delay, false, 2 ** (shot.pitchSt / 12))
    if (this.firedListeners.size) {
      const materials = [...(shot.sound && !loop ? [shot.sound] : []), ...shot.routes.map(r => r.clip)]
      const durSec = Math.max(shot.sound && !loop ? s.sfx[shot.sound]?.duration ?? 0 : 0, ...shot.routes.map(r => (s.pcm[r.clip]?.length ?? 0) / RATE))
      const fired: FiredShot = { at: this.video.currentTime + delay * this.video.playbackRate, name: e.ref.variant ?? e.ref.cue, materials, durSec }
      if (materials.length) for (const l of this.firedListeners) l(fired)
    }
    if (!useSceneSettings.getState().sendHaptics) return
    this.mixer.voices.push(...shotVoices(s.table, s.pcm, shot, ev.hand, ev.gain ?? 1, performance.now() + delay * 1000))
  }
  private flush() {
    if (this.actx) for (const x of this.scheduledSfx) if (x.at > this.actx.currentTime) try { x.src.stop() } catch { /* already ended */ }
    this.scheduledSfx.length = 0
    this.mixer.flush(performance.now())
  }
  private rebuildLoops() {
    const s = useSceneStore.getState()
    this.mixer.loopVoices = s.table && s.lib ? buildLoopVoices(s.table, s.lib) : []
  }

  /** Fires the cues the video is about to reach (both outputs) and keeps the device streams fed. */
  private tick() {
    const s = useSceneStore.getState(), it = s.items[s.cur], now = performance.now(), v = this.video
    if (this.part && this.partAB && (v.currentTime >= this.partAB[1] || v.ended)) { const ended = v.ended; this.seek(this.partAB[0]); if (ended) void v.play().catch(() => {}) }
    const playing = !!s.table && !!it && !v.paused && !v.seeking && v.readyState >= 2
    if (!playing || s.cur !== this.lastItem) { this.flush(); this.cursor = null; this.mixer.clock = null; this.lastItem = s.cur }
    if (playing && it && s.data) {
      const vt = v.currentTime, rate = v.playbackRate, t = vt + offsetOf(it)
      if (this.cursor !== null && (vt < this.lastVt - 0.02 || vt > this.lastVt + 1)) { this.flush(); this.cursor = null } // loop / seek
      if (this.cursor === null) this.cursor = t - 0.005
      const end = Math.min(t + LOOKAHEAD * rate, offsetOf(it) + (this.part && this.partAB ? this.partAB[1] : clipEnd(it, s.data.fps)))
      for (const ev of s.data.full.events) if (ev.t > this.cursor && ev.t <= end) this.fire(ev, Math.max(0, (ev.t - t) / rate))
      this.cursor = Math.max(this.cursor, end)
      this.lastVt = vt
      this.mixer.clock = { t, rate, wall: now }
    }
    if (this.actx) while (this.scheduledSfx.length && this.scheduledSfx[0].at < this.actx.currentTime - 5) this.scheduledSfx.shift()
    const settings = useSceneSettings.getState(), data = s.data, lib = s.lib
    this.mixer.pump(now, {
      enabled: settings.sendHaptics && this.helper.connected, playing, devices: this.helper.devices, leadMs: settings.hapticLeadMs, pcm: s.pcm,
      level: (t, layer, side) => data && lib ? levelAt(data.full.levels, data.fps, lib.layers[layer], t, side) : [0, 1],
    })
  }
}
