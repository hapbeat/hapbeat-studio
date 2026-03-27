import { useState } from 'react'
import type { LedPattern } from '@/types/project'
import './LedEditor.css'

const LED_PATTERNS: { value: LedPattern; label: string; description: string }[] = [
  { value: 'solid', label: '常時点灯', description: '一定の色で点灯し続けます' },
  { value: 'breathe', label: '呼吸', description: 'ゆっくり明滅を繰り返します' },
  { value: 'pulse', label: 'パルス', description: '短い間隔で点滅します' },
  { value: 'off', label: 'オフ', description: 'LED を消灯します' },
]

export function LedEditor() {
  const [idleColor, setIdleColor] = useState('#333333')
  const [idlePattern, setIdlePattern] = useState<LedPattern>('breathe')

  return (
    <div className="led-editor">
      <div className="led-editor-main">
        <div className="panel">
          <div className="panel-title">LED 設定</div>

          {/* プレビュー */}
          <div className="led-preview-section">
            <div className="led-preview-label">プレビュー</div>
            <div className="led-preview-container">
              <div
                className={`led-preview-dot ${idlePattern}`}
                style={{ '--led-color': idleColor } as React.CSSProperties}
              />
            </div>
          </div>

          {/* 待機色 */}
          <div className="led-config-section">
            <div className="config-field">
              <label className="label">待機色</label>
              <div className="led-color-input">
                <input
                  type="color"
                  value={idleColor}
                  onChange={(e) => setIdleColor(e.target.value)}
                  className="color-picker"
                />
                <input
                  type="text"
                  className="input mono"
                  value={idleColor}
                  onChange={(e) => setIdleColor(e.target.value)}
                  placeholder="#333333"
                />
              </div>
            </div>

            {/* パターン選択 */}
            <div className="config-field">
              <label className="label">パターン</label>
              <div className="led-pattern-options">
                {LED_PATTERNS.map((p) => (
                  <button
                    key={p.value}
                    className={`led-pattern-btn ${idlePattern === p.value ? 'active' : ''}`}
                    onClick={() => setIdlePattern(p.value)}
                  >
                    <span className="led-pattern-name">{p.label}</span>
                    <span className="led-pattern-desc">{p.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* イベント連動 */}
        <div className="panel">
          <div className="panel-title">イベント連動 LED</div>
          <div className="led-event-placeholder">
            イベントごとの LED 色設定は、イベント定義後に利用可能になります。
            <br />
            「Pack」タブでイベントを追加してください。
          </div>
        </div>
      </div>
    </div>
  )
}
