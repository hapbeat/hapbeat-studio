import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { useSceneSettings } from '@/stores/sceneSettings'
import { familyColor, momentCues, type SceneLib } from '@/utils/sceneData'
import { addRoute, assignSound, clipsForCue, isLoopCue, positionsForCue, removeRoute, routeClips, setClipIntensity, setSoundVolume, sfxSounds, updateRoute } from '@/utils/sceneCueTable'
import { effectiveEvent, resolveEventName } from '@/utils/cueEvents'
import { useEventStore } from '@/stores/eventStore'
import { useScene } from './sceneContext'

/** Body position labels (lib.at vocabulary, contracts device-addressing); unknown ones show as is. */
const AT_LABELS: Record<string, MessageId> = {
  hand: 'scene.at.hand', both: 'scene.at.both', pos_neck: 'scene.at.pos_neck', pos_chest: 'scene.at.pos_chest', pos_abd: 'scene.at.pos_abd',
  pos_l_arm: 'scene.at.pos_l_arm', pos_r_arm: 'scene.at.pos_r_arm', pos_l_wrist: 'scene.at.pos_l_wrist', pos_r_wrist: 'scene.at.pos_r_wrist',
  pos_hip: 'scene.at.pos_hip', pos_l_thigh: 'scene.at.pos_l_thigh', pos_r_thigh: 'scene.at.pos_r_thigh', pos_l_ankle: 'scene.at.pos_l_ankle', pos_r_ankle: 'scene.at.pos_r_ankle',
}
export function useAtLabel() {
  const { t } = useI18n()
  return (at: string) => AT_LABELS[at] ? t(AT_LABELS[at]) : at
}

/** Number input committed like the viewer's: on the native change event (spinner, Enter, blur), not on every keystroke. */
export function NumberField({ value, min, max, step, disabled, onCommit, label }: { value: number | ''; min: number; max: number; step: number; disabled?: boolean; onCommit: (value: number) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit); commit.current = onCommit
  useEffect(() => { if (input.current && document.activeElement !== input.current) input.current.value = String(value) }, [value])
  useEffect(() => {
    const el = input.current
    if (!el) return
    const change = () => { const x = parseFloat(el.value); commit.current(Number.isFinite(x) ? x : min) }
    el.addEventListener('change', change)
    return () => el.removeEventListener('change', change)
  }, [min])
  return <input ref={input} type="number" className="scene-number" aria-label={label} defaultValue={value} min={min} max={max} step={step} disabled={disabled} />
}

/** A drop target for one WAV file. */
function DropZone({ onFile, className = '', children }: { onFile: (file: File) => void; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false)
  return <div className={`scene-drop ${over ? 'over' : ''} ${className}`}
    onDragOver={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
    onDrop={e => { const file = e.dataTransfer.files[0]; setOver(false); if (!file) return; e.preventDefault(); e.stopPropagation(); onFile(file) }}>{children}</div>
}

/** Which cue the panel edits: a list of every cue, plus one-click chips for the other cues of the same moment. */
function CuePicker() {
  const { t } = useI18n()
  const { runtime } = useScene()
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const sel = useSceneStore(s => s.sel)
  useSceneStore(s => s.cur)
  if (!table || !lib) return null
  const name = (sel && resolveEventName(table, sel.name)?.ref.cue) ?? ''
  const others = name ? momentCues(runtime.events(), sel!.t, lib.ticks).filter(n => n !== name) : []
  return <div className="scene-pick">
    <span className="scene-dim">{t('scene.editing')}</span>
    <select className="scene-grow" value={name} aria-label={t('scene.editing')} onChange={e => {
      const n = e.target.value, time = runtime.video.currentTime
      e.target.blur()
      if (!n) return
      const near = runtime.events().filter(x => x.name === n).sort((a, b) => Math.abs(a.t - time) - Math.abs(b.t - time))[0]
      useSceneStore.getState().selectCue(n, near ? near.t : null)
    }}>
      <option value="">{t('scene.pickHint')}</option>
      {Object.keys(table.cues).map(n => <option key={n} value={n}>{n}</option>)}
    </select>
    <div className="scene-chips">
      {others.length > 0 && <>{t('scene.sameMoment')}{others.map(n => <button key={n} type="button" style={{ color: familyColor(lib, n) }}
        onClick={e => { e.currentTarget.blur(); useSceneStore.getState().selectCue(n, sel!.t) }}>{n}</button>)}</>}
    </div>
  </div>
}

/**
 * The edited cue's name and description, the selected moment's `cue:variant`
 * name when it is a variant (with a note when the variant writes the field this
 * panel edits: the panel edits the cue, variants are edited in the editor), and
 * "Open in editor" (Events panel).
 */
function CueHead({ lib, name, description, field }: { lib: SceneLib; name: string; description?: string; field: 'sfx' | 'haptics' }) {
  const { t } = useI18n()
  const { event, variant, unknownVariant, overrides } = useSelectedCue()
  return <>
    <div className="scene-cuehead"><b style={{ color: familyColor(lib, name) }}>{variant ? event : name}</b><span className="scene-desc" title={description ?? ''}>{description ?? ''}</span>
      <button type="button" className="scene-icon-btn" title={t('scene.openInEditorHint')} onClick={e => { e.currentTarget.blur(); if (event) useEventStore.getState().openInEditor(event) }}>{t('scene.openInEditor')}</button></div>
    {unknownVariant && <div className="scene-dim">{t('scene.variant.unknown', { name: `${name}:${unknownVariant}`, cue: name })}</div>}
    {variant && overrides[field] && <div className="scene-dim">{t('scene.variant.overrides', { name: event ?? '' })}</div>}
  </>
}

/** The selected moment's cue (a `cue:variant` name resolves to its cue, which these panels edit). */
function useSelectedCue() {
  const table = useSceneStore(s => s.table)
  const lib = useSceneStore(s => s.lib)
  const sel = useSceneStore(s => s.sel)
  const resolved = table && sel ? resolveEventName(table, sel.name) : null
  const name = resolved ? resolved.ref.cue : null
  const variant = resolved?.ref.variant ?? null
  const own = table && resolved && variant ? effectiveEvent(table, resolved.ref)?.own : null
  return { table, lib, name, variant, event: resolved ? (variant ? `${name}:${variant}` : name) : null, unknownVariant: resolved?.unknownVariant ?? null,
    overrides: { sfx: !!own?.sfx, haptics: !!own?.haptics } }
}

/** Haptic routes of the selected cue: clip × body position × gain, plus the intensity of the clips it uses. */
export function SceneHapticsPanel() {
  const { t } = useI18n()
  const { runtime, helperConnected, pickWav } = useScene()
  const atLabel = useAtLabel()
  const { table, lib, name } = useSelectedCue()
  if (!table || !lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const store = useSceneStore.getState()
  const loop = name ? isLoopCue(lib, name) : false
  const replaceWithWav = async (index: number | null, file: File | null) => {
    if (!file || !name) return
    const clip = await store.addClip(file, loop)
    if (!clip) return
    store.edit(tb => index === null ? addRoute(tb, lib, name, clip) : updateRoute(tb, name, index, { clip }))
  }
  const test = (index: number) => {
    if (!name) return
    if (!useSceneSettings.getState().sendHaptics) { store.note({ id: 'scene.test.hapticsOff', error: true }); return }
    if (!helperConnected) { store.note({ id: 'scene.test.noHelper', error: true }); return }
    const route = table.cues[name].haptics[index]
    const count = runtime.testRoute(route)
    store.note({ id: 'scene.test.sent', params: { clip: routeClips(route)[0] ?? '', at: atLabel(route.at), count } })
  }
  const cue = name ? table.cues[name] : null
  const used = cue ? [...new Set(cue.haptics.flatMap(routeClips))].filter(c => table.clips[c]) : []
  return <div className="scene-cue-panel">
    <CuePicker />
    {!name || !cue ? <div className="scene-sec scene-dim">{t('scene.selectCue')}</div> : <div className="scene-cue">
      <CueHead lib={lib} name={name} description={cue.description} field="haptics" />
      {cue.haptics.length > 0 && <div className="scene-heads"><span>{t('scene.route.clip')}</span><span>{t('scene.route.at')}</span><span>{t('scene.route.gain')}</span></div>}
      {cue.haptics.map((r, i) => <DropZone key={i} className="scene-route" onFile={file => void replaceWithWav(i, file)}>
        {/* A multi-clip route (v2 `clips`) is edited in the editor's Events panel; picking one clip here replaces the list. */}
        <select value={routeClips(r).length > 1 ? '' : routeClips(r)[0]} aria-label={t('scene.route.clip')} title={routeClips(r).join(', ')} onChange={e => { e.target.blur(); store.edit(tb => updateRoute(tb, name, i, { clip: e.target.value })) }}>
          {routeClips(r).length > 1 && <option value="" disabled>{t('scene.route.multi', { count: routeClips(r).length })}</option>}
          {clipsForCue(table, lib, name).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={r.at} aria-label={t('scene.route.at')} onChange={e => { e.target.blur(); store.edit(tb => updateRoute(tb, name, i, { at: e.target.value })) }}>
          {[...new Set([...positionsForCue(lib, name), r.at])].map(a => <option key={a} value={a}>{atLabel(a)}</option>)}
        </select>
        <NumberField value={r.gain} min={0} max={2} step={0.05} label={t('scene.route.gain')} onCommit={x => store.edit(tb => updateRoute(tb, name, i, { gain: x }))} />
        <button type="button" className="scene-icon-btn" title={t('scene.route.test')} aria-label={t('scene.route.test')} onClick={e => { e.currentTarget.blur(); test(i) }}>▶</button>
        <button type="button" className="scene-icon-btn" title={t('scene.route.wav')} onClick={async e => { e.currentTarget.blur(); await replaceWithWav(i, await pickWav()) }}>WAV…</button>
        <button type="button" className="scene-icon-btn" title={t('scene.route.remove')} aria-label={t('scene.route.remove')} onClick={e => { e.currentTarget.blur(); store.edit(tb => removeRoute(tb, name, i)) }}>✕</button>
      </DropZone>)}
      <DropZone className="scene-add-zone" onFile={file => void replaceWithWav(null, file)}>
        <button type="button" className="toolbar-btn" onClick={e => {
          e.currentTarget.blur()
          if (!store.edit(tb => addRoute(tb, lib, name))) store.note({ id: loop ? 'scene.route.noLoopClip' : 'scene.route.noClip', error: true })
        }}>＋ {t('scene.route.add')}</button>
        <span className="scene-dim">{t('scene.route.dropHint')}</span>
      </DropZone>
    </div>}
    <div className="scene-sec">
      <h3>{t('scene.intensity.heading')}</h3>
      <div className="scene-ints">
        {used.length ? used.map(c => <label key={c}><span>{c}</span>
          <NumberField value={table.clips[c].intensity} min={0} max={1} step={0.05} label={c} onCommit={x => store.edit(tb => setClipIntensity(tb, c, x))} />
        </label>) : <span>—</span>}
      </div>
    </div>
  </div>
}

/** Select value of a v2 multi-sound sfx (not a valid sound name). */
const MULTI = ' multi'

/** The selected cue's sound effect and volume. */
export function SceneSoundPanel() {
  const { t } = useI18n()
  const { runtime, pickWav } = useScene()
  const soundFiles = useSceneStore(s => s.soundFiles)
  const { table, lib, name } = useSelectedCue()
  if (!table || !lib) return <div className="scene-panel-empty">{t('scene.noProject')}</div>
  const store = useSceneStore.getState()
  const cue = name ? table.cues[name] : null
  const addWav = async (file: File | null) => {
    if (!file || !name) return
    const sound = await store.addSound(file)
    if (sound) store.edit(tb => assignSound(tb, name, sound))
  }
  return <div className="scene-cue-panel">
    <CuePicker />
    {!name || !cue ? <div className="scene-sec scene-dim">{t('scene.selectCue')}</div>
      : isLoopCue(lib, name) ? <div className="scene-cue"><CueHead lib={lib} name={name} description={cue.description} field="sfx" /><div className="scene-dim">{t('scene.sound.loopCue')}</div></div>
        : <DropZone className="scene-cue" onFile={file => void addWav(file)}>
          <CueHead lib={lib} name={name} description={cue.description} field="sfx" />
          <div className="scene-row">
            <select className="scene-grow" value={sfxSounds(cue.sfx).length > 1 ? MULTI : sfxSounds(cue.sfx)[0] ?? ''} title={sfxSounds(cue.sfx).join(', ')} aria-label={t('scene.panel.sound')} onChange={e => { e.target.blur(); store.edit(tb => assignSound(tb, name, e.target.value || null)) }}>
              <option value="">{t('scene.sound.none')}</option>
              {sfxSounds(cue.sfx).length > 1 && <option value={MULTI} disabled>{t('scene.sound.multi', { count: sfxSounds(cue.sfx).length })}</option>}
              {soundFiles.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="scene-dim">{t('scene.sound.volume')}</span>
            <NumberField value={cue.sfx ? cue.sfx.volume : ''} min={0} max={2} step={0.05} disabled={!cue.sfx} label={t('scene.sound.volume')} onCommit={x => store.edit(tb => setSoundVolume(tb, name, x))} />
            <button type="button" className="scene-icon-btn" title={t('scene.sound.play')} aria-label={t('scene.sound.play')} disabled={!cue.sfx} onClick={e => { e.currentTarget.blur(); if (cue.sfx) runtime.testSound(cue.sfx) }}>▶</button>
            <button type="button" className="scene-icon-btn" title={t('scene.sound.wav')} onClick={async e => { e.currentTarget.blur(); await addWav(await pickWav()) }}>WAV…</button>
          </div>
          <div className="scene-dim scene-drop-hint">{t('scene.sound.dropHint')}</div>
        </DropZone>}
  </div>
}
