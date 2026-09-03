import { createPortal } from 'react-dom'
import type { LedConfig, LedConditionGroup, LedConditionMeta, LedRule } from '@/types/display'
import { LED_CONDITION_METAS } from '@/types/display'
import { BRIGHTNESS_STEPS, rawToStep, stepToRaw } from '@/utils/ledBrightness'
import './LedConfigModal.css'
import { useI18n } from '@/i18n/I18nProvider'

const GROUP_ORDER: LedConditionGroup[] = ['warning', 'state']

interface LedConfigModalProps {
  ledConfig: LedConfig
  onLedChange: (config: LedConfig) => void
  onClose: () => void
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

// brightness 0-255 ⇄ 10 段階 step の変換は `@/utils/ledBrightness` に集約
// (UI 設定モーダルの「変化色の明るさ」スライダと同じ感覚で輝度を選べる)。

export function LedConfigModal({ ledConfig, onLedChange, onClose }: LedConfigModalProps) {
  const { t } = useI18n()
  const globalBrightness = ledConfig.globalBrightness ?? 255

  const updateRule = (id: string, patch: Partial<LedRule>) => {
    onLedChange({
      ...ledConfig,
      rules: ledConfig.rules.map((r) => r.id === id ? { ...r, ...patch } : r),
    })
  }

  const setGlobalBrightness = (raw: number) => {
    onLedChange({ ...ledConfig, globalBrightness: raw })
  }

  const globalStep = rawToStep(globalBrightness)

  return createPortal(
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="led-config-modal is-narrow">
        <div className="modal-header">
          <h3>{t('led.modal.title')}</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          {/* Global Brightness */}
          <div className="led-global-brightness">
            <div className="led-global-brightness-header">
              <span className="led-global-brightness-label">{t('led.globalBrightness')}</span>
              <span className="led-global-brightness-value">{globalStep} / {BRIGHTNESS_STEPS}</span>
            </div>
            <input
              type="range"
              min={0} max={BRIGHTNESS_STEPS} step={1}
              value={globalStep}
              onChange={(e) => setGlobalBrightness(stepToRaw(parseInt(e.target.value, 10)))}
              className="led-brightness-slider"
            />
            <span className="led-setting-hint">
              {t('led.globalHint')}
            </span>
          </div>

          <div className="led-rules">
            {GROUP_ORDER.map((group) => {
              const label = group === 'warning' ? t('led.warning') : t('led.state')
              const note = group === 'warning' ? t('led.warningNote') : t('led.stateNote')
              const groupMetas = LED_CONDITION_METAS.filter((m) => m.group === group)
              if (groupMetas.length === 0) return null
              return (
                <div key={group}>
                  <div className="led-group-heading">{label}</div>
                  {note && <div className="led-group-note">{note}</div>}

                  {/* state グループには遷移図を出して双方向に行き来することを示す */}
                  {group === 'state' && (
                    <div className="led-state-flow">
                      <b>{t('led.idle')}</b><span className="arrow" aria-label={t('led.flowAria')}>⇄</span><b>{t('led.connected')}</b>
                    </div>
                  )}

                  <div className="led-rule-grid">
                  {groupMetas.map((meta: LedConditionMeta) => {
                    const rule = ledConfig.rules.find((r) => r.condition === meta.condition)
                    if (!rule) return null
                    const hasOverride = rule.brightness !== undefined
                    const effectiveRaw = hasOverride ? rule.brightness! : globalBrightness
                    const effectiveStep = rawToStep(effectiveRaw)
                    return (
                      <div key={rule.id} className={`led-rule ${rule.enabled ? '' : 'disabled'}`}>
                        <div className="led-rule-header">
                          <label className="led-rule-toggle">
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                            />
                            <span className="led-rule-priority" title={t('led.priority', { priority: rule.priority })}>
                              #{rule.priority}
                            </span>
                            <span className="led-rule-name">{meta.label}</span>
                          </label>
                          <span className="led-rule-desc">{meta.description}</span>
                        </div>
                        {rule.enabled && (
                          <div className="led-rule-settings">
                            <label className="led-setting led-setting-color">
                              <span>{t('led.color')}</span>
                              <input
                                type="color"
                                value={rgbToHex(...rule.color)}
                                onChange={(e) => updateRule(rule.id, { color: hexToRgb(e.target.value) })}
                              />
                            </label>
                            <div className="led-setting led-setting-brightness">
                              <span>{t('led.brightness')}</span><label className="led-brightness-override-toggle" title={t('led.enableOverride')}>
                                <input
                                  type="checkbox"
                                  checked={hasOverride}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      updateRule(rule.id, { brightness: globalBrightness })
                                    } else {
                                      updateRule(rule.id, { brightness: undefined })
                                    }
                                  }}
                                />
                                <span className="led-setting-hint">{t('led.individual')}</span>
                              </label>
                              <input
                                type="range"
                                min={0} max={BRIGHTNESS_STEPS} step={1}
                                value={effectiveStep}
                                disabled={!hasOverride}
                                onChange={(e) => updateRule(rule.id, { brightness: stepToRaw(parseInt(e.target.value, 10)) })}
                                className="led-brightness-slider small"
                              />
                              <span className="led-brightness-num">{effectiveStep}</span>
                            </div>
                            <label className="led-setting">
                              <span>{t('led.blink')}</span>
                              <input
                                type="number"
                                min={0} max={10} step={0.1}
                                value={rule.blink_sec}
                                onChange={(e) => updateRule(rule.id, { blink_sec: parseFloat(e.target.value) || 0 })}
                              />
                              <span className="led-setting-hint">{rule.blink_sec === 0 ? t('led.steady') : `${rule.blink_sec}s`}</span>
                            </label>
                            <label className="led-setting">
                              <span>{t('led.fade')}</span>
                              <input
                                type="checkbox"
                                checked={rule.fade}
                                onChange={(e) => updateRule(rule.id, { fade: e.target.checked })}
                              />
                              <span className="led-setting-hint">{rule.fade ? t('led.smooth') : t('led.instant')}</span>
                            </label>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
