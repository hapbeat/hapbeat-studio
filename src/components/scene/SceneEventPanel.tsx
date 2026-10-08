import { useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { isLoopCue, pairedProblem, PICK_MODES, routeAlternates, routeClips, sfxAlternates, sfxSounds, soundAllowed, VARIANT_NAME, clipsForCue, type CueTable, type CueVariation, type VariationNumberKey, type DistanceFalloff } from '@/utils/sceneCueTable'
import { curveAt, RAMP_CURVES, type RampCurve } from '@/utils/rampCurve'
import { EMIT_INTERVAL_RANGE, EMIT_JITTER_RANGE } from '@/utils/sceneEmit'
import type { SceneLib } from '@/utils/sceneData'
import {
  addMaterial, addVariant, effectiveEvent, eventKey, pairedClips, removeMaterial, removeVariant, resolveEventName, setOverride, setOwnSfxVolume, setStarred, setVariation,
  setVariantKind, setVariantScale, updateOwnRoute, variantKind, rampValue, setDistanceFalloff, setEmit,
  type EffectiveEvent, type OverridableField,
} from '@/utils/cueEvents'
import { longestRun, sceneSegment } from '@/utils/sceneSegments'
import { MaterialList } from '@/components/waveform/MaterialList'
import { PairedList } from '@/components/waveform/PairedList'
import { CuePicker, NumberField, useAtLabel } from './SceneCuePanels'
import { useScene } from './sceneContext'
import { LevelMaps } from './SceneLevelMap'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

const VARIATION_FIELDS: { key: VariationNumberKey; max: number; step: number; loopOk: boolean }[] = [
  { key: 'gainJitterDb', max: 12, step: 0.5, loopOk: true },
  { key: 'pitchJitterSt', max: 12, step: 0.5, loopOk: false },
  { key: 'rateJitterPct', max: 50, step: 1, loopOk: false },
]

/**
 * "Event" details of the selected cue / variant (DEC-085 addendum: the editor only picks materials; how they
 * are used by situation is decided here): its variants and their kind (own materials, or multipliers only:
 * sfxVolume / hapticsGain / rampTo), the scene multipliers (sfx.volume, route gain; DEC-086 3rd layer), the
 * variation (pick, gain / pitch / rate jitter, paired), which materials play (★, DEC-089; the rest are alternates)
 * and removal, a loop cue's level → multiplier (levelMap, DEC-090), and playing the event's run of the recording
 * through (its real firings, as the game computes them). Edits go to the same table and are saved with it.
 */
export function SceneEventPanel() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const data = useSceneStore(s => s.data)
  const sel = useSceneStore(s => s.sel)
  if (!table || !lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const resolved = sel ? resolveEventName(table, sel.name) : null
  const e = resolved ? effectiveEvent(table, resolved.ref) : null
  if (!resolved || !e) return <div className="scene-cue-panel scene-event"><CuePicker /><div className="scene-panel-empty">{t('scene.selectCue')}</div></div>
  const key = eventKey(e.ref), loop = isLoopCue(lib, e.ref.cue), layer = loop ? lib.layers.find(l => l.cue === e.ref.cue) : undefined
  const edit: Edit = change => useSceneStore.getState().edit(change)
  const select = (name: string) => useSceneStore.getState().selectCue(name, sel?.t ?? null)
  const sound = e.sfx ? sfxSounds(e.sfx)[0] : undefined
  const run = data ? sceneSegment(data.full.events, [key], (sound && useSceneStore.getState().sfx[sound]?.duration) || 1) : null
  return <div className="scene-cue-panel scene-event">
    <CuePicker />
    <div className="scene-sec">
      <Variants table={table} e={e} select={select} edit={edit} />
      {e.ref.variant !== null && <VariantScale e={e} edit={edit} />}
      <Falloff table={table} e={e} edit={edit} />
      {e.ref.variant === null && <Emit table={table} lib={lib} cue={e.ref.cue} edit={edit} />}
      {run?.repeating && <button type="button" className="scene-icon-btn scene-event-run" title={t('scene.event.runHint')}
        onClick={ev => { ev.currentTarget.blur(); runtime.audio(); runtime.playFull(Math.max(0, run.marks[0].t - useSceneSettings.getState().leadSec)) }}>{t('scene.event.run', { at: run.marks[0].t.toFixed(1), count: run.marks.filter(m => m.target).length })}</button>}
    </div>
    {!loop || lib.loop_cue_sounds ? <Sounds e={e} edit={edit} allowed={soundAllowed(lib, e.ref.cue)} /> : null}
    <Clips table={table} e={e} edit={edit} />
    {loop && e.ref.variant === null && layer && <LevelMaps table={table} layer={layer} cue={e.ref.cue} edit={edit} />}
    <div className="scene-sec">
      <h3>{t('events.variation')}</h3>
      {e.ref.variant !== null && e.own.variation && <OverrideBar e={e} field="variation" edit={edit} />}
      <Variation e={e} loop={loop} edit={edit} />
      {!loop && (e.ref.variant === null || e.own.variation) && <Paired e={e} edit={edit} />}
    </div>
  </div>
}

/** The cue and its variants as chips (the selected one marked), add / remove a variant. */
function Variants({ table, e, select, edit }: { table: CueTable; e: EffectiveEvent; select: (name: string) => void; edit: Edit }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cue = e.ref.cue, variants = Object.keys(table.cues[cue]?.variants ?? {})
  const add = () => {
    const v = name.trim()
    if (!VARIANT_NAME.test(v)) { setError(t('events.variant.badName', { pattern: VARIANT_NAME.source })); return }
    try { edit(tb => addVariant(tb, cue, v)); setName(''); setError(null); select(`${cue}:${v}`) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  return <>
    <div className="scene-event-variants" title={t('events.variantsHint', { cue })}>
      {[cue, ...variants.map(v => `${cue}:${v}`)].map(k => <button key={k} type="button" className={`scene-toggle ${k === eventKey(e.ref) ? 'on' : ''}`} onClick={() => select(k)}>{k}</button>)}
      {e.ref.variant !== null && <button type="button" className="scene-icon-btn" title={t('events.variant.remove', { name: eventKey(e.ref) })}
        onClick={() => { edit(tb => removeVariant(tb, cue, e.ref.variant!)); select(cue) }}>✕</button>}
    </div>
    <div className="scene-row">
      <input className="scene-grow" value={name} placeholder={t('events.variant.namePlaceholder')} aria-label={t('events.variant.namePlaceholder')}
        onChange={ev => { setName(ev.target.value); setError(null) }} onKeyDown={ev => { if (ev.key === 'Enter') add() }} />
      <button type="button" className="scene-icon-btn" onClick={add}>＋ {t('events.variant.add')}</button>
    </div>
    {error && <div className="scene-dirty">{error}</div>}
  </>
}

/**
 * A variant's kind — own materials (overrides its sfx / haptics) or multipliers only (inherits the materials) — and
 * the multipliers on what it inherits: sfxVolume, hapticsGain and rampTo (over a run of firings the multipliers go
 * linearly to rampTo; here by which firing of the run it is).
 */
function VariantScale({ e, edit }: { e: EffectiveEvent; edit: Edit }) {
  const { t } = useI18n()
  const table = useSceneStore(s => s.table)
  const kind = variantKind(e), v = table?.cues[e.ref.cue]?.variants?.[e.ref.variant!] ?? {}
  const data = useSceneStore(s => s.data)
  const ramp = typeof v.rampTo === 'number', steps = Array.isArray(v.rampSteps) ? v.rampSteps : null, gradual = ramp || !!steps
  const curve: RampCurve = v.rampCurve ?? 'linear'
  const rampField = <NumberField value={ramp ? v.rampTo as number : ''} min={0} max={2} step={0.05} label={t('scene.variant.rampTo')} onCommit={x => edit(tb => setVariantScale(tb, e.ref, { rampTo: x }))} />
  /** "One by one": as many fields as the longest run of this variant in the recording, filled from the current curve. */
  const toSteps = () => {
    const count = (data ? longestRun(data.full.events, eventKey(e.ref)) : 0) || 4
    const start = !e.own.sfx ? e.scale.sfx : e.scale.haptics, to = e.scale.rampTo ?? 1
    return Array.from({ length: Math.min(64, count) }, (_, index) => Math.round(rampValue(start, to, curve, { index, count }) * 100) / 100)
  }
  // One line per inherited material: "Sound × 0.3 → 1.0" (the ramp target only while "gradually" is on).
  const row = (key: 'sfxVolume' | 'hapticsGain') => <div key={key} className="scene-row scene-variant-scale" title={`${t(`scene.variant.${key}.hint` as MessageId)}\n${key}${ramp ? ' → rampTo' : ''}`}>
    <span className="scene-grow">{t(`scene.variant.${key}` as MessageId)}</span>
    <NumberField value={typeof v[key] === 'number' ? v[key] as number : 1} min={0} max={2} step={0.05} disabled={!!steps} label={t(`scene.variant.${key}` as MessageId)}
      onCommit={x => edit(tb => setVariantScale(tb, e.ref, { [key]: x === 1 ? undefined : x }))} />
    {ramp && <><span aria-hidden="true">→</span>{rampField}</>}
  </div>
  const inherits = !e.own.sfx || !e.own.haptics
  return <>
    <div className="scene-event-variants" role="group" aria-label={t('scene.variant.kind')}>
      {(['scale', 'materials'] as const).map(k => <button key={k} type="button" className={`scene-toggle ${kind === k ? 'on' : ''}`} title={t(`scene.variant.kind.${k}.hint` as MessageId)}
        onClick={() => { if (kind !== k) edit(tb => setVariantKind(tb, e.ref, k)) }}>{t(`scene.variant.kind.${k}` as MessageId)}</button>)}
    </div>
    {inherits && <>
      <h3>{t('scene.variant.scaleHeading', { cue: e.ref.cue })}</h3>
      {!e.own.sfx && row('sfxVolume')}
      {!e.own.haptics && row('hapticsGain')}
      <label className="scene-row" title={`${t('scene.variant.rampTo.hint')}\nrampTo`}>
        <input type="checkbox" checked={gradual} onChange={ev => edit(tb => setVariantScale(tb, e.ref, ev.target.checked ? { rampTo: 1 } : { rampTo: undefined, rampCurve: undefined, rampSteps: undefined }))} />
        {t('scene.variant.ramp')}
      </label>
      {gradual && <div className="scene-ramp">
        {!steps && <label className="scene-row" title={`${t('scene.variant.curve.hint')}\nrampCurve`}>
          <span className="scene-dim">{t('scene.variant.curve')}</span>
          <select value={curve} onChange={ev => { const c = ev.target.value as RampCurve; ev.target.blur(); edit(tb => setVariantScale(tb, e.ref, { rampCurve: c })) }}>
            {RAMP_CURVES.map(c => <option key={c} value={c}>{t(`scene.variant.curve.${c}` as MessageId)}</option>)}
          </select>
          <CurvePreview curve={curve} />
        </label>}
        <label className="scene-row" title={`${t('scene.variant.steps.hint')}\nrampSteps`}>
          <input type="checkbox" checked={!!steps} onChange={ev => edit(tb => setVariantScale(tb, e.ref, ev.target.checked
            ? { rampSteps: toSteps(), rampTo: undefined, rampCurve: undefined } : { rampSteps: undefined, rampTo: steps?.[steps.length - 1] ?? 1 }))} />
          {t('scene.variant.steps')}
        </label>
        {steps && <div className="scene-ramp-steps">{steps.map((x, i) => <label key={i}><span className="scene-dim">{i + 1}</span>
          <NumberField value={x} min={0} max={2} step={0.05} label={t('scene.variant.step', { n: i + 1 })}
            onCommit={value => edit(tb => setVariantScale(tb, e.ref, { rampSteps: steps.map((y, k) => k === i ? value : y) }))} /></label>)}</div>}
      </div>}
    </>}
  </>
}

/**
 * Emitted cue (emit, DEC-088): the game fires this cue by itself while its loop cue (`during`) runs, every interval
 * ± jitter. The Scene tab plays firings made from the recorded layer by the same rule (not the recorded ones);
 * "draw again" makes another set (the same set otherwise, also after a seek).
 */
function Emit({ table, lib, cue, edit }: { table: CueTable; lib: SceneLib; cue: string; edit: Edit }) {
  const { t } = useI18n()
  const data = useSceneStore(s => s.data)
  const emit = table.cues[cue]?.emit
  if (!emit) return null
  const count = data ? data.full.events.filter(x => x.name === cue).length : 0
  return <div className="scene-sec">
    <h3 title={`${t('scene.emit.hint')}\nemit`}>{t('scene.emit.heading')}</h3>
    <div className="scene-event-variation">
      <label title={`${t('scene.emit.during.hint')}\nduring`}><span>{t('scene.emit.during')}</span>
        <select value={emit.during} onChange={ev => { const d = ev.target.value; ev.target.blur(); edit(tb => setEmit(tb, cue, { during: d })) }}>
          {!lib.loop_cues.includes(emit.during) && <option value={emit.during}>{emit.during}</option>}
          {lib.loop_cues.map(c => <option key={c} value={c}>{c}</option>)}
        </select></label>
      <label title={`${t('scene.emit.intervalSec.hint')}\nintervalSec`}><span>{t('scene.emit.intervalSec')}</span>
        <NumberField value={emit.intervalSec} min={EMIT_INTERVAL_RANGE[0]} max={EMIT_INTERVAL_RANGE[1]} step={0.05} label={t('scene.emit.intervalSec')}
          onCommit={x => edit(tb => setEmit(tb, cue, { intervalSec: x }))} /></label>
      <label title={`${t('scene.emit.jitterPct.hint')}\njitterPct`}><span>{t('scene.emit.jitterPct')}</span>
        <NumberField value={emit.jitterPct ?? 0} min={EMIT_JITTER_RANGE[0]} max={EMIT_JITTER_RANGE[1]} step={5} label={t('scene.emit.jitterPct')}
          onCommit={x => edit(tb => setEmit(tb, cue, { jitterPct: x }))} /></label>
    </div>
    <div className="scene-row">
      <span className="scene-dim scene-grow">{t('scene.emit.count', { count })}</span>
      <button type="button" className="scene-icon-btn" title={t('scene.emit.reseed.hint')} onClick={ev => { ev.currentTarget.blur(); useSceneStore.getState().reseedEmit() }}>{t('scene.emit.reseed')}</button>
    </div>
  </div>
}

const DEFAULT_FALLOFF: DistanceFalloff = { nearCm: 560, farCm: 2000, farGain: 0.15 }
/**
 * Distance falloff (distanceFalloff): the scene multiplier by the distance to the player, on sound and haptics.
 * A cue: on / off. A variant: the cue's, its own, or none (fixed). Near / far (cm), the gain far away, the shape,
 * and a small curve (left = near, right = far). Studio applies it with the recorded `dist` of each firing.
 */
function Falloff({ table, e, edit }: { table: CueTable; e: EffectiveEvent; edit: Edit }) {
  const { t } = useI18n()
  const entry = e.ref.variant === null ? table.cues[e.ref.cue] : table.cues[e.ref.cue]?.variants?.[e.ref.variant]
  const own = entry?.distanceFalloff
  const mode: 'inherit' | 'own' | 'none' = e.ref.variant !== null && own === undefined ? 'inherit' : own ? 'own' : 'none'
  const f = e.falloff
  const set = (value: DistanceFalloff | null | undefined) => edit(tb => setDistanceFalloff(tb, e.ref, value))
  const field = (key: 'nearCm' | 'farCm' | 'farGain', step: number, max: number) => <label key={key} title={`${t(`scene.falloff.${key}.hint` as MessageId)}\n${key}`}><span>{t(`scene.falloff.${key}` as MessageId)}</span>
    <NumberField value={own ? own[key] : ''} min={0} max={max} step={step} label={t(`scene.falloff.${key}` as MessageId)} onCommit={x => own && set({ ...own, [key]: x })} /></label>
  return <div className="scene-sec">
    <h3 title={`${t('scene.falloff.hint')}\ndistanceFalloff`}>{t('scene.falloff.heading')}</h3>
    <div className="scene-row">
      {e.ref.variant === null
        ? <label className="scene-check"><input type="checkbox" checked={!!own} onChange={ev => set(ev.target.checked ? DEFAULT_FALLOFF : null)} />{t('scene.falloff.on')}</label>
        : <select value={mode} aria-label={t('scene.falloff.heading')} onChange={ev => { const m = ev.target.value; ev.target.blur(); set(m === 'inherit' ? undefined : m === 'none' ? null : f ?? DEFAULT_FALLOFF) }}>
          <option value="inherit">{t('scene.falloff.inherit', { cue: e.ref.cue })}</option>
          <option value="own">{t('scene.falloff.own')}</option>
          <option value="none">{t('scene.falloff.none')}</option>
        </select>}
      {f && <FalloffPreview f={f} />}
      {f && !own && <span className="scene-dim">{`${f.nearCm}–${f.farCm} cm → ×${f.farGain}`}</span>}
    </div>
    {own && <div className="scene-event-variation">
      {field('nearCm', 10, 100000)}{field('farCm', 10, 100000)}{field('farGain', 0.05, 2)}
      <label title={`${t('scene.variant.curve.hint')}\ncurve`}><span>{t('scene.variant.curve')}</span>
        <select value={own.curve ?? 'linear'} onChange={ev => { const c = ev.target.value as RampCurve; ev.target.blur(); set(c === 'linear' ? (({ curve: _c, ...rest }) => rest)(own) : { ...own, curve: c }) }}>
          {RAMP_CURVES.map(c => <option key={c} value={c}>{t(`scene.variant.curve.${c}` as MessageId)}</option>)}
        </select></label>
    </div>}
  </div>
}
/** The falloff as a small line: left = nearCm (×1), right = farCm (×farGain); the gain scale is 0..max(1, farGain). */
function FalloffPreview({ f }: { f: DistanceFalloff }) {
  const top = Math.max(1, f.farGain)
  const y = (g: number) => (26 - g / top * 24).toFixed(1)
  const points = Array.from({ length: 25 }, (_, i) => `${(i / 24 * 116 + 2).toFixed(1)},${y(1 + (f.farGain - 1) * curveAt(f.curve ?? 'linear', i / 24))}`).join(' ')
  return <svg className="scene-curve" width={120} height={28} viewBox="0 0 120 28" aria-hidden="true">
    <rect x={2} y={2} width={116} height={24} fill="none" stroke="currentColor" strokeOpacity={0.2} />
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
  </svg>
}

/** The ramp shape (curveAt) as a small line, 0 → 1 left to right, bottom to top. */
function CurvePreview({ curve }: { curve: RampCurve }) {
  const points = Array.from({ length: 25 }, (_, i) => `${(i / 24 * 116 + 2).toFixed(1)},${(26 - curveAt(curve, i / 24) * 24).toFixed(1)}`).join(' ')
  return <svg className="scene-curve" width={120} height={28} viewBox="0 0 120 28" aria-hidden="true">
    <rect x={2} y={2} width={116} height={24} fill="none" stroke="currentColor" strokeOpacity={0.2} />
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
  </svg>
}

/** For a variant: "inherited from the cue" with an override button, or "own" with a button back to inheriting. */
function OverrideBar({ e, field, edit }: { e: EffectiveEvent; field: OverridableField; edit: Edit }) {
  const { t } = useI18n()
  if (e.ref.variant === null) return null
  const own = e.own[field]
  return <div className="scene-row">
    <span className="scene-dim scene-grow">{t(own ? 'events.variant.own' : 'events.variant.inherited', { cue: e.ref.cue })}</span>
    <button type="button" className="scene-icon-btn" onClick={() => edit(tb => setOverride(tb, e.ref, field, !own))}>{t(own ? 'events.variant.inherit' : 'events.variant.override')}</button>
  </div>
}

/** Sounds: ★ = played (first = representative), the rest alternates; removal; ▶ plays one on the PC (alternates too). */
function Sounds({ e, edit, allowed }: { e: EffectiveEvent; edit: Edit; allowed: boolean }) {
  const { t } = useI18n()
  const { runtime } = useScene()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const sounds = sfxSounds(e.sfx), alternates = sfxAlternates(e.sfx), own = e.own.sfx
  if (!allowed) return null
  return <div className="scene-sec">
    <h3>{t('events.repeat.sounds')}</h3>
    <OverrideBar e={e} field="sfx" edit={edit} />
    {own && e.sfx && <label className="scene-row" title={t('scene.event.volumeHint')}><span className="scene-dim scene-grow">{t('scene.sound.volume')}</span>
      <NumberField value={e.sfx.volume} min={0} max={2} step={0.05} label={t('scene.sound.volume')} onCommit={x => edit(tb => setOwnSfxVolume(tb, e.ref, x))} /></label>}
    {!sounds.length ? <div className="scene-dim">{t('events.soundNone')}</div>
      : e.variation?.paired === true ? <div className="scene-dim">{t('events.pair.inHaptics')}</div>
      : <MaterialList items={sounds} alternates={alternates} label={t('events.repeat.sounds')}
        onStar={own ? (s, on) => edit(tb => setStarred(tb, e.ref, 'sound', 0, s, on)) : null} onRemove={own ? s => edit(tb => removeMaterial(tb, e.ref, 'sound', 0, s)) : null}
        onPlay={s => { runtime.audio(); runtime.testSound({ sound: s, volume: e.sfx?.volume ?? 1 }) }} />}
    {own && <select value="" aria-label={t('events.addSoundMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) edit(tb => addMaterial(tb, e.ref, 'sound', 0, x)) }}>
      <option value="">{t('events.addSoundMulti')}</option>
      {soundFiles.filter(s => !sounds.includes(s) && !alternates.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
    </select>}
  </div>
}

/** Clips per route (body position): ★ = played, the rest alternates; removal; ▶ sends one to the route's devices (alternates too). */
function Clips({ table, e, edit }: { table: CueTable; e: EffectiveEvent; edit: Edit }) {
  const { t } = useI18n()
  const { runtime } = useScene()
  const atLabel = useAtLabel()
  const lib = useSceneStore(s => s.lib)!
  const own = e.own.haptics
  return <div className="scene-sec">
    <h3>{t('events.repeat.clips')}</h3>
    <OverrideBar e={e} field="haptics" edit={edit} />
    {!e.haptics.length && <div className="scene-dim">{t('events.hapticNone')}</div>}
    {e.haptics.map((r, i) => {
      const clips = routeClips(r), alternates = routeAlternates(r)
      return <div key={i}>
        <label className="scene-row" title={t('scene.event.gainHint')}><span className="scene-dim scene-grow">{atLabel(r.at)} · {t('scene.route.gain')}</span>
          {own ? <NumberField value={r.gain} min={0} max={2} step={0.05} label={t('scene.route.gain')} onCommit={x => edit(tb => updateOwnRoute(tb, e.ref, i, { gain: x }))} />
            : <span className="scene-dim">{r.gain}</span>}</label>
        {e.variation?.paired === true && i === 0
          ? <PairedList e={e} edit={edit} onPlay={(_, sound, clip) => {
            runtime.audio()
            if (sound) runtime.testSound({ sound, volume: e.sfx?.volume ?? 1 })
            if (clip) runtime.testRoute({ clip, at: r.at, gain: r.gain })
          }} />
          : <MaterialList items={clips} alternates={alternates} label={atLabel(r.at)} minItems={1}
            onStar={own ? (c, on) => edit(tb => setStarred(tb, e.ref, 'haptic', i, c, on)) : null} onRemove={own ? c => edit(tb => removeMaterial(tb, e.ref, 'haptic', i, c)) : null}
            onPlay={c => runtime.testRoute({ clip: c, at: r.at, gain: r.gain })} />}
        {own && <select value="" aria-label={t('events.addClipMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) edit(tb => addMaterial(tb, e.ref, 'haptic', i, x)) }}>
          <option value="">{t('events.addClipMulti')}</option>
          {clipsForCue(table, lib, e.ref.cue).filter(c => !clips.includes(c) && !alternates.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
        </select>}
      </div>
    })}
  </div>
}

/** `variation`: how one of several materials is picked, and the gain / pitch / rate jitter per firing (a loop cue: gain only). */
function Variation({ e, loop, edit }: { e: EffectiveEvent; loop: boolean; edit: Edit }) {
  const { t } = useI18n()
  const v: CueVariation = e.variation ?? {}, own = e.ref.variant === null || e.own.variation
  const set = (patch: Partial<CueVariation>) => edit(tb => setVariation(tb, e.ref, patch))
  // A variant inheriting the cue's variation: what it is, and one button to change it for this situation only.
  if (!own) {
    const pick = t(v.pick ? `events.variation.pick.${v.pick}` as MessageId : 'events.variation.pick.default')
    const jitters = VARIATION_FIELDS.filter(f => (!loop || f.loopOk) && typeof v[f.key] === 'number' && (v[f.key] as number) > 0).map(f => `${t(`events.variation.${f.key}` as MessageId)} ${v[f.key]}`)
    return <div className="scene-row">
      <span className="scene-dim scene-grow">{t('scene.variation.sameAs', { cue: e.ref.cue, summary: [pick, ...jitters, ...(v.paired ? [t('scene.event.paired')] : [])].join('・') })}</span>
      <button type="button" className="scene-icon-btn" onClick={() => edit(tb => setOverride(tb, e.ref, 'variation', true))}>{t('scene.variation.override')}</button>
    </div>
  }
  return <div className="scene-event-variation">
    {!loop && <label className="scene-variation-pick" title={t('events.variation.pick.hint')}><span>{t('events.variation.pick')}</span>
      <select value={v.pick ?? ''} disabled={!own} onChange={ev => { const p = ev.target.value; ev.target.blur(); set({ pick: p ? p as CueVariation['pick'] : undefined }) }}>
        <option value="">{t('events.variation.pick.default')}</option>
        {PICK_MODES.map(p => <option key={p} value={p}>{t(`events.variation.pick.${p}` as MessageId)}</option>)}
      </select></label>}
    {VARIATION_FIELDS.filter(f => !loop || f.loopOk).map(f => <label key={f.key} title={t(`events.variation.${f.key}.hint` as MessageId)}><span>{t(`events.variation.${f.key}` as MessageId)}</span>
      <NumberField value={typeof v[f.key] === 'number' ? v[f.key] as number : 0} min={0} max={f.max} step={f.step} disabled={!own} label={t(`events.variation.${f.key}` as MessageId)}
        onCommit={x => set({ [f.key]: x > 0 ? Math.min(f.max, x) : undefined })} /></label>)}
  </div>
}

/** "Pair sounds and haptics" (variation.paired): sound i plays with clip i of every route; the pairs, or why they do not line up. */
function Paired({ e, edit }: { e: EffectiveEvent; edit: Edit }) {
  const { t } = useI18n()
  const atLabel = useAtLabel()
  const own = e.ref.variant === null || e.own.variation
  const on = e.variation?.paired === true
  const problem = on ? pairedProblem(e.sfx, e.haptics) : null
  const sounds = sfxSounds(e.sfx)
  return <div className="scene-event-paired">
    <label title={t('scene.event.pairedHint')}><input type="checkbox" checked={on} disabled={!own} onChange={ev => edit(tb => setVariation(tb, e.ref, { paired: ev.target.checked ? true : undefined }))} />{t('scene.event.paired')}</label>
    {on && (problem ? <div className="scene-dirty">{t('scene.event.pairedProblem', { problem })}</div>
      : <ul className="scene-event-pairs">{sounds.map((s, i) => <li key={s}><b>{s}</b> ↔ {pairedClips(e, i).map(p => `${p.clip} (${atLabel(p.at)})`).join(', ')}</li>)}</ul>)}
  </div>
}
