import { useEffect } from 'react'
import './ClipModeInfoModal.css'
import { useI18n } from '@/i18n/I18nProvider'

export interface ClipModeInfoModalProps {
  onClose: () => void
}

/**
 * 3 つの再生モード（FIRE / CLIP / BOTH）が「デバイス側で何が起きるか」
 * を並べて比較するモーダル。Kit カード右サイドの `?` から開く。
 *
 * ラベルと先頭記号は KitEventRow の MODE_OPTIONS と揃えること。
 */
export function ClipModeInfoModal({ onClose }: ClipModeInfoModalProps) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="clip-mode-info-backdrop" onClick={onClose}>
      <div className="clip-mode-info-modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="clip-mode-info-header">
          <h3>{t('kit.modeInfo.title')}</h3>
          <button className="clip-mode-info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="clip-mode-info-body">
          <p className="clip-mode-info-intro">
            {t('kit.modeInfo.intro')}
          </p>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge fire"><span className="sym">&gt;</span>FIRE</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">{t('kit.modeInfo.fire.title')}</div><p>{t('kit.modeInfo.fire.body')}</p>
              <ul className="clip-mode-info-pros">
                <li>{t('kit.modeInfo.fire.one')}</li><li>{t('kit.modeInfo.fire.two')}</li><li>{t('kit.modeInfo.fire.three')}</li>
              </ul>
            </div>
          </div>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge clip"><span className="sym">♪</span>CLIP</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">{t('kit.modeInfo.clip.title')}</div><p>{t('kit.modeInfo.clip.body')}</p>
              <ul className="clip-mode-info-pros">
                <li>{t('kit.modeInfo.clip.one')}</li><li>{t('kit.modeInfo.clip.two')}</li><li>{t('kit.modeInfo.clip.three')}</li>
              </ul>
            </div>
          </div>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge live"><span className="sym">&gt;♪</span>BOTH</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">{t('kit.modeInfo.both.title')}</div><p>{t('kit.modeInfo.both.body')}</p>
              <ul className="clip-mode-info-pros">
                <li>{t('kit.modeInfo.both.one')}</li><li>{t('kit.modeInfo.both.two')}</li><li>{t('kit.modeInfo.both.three')}</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="clip-mode-info-footer">
          <button className="library-btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
