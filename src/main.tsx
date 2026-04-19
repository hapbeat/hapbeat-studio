import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ToastProvider } from '@/components/common/Toast'
import { ManagerConnectionProvider } from '@/hooks/useManagerConnection'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ManagerConnectionProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ManagerConnectionProvider>
  </React.StrictMode>,
)
