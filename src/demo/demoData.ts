/**
 * Fixed, anonymized, deterministic demo data for `?demo=1` screenshot mode.
 *
 * Every value here is a literal (no `Date.now()` / `Math.random()`) so
 * repeated screenshot runs produce byte-identical output. Names / IPs /
 * SSIDs are all placeholders (`*-Demo`, `192.168.10.x`, `Studio-Demo-WiFi`)
 * — nothing here is real network or customer data.
 *
 * This module is only ever reached via the guarded dynamic `import()` in
 * `src/main.tsx` (and the sibling dynamic import in
 * `useHelperConnection.tsx`), so none of it ships in the production bundle.
 */
import type { LibraryClip, KitDefinition, KitEvent } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import type { WifiProfile } from '@/stores/deviceStore'

/** Firmware version reported by both demo devices. Kept >= the
 *  `KIT_LIST_PARAMS_MIN_FW` ('0.1.3') gate in InstalledKitsSection so the
 *  Kit sub-tab's per-event amp% renders instead of the "amp ?" / old-firmware
 *  banner, and >= MIN_HELPER_VERSION so the header pill reads "Helper 接続中"
 *  (not "Helper 要更新"). */
export const DEMO_FW_VERSION = '0.1.4'

const DEMO_CREATED_AT = '2026-06-01T09:00:00.000Z'
const DEMO_UPDATED_AT = '2026-06-15T09:00:00.000Z'

// ---------------------------------------------------------------------------
// Kit tab: Library clips + one Kit with FIRE / CLIP / BOTH events
// ---------------------------------------------------------------------------

/** Library clips shown in the Clips panel (left side of the Kit tab). Audio
 *  is intentionally NOT backed by a real file — `sourceFilename` points at a
 *  path that doesn't exist on disk. Nothing in demo mode calls
 *  `getClipAudio` during render (only on explicit Play clicks), and that
 *  path already degrades gracefully (toast "audio data が見つかりません")
 *  when the blob lookup misses — see KitManager.tsx `toggle()`. */
export const DEMO_CLIPS: LibraryClip[] = [
  {
    id: 'demo-clip-impact-hit',
    name: 'impact_hit',
    tags: ['impact', 'demo'],
    group: 'impact',
    duration: 0.62,
    channels: 1,
    sampleRate: 16000,
    fileSize: 19840,
    sourceFilename: 'impact/impact_hit.wav',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    libraryIntensity: 0.8,
    note: 'Demo clip — no audio backing file.',
  },
  {
    id: 'demo-clip-footstep',
    name: 'footstep_soft',
    tags: ['footstep', 'demo'],
    group: 'movement',
    duration: 0.18,
    channels: 1,
    sampleRate: 16000,
    fileSize: 5760,
    sourceFilename: 'movement/footstep_soft.wav',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    libraryIntensity: 0.45,
  },
  {
    id: 'demo-clip-heartbeat',
    name: 'heartbeat_loop',
    tags: ['ambient', 'demo'],
    group: 'ambient',
    duration: 4.0,
    channels: 1,
    sampleRate: 16000,
    fileSize: 128000,
    sourceFilename: 'ambient/heartbeat_loop.wav',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    libraryIntensity: 0.6,
  },
  {
    id: 'demo-clip-explosion',
    name: 'explosion_big',
    tags: ['impact', 'demo'],
    group: 'impact',
    duration: 1.35,
    channels: 1,
    sampleRate: 16000,
    fileSize: 43200,
    sourceFilename: 'impact/explosion_big.wav',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    libraryIntensity: 1.0,
  },
  {
    id: 'demo-clip-notify',
    name: 'notify_short',
    tags: ['ui', 'demo'],
    group: 'ui',
    duration: 0.12,
    channels: 1,
    sampleRate: 16000,
    fileSize: 3840,
    sourceFilename: 'ui/notify_short.wav',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    libraryIntensity: 0.5,
  },
]

/** Kit events — deliberately mixes FIRE-only (`command`), CLIP-only
 *  (`stream_clip`) and BOTH (`command` + `stream_clip`) so all three
 *  mode pill states are visible in one screenshot. `clip*` fields are
 *  snapshots copied from the matching DEMO_CLIPS entry at "add" time,
 *  matching how `addEventToKit` normally populates them. */
const demoEvent = (
  id: string,
  clip: LibraryClip,
  modes: KitEvent['modes'],
  intensity: number,
  deviceWiper: number | null,
): KitEvent => ({
  id,
  eventId: `demo-kit.${clip.name}`,
  clipName: clip.name,
  clipSourceFilename: clip.sourceFilename,
  clipDuration: clip.duration,
  clipChannels: clip.channels,
  clipSampleRate: clip.sampleRate,
  clipFileSize: clip.fileSize,
  modes,
  loop: false,
  intensity,
  deviceWiper,
})

export const DEMO_KIT_ID = 'demo-kit'

export const DEMO_KITS: KitDefinition[] = [
  {
    id: DEMO_KIT_ID,
    name: 'demo-kit',
    version: '1.0.0',
    description: 'Screenshot/demo kit — sample events for docs.',
    createdAt: DEMO_CREATED_AT,
    updatedAt: DEMO_UPDATED_AT,
    targetDevice: {
      firmware_version_min: '0.1.0',
      board: 'duo_wl_v3',
      volume_level: 8,
      volume_wiper: 96,
      volume_steps: 16,
    },
    events: [
      // FIRE only — plays from on-device flash (install-clips/).
      demoEvent('demo-ev-impact', DEMO_CLIPS[0], ['command'], 0.8, 96),
      demoEvent('demo-ev-notify', DEMO_CLIPS[4], ['command'], 0.5, 64),
      // CLIP only — SDK-streamed, no on-device flash usage.
      demoEvent('demo-ev-heartbeat', DEMO_CLIPS[2], ['stream_clip'], 0.6, null),
      // BOTH — authored for both playback paths under one eventId.
      demoEvent('demo-ev-explosion', DEMO_CLIPS[3], ['command', 'stream_clip'], 1.0, 120),
    ],
  },
]

// ---------------------------------------------------------------------------
// Manage tab: devices + per-IP deviceStore caches
// ---------------------------------------------------------------------------

export const DEMO_NECKLACE_IP = '192.168.10.101'
export const DEMO_BAND_IP = '192.168.10.102'

export const DEMO_DEVICES: DeviceInfo[] = [
  {
    name: 'Necklace-Demo',
    ipAddress: DEMO_NECKLACE_IP,
    address: 'player_1/pos_chest',
    firmwareVersion: DEMO_FW_VERSION,
    online: true,
    serialConnected: false,
    volumeWiper: 96,
    volumeLevel: 8,
    volumeSteps: 16,
    role: 'receiver',
    transport: 'udp',
    transports: ['udp'],
  },
  {
    name: 'Band-Demo',
    ipAddress: DEMO_BAND_IP,
    address: 'player_1/pos_l_wrist/group_1',
    firmwareVersion: DEMO_FW_VERSION,
    online: true,
    serialConnected: false,
    volumeWiper: 80,
    volumeLevel: 6,
    volumeSteps: 16,
    role: 'receiver',
    transport: 'udp',
    transports: ['udp'],
  },
]

export const DEMO_WIFI_SSID = 'Studio-Demo-WiFi'

/** Per-IP `get_info` cache (deviceStore.infoCache). */
export const DEMO_INFO_CACHE: Record<string, {
  name: string
  mac: string
  fw: string
  group: number
  wifi_connected: boolean
  board: string
  mode: 'sta'
  oled_brightness: number
}> = {
  [DEMO_NECKLACE_IP]: {
    name: 'Necklace-Demo',
    mac: '3C:00:00:AA:BB:01',
    fw: DEMO_FW_VERSION,
    group: 1,
    wifi_connected: true,
    board: 'duo_wl_v3',
    mode: 'sta',
    oled_brightness: 2,
  },
  [DEMO_BAND_IP]: {
    name: 'Band-Demo',
    mac: '3C:00:00:AA:BB:02',
    fw: DEMO_FW_VERSION,
    group: 1,
    wifi_connected: true,
    board: 'band_wl_v4',
    mode: 'sta',
    oled_brightness: 2,
  },
}

/** Per-IP `get_wifi_status` cache (deviceStore.wifiStatusCache). */
export const DEMO_WIFI_STATUS_CACHE: Record<string, {
  connected: boolean
  ssid: string
  ip: string
  rssi: number
  channel: number
}> = {
  [DEMO_NECKLACE_IP]: { connected: true, ssid: DEMO_WIFI_SSID, ip: DEMO_NECKLACE_IP, rssi: -52, channel: 6 },
  [DEMO_BAND_IP]: { connected: true, ssid: DEMO_WIFI_SSID, ip: DEMO_BAND_IP, rssi: -58, channel: 6 },
}

const DEMO_WIFI_PROFILES: WifiProfile[] = [
  { index: 0, ssid: DEMO_WIFI_SSID, has_pass: true, active: true },
  { index: 1, ssid: 'Studio-Demo-WiFi-5G', has_pass: true, active: false },
]

/** Per-IP `list_wifi_profiles` cache (deviceStore.wifiProfilesCache). */
export const DEMO_WIFI_PROFILES_CACHE: Record<string, { profiles: WifiProfile[]; count: number; max: number }> = {
  [DEMO_NECKLACE_IP]: { profiles: DEMO_WIFI_PROFILES, count: DEMO_WIFI_PROFILES.length, max: 5 },
  [DEMO_BAND_IP]: { profiles: DEMO_WIFI_PROFILES, count: DEMO_WIFI_PROFILES.length, max: 5 },
}

/** Per-IP `kit_list` cache (deviceStore.kitListCache) — the device's own
 *  report of installed kits, shown in the "Kit" sub-tab. Every event carries
 *  `intensity` so InstalledKitsSection renders real amp% (needs fw >= 0.1.3,
 *  satisfied by DEMO_FW_VERSION above) instead of "amp ?". */
export const DEMO_KIT_LIST_CACHE: Record<string, Array<{
  kit_id: string
  version: string
  events: Array<{ name: string; mode: string; intensity: number }>
}>> = {
  [DEMO_NECKLACE_IP]: [
    {
      kit_id: DEMO_KIT_ID,
      version: '1.0.0',
      events: [
        { name: `${DEMO_KIT_ID}.impact_hit`, mode: 'command', intensity: 0.8 },
        { name: `${DEMO_KIT_ID}.notify_short`, mode: 'command', intensity: 0.5 },
        { name: `${DEMO_KIT_ID}.heartbeat_loop`, mode: 'stream_clip', intensity: 0.6 },
        { name: `${DEMO_KIT_ID}.explosion_big`, mode: 'command', intensity: 1.0 },
        { name: `${DEMO_KIT_ID}.explosion_big`, mode: 'stream_clip', intensity: 1.0 },
      ],
    },
  ],
  [DEMO_BAND_IP]: [
    {
      kit_id: DEMO_KIT_ID,
      version: '1.0.0',
      events: [
        { name: `${DEMO_KIT_ID}.impact_hit`, mode: 'command', intensity: 0.8 },
        { name: `${DEMO_KIT_ID}.notify_short`, mode: 'command', intensity: 0.5 },
      ],
    },
  ],
}
