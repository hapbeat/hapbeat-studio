import { createPortal } from 'react-dom'
import type { VolumeConfig, VolumeDirection } from '@/types/display'
import { useI18n } from '@/i18n/I18nProvider'
import './LedConfigModal.css'

interface VolumeConfigModalProps {
  volumeConfig: VolumeConfig
  onVolumeChange: (config: VolumeConfig) => void
  onClose: () => void
}

export function VolumeConfigModal({ volumeConfig, onVolumeChange, onClose }: VolumeConfigModalProps) {
  const { t } = useI18n()
  return createPortal(
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="led-config-modal is-narrow">
        <div className="modal-header">
          <h3>{t('display.volume')}</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          <div className="volume-modal-settings">
            <label className="volume-modal-row">
              <span className="volume-modal-label">{t('volume.steps')}</span>
              <input
                type="number" min={1} max={64}
                value={volumeConfig.steps}
                onChange={(e) => {
                  const steps = Math.max(1, Math.min(64, parseInt(e.target.value) || 10))
                  onVolumeChange({ ...volumeConfig, steps, default_level: Math.min(volumeConfig.default_level, steps - 1) })
                }}
              />
              <span className="volume-modal-hint">1〜64</span>
            </label>
            <label className="volume-modal-row">
              <span className="volume-modal-label">{t('volume.direction')}</span>
              <select
                value={volumeConfig.direction}
                onChange={(e) => onVolumeChange({ ...volumeConfig, direction: e.target.value as VolumeDirection })}
              >
                <option value="ascending">{t('volume.ascending')}</option>
                <option value="descending">{t('volume.descending')}</option>
              </select>
            </label>
            <label className="volume-modal-row">
              <span className="volume-modal-label">{t('volume.fixed')}</span>
              <input
                type="range" min={0} max={volumeConfig.steps - 1}
                value={volumeConfig.default_level}
                onChange={(e) => onVolumeChange({ ...volumeConfig, default_level: parseInt(e.target.value) })}
              />
              <span className="volume-modal-hint">{volumeConfig.default_level} / {volumeConfig.steps - 1}</span>
            </label>
            <div className="volume-modal-row">
              <span className="volume-modal-label" />
              <span className="volume-modal-hint">
                {t('volume.fixedHint')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
