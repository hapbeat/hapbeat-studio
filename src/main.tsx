import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ToastProvider } from '@/components/common/Toast'
import { HelperConnectionProvider } from '@/hooks/useHelperConnection'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelperConnectionProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </HelperConnectionProvider>
  </React.StrictMode>,
)
