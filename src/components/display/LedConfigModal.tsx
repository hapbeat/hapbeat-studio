import { createPortal } from 'react-dom'
import type { LedConfig, LedRule } from '@/types/display'
import { LED_CONDITION_METAS } from '@/types/display'
import './LedConfigModal.css'

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

// 非線形 brightness マッピング: 低い方の分解能を高くする
// step 0 = OFF(0), step 1 = 最小(20), step N = MAX(255)
// 中間はガンマカーブで生成
const BRIGHTNESS_STEPS = 10
const BRIGHTNESS_MIN = 20 // 最小可視輝度

function buildBrightnessTable(steps: number): number[] {
  const table = [0] // step 0 = OFF
  for (let i = 1; i <= steps; i++) {
    const raw = BRIGHTNESS_MIN + (255 - BRIGHTNESS_MIN) * (i - 1) / (steps - 1)
    table.push(Math.round(raw))
  }
  table[steps] = 255
  return table
}

const BRIGHTNESS_TABLE = buildBrightnessTable(BRIGHTNESS_STEPS)

function rawToStep(raw: number): number {
  let best = 0
  let bestDist = Math.abs(raw - BRIGHTNESS_TABLE[0])
  for (let i = 1; i < BRIGHTNESS_TABLE.length; i++) {
    const d = Math.abs(raw - BRIGHTNESS_TABLE[i])
    if (d < bestDist) { best = i; bestDist = d }
  }
  return best
}
function stepToRaw(step: number): number {
  return BRIGHTNESS_TABLE[Math.max(0, Math.min(step, BRIGHTNESS_STEPS))]
}

export function LedConfigModal({ ledConfig, onLedChange, onClose }: LedConfigModalProps) {
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
      <div className="led-config-modal">
        <div className="modal-header">
          <h3>LED 設定</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          {/* Global Brightness */}
          <div className="led-global-brightness">
            <div className="led-global-brightness-header">
              <span className="led-global-brightness-label">全体の明るさ</span>
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
              各項目で個別に設定されていない場合、この値が適用されます
            </span>
          </div>

          <div className="led-rules">
            {ledConfig.rules.map((rule) => {
              const meta = LED_CONDITION_METAS.find((m) => m.condition === rule.condition)
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
                      <span className="led-rule-name">{meta?.label ?? rule.condition}</span>
                    </label>
                    <span className="led-rule-desc">{meta?.description ?? ''}</span>
                  </div>
                  {rule.enabled && (
                    <div className="led-rule-settings">
                      <label className="led-setting">
                        <span>色</span>
                        <input
                          type="color"
                          value={rgbToHex(...rule.color)}
                          onChange={(e) => updateRule(rule.id, { color: hexToRgb(e.target.value) })}
                        />
                      </label>
                      <div className="led-setting led-setting-brightness">
                        <span>明るさ</span>
                        <label className="led-brightness-override-toggle" title="個別設定を有効にする">
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
                          <span className="led-setting-hint">個別</span>
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
                        <span>点滅 (秒)</span>
                        <input
                          type="number"
                          min={0} max={10} step={0.1}
                          value={rule.blink_sec}
                          onChange={(e) => updateRule(rule.id, { blink_sec: parseFloat(e.target.value) || 0 })}
                        />
                        <span className="led-setting-hint">{rule.blink_sec === 0 ? '常灯' : `${rule.blink_sec}s`}</span>
                      </label>
                      <label className="led-setting">
                        <span>フェード</span>
                        <input
                          type="checkbox"
                          checked={rule.fade}
                          onChange={(e) => updateRule(rule.id, { fade: e.target.checked })}
                        />
                        <span className="led-setting-hint">{rule.fade ? 'なめらか' : '瞬時'}</span>
                      </label>
                    </div>
                  )}
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
