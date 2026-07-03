/**
 * Demo/screenshot mode seed logic (`?demo=1`).
 *
 * Wiring: `src/main.tsx` checks `isDemoMode()` once at startup and, only
 * when true, `import('@/demo/seedDemo')`s this module before the first
 * render. That dynamic import is what code-splits this file (and its
 * `demoData.ts` sibling) out of the normal production bundle — nothing
 * here is ever fetched unless the flag is present.
 * `useHelperConnection.tsx` performs its own parallel guarded dynamic
 * import of the small `DEMO_DEVICES` / `DEMO_FW_VERSION` payload so the
 * "Helper 接続中" connection state + device list can be faked without a
 * real WebSocket — see the comment there for why that's a separate,
 * narrower import instead of a callback threaded through this module.
 *
 * What gets seeded:
 *   - Kit tab:     `libraryStore.clips` / `kits` / `activeKitId` (+ demoMode
 *                  flag so the "pick a folder" empty-state gate is bypassed)
 *   - Manage tab:  `deviceStore` per-IP caches (infoCache incl. AP status +
 *                  OLED brightness, wifiStatusCache, wifiProfilesCache,
 *                  kitListCache) + the sidebar selection so DevicePill /
 *                  WorkDirBar also show a selected device
 *   - UI tab:      untouched — it already renders standalone with no
 *                  connection/folder dependency.
 *
 * Design choice — why a `libraryStore.demoMode` flag instead of a stub
 * `FileSystemDirectoryHandle`:
 *   A fake/sentinel directory handle would have to satisfy the real
 *   `FileSystemDirectoryHandle` interface (getDirectoryHandle /
 *   getFileHandle / etc.) everywhere `workDirHandle` is read — including
 *   inside `flushKitFolderNow`'s write path, `getClipAudio`/
 *   `getKitEventAudio`'s disk-read fallback, and every `importXxx`
 *   scanner. Any incomplete stub risks a thrown `TypeError` the first
 *   time an autosave effect fires (kit create/edit already schedules one).
 *   A plain boolean flag is much narrower: every disk-write call site in
 *   `libraryStore.ts` already reads `if (workDirHandle) await ...`, so
 *   leaving `workDirHandle` as real `null` means those all silently no-op
 *   with zero risk of a stub throwing partway through a write. The flag's
 *   only job is (a) let the Kit tab's render gate pass and (b) make
 *   `loadLibrary()` skip the disk-restore path that would otherwise wipe
 *   the clips/kits this module just seeded.
 *
 * Determinism: no `Date.now()` / `Math.random()` anywhere in this module
 * or `demoData.ts` — every id/timestamp/IP/SSID is a fixed literal so
 * repeated screenshot runs are byte-identical.
 */
import { useLibraryStore } from '@/stores/libraryStore'
import { useDeviceStore } from '@/stores/deviceStore'
import {
  DEMO_CLIPS,
  DEMO_KITS,
  DEMO_KIT_ID,
  DEMO_NECKLACE_IP,
  DEMO_BAND_IP,
  DEMO_INFO_CACHE,
  DEMO_WIFI_STATUS_CACHE,
  DEMO_WIFI_PROFILES_CACHE,
  DEMO_KIT_LIST_CACHE,
} from '@/demo/demoData'

/** Seed the Kit tab: Library clips + one Kit with FIRE/CLIP/BOTH events. */
function seedLibraryStore(): void {
  useLibraryStore.setState({
    demoMode: true,
    clips: DEMO_CLIPS,
    kits: DEMO_KITS,
    activeKitId: DEMO_KIT_ID,
    // No workDirHandle/kitDirHandle is ever created — every disk-write
    // call site in libraryStore.ts is already conditional on a truthy
    // handle, so leaving these `null` makes writes no-ops (see module
    // comment above) instead of needing a stub to satisfy the real
    // FileSystemDirectoryHandle interface.
  })
}

/** Seed the Manage tab: per-IP deviceStore caches + sidebar selection.
 *  The device LIST itself (`DeviceInfo[]`, `isConnected`, `helperVersion`)
 *  is served by `useHelperConnection.tsx`'s own guarded dynamic import —
 *  this only fills the caches that DeviceDetail/WifiProfilesForm/
 *  InstalledKitsSection read once a device is selected. */
function seedDeviceStore(): void {
  const infoCache = { ...DEMO_INFO_CACHE }
  const wifiStatusCache = { ...DEMO_WIFI_STATUS_CACHE }
  const wifiProfilesCache = { ...DEMO_WIFI_PROFILES_CACHE }
  const kitListCache = { ...DEMO_KIT_LIST_CACHE }

  useDeviceStore.setState({
    infoCache,
    wifiStatusCache,
    wifiProfilesCache,
    kitListCache,
    selectedIp: DEMO_NECKLACE_IP,
    selectedIps: [DEMO_NECKLACE_IP, DEMO_BAND_IP],
    dismissedIps: [],
  })
}

/** Entry point called once from `main.tsx` behind the `?demo=1` guard. */
export function seedDemo(): void {
  seedLibraryStore()
  seedDeviceStore()
}
