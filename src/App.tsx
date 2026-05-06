import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { KitManager } from '@/components/kit/KitManager'
import { Devices } from '@/components/devices/Devices'
import { LogDrawer } from '@/components/log/LogDrawer'
import { HelperOnboardingModal } from '@/components/common/HelperOnboardingModal'
import { HelperToastBridge } from '@/components/common/HelperToastBridge'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import './App.css'

type Tab = 'waveform' | 'kit' | 'display' | 'devices'

const TABS: Tab[] = ['waveform', 'kit', 'display', 'devices']

const TAB_LABELS: Record<Tab, string> = {
  waveform: 'Wave Editor',
  kit: 'Kit',
  display: 'Display',
  devices: 'Devices',
}

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
    return (TABS as string[]).includes(saved ?? '') ? (saved as Tab) : 'waveform'
  })

  // Track which tabs the user has visited at least once. We mount each
  // tab on first visit and keep it mounted after — see PersistentTab.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set([
    (() => {
      const saved = localStorage.getItem('hapbeat-studio-tab')
      return (TABS as string[]).includes(saved ?? '') ? (saved as Tab) : 'waveform'
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
  const { isConnected, send } = useHelperConnection()
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
        <div className="header-toggle">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`toggle-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        {isConnected ? (
          <div className="connection-status">
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
      </header>
      <HelperOnboardingModal
        open={helperModalOpen}
        onClose={() => setHelperModalOpen(false)}
        onRetry={handleRetry}
      />
      <main className="tab-content">
        <PersistentTab active={activeTab === 'waveform'} visited={visitedTabs.has('waveform')}>
          <WaveformEditor />
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
      <HelperToastBridge />
    </div>
  )
}
