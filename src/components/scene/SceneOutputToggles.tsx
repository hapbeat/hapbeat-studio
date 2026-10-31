import { useI18n } from '@/i18n/I18nProvider'
import { useSceneSettings } from '@/stores/sceneSettings'
import { effectiveOutput, useScenePlayback, type SceneOutput } from '@/stores/scenePlayback'
import { useScene } from './sceneContext'
import { KindIcon } from '@/components/common/KindIcon'

const toggle = (kind: 'sound' | 'haptic', label: string, on: boolean, flip: () => void, title: string) =>
  <button type="button" className={`scene-toggle ${kind} ${on ? 'on' : ''}`} title={title} aria-pressed={on} onClick={e => { e.currentTarget.blur(); flip() }}>
    <KindIcon kind={kind} size={14} decorative />
    <span>{label}</span>
    <span className="scene-stack"><span aria-hidden="true" className="scene-sizer">OFF</span><span>{on ? 'ON' : 'OFF'}</span></span>
  </button>

/**
 * PC sound / haptic send toggles and the output chip, in the timeline's info row. Every state's text is stacked in one
 * grid cell, so a toggle keeps the width of its longest state (no layout shift). Keys: M / H.
 */
export function SceneOutputToggles() {
  const { t } = useI18n()
  const pcSound = useSceneSettings(s => s.pcSound)
  const sendHaptics = useSceneSettings(s => s.sendHaptics)
  return <span className="scene-toggles">
    {toggle('sound', t('scene.output.sound'), pcSound, () => useSceneSettings.getState().update({ pcSound: !pcSound }), t('scene.output.soundTitle'))}
    {toggle('haptic', t('scene.output.haptics'), sendHaptics, () => useSceneSettings.getState().update({ sendHaptics: !sendHaptics }), t('scene.output.hapticsTitle'))}
    <SceneOutputChip className="scene-toggle-status" />
  </span>
}

/**
 * This PC's playback settings (scenePlayback) in the Project panel's "Haptic output": the haptic path (stream from this
 * PC / the Kit on the Hapbeat), all Hapbeats and the video's volume. Each control gives up the focus once used, so the
 * Scene keys (arrows included) keep working.
 */
export function SceneOutputSettings() {
  const { t } = useI18n()
  const output = useScenePlayback(s => s.output)
  const allDevices = useScenePlayback(s => s.allDevices)
  const videoVolume = useScenePlayback(s => s.videoVolume)
  const path = (value: SceneOutput, label: string) => <button type="button" className={output === value ? 'on' : ''} aria-pressed={output === value}
    onClick={e => { e.currentTarget.blur(); useScenePlayback.getState().update({ output: value }) }}>{label}</button>
  return <div className="scene-row">
    <span className="scene-seg" role="group" aria-label={t('scene.path.label')} title={t('scene.path.title')}>
      {path('clip', t('scene.path.clip'))}{path('fire', t('scene.path.fire'))}
    </span>
    {toggle('haptic', t('scene.allDevices.label'), allDevices, () => useScenePlayback.getState().update({ allDevices: !allDevices }), t('scene.allDevices.title'))}
    <label className="scene-volume" title={t('scene.videoVolume.title')}>{t('scene.videoVolume.label')}
      <input type="range" min={0} max={1} step={0.05} value={videoVolume} aria-label={t('scene.videoVolume.title')}
        onPointerUp={e => e.currentTarget.blur()} onChange={e => useScenePlayback.getState().update({ videoVolume: Number(e.target.value) })} /></label>
  </div>
}

/**
 * Where the haptics go now, in one line: the path the runtime plays by (effectiveOutput: CLIP until the Kit is known
 * to be on the devices, and while it is missing), how many devices it reaches and, in FIRE, the Kit's state. Shown by
 * the output toggles and the presentation bar.
 */
export function SceneOutputChip({ className }: { className?: string }) {
  const { t } = useI18n()
  const { helperConnected, devices } = useScene()
  const sendHaptics = useSceneSettings(s => s.sendHaptics)
  const output = useScenePlayback(s => s.output)
  const kitState = useScenePlayback(s => s.kitState)
  const fire = output === 'fire', fallback = fire && kitState === 'missing'
  const kit = !fire || fallback ? '' : kitState === 'checking' ? t('scene.kit.state.checking') : kitState === 'ready' ? t('scene.kit.state.ready')
    : kitState === 'differs' ? t('scene.kit.state.differs') : kitState === 'unreachable' ? t('scene.kit.state.unreachable') : ''
  const text = !helperConnected ? t('scene.output.noHelper') : !sendHaptics ? t('scene.output.hapticsOff')
    : [fallback ? t('scene.path.fallback') : t(effectiveOutput({ output, kitState }) === 'fire' ? 'scene.path.fire' : 'scene.path.clip'), t('scene.output.devices', { count: devices.length }), kit].filter(Boolean).join(' · ')
  const warn = !helperConnected || fallback || kitState === 'differs' || kitState === 'unreachable'
  return <span className={`scene-chip ${warn ? 'warn' : ''} ${className ?? ''}`} role="status" title={text}>{text}</span>
}
