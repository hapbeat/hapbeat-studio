import { useState } from 'react'
import type { LedPattern } from '@/types/project'
import './LedEditor.css'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'

const LED_PATTERNS: { value: LedPattern; label: MessageId; description: MessageId }[] = [
  { value: 'solid', label: 'legacyLed.solid', description: 'legacyLed.solidDesc' }, { value: 'breathe', label: 'legacyLed.breathe', description: 'legacyLed.breatheDesc' }, { value: 'pulse', label: 'legacyLed.pulse', description: 'legacyLed.pulseDesc' }, { value: 'off', label: 'legacyLed.off', description: 'legacyLed.offDesc' },
]

export function LedEditor() {
  const { t } = useI18n()
  const [idleColor, setIdleColor] = useState('#333333')
  const [idlePattern, setIdlePattern] = useState<LedPattern>('breathe')

  return (
    <div className="led-editor">
      <div className="led-editor-main">
        <div className="panel">
          <div className="panel-title">{t('legacyLed.title')}</div>

          {/* プレビュー */}
          <div className="led-preview-section">
            <div className="led-preview-label">{t('legacyLed.preview')}</div>
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
              <label className="label">{t('legacyLed.idleColor')}</label>
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
              <label className="label">{t('legacyLed.pattern')}</label>
              <div className="led-pattern-options">
                {LED_PATTERNS.map((p) => (
                  <button
                    key={p.value}
                    className={`led-pattern-btn ${idlePattern === p.value ? 'active' : ''}`}
                    onClick={() => setIdlePattern(p.value)}
                  >
                    <span className="led-pattern-name">{t(p.label)}</span><span className="led-pattern-desc">{t(p.description)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* イベント連動 */}
        <div className="panel">
          <div className="panel-title">{t('legacyLed.eventTitle')}</div>
          <div className="led-event-placeholder">
            {t('legacyLed.eventHint')}
            <br />
            {t('legacyLed.eventAction')}
          </div>
        </div>
      </div>
    </div>
  )
}
