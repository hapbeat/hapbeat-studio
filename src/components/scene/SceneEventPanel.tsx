import { useState } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { isLoopCue, PICK_MODES, routeClips, sfxSounds, soundAllowed, VARIANT_NAME, clipsForCue, type CueTable, type CueVariation, type VariationNumberKey } from '@/utils/sceneCueTable'
import {
  addVariant, effectiveEvent, eventKey, removeVariant, resolveEventName, setOverride, setRouteClips, setSfxSounds, setVariation,
  type EffectiveEvent, type OverridableField,
} from '@/utils/cueEvents'
import { representativeSegment } from '@/utils/sceneSegments'
import { MaterialList } from '@/components/waveform/MaterialList'
import { NumberField, useAtLabel } from './SceneCuePanels'
import { useScene } from './sceneContext'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

const VARIATION_FIELDS: { key: VariationNumberKey; max: number; step: number; loopOk: boolean }[] = [
  { key: 'gainJitterDb', max: 12, step: 0.5, loopOk: true },
  { key: 'pitchJitterSt', max: 12, step: 0.5, loopOk: false },
  { key: 'rateJitterPct', max: 50, step: 1, loopOk: false },
]

/**
 * "Event" details of the selected cue / variant (DEC-085 addendum: the editor only picks materials; how they
 * are used by situation is decided here): its variants and their sfx / haptics overrides, the variation
 * (pick, gain / pitch / rate jitter), the order of the material candidates (★ = representative) and removal,
 * and playing the event's run of the recording through (its real firings, with the variation). Edits go to
 * the same table and are saved with it.
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
  if (!resolved || !e) return <div className="scene-panel-empty">{t('scene.selectCue')}</div>
  const key = eventKey(e.ref), loop = isLoopCue(lib, e.ref.cue)
  const edit: Edit = change => useSceneStore.getState().edit(change)
  const select = (name: string) => useSceneStore.getState().selectCue(name, sel?.t ?? null)
  const sound = e.sfx ? sfxSounds(e.sfx)[0] : undefined
  const run = data ? representativeSegment(data.full.events, key, (sound && useSceneStore.getState().sfx[sound]?.duration) || 1) : null
  return <div className="scene-cue-panel scene-event">
    <div className="scene-sec">
      <Variants table={table} e={e} select={select} edit={edit} />
      {run?.run && <button type="button" className="scene-icon-btn scene-event-run" title={t('scene.event.runHint')}
        onClick={ev => { ev.currentTarget.blur(); runtime.audio(); runtime.playFull(run.start) }}>{t('scene.event.run', { at: run.marks[0].toFixed(1), count: run.marks.length })}</button>}
    </div>
    {!loop || lib.loop_cue_sounds ? <Sounds e={e} edit={edit} allowed={soundAllowed(lib, e.ref.cue)} /> : null}
    <Clips table={table} e={e} edit={edit} />
    <div className="scene-sec">
      <h3>{t('events.variation')}</h3>
      <OverrideBar e={e} field="variation" edit={edit} />
      <Variation e={e} loop={loop} edit={edit} />
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

/** Sound candidates: order (★ first = representative) and removal; ▶ plays one on the PC. */
function Sounds({ e, edit, allowed }: { e: EffectiveEvent; edit: Edit; allowed: boolean }) {
  const { t } = useI18n()
  const { runtime } = useScene()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const sounds = sfxSounds(e.sfx), own = e.own.sfx
  const set = (list: string[]) => edit(tb => setSfxSounds(tb, e.ref, list))
  if (!allowed) return null
  return <div className="scene-sec">
    <h3>{t('events.repeat.sounds')}</h3>
    <OverrideBar e={e} field="sfx" edit={edit} />
    {!sounds.length ? <div className="scene-dim">{t('events.soundNone')}</div>
      : <MaterialList items={sounds} label={t('events.repeat.sounds')} onReorder={own ? set : null} onRemove={own ? set : null}
        onPlay={s => { runtime.audio(); runtime.testSound({ sound: s, volume: e.sfx?.volume ?? 1 }) }} />}
    {own && <select value="" aria-label={t('events.addSoundMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) set([...sounds, x]) }}>
      <option value="">{t('events.addSoundMulti')}</option>
      {soundFiles.filter(s => !sounds.includes(s)).map(s => <option key={s} value={s}>{s}</option>)}
    </select>}
  </div>
}

/** Clip candidates per route (body position): order and removal; ▶ sends one to the route's devices. */
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
      const clips = routeClips(r), set = (list: string[]) => edit(tb => setRouteClips(tb, e.ref, i, list))
      return <div key={i}>
        <div className="scene-dim">{atLabel(r.at)} · gain {r.gain}</div>
        <MaterialList items={clips} label={atLabel(r.at)} onReorder={own ? set : null} onRemove={own ? set : null} minItems={1}
          onPlay={c => runtime.testRoute({ clip: c, at: r.at, gain: r.gain })} />
        {own && <select value="" aria-label={t('events.addClipMulti')} onChange={ev => { const x = ev.target.value; ev.target.blur(); if (x) set([...clips, x]) }}>
          <option value="">{t('events.addClipMulti')}</option>
          {clipsForCue(table, lib, e.ref.cue).filter(c => !clips.includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
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
  return <div className="scene-event-variation">
    {!loop && <label title={t('events.variation.pick.hint')}>{t('events.variation.pick')}
      <select value={v.pick ?? ''} disabled={!own} onChange={ev => { const p = ev.target.value; ev.target.blur(); set({ pick: p ? p as CueVariation['pick'] : undefined }) }}>
        <option value="">{t('events.variation.pick.default')}</option>
        {PICK_MODES.map(p => <option key={p} value={p}>{t(`events.variation.pick.${p}` as MessageId)}</option>)}
      </select></label>}
    {VARIATION_FIELDS.filter(f => !loop || f.loopOk).map(f => <label key={f.key} title={t(`events.variation.${f.key}.hint` as MessageId)}>{t(`events.variation.${f.key}` as MessageId)}
      <NumberField value={typeof v[f.key] === 'number' ? v[f.key] as number : 0} min={0} max={f.max} step={f.step} disabled={!own} label={t(`events.variation.${f.key}` as MessageId)}
        onCommit={x => set({ [f.key]: x > 0 ? Math.min(f.max, x) : undefined })} /></label>)}
  </div>
}
