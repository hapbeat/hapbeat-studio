import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ToastProvider } from '@/components/common/Toast'
import { HelperConnectionProvider } from '@/hooks/useHelperConnection'
import { isDemoMode } from '@/demo/isDemoMode'

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HelperConnectionProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </HelperConnectionProvider>
    </React.StrictMode>,
  )
}

// Demo/screenshot mode (`?demo=1`): seed fully-populated, anonymized,
// deterministic store state (Kit library/kits + Manage-tab device caches)
// BEFORE the first render, so KitManager/DeviceDetail mount already
// showing seeded data instead of their normal empty states. Guarded by a
// dynamic `import()` so `src/demo/*` (seed data + logic) is code-split out
// of the production bundle and only fetched when the flag is present.
// `useHelperConnection.tsx` does its own separate guarded dynamic import
// for the fake Helper-connection/device-list state (see comment there).
// Completely inert otherwise — zero impact on normal app startup.
if (isDemoMode()) {
  void import('@/demo/seedDemo').then(({ seedDemo }) => {
    seedDemo()
    renderApp()
  })
} else {
  renderApp()
}
