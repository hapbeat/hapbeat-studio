import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  desktopApi,
  useDesktopUi,
  type DesktopHelperStatus,
  type DesktopUpdateResult,
} from '@/config/desktopShell'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useI18n } from '@/i18n/I18nProvider'
import { DiscoveryRecoverySection } from './DiscoveryRecoverySection'
import './HelperOnboardingModal.css'
import './DesktopAppModal.css'

/**
 * The bundled helper's state as the app reports it (null in a browser). Also
 * opens the app panel when the bundled helper cannot run, so a stopped helper
 * is not left as a red dot nobody clicks.
 */
export function useDesktopHelperStatus(onUnrecoverable?: () => void): DesktopHelperStatus | null {
  const [status, setStatus] = useState<DesktopHelperStatus | null>(null)
  const onUnrecoverableRef = useRef(onUnrecoverable)
  onUnrecoverableRef.current = onUnrecoverable
  useEffect(() => {
    const api = desktopApi()
    if (!api) return
    let alive = true
    const apply = (next: DesktopHelperStatus) => {
      if (!alive) return
      setStatus(next)
      if (next.state === 'crashed' || next.state === 'missing') onUnrecoverableRef.current?.()
    }
    void api.helper.status().then(apply).catch(() => { /* app without the API */ })
    const unsubscribe = api.helper.onStatus(apply)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  return status
}

type Translate = ReturnType<typeof useI18n>['t']

function helperStateText(status: DesktopHelperStatus | null, t: Translate): string {
  if (!status) return t('desktop.helper.state.browser')
  switch (status.state) {
    case 'running':
      return t('desktop.helper.state.running', { version: status.version ?? '?' })
    case 'external':
      return t('desktop.helper.state.external')
    case 'starting':
      return t('desktop.helper.state.starting')
    case 'crashed':
      return t('desktop.helper.state.crashed')
    case 'missing':
      return t('desktop.helper.state.missing')
    default:
      return t('desktop.helper.state.stopped')
  }
}

function updateText(result: DesktopUpdateResult | 'checking' | null, t: Translate): string {
  if (result === null) return ''
  if (result === 'checking') return t('desktop.update.checking')
  switch (result.state) {
    case 'none':
      return t('desktop.update.none')
    case 'downloading':
      return t('desktop.update.downloading', { version: result.version ?? '' })
    case 'downloaded':
      return t('desktop.update.downloaded', { version: result.version ?? '' })
    case 'dev':
      return t('desktop.update.dev')
    default:
      return t('desktop.update.error')
  }
}

interface DesktopAppModalProps {
  open: boolean
  onClose: () => void
  helperStatus: DesktopHelperStatus | null
}

/**
 * Desktop app panel: replaces the pipx-based Helper setup / management modals
 * inside the app (the helper is built in, so there is nothing to install).
 */
export function DesktopAppModal({ open, onClose, helperStatus }: DesktopAppModalProps) {
  const { t } = useI18n()
  const { isConnected } = useHelperConnection()
  const fullUi = useDesktopUi((s) => s.fullUi)
  const setFullUi = useDesktopUi((s) => s.setFullUi)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [update, setUpdate] = useState<DesktopUpdateResult | 'checking' | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const api = desktopApi()

  useEffect(() => {
    if (!open || !api) return
    void api.getInfo().then((info) => setAppVersion(info.appVersion)).catch(() => { /* keep unknown */ })
  }, [open, api])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const restartHelper = useCallback(async () => {
    if (!api) return
    setRestarting(true)
    try {
      await api.helper.restart()
    } finally {
      setRestarting(false)
    }
  }, [api])

  const checkUpdates = useCallback(async () => {
    if (!api) return
    setUpdate('checking')
    try {
      setUpdate(await api.checkForUpdates())
    } catch {
      setUpdate({ state: 'error' })
    }
  }, [api])

  if (!open) return null

  const dotClass = isConnected ? 'connected' : 'disconnected'
  return createPortal(
    <div className="helper-modal-backdrop" onClick={onClose}>
      <div
        className="helper-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('desktop.modal.aria')}
      >
        <div className="helper-modal-header">
          <span className="helper-modal-title">
            <span className={`helper-modal-dot ${dotClass}`} />
            {t('desktop.modal.title')}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="helper-modal-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>

        <div className="helper-modal-body">
          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('desktop.helper.title')}</h3>
            <p className="desktop-app-status-line">{helperStateText(helperStatus, t)}</p>
            <p className="desktop-app-status-line desktop-app-status-line--muted">
              {isConnected ? t('desktop.helper.connected') : t('desktop.helper.disconnected')}
            </p>
            <div className="desktop-app-actions">
              <button
                type="button"
                className="form-button-secondary desktop-app-fixed-btn"
                onClick={() => void restartHelper()}
                disabled={!api || restarting}
              >
                {restarting ? t('desktop.helper.restarting') : t('desktop.helper.restart')}
              </button>
              <button
                type="button"
                className="form-button-secondary"
                onClick={() => void api?.helper.openLogFolder()}
                disabled={!api}
              >
                {t('desktop.helper.logs')}
              </button>
            </div>
            <p className="helper-modal-section-desc">{t('desktop.helper.firewall')}</p>
          </section>

          <DiscoveryRecoverySection />

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('desktop.update.title')}</h3>
            <p className="helper-modal-section-desc">{t('desktop.update.desc')}</p>
            <div className="desktop-app-actions">
              <span className="desktop-app-version">
                {t('desktop.update.version', { version: appVersion ?? '-' })}
              </span>
              <button
                type="button"
                className="form-button-secondary"
                onClick={() => void checkUpdates()}
                disabled={!api || update === 'checking'}
              >
                {t('desktop.update.check')}
              </button>
            </div>
            <p className="desktop-app-status-line desktop-app-status-line--muted">{updateText(update, t)}</p>
          </section>

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">{t('desktop.view.title')}</h3>
            <label className="desktop-app-check">
              <input type="checkbox" checked={fullUi} onChange={(e) => setFullUi(e.target.checked)} />
              <span>{t('desktop.view.fullUi')}</span>
            </label>
            <p className="helper-modal-section-desc">{t('desktop.view.fullUiDesc')}</p>
          </section>

          <p className="helper-modal-build-meta">
            Studio build: <code>{import.meta.env.VITE_BUILD_SHA}</code>
            {' · '}
            <code>{(import.meta.env.VITE_BUILD_DATE ?? '').replace(/\.\d+Z$/, 'Z')}</code>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
