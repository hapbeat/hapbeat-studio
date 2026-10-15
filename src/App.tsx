import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { EditorFolderConfirm } from '@/components/waveform/EditorFolderConfirm'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { SceneView } from '@/components/scene/SceneView'
import { OPEN_TAB_EVENT } from '@/stores/eventStore'
import { KitManager } from '@/components/kit/KitManager'
import { Devices } from '@/components/devices/Devices'
import { LogDrawer } from '@/components/log/LogDrawer'
import { HelperOnboardingModal } from '@/components/common/HelperOnboardingModal'
import { HelperManageModal } from '@/components/common/HelperManageModal'
import { DesktopAppModal, formatSavedAt, useDesktopHelperStatus, useDesktopStudioStatus } from '@/components/common/DesktopAppModal'
import { ExternalLinkIcon } from '@/components/common/ExternalLinkIcon'
import { useToast } from '@/components/common/Toast'
import { HelperFailureToastListener } from '@/components/common/HelperFailureToastListener'
import { VersionSwitcher } from '@/components/common/VersionSwitcher'
import { WorkFolderPrompt } from '@/components/common/WorkFolderPrompt'
import { useLibraryStore } from '@/stores/libraryStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceSelectionSync } from '@/hooks/useDeviceSelectionSync'
import { useHelperUpdate, useStudioFrozenNotice } from '@/hooks/useReleaseNotices'
import { MIN_HELPER_VERSION } from '@/config/helperCompat'
import { IS_DESKTOP_SHELL, useSimpleUi, visibleTabs } from '@/config/desktopShell'
import { useI18n } from '@/i18n/I18nProvider'
import './App.css'
import { handlePlaybackShortcut } from '@/utils/playbackShortcut'

type Tab = 'editor' | 'scene' | 'kit' | 'display' | 'devices'

const TABS: Tab[] = ['editor', 'scene', 'kit', 'display', 'devices']

const DEFAULT_TAB: Tab = 'kit'

/** Tabs still in beta (badge on the tab button). */
const BETA_TABS: Tab[] = ['editor', 'scene']

/**
 * Tab shown on load: the URL hash (`#editor`, `#scene`, `#kit`, `#display`, `#devices`; kept in sync, so a
 * reload stays on the tab), then `?tab=<id>` (the haptic authoring launcher), then the last tab used, then Kit.
 * Only tabs the layout shows count (the desktop app's simple layout has Kit / UI / Manage).
 */
function initialTab(tabs: readonly Tab[]): Tab {
  const hash = window.location.hash.replace(/^#/, '')
  if ((tabs as string[]).includes(hash)) return hash as Tab
  let wanted: string | null = null
  try { wanted = new URLSearchParams(window.location.search).get('tab') } catch { /* no URL params */ }
  if (wanted && (tabs as string[]).includes(wanted)) return wanted as Tab
  const saved = localStorage.getItem('hapbeat-studio-tab')
  return (tabs as string[]).includes(saved ?? '') ? (saved as Tab) : DEFAULT_TAB
}

const DOCS_URL = 'https://devtools.hapbeat.com/docs/tools/studio/initial-setup/'

/** Show the tabs anyway if the startup work folder lookup hangs (e.g. IndexedDB blocked by another Studio tab). */
const FOLDER_LOOKUP_TIMEOUT_MS = 1500

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
    scene: { main: t('tabs.scene.main'), sub: t('tabs.scene.sub') },
    kit: { main: t('tabs.kit.main'), sub: t('tabs.kit.sub') },
    display: { main: t('tabs.ui.main'), sub: t('tabs.ui.sub') },
    devices: { main: t('tabs.manage.main'), sub: t('tabs.manage.sub') },
  }
  const simpleUi = useSimpleUi()
  const tabs = useMemo(() => visibleTabs(TABS, simpleUi), [simpleUi])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeTab, setActiveTab] = useState<Tab>(() => initialTab(tabs))

  // The work folder is restored here, not in the Kit tab, so the first-run
  // guide under the header knows the folder state whichever tab opens first.
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const workDirStatus = useLibraryStore((s) => s.workDirStatus)
  const demoMode = useLibraryStore((s) => s.demoMode)
  useEffect(() => { void loadLibrary() }, [loadLibrary])
  const [folderLookupTimedOut, setFolderLookupTimedOut] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setFolderLookupTimedOut(true), FOLDER_LOOKUP_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [])
  // Tabs mount once the lookup is done, so the guide never pops in above them.
  const tabsReady = workDirStatus !== 'checking' || demoMode || folderLookupTimedOut

  // Track which tabs the user has visited at least once. We mount each
  // tab on first visit and keep it mounted after — see PersistentTab.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([initialTab(tabs)]))

  // "Show all features" turned off while on a tab the simple layout hides → back to Kit.
  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab(DEFAULT_TAB)
  }, [tabs, activeTab])

  // The app header can be folded away to give tabs (notably the editor) more height.
  // A slim bar with the expand button stays visible while folded.
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    try { return localStorage.getItem('hapbeat-studio-header-collapsed') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('hapbeat-studio-header-collapsed', headerCollapsed ? '1' : '0') } catch { /* preference only */ }
  }, [headerCollapsed])

  // The URL names the tab (#editor, #scene …): a reload comes back to it. `?tab=` is turned into the hash.
  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('tab')
    url.hash = activeTab
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url)
  }, [activeTab])
  useEffect(() => {
    const onHash = () => { const hash = window.location.hash.replace(/^#/, ''); if ((tabsRef.current as string[]).includes(hash)) setActiveTab(hash as Tab) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
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
  // Device selection follows the user across tabs (Editor / Scene / Kit share
  // the Kit target selection).
  useDeviceSelectionSync(activeTab === 'devices' ? 'manage' : activeTab === 'display' ? 'display' : 'kit')
  // Cross-tab jumps (Scene tab "open in editor").
  useEffect(() => {
    const open = (event: Event) => { const tab = (event as CustomEvent<string>).detail; if ((tabsRef.current as string[]).includes(tab)) setActiveTab(tab as Tab) }
    window.addEventListener(OPEN_TAB_EVENT, open)
    return () => window.removeEventListener(OPEN_TAB_EVENT, open)
  }, [])
  const { isConnected, helperVersion, helperCompat, send } = useHelperConnection()
  const { toast } = useToast()
  const [helperModalOpen, setHelperModalOpen] = useState(false)
  const [helperManageOpen, setHelperManageOpen] = useState(false)
  // Desktop app: one panel (bundled helper, app updates, layout) replaces the pipx
  // setup / management modals. It also opens by itself if the bundled helper cannot run.
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(false)
  const openDesktopPanel = useCallback(() => setDesktopPanelOpen(true), [])
  const desktopHelper = useDesktopHelperStatus(IS_DESKTOP_SHELL ? openDesktopPanel : undefined)
  const openHelperSetup = IS_DESKTOP_SHELL ? openDesktopPanel : () => setHelperModalOpen(true)
  const openHelperManage = IS_DESKTOP_SHELL ? openDesktopPanel : () => setHelperManageOpen(true)
  // App users never install a Helper, so the header names what it shows: the link to the devices.
  const helperLabel = IS_DESKTOP_SHELL ? t('desktop.header.label') : t('common.helper')
  // Offline, the app shows its saved copy of Studio: say so once.
  const studioStatus = useDesktopStudioStatus()
  const offlineAnnounced = useRef(false)
  useEffect(() => {
    if (studioStatus?.mode !== 'offline' || offlineAnnounced.current) return
    offlineAnnounced.current = true
    toast(t('desktop.offline.toast', { date: formatSavedAt(studioStatus.copy?.savedAt, locale) }), 'info')
  }, [studioStatus, t, toast, locale])
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
  // (Not in the desktop app: its helper is built in and updates with the app.)
  useEffect(() => {
    const version = helperUpdate.product?.latest
    if (IS_DESKTOP_SHELL) return
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
      {/* Folded, the header keeps its layout (hidden) in a slim bar, so the open / close toggle stays at the same place: the left end of the tab row. */}
      <header className={`app-header ${headerCollapsed ? 'app-header-folded' : ''}`}>
        <div className="header-title">
          <span className="header-brand"><span className="header-brand-full">Hapbeat </span>Studio</span>
          {!IS_DESKTOP_SHELL && <VersionSwitcher compact />}
        </div>
        <div className="header-tabs-box">
          <button type="button" className="header-collapse-toggle" onClick={() => setHeaderCollapsed(!headerCollapsed)}
            aria-label={t(headerCollapsed ? 'header.expand' : 'header.collapse')} title={t(headerCollapsed ? 'header.expand' : 'header.collapse')}>{headerCollapsed ? '▾' : '▴'}</button>
          {headerCollapsed && <span className="header-collapsed-label">Hapbeat Studio · {tabLabels[activeTab].main}</span>}
        <div className="header-toggle header-toggle-tabs" aria-hidden={headerCollapsed || undefined}>
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`toggle-btn tab-btn-stacked ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className="tab-btn-main">{tabLabels[tab].main}</span>
              {BETA_TABS.includes(tab) && <span className="tab-beta-badge" aria-label={t('editor.beta')}>BETA</span>}
              <span className="tab-btn-sub">{tabLabels[tab].sub}</span>
            </button>
          ))}
        </div>
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
              onClick={openHelperManage}
              aria-label={helperCompat === 'outdated' ? t('header.helper.outdated') : t('header.helper.manage')}
              data-tip={
                helperCompat === 'outdated'
                  ? t('header.helper.tooltip.outdated', { version: helperVersion })
                  : (helperVersion ? t('header.helper.tooltip.connected', { version: helperVersion }) : t('header.helper.tooltip.unknown'))
              }
              >
              <span className={`status-dot ${helperCompat === 'outdated' ? 'outdated' : 'connected'}`} />
              <span className="connection-status-label">{helperLabel}</span>
            </button>
          ) : (
            <button
              type="button"
              className="connection-status connection-status--icon connection-status--clickable"
              onClick={openHelperSetup}
              aria-label={IS_DESKTOP_SHELL ? t('desktop.header.tooltip') : t('header.helper.setup')}
              title={IS_DESKTOP_SHELL ? t('desktop.header.tooltip') : t('header.helper.setup')}
            >
              <span className="status-dot disconnected" />
              <span className="connection-status-label">{helperLabel}</span>
            </button>
          )}
        </div>
      </header>
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
            onClick={openHelperManage}
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
      <WorkFolderPrompt variant="banner" onConnected={() => setActiveTab('kit')} />
      {IS_DESKTOP_SHELL ? (
        <DesktopAppModal
          open={desktopPanelOpen}
          onClose={() => setDesktopPanelOpen(false)}
          helperStatus={desktopHelper}
          helperCompat={helperCompat}
        />
      ) : (
        <>
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
        </>
      )}
      <main className={`tab-content ${activeTab === 'editor' || activeTab === 'scene' ? 'tab-content-editor' : ''}`}>
        {tabsReady && <>
        <PersistentTab active={activeTab === 'editor'} visited={visitedTabs.has('editor')}>
          <WaveformEditor active={activeTab === 'editor'} />
        </PersistentTab>
        <PersistentTab active={activeTab === 'scene'} visited={visitedTabs.has('scene')}>
          <SceneView active={activeTab === 'scene'} />
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
        </>}
      </main>
      <LogDrawer />
      <HelperFailureToastListener />
      <EditorFolderConfirm />
    </div>
  )
}
