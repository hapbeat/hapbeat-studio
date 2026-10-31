import { useSceneStore, sceneVideoUrl } from '@/stores/sceneStore'
import { usePcTiming } from '@/stores/pcTiming'
import { effectiveOutput, useScenePlayback, type SceneOutput } from '@/stores/scenePlayback'
import { perfTrack } from '@/utils/perfRegistry'
import { useSceneSettings } from '@/stores/sceneSettings'
import { clipEnd, focusEvent, itemEvents, levelAt, momentStart, type SceneItem, type VisibleEvent } from '@/utils/sceneData'
import { isLoopCue, routeClips, sfxSounds, type CueRoute, type CueSfx, soundIntensity } from '@/utils/sceneCueTable'
import { effectiveEvent, fireShot, MaterialPicker, resolveEventName } from '@/utils/cueEvents'
import { runPosition } from '@/utils/sceneSegments'
import { buildLoopSounds, LoopSoundPlayer, loopSoundLevel, type LoopSound } from '@/utils/sceneLoopSounds'
import { buildLoopVoices, shotVoices, type LoopVoice, LEAD_MS, LOOKAHEAD, matchesAddress, RATE, routeTargets, SceneHapticMixer, type HapticDevice, type HelperSend, type StreamAck, type StreamDisplaced } from '@/utils/sceneHaptics'
import { SceneKitFire } from '@/utils/sceneKitFire'
import { isStreamOpen } from '@/utils/openStreams'
import { useSceneStrength } from '@/stores/sceneStrength'
import { hapticAllowed } from '@/utils/sceneStrength'

export const SPEEDS = [1, 0.5, 0.25]

/**
 * The Scene tab's playback engine (one per tab, outlives dock panels): the
 * video element (moved into whichever panel shows it), cue sounds via Web Audio
 * scheduled against the video clock, loop-cue sounds following the recorded
 * layer levels (like the haptic loop layers), the video's own soundtrack (with the PC sound), and the haptics through
 * hapbeat-helper: per-device PCM streams (CLIP output) or PLAY of the installed Kit's events (FIRE output,
 * scenePlayback; CLIP until the Kit is known to be on every device, effectiveOutput). A 10 ms tick fires the cues the video is about to reach.
 * Every item plays the full replay video (video time = replay time); a moment is its stretch of it, played from
 * the lead-in before its mark (momentStart) to its end, where it stops (or, looped, goes back to that start).
 * Ported from the standalone viewer's tick() / fire() / pumpHaptics().
 */
/** One firing as played: video time, the event's short name (variant or cue) and its sound / clips. */
export interface FiredShot { at: number; name: string; materials: string[]; durSec: number }

export class SceneRuntime {
  readonly video: HTMLVideoElement
  speedIndex = 0
  /** W: loop ±0.5 s around the focused cue; also on while a loop cue's span plays (playSpan, `span`). */
  part = false
  partAB: [number, number] | null = null
  /** The part is a loop cue's span (playSpan), not W's ±0.5 s: a moment, W or another span ends it. */
  private span = false
  private actx: AudioContext | null = null
  private scheduledSfx: { src: AudioBufferSourceNode; at: number }[] = []
  private mixer: SceneHapticMixer
  private kitFire: SceneKitFire
  /** Loop cues' sounds, looped at the recorded layer level. */
  private loopSounds: LoopSound[] = []
  private loopPlayer = new LoopSoundPlayer()
  private helper: { send: HelperSend; connected: boolean; devices: HapticDevice[] } = { send: () => {}, connected: false, devices: [] }
  private cursor: number | null = null
  private lastVt = 0
  private lastItem = -1
  /** The output the cursor fired its lookahead through (effectiveOutput). */
  private lastOutput: SceneOutput = 'clip'
  /** Time to start from once the item's video is ready (playMoment / playFull while another item was shown). */
  private pendingStart: number | null = null
  /** Whether the pending start also plays (a moment / span / ▶ does; 「全編に戻って続ける」 keeps a paused video paused). */
  private pendingPlay = true
  /** The moment whose video the element holds (set once its URL is assigned); the old one plays on until then. */
  private loadedCur = -1
  /** Whether the video has played inside the moment / span shown now (else 「全編に戻って続ける」 starts at its mark − lead). */
  private playedHere = false
  /**
   * The last full-replay playhead outside a loop cue span (replay seconds): where the 全編 row and 「全編に戻って続ける」
   * resume after tuning a moment or a span. 0 for a newly opened recording.
   */
  fullTime = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribes: (() => void)[] = []
  /** Multi-material picks (v2 `clips` / `sounds`), per event. */
  private picker = new MaterialPicker()
  /** Called for every firing with its video time, event and what it plays (the overlay's "bite: bite_t51_a"). */
  private firedListeners = new Set<(fired: FiredShot) => void>()
  onFired(listener: (fired: FiredShot) => void) { this.firedListeners.add(listener); return () => { this.firedListeners.delete(listener) } }

  constructor() {
    this.video = document.createElement('video')
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto'
    this.video.className = 'scene-video'
    this.mixer = new SceneHapticMixer((type, payload) => this.helper.send(type, payload), text => useSceneStore.getState().addLog(text), isStreamOpen)
    this.kitFire = new SceneKitFire({
      send: (type, payload) => this.helper.send(type, payload), now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      log: text => useSceneStore.getState().addLog(text),
    })
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 10)
    perfTrack('intervals', 1)
    let prev = useSceneStore.getState()
    this.unsubscribes.push(useSceneStore.subscribe(state => {
      // A new moment, another file, or a newly opened recording (a re-opened project revokes the old video URLs, even for
      // the same file names; its levels are new); not a mere rename of the items (firing overrides) or a firing gain
      // edit (setFiringGains keeps the levels), which keep the video playing.
      const newRecording = state.recorded?.full.levels !== prev.recorded?.full.levels
      if (state.root !== prev.root || newRecording) this.fullTime = 0
      if (state.cur !== prev.cur || state.root !== prev.root || newRecording || state.items[state.cur]?.file !== prev.items[prev.cur]?.file
        || (state.items !== prev.items && !state.items.length)) this.loadItem()
      if (state.table !== prev.table || state.lib !== prev.lib) this.rebuildLoops()
      prev = state
    }))
    // The video's soundtrack follows the PC sound (M, the toggles) at this PC's video volume (a recording has none).
    this.applyVideoSound()
    this.unsubscribes.push(useSceneSettings.subscribe((now, before) => { if (now.pcSound !== before.pcSound) this.applyVideoSound() }))
    this.unsubscribes.push(useScenePlayback.subscribe((now, before) => {
      if (now.videoVolume !== before.videoVolume) this.applyVideoSound()
      if (now.allDevices !== before.allDevices || now.overallGain !== before.overallGain) this.rebuildLoops()
    }))
    this.rebuildLoops()
    if (useSceneStore.getState().items.length) this.loadItem()
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); perfTrack('intervals', -1) }
    this.timer = null
    for (const off of this.unsubscribes) off()
    this.unsubscribes = []
    this.video.pause()
    this.flush()
    this.kitFire.stopAll(this.helper.connected, this.helper.devices)
    this.mixer.endSessions()
  }
  dispose() { this.stop(); if (this.actx) { void this.actx.close(); perfTrack('audioContexts', -1) } this.actx = null }

  setHelper(helper: { send: HelperSend; connected: boolean; devices: HapticDevice[] }) { this.helper = helper }
  get streaming() { return this.mixer.streaming }
  /** Whether a helper `stream_ack` is for one of this tab's device streams. */
  ownsStream(streamId: string | undefined) { return this.mixer.owns(streamId) }
  /** A helper `stream_ack`: a rejected / partial BEGIN re-opens that device's stream after a back-off. */
  streamAck(ack: StreamAck) { this.mixer.onAck(ack, performance.now()) }
  /** A helper `stream_displaced`: another client's stream re-opens after the back-off, this tab's waits until it ends. */
  streamDisplaced(note: StreamDisplaced) { this.mixer.onDisplaced(note, performance.now()) }
  /** Sends stream_end for every open device stream (page unload: React cleanups do not run). */
  endStreams() { this.mixer.endSessions() }

  item(): SceneItem | undefined { const s = useSceneStore.getState(); return s.items[s.cur] }
  events(): VisibleEvent[] {
    const s = useSceneStore.getState(), it = s.items[s.cur]
    return it && s.data ? itemEvents(it, s.data.full.events) : []
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
    this.video.onloadedmetadata = () => this.itemReady()
    // Every item is the same full replay video: an item whose video is already in the element is ready at once.
    sceneVideoUrl(root, it.file).then(url => {
      if (useSceneStore.getState().cur !== cur) return
      const same = this.video.src === url
      if (!same) this.video.src = url
      this.loadedCur = cur
      if (same && this.video.readyState >= 1) this.itemReady()
    }, error => useSceneStore.getState().note({ id: 'scene.video.unreadable', params: { file: it.file, error: error instanceof Error ? error.message : String(error) }, error: true }))
  }
  /** The shown item's video is ready: its pending start (playing or not), else W's part, else a moment's start (paused) or the full replay's last position. */
  private itemReady() {
    this.video.playbackRate = SPEEDS[this.speedIndex]
    const start = this.pendingStart
    this.pendingStart = null
    // Only a user's ▶ (playMoment / playFull) starts it; showing an item (reload, opening a project, selecting) leaves it paused.
    if (start !== null) { this.seek(start); if (this.pendingPlay) void this.video.play().catch(() => {}); return }
    if (this.part) { this.setPart(true, false); return }
    const it = this.item()
    this.seek(it?.kind === 'clip' ? momentStart(it, useSceneSettings.getState().leadSec) : this.fullTime)
  }
  /** The video element loops by itself only in the full replay without a chapter (a moment's stretch, W's part and a chapter loop in tick()). */
  private loopOn() { return useSceneSettings.getState().loop && !this.part && this.item()?.kind !== 'clip' && useSceneStore.getState().chapter === null }
  /**
   * The stretch the shown item plays (W's part, else a moment's: from its lead-in to its end, else the full replay's
   * chapter); null = the whole replay.
   */
  private playRange(it: SceneItem): [number, number] | null {
    if (this.part && this.partAB) return this.partAB
    if (it.kind === 'clip') return [momentStart(it, useSceneSettings.getState().leadSec), clipEnd(it)]
    const s = useSceneStore.getState(), c = s.chapter === null ? undefined : s.data?.chapters[s.chapter]
    return c ? [c.start, c.end] : null
  }
  applyLoop() { this.video.loop = this.loopOn() }
  private applyVideoSound() { this.video.muted = !useSceneSettings.getState().pcSound; this.video.volume = useScenePlayback.getState().videoVolume }

  /** ▶ at (or past) the end of the play range starts it again. */
  togglePlay() {
    const it = this.item(), range = it && this.playRange(it)
    if (!this.video.paused) { this.video.pause(); return }
    if (range && this.video.currentTime >= range[1] - 0.01) this.seek(range[0])
    void this.video.play().catch(() => {})
  }
  /** A seek out of the chapter playing (the overlay bar, the timeline, the keys) leaves the chapter: the full replay plays on from there. */
  seek(t: number) {
    const s = useSceneStore.getState(), c = s.chapter === null ? undefined : s.data?.chapters[s.chapter]
    if (c && (t < c.start || t >= c.end)) { this.endChapter(); this.applyLoop() }
    this.video.currentTime = Math.max(0, Math.min(t, (this.video.duration || 0) - 0.001))
  }
  step(frames: number) {
    const fps = useSceneStore.getState().data?.fps ?? 30
    this.video.pause()
    this.seek((Math.round(this.video.currentTime * fps) + frames + 0.5) / fps)
  }
  cycleSpeed() { this.speedIndex = (this.speedIndex + 1) % SPEEDS.length; this.video.playbackRate = SPEEDS[this.speedIndex] }
  /** W: loop ±0.5 s around the focused cue; `play` false only cues it (a moment just loaded). */
  setPart(on: boolean, play = true) {
    this.endSpan(); this.endChapter()
    this.part = on
    this.partAB = null
    const it = this.item()
    if (on && it) {
      const e = focusEvent(it, this.events(), this.video.currentTime, useSceneStore.getState().lib?.ticks ?? [])
      if (e) { this.partAB = [Math.max(0, e.t - 0.5), e.t + 0.5]; this.seek(this.partAB[0]); if (play) void this.video.play().catch(() => {}) }
    }
    this.applyLoop()
  }
  /**
   * Plays moment `index` from `leadSec` before its mark, loading it first when another is shown. The full replay resumes
   * at `fullTime` (where it was left for a moment or a span; shown without a span: plays on from where it is).
   */
  playMoment(index: number, leadSec: number) {
    const s = useSceneStore.getState(), it = s.items[index]
    if (!it) return
    const wasSpan = this.span
    this.endChapter()
    if (this.span) { this.endSpan(); this.part = false; this.partAB = null }
    this.applyLoop()
    const t = it.kind === 'clip' ? momentStart(it, leadSec) : this.fullTime
    if (s.cur === index && this.video.readyState >= 1) { if (it.kind === 'clip' || wasSpan) this.seek(t); void this.video.play().catch(() => {}); return }
    this.pendingStart = t
    this.pendingPlay = true
    s.select(index)
  }
  /** Plays the full replay (moment 0) from replay time `t`, switching to it first when another moment is shown. */
  playFull(t: number) { this.showFull(t, true) }
  /** The full replay at replay time `t`, playing or paused (`play`), switching to it first when another moment is shown. */
  private showFull(t: number, play: boolean) {
    const s = useSceneStore.getState()
    if (s.items[s.cur]?.kind === 'full' && this.video.readyState >= 1) { this.seek(t); if (play) void this.video.play().catch(() => {}); return }
    this.pendingStart = t
    this.pendingPlay = play
    const index = s.items.findIndex(it => it.kind === 'full')
    if (index >= 0) s.select(index)
  }
  /**
   * 「全編に戻って続ける」 (F): the full replay without the moment's / span's play range (no span, no W loop), at the
   * position shown now (video time is replay time); before anything played there, the moment's mark (a span: its
   * start) − the lead-in. Playing stays playing, paused stays paused.
   */
  returnToFull() {
    const s = useSceneStore.getState(), it = s.items[s.cur], v = this.video
    if (!it) return
    const lead = useSceneSettings.getState().leadSec, play = !v.paused
    const t = it.kind === 'clip' ? (this.playedHere ? v.currentTime : Math.max(0, it.at - lead))
      : this.span && this.partAB && !this.playedHere ? this.partAB[0] : v.currentTime
    this.endSpan(); this.endChapter(); this.part = false; this.partAB = null; this.applyLoop()
    this.fullTime = t
    this.showFull(t, play)
  }
  /**
   * Plays a loop cue's active span `run` (replay seconds) in the full replay, from `leadSec` before its start to
   * `postSec` after its end, repeated like W's part until a moment, W or another span is chosen.
   */
  playSpan(run: [number, number], leadSec: number, postSec: number) {
    this.endChapter()
    this.playedHere = false
    this.span = true
    this.part = true
    this.partAB = [Math.max(0, run[0] - leadSec), run[1] + postSec]
    useSceneStore.getState().setSpan(run)
    this.applyLoop()
    this.playFull(this.partAB[0])
  }
  /**
   * Plays chapter `index` (data.chapters, scene-recording section 3.2.1) in the full replay from its start; its range
   * then plays like a moment's (back to its start with the loop setting on, else it stops at its end). Ends a span or
   * W's part; another item, a moment, W, a span or F ends the chapter.
   */
  playChapter(index: number) {
    const c = useSceneStore.getState().data?.chapters[index]
    if (!c) return
    this.endSpan(); this.part = false; this.partAB = null
    this.showFull(c.start, true) // selecting the full replay clears the chapter (sceneStore.select): set it after
    useSceneStore.getState().setChapter(index)
    this.applyLoop()
  }
  private endChapter() { if (useSceneStore.getState().chapter !== null) useSceneStore.getState().setChapter(null) }
  private endSpan() {
    if (!this.span) return
    this.span = false
    useSceneStore.getState().setSpan(null)
  }
  restart() { const it = this.item(), range = it && this.playRange(it); this.seek(range ? range[0] : 0); void this.video.play().catch(() => {}) }

  /** Plays one cue sound now (▶ in the Sound panel; its first sound), regardless of the PC sound setting. */
  testSound(sfx: CueSfx) { const sound = sfxSounds(sfx)[0]; if (sound) this.playSfx(sound, sfx.volume, 0, true) }
  /**
   * Sends one route (its first clip) to its devices now (▶ in the Haptics panel), by the output (CLIP: 1 s of a loop
   * clip into the stream; FIRE: its Kit event, a loop stopped after 1 s). Returns how many devices it reaches.
   */
  testRoute(r: CueRoute): number {
    const s = useSceneStore.getState(), pb = useScenePlayback.getState(), name = routeClips(r)[0], clip = name === undefined ? undefined : s.table?.clips[name]
    if (!clip || name === undefined || !s.table) return 0
    if (effectiveOutput(pb) === 'fire') return this.kitFire.test({ table: s.table, clip: name, at: r.at, gain: r.gain * pb.overallGain, devices: this.helper.devices, all: pb.allDevices })
    let p = s.pcm[name]
    if (!p) return 0
    if (clip.loop) { const q = new Float32Array(RATE); for (let i = 0; i < RATE; i++) q[i] = p[i % p.length]; p = q }
    const targets = routeTargets(r.at, undefined, pb.allDevices)
    this.mixer.voices.push({ pcm: p, targets, gain: clip.intensity * r.gain * pb.overallGain, start: performance.now() + LEAD_MS })
    return this.helper.devices.filter(d => targets.some(tg => matchesAddress(tg, d.address))).length
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
   * haptic rate jitter. Loop cues are layer driven (their sound plays in tick(), at the recorded level).
   */
  private fire(ev: VisibleEvent | { name: string; hand: string; gain?: number }, delay: number) {
    const s = useSceneStore.getState(), resolved = s.table && resolveEventName(s.table, ev.name), e = resolved && s.table && effectiveEvent(s.table, resolved.ref)
    if (!e || !s.table || !s.lib) return
    const loop = isLoopCue(s.table, e.ref.cue)
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
    // The strength panel's M / S (this session only).
    const st = useSceneStrength.getState()
    if (!hapticAllowed(ev.name, st.muted, st.soloed)) return
    // The firing's own gain × this PC's overall multiplier (the send clamp stays where it was: the Kit PLAY, the PCM16 mix).
    const pb = useScenePlayback.getState(), cueGain = (ev.gain ?? 1) * pb.overallGain
    if (effectiveOutput(pb) === 'fire') {
      if (this.helper.connected) this.kitFire.shot({ table: s.table, shot, hand: ev.hand, cueGain, delayMs: delay * 1000, offsetMs: pb.fireOffsetMs, devices: this.helper.devices, all: pb.allDevices })
      return
    }
    this.mixer.voices.push(...shotVoices(s.table, s.pcm, shot, ev.hand, cueGain, performance.now() + delay * 1000, pb.allDevices))
  }
  private flush() {
    if (this.actx) for (const x of this.scheduledSfx) if (x.at > this.actx.currentTime) try { x.src.stop() } catch { /* already ended */ }
    this.scheduledSfx.length = 0
    if (this.actx) this.loopPlayer.stopAll(this.actx)
    this.mixer.flush(performance.now())
    this.kitFire.flush(this.helper.connected)
  }
  private rebuildLoops() {
    const s = useSceneStore.getState(), pb = useScenePlayback.getState()
    // This PC's overall multiplier on the loops too (the CLIP mix and FIRE's loopTick read these voices). M / S are
    // applied each tick (loopOn), so toggling them never rebuilds the voices (their phases go on).
    this.mixer.loopVoices = s.table && s.lib ? buildLoopVoices(s.table, s.lib, pb.allDevices).map(v => ({ ...v, gain: v.gain * pb.overallGain })) : []
    this.loopSounds = s.table && s.lib ? buildLoopSounds(s.table, s.lib) : []
  }

  /** Fires the cues the video is about to reach (both outputs) and keeps the device streams fed. */
  private tick() {
    const s = useSceneStore.getState(), it = s.items[s.cur], now = performance.now(), v = this.video
    const settings = useSceneSettings.getState(), pb = useScenePlayback.getState(), output = effectiveOutput(pb)
    const fireOn = settings.sendHaptics && this.helper.connected && output === 'fire'
    // The output switched: the old path drops the cues it had scheduled ahead, so fire the window again through the new one.
    if (output !== this.lastOutput) { this.flush(); this.cursor = null; this.lastOutput = output }
    // The end of the play range: W's part and a looped moment go back to its start, an unlooped moment stops there.
    const range = it && this.loadedCur === s.cur ? this.playRange(it) : null
    if (range && (v.currentTime >= range[1] || v.ended)) {
      if (this.part || useSceneSettings.getState().loop) { const ended = v.ended; this.seek(range[0]); if (ended) void v.play().catch(() => {}) }
      else if (!v.paused) v.pause()
    }
    const playing = !!s.table && !!it && !v.paused && !v.seeking && v.readyState >= 2
    if (s.cur !== this.lastItem) this.playedHere = false
    // The full replay's playhead (its own video, loaded, outside a span): where it resumes after a moment or a span.
    if (it?.kind === 'full' && !this.span && this.loadedCur === s.cur && this.pendingStart === null && v.readyState >= 1) this.fullTime = v.currentTime
    if (!v.paused && v.readyState >= 1 && this.loadedCur === s.cur) this.playedHere = true
    if (!playing || s.cur !== this.lastItem) { this.flush(); this.cursor = null; this.mixer.clock = null; this.lastItem = s.cur }
    if (playing && it && s.data) {
      const vt = v.currentTime, rate = v.playbackRate, t = vt
      if (this.cursor !== null && (vt < this.lastVt - 0.02 || vt > this.lastVt + 1)) { this.flush(); this.cursor = null } // loop / seek
      if (this.cursor === null) this.cursor = t - 0.005
      // FIRE sends each PLAY at its cue's time + fireOffsetMs: a negative offset needs the cue that much earlier.
      const lookahead = LOOKAHEAD + (output === 'fire' ? Math.max(0, -pb.fireOffsetMs) / 1000 : 0)
      const end = Math.min(t + lookahead * rate, range ? range[1] : clipEnd(it))
      for (const ev of s.data.full.events) if (ev.t > this.cursor && ev.t <= end) this.fire(ev, Math.max(0, (ev.t - t) / rate))
      this.cursor = Math.max(this.cursor, end)
      this.lastVt = vt
      this.mixer.clock = { t, rate, wall: now }
    }
    if (this.actx) while (this.scheduledSfx.length && this.scheduledSfx[0].at < this.actx.currentTime - 5) this.scheduledSfx.shift()
    const data = s.data, lib = s.lib
    // Loop-cue sounds at the level recorded for the replay time now (both hands' louder gain, its rate), with the PC sound on.
    if (playing && it && data && lib && settings.pcSound && this.loopSounds.length) {
      const t = v.currentTime
      this.loopPlayer.update(() => this.audio(), this.loopSounds, s.sfx, layer => loopSoundLevel(data.full.levels, data.fps, lib.layers[layer], t))
    } else if (this.actx) this.loopPlayer.stopAll(this.actx)
    // The strength panel's M / S on the loops: a muted loop cue, or any solo of another event, leaves its voices out
    // (FIRE stops them; the mix skips them, keeping their phase).
    const st = useSceneStrength.getState()
    const loopOn = lib && (st.muted.size || st.soloed.size) ? (x: LoopVoice) => hapticAllowed(lib.layers[x.layer]?.cue ?? '', st.muted, st.soloed) : undefined
    // FIRE loops at the level of the replay time the haptic plays for (+ offset = later: an earlier level now).
    if (!fireOn) this.kitFire.stopAll(this.helper.connected, this.helper.devices)
    else if (playing && s.table && data && lib) this.kitFire.loopTick({ table: s.table, voices: loopOn ? this.mixer.loopVoices.filter(loopOn) : this.mixer.loopVoices, t: v.currentTime - pb.fireOffsetMs / 1000 * v.playbackRate, devices: this.helper.devices,
      level: (t, layer, side) => levelAt(data.full.levels, data.fps, lib.layers[layer], t, side) })
    // The stream is off in FIRE output (STOP_ALL there would end its device sessions anyway).
    this.mixer.pump(now, {
      enabled: settings.sendHaptics && this.helper.connected && output === 'clip', playing, devices: this.helper.devices, leadMs: -usePcTiming.getState().offsetMs, pcm: s.pcm,
      level: (t, layer, side) => data && lib ? levelAt(data.full.levels, data.fps, lib.layers[layer], t, side) : [0, 1], loopOn,
    })
  }
}
