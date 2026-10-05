import { useSceneStore, sceneVideoUrl } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { clipEnd, focusEvent, itemEvents, levelAt, offsetOf, type SceneItem, type VisibleEvent } from '@/utils/sceneData'
import { isLoopCue, routeClips, sfxSounds, type CueRoute, type CueSfx } from '@/utils/sceneCueTable'
import { effectiveEvent, fireShot, MaterialPicker, resolveEventName } from '@/utils/cueEvents'
import { buildLoopVoices, shotVoices, LEAD_MS, LOOKAHEAD, matchesAddress, RATE, SceneHapticMixer, targetsOf, type HapticDevice, type HelperSend } from '@/utils/sceneHaptics'

export const SPEEDS = [1, 0.5, 0.25]

/**
 * The Scene tab's playback engine (one per tab, outlives dock panels): the
 * video element (moved into whichever panel shows it), cue sounds via Web Audio
 * scheduled against the video clock, and the per-device haptic streams through
 * hapbeat-helper. A 10 ms tick fires the cues the video is about to reach.
 * Ported from the standalone viewer's tick() / fire() / pumpHaptics().
 */
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
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  /** Multi-material picks (v2 `clips` / `sounds`), per event. */
  private picker = new MaterialPicker()

  constructor() {
    this.video = document.createElement('video')
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto'
    this.video.className = 'scene-video'
    this.mixer = new SceneHapticMixer((type, payload) => this.helper.send(type, payload), text => useSceneStore.getState().addLog(text))
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 10)
    let prev = useSceneStore.getState()
    this.unsubscribe = useSceneStore.subscribe(state => {
      if (state.cur !== prev.cur || state.items !== prev.items) this.loadItem()
      if (state.table !== prev.table || state.lib !== prev.lib) this.rebuildLoops()
      prev = state
    })
    this.rebuildLoops()
    if (useSceneStore.getState().items.length) this.loadItem()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.(); this.unsubscribe = null
    this.video.pause()
    this.flush()
    this.mixer.endSessions()
  }
  dispose() { this.stop(); void this.actx?.close(); this.actx = null }

  setHelper(helper: { send: HelperSend; connected: boolean; devices: HapticDevice[] }) { this.helper = helper }
  get streaming() { return this.mixer.streaming }

  item(): SceneItem | undefined { const s = useSceneStore.getState(); return s.items[s.cur] }
  events(): VisibleEvent[] {
    const s = useSceneStore.getState(), it = s.items[s.cur]
    return it && s.data ? itemEvents(it, s.data.full.events, s.data.fps) : []
  }

  /** Unlocks Web Audio (call from a user gesture). */
  audio(): AudioContext {
    if (!this.actx) this.actx = new AudioContext()
    if (this.actx.state === 'suspended') void this.actx.resume()
    return this.actx
  }

  private loadItem() {
    const s = useSceneStore.getState(), it = s.items[s.cur], root = s.root, cur = s.cur
    if (!it || !root) { this.video.removeAttribute('src'); this.video.load(); return }
    this.video.loop = this.loopOn()
    this.video.onloadedmetadata = () => { this.video.playbackRate = SPEEDS[this.speedIndex]; if (this.part) this.setPart(true); else void this.video.play().catch(() => {}) }
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
  setPart(on: boolean) {
    this.part = on
    this.partAB = null
    const it = this.item()
    if (on && it) {
      const e = focusEvent(it, this.events(), this.video.currentTime, useSceneStore.getState().lib?.ticks ?? [])
      if (e) { this.partAB = [Math.max(0, e.t - 0.5), e.t + 0.5]; this.seek(this.partAB[0]); void this.video.play().catch(() => {}) }
    }
    this.applyLoop()
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
    src.buffer = b; src.playbackRate.value = rate; g.gain.value = volume; src.connect(g).connect(c.destination)
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
    const shot = fireShot(e, loop, this.picker)
    if (shot.sound && !loop) this.playSfx(shot.sound, shot.soundGain, delay, false, 2 ** (shot.pitchSt / 12))
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
