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

export function LedConfigModal({ ledConfig, onLedChange, onClose }: LedConfigModalProps) {
  const updateRule = (id: string, patch: Partial<LedRule>) => {
    onLedChange({
      rules: ledConfig.rules.map((r) => r.id === id ? { ...r, ...patch } : r),
    })
  }

  return createPortal(
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="led-config-modal">
        <div className="modal-header">
          <h3>LED 設定</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          <div className="led-rules">
            {ledConfig.rules.map((rule) => {
              const meta = LED_CONDITION_METAS.find((m) => m.condition === rule.condition)
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
