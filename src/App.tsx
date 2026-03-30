import { useState } from 'react'
import { WaveformEditor } from '@/components/waveform/WaveformEditor'
import { DisplayEditor } from '@/components/display/DisplayEditor'
import { KitManager } from '@/components/kit/KitManager'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import './App.css'

type Tab = 'waveform' | 'kit' | 'display'

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('waveform')
  const { isConnected } = useManagerConnection()

  return (
    <div className="app">
      <header className="app-header">
        <h1>Hapbeat Studio</h1>
        <div className="header-toggle">
          <button
            className={`toggle-btn ${activeTab === 'waveform' ? 'active' : ''}`}
            onClick={() => setActiveTab('waveform')}
          >
            Wave Editor
          </button>
          <button
            className={`toggle-btn ${activeTab === 'kit' ? 'active' : ''}`}
            onClick={() => setActiveTab('kit')}
          >
            Kit
          </button>
          <button
            className={`toggle-btn ${activeTab === 'display' ? 'active' : ''}`}
            onClick={() => setActiveTab('display')}
          >
            Display
          </button>
        </div>
        <div className="connection-status">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          {isConnected ? 'Manager 接続中' : 'Manager 未接続'}
        </div>
      </header>
      <main className="tab-content">
        {activeTab === 'waveform' && <WaveformEditor />}
        {activeTab === 'kit' && <KitManager />}
        {activeTab === 'display' && <DisplayEditor />}
      </main>
    </div>
  )
}
