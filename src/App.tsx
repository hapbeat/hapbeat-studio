import { useState, useEffect } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { KitManager } from '@/components/kit/KitManager'
import { Devices } from '@/components/devices/Devices'
import { TestPanel } from '@/components/test/TestPanel'
import { FirmwarePanel } from '@/components/firmware/FirmwarePanel'
import { LogDrawer } from '@/components/log/LogDrawer'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import './App.css'

type Tab = 'waveform' | 'kit' | 'display' | 'devices' | 'test' | 'firmware'

const TABS: Tab[] = ['waveform', 'kit', 'display', 'devices', 'test', 'firmware']

const TAB_LABELS: Record<Tab, string> = {
  waveform: 'Wave Editor',
  kit: 'Kit',
  display: 'Display',
  devices: 'Devices',
  test: 'Test',
  firmware: 'Firmware',
}

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('hapbeat-studio-tab')
    return (TABS as string[]).includes(saved ?? '') ? (saved as Tab) : 'waveform'
  })

  useEffect(() => {
    localStorage.setItem('hapbeat-studio-tab', activeTab)
  }, [activeTab])
  const { isConnected } = useHelperConnection()

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
        <div className="connection-status">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          {isConnected
            ? 'Helper 接続中'
            : 'Helper 未接続 — `hapbeat-helper start --foreground` で起動してください'}
        </div>
      </header>
      <main className="tab-content">
        {activeTab === 'waveform' && <WaveformEditor />}
        {activeTab === 'kit' && <KitManager />}
        {activeTab === 'display' && <DisplayEditor />}
        {activeTab === 'devices' && <Devices />}
        {activeTab === 'test' && <TestPanel />}
        {activeTab === 'firmware' && <FirmwarePanel />}
      </main>
      <LogDrawer />
    </div>
  )
}
