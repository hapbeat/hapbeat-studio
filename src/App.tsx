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
import { HelperToastBridge } from '@/components/common/HelperToastBridge'
import { useHelperConnection } from '@/hooks/useHelperConnection'
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

const DOCS_URL = 'https://devtools.hapbeat.com/docs/studio/getting-started/'

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
  const { isConnected, helperVersion, send } = useHelperConnection()
  const [helperModalOpen, setHelperModalOpen] = useState(false)

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
        <h1>Hapbeat Studio</h1>
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
            Docs ↗
          </a>
          {isConnected ? (
            <div
              className="connection-status connection-status--with-tip"
              data-tip={helperVersion ? `hapbeat-helper v${helperVersion}` : 'helper version 不明 (古い helper)'}
            >
              <span className="status-dot connected" />
              Helper 接続中
            </div>
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
      <HelperOnboardingModal
        open={helperModalOpen}
        onClose={() => setHelperModalOpen(false)}
        onRetry={handleRetry}
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
