import { createPortal } from 'react-dom'
import type { UiSettings } from '@/types/display'
import type { ManagerMessage } from '@/types/manager'
import { useDeviceStore } from '@/stores/deviceStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { BRIGHTNESS_STEPS, rawToStep, stepToRaw } from '@/utils/ledBrightness'
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

const BRIGHTNESS_LEVELS: { value: 1 | 2 | 3; label: string; hint: string }[] = [
  { value: 1, label: 'Low',  hint: '暗所・夜間 (~6%)' },
  { value: 2, label: 'Mid',  hint: '通常室内 (50%)' },
  { value: 3, label: 'High', hint: '明所・展示 (100%)' },
]

const HOLD_PRESETS = [600, 800, 1000, 1200, 1500, 2000]

export function UiSettingsModal({
  uiSettings,
  onUiSettingsChange,
  managerSend,
  onClose,
}: UiSettingsModalProps) {
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
          <h3>UI 設定 (OLED / ボタン)</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          {/* OLED 輝度 — 即時反映 */}
          <div className="ui-settings-section">
            <div className="ui-settings-section-title">OLED 輝度</div>
            <div className="ui-settings-row">
              <div className="device-toggle" role="group" aria-label="OLED brightness">
                {BRIGHTNESS_LEVELS.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    className={`btn btn-sm device-toggle-btn ${uiSettings.oled_brightness === l.value ? 'active' : ''}`}
                    onClick={() => handleBrightness(l.value)}
                    title={l.hint}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <span className="ui-settings-hint">
                {selectedIps.length === 0
                  ? '※ デバイス未選択 — Deploy 後に反映'
                  : `${onlineSelected.length}/${selectedIps.length} デバイスへ即時送信`}
              </span>
            </div>
            <div className="ui-settings-hint-block">
              {BRIGHTNESS_LEVELS.find((l) => l.value === uiSettings.oled_brightness)?.hint}
            </div>
          </div>

          {/* Hold タイミング — Deploy 後反映 */}
          <div className="ui-settings-section">
            <div className="ui-settings-section-title">Hold タイミング</div>

            {/* タイムライン: feedback_start → hold_ms 発火 */}
            <HoldTimeline
              feedbackStart={uiSettings.hold_feedback_start_ms}
              fireAt={uiSettings.hold_ms}
              feedbackColor={uiSettings.hold_feedback_color}
              feedbackBrightness={uiSettings.hold_feedback_brightness}
            />

            <div className="ui-settings-row" style={{ marginTop: 6 }}>
              <span className="ui-settings-row-label">発火時間</span>
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
              <span className="ui-settings-row-label">色変化開始</span>
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
              <span className="ui-settings-row-label">変化色</span>
              <input
                type="color"
                value={colorToHex(uiSettings.hold_feedback_color)}
                onChange={(e) => handleFeedbackColor(e.target.value)}
                className="ui-settings-color"
                title="Hold 開始予告の色 (純色を指定し、輝度は別途調整)"
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
              <span className="ui-settings-row-label">変化色の明るさ</span>
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
              押し始めはここで設定した色 + 明るさで点灯し、発火時間に向かって
              線形に 0 まで暗くなります (= 押している進捗の可視化)。
              暗くなりすぎると変化が見えづらいので、必要に応じて明るさを上げて
              ください (LED 設定と同じ 10 段階、ただし設定は独立)。
            </div>
            <div className="ui-settings-hint-block">
              押下から「色変化開始」までは短押し扱い。色が変わってから「発火時間」
              までの間に離せば短押し相当 (action なし)、その間 hold し続けると
              hold アクションが実行されます。
              <br />
              色変化開始を 0ms にすると押した瞬間から色が変わり、hold 中の感触は
              出ますが短押しの視覚区別が無くなります。
            </div>

            <label className="ui-settings-checkbox">
              <input
                type="checkbox"
                checked={uiSettings.hold_show_oled_indicator}
                onChange={(e) =>
                  onUiSettingsChange({ ...uiSettings, hold_show_oled_indicator: e.target.checked })
                }
              />
              <span>Hold 中に OLED へ "Hold..." を表示</span>
            </label>
            <div className="ui-settings-hint-block">
              無効の場合、Hold 中は LED 色変化のみで知らせます (短押し時の
              位置/グループ表示が隠されないように既定 OFF)。
            </div>
          </div>

          <div className="ui-settings-footer-note">
            ※ ここでの設定はモーダルを閉じても **Deploy** を押すまで本体に
            書き込まれません (OLED 輝度のスライダー操作は除く)。
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
          title={`短押し範囲: 0〜${feedbackStart}ms`}
        >
          {tapLabelVisible && (
            <span className="hold-timeline-seg-label">短押し 0-{feedbackStart}ms</span>
          )}
        </div>
        <div
          className="hold-timeline-seg hold-timeline-pending"
          style={{ width: `${pendPct}%`, background: fadeBg }}
          title={`発火予告: ${feedbackStart}〜${fireAt}ms (色 → fade out)`}
        >
          {pendLabelVisible && (
            <span className="hold-timeline-seg-label">
              予告 {feedbackStart}-{fireAt}ms (fade)
            </span>
          )}
          <span className="hold-timeline-fire" aria-hidden="true">▾発火</span>
        </div>
      </div>
    </div>
  )
}
