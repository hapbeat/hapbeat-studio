import { useState } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { DeviceLayoutDesigner } from '@/components/display/DeviceLayoutDesigner'
import { LedEditor } from '@/components/led/LedEditor'
import { PackBuilder } from '@/components/pack/PackBuilder'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import './App.css'

type Tab = 'waveform' | 'display' | 'layout_designer' | 'led' | 'pack'

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('waveform')
  const { isConnected } = useManagerConnection()

  const tabs: { key: Tab; label: string }[] = [
    { key: 'waveform', label: '波形エディタ' },
    { key: 'display', label: 'ディスプレイ' },
    { key: 'layout_designer', label: 'レイアウト調整' },
    { key: 'led', label: 'LED' },
    { key: 'pack', label: 'Pack' },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <h1>Hapbeat Studio</h1>
        <div className="connection-status">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          {isConnected ? 'Manager 接続中' : 'Manager 未接続'}
        </div>
      </header>
      <nav className="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <main className="tab-content">
        {activeTab === 'waveform' && <WaveformEditor />}
        {activeTab === 'display' && <DisplayEditor />}
        {activeTab === 'layout_designer' && <DeviceLayoutDesigner />}
        {activeTab === 'led' && <LedEditor />}
        {activeTab === 'pack' && <PackBuilder />}
      </main>
    </div>
  )
}
