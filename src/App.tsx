import { useState, useEffect, useCallback, type ReactNode } from 'react'
// Wave Editor は WIP のため初回公開では非表示にする (2026-05-07)。
// 再有効化する時は Tab union / TABS / TAB_LABELS / PersistentTab block / import を
// 一括で復活させるだけで OK。コンポーネント本体 (components/waveform/) は
// 削除せず保持してある。
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { KitManager } from '@/components/kit/KitManager'
import { Devices } from '@/components/devices/Devices'
import { LogDrawer } from '@/components/log/LogDrawer'
import { HelperOnboardingModal } from '@/components/common/HelperOnboardingModal'
import { HelperManageModal } from '@/components/common/HelperManageModal'
import { ExternalLinkIcon } from '@/components/common/ExternalLinkIcon'
import { HelperToastBridge } from '@/components/common/HelperToastBridge'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { MIN_HELPER_VERSION } from '@/config/helperCompat'
import './App.css'

type Tab = 'kit' | 'display' | 'devices'

const TABS: Tab[] = ['kit', 'display', 'devices']

const TAB_LABELS: Record<Tab, { main: string; sub: string }> = {
  // 上部タブは「主タイトル + サブタイトル」の 2 行構成。
  //
  // 'devices' → 'Manage' へリネーム (2026-05-08)。Wi-Fi 設定 / ファーム
  // 書込み / 各種テストなど「複数台のデバイスを統合管理する」位置付けが
  // 実態に近いため。Hardware は物理寄り、Setup は初期設定寄りで却下、
  // Console / Admin は技術色が強すぎるため不採用。
  //
  // サブタイトルは英語で統一 (2026-05-08 改訂)。
  // - Kit  / Vibration Clips: クリップという呼称が UI 全体で使われており直観的
  // - UI   / Display etc.   : OLED 配置以外にも LED / ボタン / 輝度 / Hold 時間
  //                            などを含むため "etc." で包括性を示す
  // - Manage / Config       : Wi-Fi / ファーム / 各種設定。dev tool らしく短く
  kit:     { main: 'Kit',    sub: 'Vibration Clips' },
  display: { main: 'UI',     sub: 'Display etc.' },
  devices: { main: 'Manage', sub: 'Config' },
}

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
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('hapbeat-studio-tab')
    // 旧 'waveform' タブの localStorage 値が残っていても安全に
    // DEFAULT_TAB へフォールバックさせる (TABS に含まれない値は無視)。
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

  useEffect(() => {
    localStorage.setItem('hapbeat-studio-tab', activeTab)
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])
  const { isConnected, helperVersion, helperCompat, send } = useHelperConnection()
  const [helperModalOpen, setHelperModalOpen] = useState(false)
  const [helperManageOpen, setHelperManageOpen] = useState(false)
  // Top-of-app banner suppressing — opt-in per session only. We deliberately
  // do NOT persist this to localStorage: an outdated Helper is a fix-it-now
  // problem that should remind the user every fresh Studio load.
  const [helperOutdatedDismissed, setHelperOutdatedDismissed] = useState(false)

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
      <header className="app-header">
        <h1>
          Hapbeat Studio
          <span className="app-version-badge" title="Studio バージョン (Manage で旧版に切替可)">
            v{import.meta.env.VITE_APP_VERSION}
          </span>
        </h1>
        <div className="header-toggle header-toggle-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`toggle-btn tab-btn-stacked ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className="tab-btn-main">{TAB_LABELS[tab].main}</span>
              <span className="tab-btn-sub">{TAB_LABELS[tab].sub}</span>
            </button>
          ))}
        </div>
        <div className="header-meta">
          <a
            className="header-docs-link"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            title="Hapbeat Studio docs を新しいタブで開く"
          >
            Docs <ExternalLinkIcon />
          </a>
          {isConnected ? (
            <button
              type="button"
              className={`connection-status connection-status--clickable connection-status--with-tip ${helperCompat === 'outdated' ? 'connection-status--outdated' : ''}`}
              onClick={() => setHelperManageOpen(true)}
              data-tip={
                helperCompat === 'outdated'
                  ? `hapbeat-helper v${helperVersion} は古い版です — クリックして upgrade 手順を表示`
                  : (helperVersion ? `hapbeat-helper v${helperVersion} (クリックで管理)` : 'helper version 不明 (クリックで管理)')
              }
            >
              <span className={`status-dot ${helperCompat === 'outdated' ? 'outdated' : 'connected'}`} />
              {helperCompat === 'outdated' ? 'Helper 要更新' : 'Helper 接続中'}
            </button>
          ) : (
            <button
              type="button"
              className="connection-status connection-status--clickable"
              onClick={() => setHelperModalOpen(true)}
              title="クリックでセットアップ方法を表示"
            >
              <span className="status-dot disconnected" />
              Helper 未接続
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
            <strong>hapbeat-helper の更新が必要です</strong>
            <span className="helper-outdated-banner-detail">
              {' '}
              現在 v{helperVersion ?? '?'} / 必要 v{MIN_HELPER_VERSION} 以上 — 一部の Kit deploy / device 操作が失敗する可能性があります。
            </span>
          </div>
          <button
            type="button"
            className="helper-outdated-banner-action"
            onClick={() => setHelperManageOpen(true)}
          >
            更新手順を表示
          </button>
          <button
            type="button"
            className="helper-outdated-banner-close"
            aria-label="このセッション中は非表示"
            title="このセッション中は非表示"
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
      <main className="tab-content">
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
      <HelperToastBridge />
    </div>
  )
}
