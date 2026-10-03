import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { KitManager } from '@/components/kit/KitManager'
import { Devices } from '@/components/devices/Devices'
import { LogDrawer } from '@/components/log/LogDrawer'
import { HelperOnboardingModal } from '@/components/common/HelperOnboardingModal'
import { HelperManageModal } from '@/components/common/HelperManageModal'
import { ExternalLinkIcon } from '@/components/common/ExternalLinkIcon'
import { useToast } from '@/components/common/Toast'
import { HelperFailureToastListener } from '@/components/common/HelperFailureToastListener'
import { VersionSwitcher } from '@/components/common/VersionSwitcher'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useHelperUpdate, useStudioFrozenNotice } from '@/hooks/useReleaseNotices'
import { MIN_HELPER_VERSION } from '@/config/helperCompat'
import { useI18n } from '@/i18n/I18nProvider'
import './App.css'
import { handlePlaybackShortcut } from '@/utils/playbackShortcut'

type Tab = 'editor' | 'kit' | 'display' | 'devices'

const TABS: Tab[] = ['editor', 'kit', 'display', 'devices']

const DEFAULT_TAB: Tab = 'kit'

const DOCS_URL = 'https://devtools.hapbeat.com/docs/tools/studio/initial-setup/'

/**
 * Render a tab pane that mounts on first visit and stays mounted on
 * later switches (toggled via `display: none`). This lets the Kit tab
 * keep its `loadLibrary()` result, scroll position, and selected kit
 * across tab changes — re-mounting on every switch was running a
 * "Loading…" flash and resetting the UI state every visit.
 *
 * The first visit still pays the mount + load cost (acceptable
 * one-time delay). Subsequent visits are instant because the React
 * subtree is already there.
 */
function PersistentTab({
  active,
  visited,
  children,
}: {
  active: boolean
  visited: boolean
  children: ReactNode
}) {
  if (!visited) return null
  return <div style={{ display: active ? 'contents' : 'none' }}>{children}</div>
}

export function App() {
  const { locale, setLocale, t } = useI18n()
  const tabLabels: Record<Tab, { main: string; sub: string }> = {
    editor: { main: t('tabs.editor.main'), sub: t('tabs.editor.sub') },
    kit: { main: t('tabs.kit.main'), sub: t('tabs.kit.sub') },
    display: { main: t('tabs.ui.main'), sub: t('tabs.ui.sub') },
    devices: { main: t('tabs.manage.main'), sub: t('tabs.manage.sub') },
  }
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('hapbeat-studio-tab')
    return (TABS as string[]).includes(saved ?? '') ? (saved as Tab) : DEFAULT_TAB
  })

  // Track which tabs the user has visited at least once. We mount each
  // tab on first visit and keep it mounted after — see PersistentTab.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([
    (() => {
      const saved = localStorage.getItem('hapbeat-studio-tab')
      return (TABS as string[]).includes(saved ?? '') ? (saved as Tab) : DEFAULT_TAB
    })(),
  ]))

  // The app header can be folded away to give tabs (notably the editor) more height.
  // A slim bar with the expand button stays visible while folded.
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    try { return localStorage.getItem('hapbeat-studio-header-collapsed') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('hapbeat-studio-header-collapsed', headerCollapsed ? '1' : '0') } catch { /* preference only */ }
  }, [headerCollapsed])

  useEffect(() => {
    localStorage.setItem('hapbeat-studio-tab', activeTab)
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])
  useEffect(() => {
    const handleSpace = (event: KeyboardEvent) => handlePlaybackShortcut(event, activeTab, event => window.dispatchEvent(event))
    window.addEventListener('keydown', handleSpace, true)
    return () => window.removeEventListener('keydown', handleSpace, true)
  }, [activeTab])
  const { isConnected, helperVersion, helperCompat, send } = useHelperConnection()
  const { toast } = useToast()
  const [helperModalOpen, setHelperModalOpen] = useState(false)
  const [helperManageOpen, setHelperManageOpen] = useState(false)
  // Top-of-app banner suppressing — opt-in per session only. We deliberately
  // do NOT persist this to localStorage: an outdated Helper is a fix-it-now
  // problem that should remind the user every fresh Studio load.
  const [helperOutdatedDismissed, setHelperOutdatedDismissed] = useState(false)
  // 「使えてはいるが新しい版がある」お知らせ (上の必須警告とは別)。
  // 閉じた版は localStorage に記録され、より新しい版が出るまで再表示しない
  // — 版を意図的に固定している人に毎回閉じさせないため (DEC-053 §5.1)。
  const helperUpdate = useHelperUpdate(helperVersion)
  const studioFrozen = useStudioFrozenNotice()
  const announcedUpdates = useRef(new Set<string>())

  // Informational release notices are transient: keeping them in the header
  // would move the centered primary navigation whenever one becomes visible.
  useEffect(() => {
    const version = helperUpdate.product?.latest
    if (!helperUpdate.visible || helperCompat === 'outdated' || !version) return
    const key = `helper:${version}`
    if (announcedUpdates.current.has(key)) return
    announcedUpdates.current.add(key)
    toast(t('header.helperUpdate', { version }), 'info')
    helperUpdate.dismiss()
  }, [helperUpdate, helperCompat, t, toast])

  useEffect(() => {
    if (!studioFrozen.visible || !studioFrozen.latest) return
    const key = `studio:${studioFrozen.latest}`
    if (announcedUpdates.current.has(key)) return
    announcedUpdates.current.add(key)
    toast(t('header.studioUpdate', { version: studioFrozen.latest }), 'info')
    studioFrozen.dismiss()
  }, [studioFrozen, t, toast])

  // Auto-close modal when Helper connects
  useEffect(() => {
    if (isConnected) setHelperModalOpen(false)
  }, [isConnected])

  const handleRetry = useCallback(() => {
    // Send a ping to trigger an immediate reconnect attempt via the provider's
    // reconnect loop — also refreshes the device list if already connected.
    send({ type: 'ping', payload: {} })
  }, [send])

  return (
    <div className="app">
      {headerCollapsed ? (
        <div className="app-header-collapsed">
          <button type="button" className="header-collapse-toggle" onClick={() => setHeaderCollapsed(false)} aria-label={t('header.expand')} title={t('header.expand')}>
            ▾ Hapbeat Studio · {tabLabels[activeTab].main}
          </button>
        </div>
      ) : (
      <header className="app-header">
        <div className="header-title">
          <span className="header-brand"><span className="header-brand-full">Hapbeat </span>Studio</span>
          <VersionSwitcher compact />
        </div>
        <div className="header-toggle header-toggle-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`toggle-btn tab-btn-stacked ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className="tab-btn-main">{tabLabels[tab].main}</span>
              {tab === 'editor' && <span className="tab-beta-badge" aria-label={t('editor.beta')}>BETA</span>}
              <span className="tab-btn-sub">{tabLabels[tab].sub}</span>
            </button>
          ))}
        </div>
        <div className="header-meta">
          <a
            className="header-docs-link"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            title={t('header.docs.title')}
          >
            {t('common.docs')} <ExternalLinkIcon />
          </a>
          <button
            type="button"
            className="language-switcher"
            aria-label={locale === 'ja' ? t('header.language.toEnglish') : t('header.language.toJapanese')}
            title={locale === 'ja' ? 'JA → EN' : 'EN → JA'}
            onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
            </svg>
            {locale.toUpperCase()}
          </button>
          {isConnected ? (
            <button
              type="button"
              className={`connection-status connection-status--icon connection-status--clickable connection-status--with-tip ${helperCompat === 'outdated' ? 'connection-status--outdated' : ''}`}
              onClick={() => setHelperManageOpen(true)}
              aria-label={helperCompat === 'outdated' ? t('header.helper.outdated') : t('header.helper.manage')}
              data-tip={
                helperCompat === 'outdated'
                  ? t('header.helper.tooltip.outdated', { version: helperVersion })
                  : (helperVersion ? t('header.helper.tooltip.connected', { version: helperVersion }) : t('header.helper.tooltip.unknown'))
              }
              >
              <span className={`status-dot ${helperCompat === 'outdated' ? 'outdated' : 'connected'}`} />
              <span className="connection-status-label">{t('common.helper')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="connection-status connection-status--icon connection-status--clickable"
              onClick={() => setHelperModalOpen(true)}
              aria-label={t('header.helper.setup')}
              title={t('header.helper.setup')}
            >
              <span className="status-dot disconnected" />
              <span className="connection-status-label">{t('common.helper')}</span>
            </button>
          )}
          <button type="button" className="header-collapse-toggle" onClick={() => setHeaderCollapsed(true)} aria-label={t('header.collapse')} title={t('header.collapse')}>▴</button>
        </div>
      </header>
      )}
      {/* Outdated-Helper banner: shown when a Helper is connected but its
          version is below MIN_HELPER_VERSION. Dismissible per session, with a
          one-click jump into HelperManageModal where the upgrade commands
          live. Render BELOW the header so it doesn't push the tab bar around
          but ABOVE the modals so it isn't visually trapped behind them. */}
      {isConnected && helperCompat === 'outdated' && !helperOutdatedDismissed && (
        <div className="helper-outdated-banner" role="alert">
          <span className="helper-outdated-banner-icon" aria-hidden>⚠</span>
          <div className="helper-outdated-banner-body">
            <strong>{t('header.outdated.title')}</strong>
            <span className="helper-outdated-banner-detail">
              {' '}
              {t('header.outdated.detail', { current: helperVersion ?? '?', minimum: MIN_HELPER_VERSION })}
            </span>
          </div>
          <button
            type="button"
            className="helper-outdated-banner-action"
            onClick={() => setHelperManageOpen(true)}
          >
            {t('header.showUpdate')}
          </button>
          <button
            type="button"
            className="helper-outdated-banner-close"
            aria-label={t('header.outdated.hideSession')}
            title={t('header.outdated.hideSession')}
            onClick={() => setHelperOutdatedDismissed(true)}
          >×</button>
        </div>
      )}
      <HelperOnboardingModal
        open={helperModalOpen}
        onClose={() => setHelperModalOpen(false)}
        onRetry={handleRetry}
      />
      <HelperManageModal
        open={helperManageOpen}
        onClose={() => setHelperManageOpen(false)}
        helperVersion={helperVersion}
        helperCompat={helperCompat}
      />
      <main className={`tab-content ${activeTab === 'editor' ? 'tab-content-editor' : ''}`}>
        <PersistentTab active={activeTab === 'editor'} visited={visitedTabs.has('editor')}>
          <WaveformEditor active={activeTab === 'editor'} />
        </PersistentTab>
        <PersistentTab active={activeTab === 'kit'} visited={visitedTabs.has('kit')}>
          <KitManager />
        </PersistentTab>
        <PersistentTab active={activeTab === 'display'} visited={visitedTabs.has('display')}>
          <DisplayEditor />
        </PersistentTab>
        <PersistentTab active={activeTab === 'devices'} visited={visitedTabs.has('devices')}>
          <Devices />
        </PersistentTab>
      </main>
      <LogDrawer />
      <HelperFailureToastListener />
    </div>
  )
}
