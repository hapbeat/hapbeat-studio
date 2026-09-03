import { createPortal } from 'react-dom'
import type { UiSettings } from '@/types/display'
import type { ManagerMessage } from '@/types/manager'
import { useDeviceStore } from '@/stores/deviceStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { BRIGHTNESS_STEPS, rawToStep, stepToRaw } from '@/utils/ledBrightness'
import { useI18n } from '@/i18n/I18nProvider'
import './LedConfigModal.css'

interface UiSettingsModalProps {
  uiSettings: UiSettings
  onUiSettingsChange: (settings: UiSettings) => void
  /**
   * Connected manager send-fn. OLED 輝度はピックアップした瞬間に
   * `set_oled_brightness` で全選択デバイスへ即時反映する。値の永続化は
   * 通常の Deploy 経由で `ui-config.json` に書き込まれる。
   */
  managerSend: (msg: ManagerMessage) => void
  onClose: () => void
}

const BRIGHTNESS_LEVELS: { value: 1 | 2 | 3; label: string; hint: 'ui.brightness.low' | 'ui.brightness.mid' | 'ui.brightness.high' }[] = [
  { value: 1, label: 'Low',  hint: 'ui.brightness.low' },
  { value: 2, label: 'Mid',  hint: 'ui.brightness.mid' },
  { value: 3, label: 'High', hint: 'ui.brightness.high' },
]

const HOLD_PRESETS = [600, 800, 1000, 1200, 1500, 2000]

export function UiSettingsModal({
  uiSettings,
  onUiSettingsChange,
  managerSend,
  onClose,
}: UiSettingsModalProps) {
  const { t } = useI18n()
  const selectedIps = useDeviceStore((s) => s.selectedIps)
  const { devices } = useHelperConnection()
  const onlineSelected = devices.filter(
    (d) => d.online && selectedIps.includes(d.ipAddress),
  )

  const handleBrightness = (v: 1 | 2 | 3) => {
    onUiSettingsChange({ ...uiSettings, oled_brightness: v })
    // Push to all currently-selected online devices so the user can see the
    // change immediately while tweaking. Deploy still writes ui-config.json.
    if (onlineSelected.length > 0) {
      managerSend({
        type: 'set_oled_brightness',
        payload: { level: v, targets: onlineSelected.map((d) => d.ipAddress) },
      })
    }
  }

  const handleHoldMs = (ms: number) => {
    const clamped = Math.max(300, Math.min(3000, Math.round(ms)))
    // hold_feedback_start_ms < hold_ms を維持
    const fbStart = Math.min(uiSettings.hold_feedback_start_ms, Math.max(50, clamped - 100))
    onUiSettingsChange({ ...uiSettings, hold_ms: clamped, hold_feedback_start_ms: fbStart })
  }

  const handleFeedbackStart = (ms: number) => {
    // 0 〜 hold_ms - 50 の範囲に収める
    const clamped = Math.max(0, Math.min(uiSettings.hold_ms - 50, Math.round(ms)))
    onUiSettingsChange({ ...uiSettings, hold_feedback_start_ms: clamped })
  }

  const colorToHex = (rgb: [number, number, number]) =>
    '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
  const hexToColor = (hex: string): [number, number, number] => {
    const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 255, 255]
  }
  const handleFeedbackColor = (hex: string) => {
    onUiSettingsChange({ ...uiSettings, hold_feedback_color: hexToColor(hex) })
  }
  const handleFeedbackBrightnessStep = (step: number) => {
    // LED 設定の global brightness と同じ 10 段階 (gamma 1.8 テーブル) で扱う
    const raw = stepToRaw(Math.max(0, Math.min(BRIGHTNESS_STEPS, Math.round(step))))
    onUiSettingsChange({ ...uiSettings, hold_feedback_brightness: raw })
  }
  const feedbackBrightnessStep = rawToStep(uiSettings.hold_feedback_brightness)

  return createPortal(
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="led-config-modal is-narrow">
        <div className="modal-header">
          <h3>{t('ui.modal.title')}</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          {/* OLED 輝度 — 即時反映 */}
          <div className="ui-settings-section">
            <div className="ui-settings-section-title">{t('ui.brightness')}</div>
            <div className="ui-settings-row">
              <div className="device-toggle" role="group" aria-label="OLED brightness">
                {BRIGHTNESS_LEVELS.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    className={`btn btn-sm device-toggle-btn ${uiSettings.oled_brightness === l.value ? 'active' : ''}`}
                    onClick={() => handleBrightness(l.value)}
                    title={t(l.hint)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <span className="ui-settings-hint">
                {selectedIps.length === 0
                  ? t('ui.noDevice')
                  : t('ui.sendNow', { online: onlineSelected.length, selected: selectedIps.length })}
              </span>
            </div>
            <div className="ui-settings-hint-block">
              {t(BRIGHTNESS_LEVELS.find((l) => l.value === uiSettings.oled_brightness)?.hint ?? 'ui.brightness.mid')}
            </div>
          </div>

          {/* Hold タイミング — Deploy 後反映 */}
          <div className="ui-settings-section">
            <div className="ui-settings-section-title">{t('ui.holdTiming')}</div>

            {/* タイムライン: feedback_start → hold_ms 発火 */}
            <HoldTimeline
              feedbackStart={uiSettings.hold_feedback_start_ms}
              fireAt={uiSettings.hold_ms}
              feedbackColor={uiSettings.hold_feedback_color}
              feedbackBrightness={uiSettings.hold_feedback_brightness}
            />

            <div className="ui-settings-row" style={{ marginTop: 6 }}>
              <span className="ui-settings-row-label">{t('ui.fireAt')}</span>
              <input
                type="range"
                min={300} max={3000} step={50}
                value={uiSettings.hold_ms}
                onChange={(e) => handleHoldMs(parseInt(e.target.value, 10))}
                className="ui-settings-slider"
              />
              <input
                type="number"
                min={300} max={3000} step={50}
                value={uiSettings.hold_ms}
                onChange={(e) => handleHoldMs(parseInt(e.target.value, 10) || 1000)}
                className="ui-settings-num"
              />
              <span className="ui-settings-unit">ms</span>
            </div>
            <div className="ui-settings-presets">
              {HOLD_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`btn btn-xs ${uiSettings.hold_ms === p ? 'active' : ''}`}
                  onClick={() => handleHoldMs(p)}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="ui-settings-row" style={{ marginTop: 10 }}>
              <span className="ui-settings-row-label">{t('ui.feedbackStart')}</span>
              <input
                type="range"
                min={0}
                max={Math.max(50, uiSettings.hold_ms - 50)}
                step={50}
                value={uiSettings.hold_feedback_start_ms}
                onChange={(e) => handleFeedbackStart(parseInt(e.target.value, 10))}
                className="ui-settings-slider"
              />
              <input
                type="number"
                min={0}
                max={Math.max(50, uiSettings.hold_ms - 50)}
                step={50}
                value={uiSettings.hold_feedback_start_ms}
                onChange={(e) => handleFeedbackStart(parseInt(e.target.value, 10) || 0)}
                className="ui-settings-num"
              />
              <span className="ui-settings-unit">ms</span>
            </div>

            <div className="ui-settings-row" style={{ marginTop: 6 }}>
              <span className="ui-settings-row-label">{t('ui.feedbackColor')}</span>
              <input
                type="color"
                value={colorToHex(uiSettings.hold_feedback_color)}
                onChange={(e) => handleFeedbackColor(e.target.value)}
                className="ui-settings-color"
                title={t('ui.feedbackColorTitle')}
              />
              <input
                type="text"
                value={colorToHex(uiSettings.hold_feedback_color)}
                onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && handleFeedbackColor(e.target.value)}
                className="ui-settings-num"
                style={{ width: 88, fontFamily: 'monospace' }}
              />
            </div>

            <div className="ui-settings-row" style={{ marginTop: 6 }}>
              <span className="ui-settings-row-label">{t('ui.feedbackBrightness')}</span>
              <input
                type="range"
                min={0} max={BRIGHTNESS_STEPS} step={1}
                value={feedbackBrightnessStep}
                onChange={(e) => handleFeedbackBrightnessStep(parseInt(e.target.value, 10))}
                className="ui-settings-slider"
              />
              <span className="ui-settings-unit">
                {feedbackBrightnessStep} / {BRIGHTNESS_STEPS}
              </span>
            </div>
            <div className="ui-settings-hint-block">
              {t('ui.feedbackExplanation')}
            </div>
            <div className="ui-settings-hint-block">
              {t('ui.holdExplanation')}
            </div>

            <label className="ui-settings-checkbox">
              <input
                type="checkbox"
                checked={uiSettings.hold_show_oled_indicator}
                onChange={(e) =>
                  onUiSettingsChange({ ...uiSettings, hold_show_oled_indicator: e.target.checked })
                }
              />
              <span>{t('ui.showHold')}</span>
            </label>
            <div className="ui-settings-hint-block">
              {t('ui.showHoldHint')}
            </div>
          </div>

          <div className="ui-settings-footer-note">
            {t('ui.deployNote')}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

/**
 * Hold タイミングを横棒タイムラインで可視化。
 *
 *   [短押し 0-300ms][予告 (色 → fade out)         ▾発火]
 *
 * 予告セグメントは color * brightness から始まり、右端 (発火点) で 0 (黒)
 * になる線形グラデーションで fade-out を表現する。
 */
function HoldTimeline({
  feedbackStart,
  fireAt,
  feedbackColor,
  feedbackBrightness,
}: {
  feedbackStart: number
  fireAt: number
  feedbackColor: [number, number, number]
  feedbackBrightness: number
}) {
  const { t } = useI18n()
  const total = Math.max(fireAt, feedbackStart) || 1
  const tapPct = (feedbackStart / total) * 100
  const pendPct = ((fireAt - feedbackStart) / total) * 100
  // color × brightness/255 を effective として preview に出す
  const scale = Math.max(0, Math.min(255, feedbackBrightness)) / 255
  const eff = feedbackColor.map((c) => Math.round(c * scale)) as [number, number, number]
  const startCss = `rgb(${eff.join(',')})`
  const endCss = 'rgb(0,0,0)'
  const fadeBg = `linear-gradient(to right, ${startCss}, ${endCss})`
  const tapLabelVisible = tapPct >= 18
  const pendLabelVisible = pendPct >= 22
  return (
    <div className="hold-timeline">
      <div className="hold-timeline-bar">
        <div
          className="hold-timeline-seg hold-timeline-tap"
          style={{ width: `${tapPct}%` }}
          title={t('ui.tapRange', { ms: feedbackStart })}
        >
          {tapLabelVisible && (
            <span className="hold-timeline-seg-label">{t('ui.tapLabel', { ms: feedbackStart })}</span>
          )}
        </div>
        <div
          className="hold-timeline-seg hold-timeline-pending"
          style={{ width: `${pendPct}%`, background: fadeBg }}
          title={t('ui.pendingRange', { start: feedbackStart, end: fireAt })}
        >
          {pendLabelVisible && (
            <span className="hold-timeline-seg-label">
              {t('ui.pendingLabel', { start: feedbackStart, end: fireAt })}
            </span>
          )}
          <span className="hold-timeline-fire" aria-hidden="true">{t('ui.trigger')}</span>
        </div>
      </div>
    </div>
  )
}
