import { useI18n } from '@/i18n/I18nProvider'
import { useSceneSettings } from '@/stores/sceneSettings'
import { useScene } from './sceneContext'

/**
 * PC sound / haptic send toggles with the device count. Every state's text is
 * stacked in one grid cell, so a toggle keeps the width of its longest state
 * (no layout shift). Keys: M / H.
 */
export function SceneOutputToggles() {
  const { t } = useI18n()
  const { helperConnected, devices } = useScene()
  const pcSound = useSceneSettings(s => s.pcSound)
  const sendHaptics = useSceneSettings(s => s.sendHaptics)
  const toggle = (label: string, on: boolean, flip: () => void, title: string) =>
    <button type="button" className={`scene-toggle ${on ? 'on' : ''}`} title={title} aria-pressed={on} onClick={e => { e.currentTarget.blur(); flip() }}>
      <span>{label}</span>
      <span className="scene-stack"><span aria-hidden="true" className="scene-sizer">OFF</span><span>{on ? 'ON' : 'OFF'}</span></span>
    </button>
  const status = !helperConnected ? t('scene.output.noHelper') : sendHaptics ? t('scene.output.devices', { count: devices.length }) : ''
  return <span className="scene-toggles">
    {toggle(t('scene.output.sound'), pcSound, () => useSceneSettings.getState().update({ pcSound: !pcSound }), t('scene.output.soundTitle'))}
    {toggle(t('scene.output.haptics'), sendHaptics, () => useSceneSettings.getState().update({ sendHaptics: !sendHaptics }), t('scene.output.hapticsTitle'))}
    <span className="scene-stack scene-toggle-status">
      <span aria-hidden="true" className="scene-sizer">{t('scene.output.noHelper')}</span>
      <span aria-hidden="true" className="scene-sizer">{t('scene.output.devices', { count: 88 })}</span>
      <span>{status}</span>
    </span>
  </span>
}
