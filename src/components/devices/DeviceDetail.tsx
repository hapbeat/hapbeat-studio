import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore, type WifiProfile } from '@/stores/deviceStore'
import { ApModeSection } from './ApModeSection'
import { useLibraryStore } from '@/stores/libraryStore'
import type { KitDefinition, KitEvent } from '@/types/library'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, EqBandReadout, ManagerMessage, MqttClientEntry, NodeRole, NodeTransport, SensorMapping } from '@/types/manager'
import { IdentityForm } from './IdentityForm'
import { WifiProfilesForm } from './WifiProfilesForm'
import { UiConfigForm } from './UiConfigForm'
import { DebugDumpSection } from './DebugDumpSection'
import { InstalledKitsSection } from './InstalledKitsSection'
import { TestSubTab } from './TestSubTab'
import { FirmwareSubTab } from './FirmwareSubTab'
import { OnboardingWizard } from './OnboardingWizard'
import {
  EspNowConfigSection,
  EspNowDisplayPowerSection,
  EspNowStreamReadout,
  MqttConfigSection,
  BrokerConfigSection,
  SensorMappingSection,
  DuoWlV4AudioSection,
  DuoWlV4EspNowAudioSection,
  DuoWlV4EqSection,
  DuoWlV4DspSection,
  DuoWlV4SettingsBackup,
  SolidTransmitterTuningSection,
  SwHapticEqSection,
} from './NodeConfigSections'
import { useDeviceTransport } from '@/hooks/useDeviceTransport'
import { useSerialMaster } from '@/stores/serialMaster'
import { roleBadge } from '@/utils/roleLabels'

type SubTab =
  | 'wifi' | 'config' | 'kit' | 'test' | 'firmware' | 'espnow'
  | 'mqtt'      // single shared MQTT tab: broker panel OR client settings,
                // + flow chart. Shared id so switching sensor↔broker keeps it.
  | 'mapping'   // sensor live value + mapping editor
  | 'audio'     // DuoWL v4 pure espnow_stream receiver only — gain stage + A-V delay
  | 'eq'        // DuoWL v4 pure espnow_stream receiver only — per-codec EQ designer
  | 'dsp'       // DuoWL v4 pure espnow_stream receiver only — DSP profile + DRC/3D/Beep/AGC

const SUB_TAB_LABEL: Record<SubTab, string> = {
  wifi: 'Wi-Fi',
  config: '設定',
  kit: 'Kit',
  test: '再生テスト',
  firmware: 'ファームウェア',
  espnow: 'ESP-NOW',
  mqtt: 'MQTT',
  mapping: 'センサー',
  audio: '音声',
  eq: 'EQ',
  dsp: 'DSP',
}

/**
 * Which sub-tabs a node shows, by role/transport (DEC-034). A node
 * that doesn't report a role is a `receiver` on `udp` → the classic
 * 5-tab layout, identical to before. `board` only matters for the pure
 * espnow_stream receiver case: a DuoWL v4 unit gets three extra tabs
 * (音声 / EQ / DSP) split off from what used to be crammed into the espnow
 * tab — DSP (aic3204-full-dsp-registers.md) is DRC/3D/Beep/AGC, split from
 * EQ (biquad bands + 1st-order IIR + profile selector) purely for tab width.
 */
function computeSubTabs(
  role: NodeRole,
  transport: NodeTransport,
  transports: NodeTransport[],
  board: string | undefined,
): SubTab[] {
  switch (role) {
    case 'sensor':
      // MQTT (client 設定 + 接続フロー) とセンサー (ライブ値 + マッピング)
      // を専用タブに (user feedback 2026-06-13)。MQTT タブ id は broker と
      // 共有 → sensor↔broker 切替でタブが維持される。
      return ['wifi', 'config', 'mqtt', 'mapping', 'firmware']
    case 'broker':
      // broker も同じ 'mqtt' タブ id (フロー図 + ブローカー設定)。
      return ['wifi', 'config', 'mqtt', 'firmware']
    case 'transmitter':
      return ['espnow', 'firmware']
    case 'receiver':
    default: {
      // Pure ESP-NOW stream receiver: no Wi-Fi STA, no kit/event playback.
      const pureStream =
        transport === 'espnow_stream'
        && !transports.includes('udp')
        && !transports.includes('mqtt')
      if (pureStream) {
        return board === 'duo_wl_v4'
          ? ['espnow', 'audio', 'eq', 'dsp', 'firmware']
          : ['espnow', 'firmware']
      }
      // mqtt receiver gets the MQTT client tab; plain udp doesn't.
      if (transports.includes('mqtt')) {
        return ['wifi', 'config', 'mqtt', 'kit', 'test', 'firmware']
      }
      return ['wifi', 'config', 'kit', 'test', 'firmware']
    }
  }
}

const SUBTAB_KEY = 'hapbeat-studio-devices-subtab'

/**
 * Right-hand pane: per-device tabs, gated by the node's role/transport.
 */
export function DeviceDetail() {
  const { devices, lastMessage, send, injectMessage } = useHelperConnection()
  const pushLog = useLogStore((s) => s.push)
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const setInfo = useDeviceStore((s) => s.setInfo)
  const setApStatus = useDeviceStore((s) => s.setApStatus)
  const setWifiStatus = useDeviceStore((s) => s.setWifiStatus)
  const setWifiProfiles = useDeviceStore((s) => s.setWifiProfiles)
  const setDebugDump = useDeviceStore((s) => s.setDebugDump)
  const setKitList = useDeviceStore((s) => s.setKitList)
  const setSensorMapping = useDeviceStore((s) => s.setSensorMapping)
  const setSensorReading = useDeviceStore((s) => s.setSensorReading)
  const bumpInfoTick = useDeviceStore((s) => s.bumpInfoTick)
  const infoCache = useDeviceStore((s) => s.infoCache)
  const infoTickCache = useDeviceStore((s) => s.infoTick)
  const wifiStatusCache = useDeviceStore((s) => s.wifiStatusCache)
  const wifiProfilesCache = useDeviceStore((s) => s.wifiProfilesCache)
  const debugDumpCache = useDeviceStore((s) => s.debugDumpCache)
  const kitListCache = useDeviceStore((s) => s.kitListCache)
  const sensorMappingCache = useDeviceStore((s) => s.sensorMappingCache)
  const sensorReadingCache = useDeviceStore((s) => s.sensorReadingCache)

  const masterMode = useSerialMaster((s) => s.mode)
  const masterInfo = useSerialMaster((s) => s.info)
  const masterRefreshTick = useSerialMaster((s) => s.refreshTick)
  const masterWifiStatus = useSerialMaster((s) => s.wifiStatus)
  const masterWifiProfiles = useSerialMaster((s) => s.wifiProfiles)
  const masterWifiProfileMax = useSerialMaster((s) => s.wifiProfileMax)

  const device: DeviceInfo | undefined = useMemo(() => {
    if (selectedIp?.startsWith('serial:')) {
      if (masterMode !== 'config' || !masterInfo) return undefined
      return {
        ipAddress: selectedIp,
        name: masterInfo.name ?? '(unnamed)',
        address: 'USB Serial',
        firmwareVersion: masterInfo.fw,
        online: true,
        role: masterInfo.role,
        transport: masterInfo.transport,
        transports: masterInfo.transports,
      } as DeviceInfo
    }
    return devices.find((d) => d.ipAddress === selectedIp)
  }, [devices, selectedIp, masterMode, masterInfo])

  const [subTab, setSubTab] = useState<SubTab>(() => {
    const saved = localStorage.getItem(SUBTAB_KEY)
    return saved && saved in SUB_TAB_LABEL ? (saved as SubTab) : 'wifi'
  })
  useEffect(() => {
    localStorage.setItem(SUBTAB_KEY, subTab)
  }, [subTab])

  // Auto-jump to the Wi-Fi tab ONLY when a device is confirmed to be
  // Wi-Fi-disconnected (so it obviously needs setup), and only once per
  // device. Previously this fired whenever the wifi status was merely
  // *unknown* — which is the case right after every device switch
  // (caches are cleared, get_wifi_status is still in flight) — so the
  // tab reset to Wi-Fi on every switch. Keeping the current tab when the
  // status is unknown lets the user stay on e.g. the MQTT tab while
  // switching between sensor and broker (user feedback 2026-06-13). The
  // activeSubTab fallback below still redirects if the tab isn't valid
  // for the newly-selected device's role.
  const autoJumpedIpRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp) return
    const wifiStatus = selectedIp.startsWith('serial:')
      ? useSerialMaster.getState().wifiStatus
      : wifiStatusCache[selectedIp]
    if (wifiStatus?.connected === false && autoJumpedIpRef.current !== selectedIp) {
      autoJumpedIpRef.current = selectedIp
      // espnow_stream receivers have no Wi-Fi — jump to the espnow tab instead
      // of the Wi-Fi setup tab (which would be irrelevant for them).
      const transport = selectedIp.startsWith('serial:')
        ? useSerialMaster.getState().info?.transport
        : devices.find((d) => d.ipAddress === selectedIp)?.transport
      setSubTab(transport === 'espnow_stream' ? 'espnow' : 'wifi')
    }
  }, [selectedIp, wifiStatusCache, devices])

  const [globalStatus, setGlobalStatus] = useState<{ kind: 'ok' | 'err' | 'warn' | 'muted'; msg: string } | null>(null)

  const clearCachesFor = useDeviceStore((s) => s.clearCachesFor)
  const prevSelectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedIp || selectedIp.startsWith('serial:')) {
      prevSelectedRef.current = selectedIp ?? null
      return
    }
    const prev = prevSelectedRef.current
    if (prev && prev !== selectedIp && !prev.startsWith('serial:')) {
      clearCachesFor(prev)
    }
    prevSelectedRef.current = selectedIp
    if (!device?.online) return
    // Helper opens one TCP connection per command, so each query is a
    // "[TCP] Client connected" line on the device. AP mode + OLED
    // brightness only exist on wearable receivers — skip those 2 for
    // sensor/broker/transmitter so a slow classic-ESP32 node only sees a
    // 3-command burst on selection, not 5 (user report 2026-06-13).
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    if ((device?.role ?? 'receiver') === 'receiver') {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
      send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
    }
  }, [selectedIp, device?.online, device?.role, send, clearCachesFor])

  // Drain helper push messages.
  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>

    if (t === 'get_info_result' && typeof p.device === 'string') {
      setInfo(p.device, {
        name: p.name as string | undefined,
        mac: p.mac as string | undefined,
        fw: p.fw as string | undefined,
        build: p.build as string | undefined,
        group: p.group as number | undefined,
        wifi_connected: p.wifi_connected as boolean | undefined,
        board: p.board as string | undefined,
        // node-roles (DEC-034)
        role: p.role as NodeRole | undefined,
        transport: p.transport as NodeTransport | undefined,
        transports: p.transports as NodeTransport[] | undefined,
        espnow_channel: p.espnow_channel as number | undefined,
        gain: p.gain as number | undefined,
        input_level: p.input_level as number | undefined,
        opus_complexity: p.opus_complexity as number | undefined,
        stream_hp_buffer_ms: p.stream_hp_buffer_ms as number | undefined,
        broker_host: p.broker_host as string | undefined,
        broker_port: p.broker_port as number | undefined,
        topic_root: p.topic_root as string | undefined,
        mqtt_qos: p.mqtt_qos as number | undefined,
        mqtt_connected: p.mqtt_connected as boolean | undefined,
        static_octet: p.static_octet as number | undefined,
        mqtt_port: p.mqtt_port as number | undefined,
        mqtt_running: p.mqtt_running as boolean | undefined,
        mqtt_clients: p.mqtt_clients as MqttClientEntry[] | undefined,
        mqtt_pub_count: p.mqtt_pub_count as number | undefined,
        mqtt_last_topic: p.mqtt_last_topic as string | undefined,
        mqtt_last_payload: p.mqtt_last_payload as string | undefined,
        mappings_count: p.mappings_count as number | undefined,
        sensor_types: p.sensor_types as string[] | undefined,
        alert_loop: p.alert_loop as boolean | undefined,
        alert_limit: p.alert_limit as boolean | undefined,
        ack_hold_ms: p.ack_hold_ms as number | undefined,
        recv_topics: p.recv_topics as string[] | undefined,
        // ESP-NOW display/power + stream stats (espnow_stream receiver)
        espnow_ui: p.espnow_ui as { auto_off_ms?: number; wake_on_button?: boolean; wake_on_volume?: boolean; led_enabled?: boolean; low_batt_pct?: number } | undefined,
        stream: p.stream as { received?: number; lost?: number; recovered?: number; dropped?: number; max_gap?: number; handoffs?: number; sources?: number; locked?: boolean; locked_mac?: string; delay_ms?: number } | undefined,
        // DuoWL v4 audio stage settings (DEC-041, board === "duo_wl_v4" only)
        audio: p.audio as {
          pam_db?: number
          lineout_db?: number
          boost_db?: number
          hp_db?: number
          input_mode?: 'output' | 'line_in'
          stream_buffer_ms?: number
        } | undefined,
        // DuoWL v4 ESP-NOW hp48 audio-DSP config (audio-dsp-config.md §2/§3)
        eq: p.eq as { haptic: EqBandReadout[]; hp: EqBandReadout[] } | undefined,
        // Non-DuoWL-v4 (v3-family) software haptic EQ engine marker — "sw" gates
        // SwHapticEqSection (see NodeConfigSections.tsx). Absent on DuoWL v4.
        eq_engine: p.eq_engine as string | undefined,
        av_delay_ms: p.av_delay_ms as number | undefined,
        // DuoWL v4 full AIC3204 DSP feature set (aic3204-full-dsp-registers.md)
        dsp_profile: p.dsp_profile as {
          haptic: { profile: 'standard' | 'eq6' | 'eq6_drc' | 'full'; bands: number; has_iir: boolean; has_drc: boolean; has_3d: boolean; has_beep: boolean }
          hp: { profile: 'standard' | 'eq6' | 'eq6_drc' | 'full'; bands: number; has_iir: boolean; has_drc: boolean; has_3d: boolean; has_beep: boolean }
        } | undefined,
        eq_iir: p.eq_iir as { haptic: [number, number, number]; hp: [number, number, number] } | undefined,
        drc: p.drc as {
          haptic: { enable_l: boolean; enable_r: boolean; threshold_db: number; hysteresis_db: number; hold: number; attack: number; decay: number; compressing_l: boolean; compressing_r: boolean }
          hp: { enable_l: boolean; enable_r: boolean; threshold_db: number; hysteresis_db: number; hold: number; attack: number; decay: number; compressing_l: boolean; compressing_r: boolean }
        } | undefined,
        effect_3d: p.effect_3d as { haptic: number; hp: number } | undefined,
        agc: p.agc as {
          enable: boolean
          target_level_db: number
          max_gain_db: number
          attack: number
          decay: number
          noise_threshold_db: number
          hysteresis_db: number
          applied_gain_l_db: number
          applied_gain_r_db: number
        } | undefined,
        // SoftAP extension fields (firmware ≥ v0.1.0)
        mode: p.mode as 'sta' | 'ap' | undefined,
        ap_ssid: p.ap_ssid as string | undefined,
        ap_ip: p.ap_ip as string | undefined,
        ap_has_pass: p.ap_has_pass as boolean | undefined,
        ap_client_count: p.ap_client_count as number | undefined,
      })
      // Bump the per-IP get_info counter so device-backed controls reconcile
      // to the echoed value even when it's numerically unchanged (finding 3).
      // Only on get_info (a full snapshot) — NOT on the partial ap_status /
      // oled / volume_changed merges below, so an unrelated push can't
      // prematurely revert an optimistic just-committed value.
      bumpInfoTick(p.device)
    } else if (t === 'ap_status_result' && typeof p.device === 'string') {
      setApStatus(p.device, {
        mode: p.mode as 'sta' | 'ap' | undefined,
        ap_ssid: p.ap_ssid as string | undefined,
        ap_ip: p.ap_ip as string | undefined,
        ap_has_pass: p.ap_has_pass as boolean | undefined,
        ap_client_count: p.ap_client_count as number | undefined,
      })
    } else if (t === 'oled_brightness_result' && typeof p.device === 'string') {
      setInfo(p.device, { oled_brightness: p.level as number | undefined })
    } else if (t === 'wifi_status_result' && typeof p.device === 'string') {
      setWifiStatus(p.device, {
        connected: p.connected as boolean | undefined,
        ssid: p.ssid as string | undefined,
        ip: p.ip as string | undefined,
        rssi: p.rssi as number | undefined,
        channel: p.channel as number | undefined,
      })
    } else if (t === 'wifi_profiles_result' && typeof p.device === 'string') {
      const profiles = (p.profiles as WifiProfile[] | undefined) ?? []
      const cnt = (p.count as number | undefined) ?? profiles.length
      const max = (p.max as number | undefined) ?? 5
      setWifiProfiles(p.device, profiles, cnt, max)
    } else if (t === 'debug_dump_result' && typeof p.device === 'string') {
      setDebugDump(p.device, p as Record<string, unknown>)
    } else if (t === 'sensor_mapping_result' && typeof p.device === 'string') {
      // Accept both top-level `mappings` and serial-style `data.mappings`.
      const maps =
        (p.mappings as SensorMapping[] | undefined)
        ?? ((p.data as { mappings?: SensorMapping[] } | undefined)?.mappings)
        ?? []
      setSensorMapping(p.device, maps)
    } else if (t === 'sensor_reading_result' && typeof p.device === 'string') {
      // Live tuning view: accept `data.{r,g,b,...}` (firmware shape) or
      // top-level fields. Error responses (sensor not ready) are skipped —
      // the UI keeps showing the last good sample with its age.
      const d = (p.data as Record<string, unknown> | undefined) ?? p
      if (typeof d.r === 'number' && typeof d.g === 'number' && typeof d.b === 'number') {
        setSensorReading(p.device, {
          sensor: d.sensor as string | undefined,
          r: d.r as number,
          g: d.g as number,
          b: d.b as number,
          clear: d.clear as number | undefined,
          key: d.key as string | undefined,
          age_ms: d.age_ms as number | undefined,
        })
      }
    } else if (t === 'kit_list_result' && typeof p.device === 'string') {
      const kits = (p.kits as Array<{
        kit_id: string
        version?: string
        events?: Array<string | { name: string; mode?: string }>
      }> | undefined) ?? []
      setKitList(p.device, kits)
    } else if (t === 'volume_changed') {
      // Unsolicited push from a physical volume knob/button (helper relays
      // it straight from the device's PONG/serial event). `hp_db` (DuoWL v4
      // TPA6130A2 headphone volume, SW4/SW5 buttons) is the only field this
      // view cares about — merge it into infoCache.audio.hp_db so the
      // DuoWlV4AudioSection headphone slider follows the physical buttons
      // live. Merges onto the CURRENT audio object (not a bare replace) so
      // the other audio fields (pam_db/lineout_db/...) aren't clobbered.
      // The "don't clobber a dirty edit" rule lives in the consumer
      // (useDeviceBackedValue's adopt-when-not-dirty effect) — writing the
      // cache here is always safe.
      const ip = typeof p.device === 'string' ? p.device : (typeof p.ip === 'string' ? p.ip : null)
      const hpDb = typeof p.hp_db === 'number' ? p.hp_db : undefined
      if (ip && hpDb !== undefined) {
        const prevAudio = useDeviceStore.getState().infoCache[ip]?.audio
        setInfo(ip, { audio: { ...prevAudio, hp_db: hpDb } })
      }
    } else if (t === 'write_result') {
      const ok = p.success === true
      const summary = (p.summary as string)
        || (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      const fullMsg = (p.message as string)
        || (p.error as string)
        || (ok ? 'ok' : 'failed')
      setGlobalStatus({
        kind: ok ? 'ok' : 'err',
        msg: summary.split('\n')[0],
      })
      const tag = ok ? '✓' : '✗'
      for (const line of fullMsg.split('\n')) {
        if (line.trim().length === 0) continue
        pushLog('helper', `${tag} ${line}`)
      }
      const results = p.results as Array<Record<string, unknown>> | undefined
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r.success) continue
          const ip = r.ip as string ?? '?'
          const resp = (r.response as Record<string, unknown>) ?? {}
          const phase = (resp.phase as string) ?? '?'
          const cmd = (resp.cmd as string) ?? (p.cmd as string) ?? '?'
          pushLog('helper', `   ↳ ${ip} cmd=${cmd} phase=${phase} resp=${JSON.stringify(resp)}`)
        }
      }
    }
  }, [
    lastMessage,
    pushLog,
    setInfo,
    setApStatus,
    setWifiStatus,
    setWifiProfiles,
    setDebugDump,
    setKitList,
    setSensorMapping,
    setSensorReading,
    bumpInfoTick,
  ])

  useEffect(() => {
    if (!globalStatus) return
    const t = setTimeout(() => setGlobalStatus(null), 4000)
    return () => clearTimeout(t)
  }, [globalStatus])

  const playEvent = useCallback((eventId: string, fromKitList: number | null = null) => {
    if (!selectedIp) return
    let intensity = 1.0
    let source = 'fallback 1.0'
    if (fromKitList != null) {
      intensity = fromKitList
      source = `device kit_list (amp ${(intensity * 100).toFixed(0)}%)`
    } else {
      const kits = useLibraryStore.getState().kits
      const tryFind = (matchId: string): { ev: KitEvent; k: KitDefinition } | null => {
        for (const k of kits) {
          const ev = k.events.find((e) => e.eventId === matchId)
          if (ev && typeof ev.intensity === 'number') return { ev, k }
        }
        return null
      }
      const hit = tryFind(eventId)
      if (hit) {
        intensity = hit.ev.intensity
        const mode = hit.ev.modes?.[0] ?? 'command'
        source = `libraryStore (kit=${hit.k.id}, mode=${mode}, amp ${(intensity * 100).toFixed(0)}%)`
      }
    }

    // Send to the CHECKED devices by IP (helper unicasts when `targets` is
    // present), so the user doesn't have to set an address/target string.
    // preview_event rides the helper's UDP path, so only LAN IPs are valid
    // targets — drop any `serial:` pseudo-device in the selection (helper
    // would otherwise sendto() a bogus host and the UI would show a false
    // success). Fall back to the focused device when nothing is checked; the
    // list is non-empty here so the helper never drops to broadcast-all.
    const isLan = (ip: string) => !ip.startsWith('serial:')
    const lanChecked = useDeviceStore.getState().selectedIps.filter(isLan)
    const targets = lanChecked.length > 0
      ? lanChecked
      : (isLan(selectedIp) ? [selectedIp] : [])
    if (targets.length === 0) {
      // Serial-only (USB) selection: preview_event can't ride the serial
      // config channel, so don't send a doomed packet that reads as success.
      setGlobalStatus({ kind: 'warn', msg: 'シリアル接続デバイスではテスト再生できません（LAN 接続が必要）' })
      pushLog('preview', `× preview_event skipped: serial-only selection (event_id=${eventId})`)
      return
    }
    const payload = { event_id: eventId, target: '', gain: intensity, targets }
    send({ type: 'preview_event', payload })
    pushLog(
      'preview',
      `→ ${targets.join(', ')}: preview_event event_id=${eventId} gain=${intensity.toFixed(2)} (${source})`,
    )
  }, [selectedIp, send, pushLog])

  const transport = useDeviceTransport(selectedIp)
  const sendTo = useCallback((msg: ManagerMessage) => { void transport.sendTo(msg) }, [transport])

  // Debounced get_info trigger for the DuoWL v4 device-backed controls
  // (finding 3). The Serial path can't reconcile through the injected
  // get_info_result (that lands in infoCache, but a serial device's UI reads
  // masterInfo) — so it goes through refreshAll(), which repopulates
  // masterInfo AND bumps serialMaster.refreshTick (the serial syncTick). The
  // LAN path sends get_info; get_info_result then bumps deviceStore.infoTick.
  const reconcileInfo = useCallback(() => {
    if (transport.isSerial) { void useSerialMaster.getState().refreshAll(); return }
    if (selectedIp) send({ type: 'get_info', payload: { ip: selectedIp } })
  }, [transport.isSerial, send, selectedIp])

  // ── Bulk config over USB serial ─────────────────────────────────────
  // Apply a config command to ALL selected USB-serial cards ONE AT A TIME
  // (serial path only). Unlike the parallel firmware flash, config is
  // serialized because set_wifi self-reboots each device — see bulkConfigCmd.
  const bulkConfigCmd = useSerialMaster((s) => s.bulkConfigCmd)
  const selectedPortIds = useSerialMaster((s) => s.selectedPortIds)
  const activePortId = useSerialMaster((s) => s.activePortId)
  const isSerialDevice = !!selectedIp && selectedIp.startsWith('serial:')
  // Targets = EXACTLY the checked USB cards (✔ 書込対象) — never auto-add the
  // config-connected ("⚙ 設定", activePortId) card just because its form
  // happens to be on screen. That auto-add used to silently write to an
  // unchecked device whenever the user was mid-config on one card and had
  // ticked a *different* card for a bulk apply (bug report 2026-07-20): the
  // on-screen device got written too even though its checkbox was empty.
  // The checkbox is now the ONE selection concept for every write action
  // (flash + bulk-config) — if the user wants the on-screen device included,
  // they check its box like any other target.
  const bulkTargetIds = useMemo(() => [...selectedPortIds], [selectedPortIds])
  // Fix 2 (2026-07-20): now that the checkbox is the ONE selection concept
  // (above), the 設定-connected device and the ✔ write-target set can
  // silently diverge — the config form on screen edits one device, but a
  // write goes to whatever's checked. Surface that mismatch once, near the
  // write actions, instead of leaving it implicit. True only when there IS
  // a live config connection and its port isn't in the checked set.
  const configConnectedNotChecked =
    masterMode === 'config' && !!activePortId && !bulkTargetIds.includes(activePortId)
  const bulkApply = useCallback((msg: ManagerMessage) => {
    // Same ManagerMessage → firmware serial-config JSON translation as
    // useDeviceTransport's single-port serial path.
    const cmd: Record<string, unknown> = {
      cmd: msg.type,
      ...(msg.payload as Record<string, unknown>),
    }
    delete cmd.ip
    delete cmd.targets
    void bulkConfigCmd(bulkTargetIds.map((id) => ({ id, cmd }))).then(({ ok, fail }) => {
      // Summary toast (symmetric with the single-device write_result path).
      injectMessage({
        type: 'write_result',
        payload: {
          success: fail === 0,
          device: selectedIp,
          cmd: `${msg.type} (一括 ${ok + fail} 台)`,
          message: fail === 0
            ? `✓ ${ok} 台に一括適用しました`
            : `一括設定: 成功 ${ok} / 失敗 ${fail}`,
        },
      })
    })
  }, [bulkConfigCmd, bulkTargetIds, injectMessage, selectedIp])

  if (!device || !selectedIp) {
    return <OnboardingWizard />
  }

  const refreshInfo = () => {
    if (transport.isSerial) {
      void useSerialMaster.getState().refreshAll()
      return
    }
    send({ type: 'get_info', payload: { ip: selectedIp } })
    send({ type: 'get_wifi_status', payload: { ip: selectedIp } })
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
    // AP/OLED are receiver-only — skip for sensor/broker/transmitter.
    if ((device?.role ?? 'receiver') === 'receiver') {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
      send({ type: 'get_oled_brightness', payload: { ip: selectedIp } })
    }
  }

  const refreshApStatus = () => {
    if (!transport.isSerial) {
      send({ type: 'get_ap_status', payload: { ip: selectedIp } })
    }
  }

  const refreshWifiProfiles = () => {
    if (transport.isSerial) {
      void useSerialMaster.getState().refreshAll()
      return
    }
    send({ type: 'list_wifi_profiles', payload: { ip: selectedIp } })
  }

  const cachedInfo = transport.isSerial
    ? (masterInfo ? {
        name: masterInfo.name,
        mac: masterInfo.mac,
        fw: masterInfo.fw,
        build: masterInfo.build,
        group: masterInfo.group,
        wifi_connected: masterInfo.wifi_connected,
        board: masterInfo.board,
        role: masterInfo.role,
        transport: masterInfo.transport,
        transports: masterInfo.transports,
        espnow_channel: masterInfo.espnow_channel,
        gain: masterInfo.gain,
        input_level: masterInfo.input_level,
        opus_complexity: masterInfo.opus_complexity,
        stream_hp_buffer_ms: masterInfo.stream_hp_buffer_ms,
        broker_host: masterInfo.broker_host,
        broker_port: masterInfo.broker_port,
        topic_root: masterInfo.topic_root,
        mqtt_qos: masterInfo.mqtt_qos,
        mqtt_connected: masterInfo.mqtt_connected,
        static_octet: masterInfo.static_octet,
        mqtt_port: masterInfo.mqtt_port,
        mqtt_running: masterInfo.mqtt_running,
        mqtt_clients: masterInfo.mqtt_clients,
        mqtt_pub_count: masterInfo.mqtt_pub_count,
        mqtt_last_topic: masterInfo.mqtt_last_topic,
        mqtt_last_payload: masterInfo.mqtt_last_payload,
        mappings_count: masterInfo.mappings_count,
        sensor_types: masterInfo.sensor_types,
        alert_loop: masterInfo.alert_loop,
        alert_limit: masterInfo.alert_limit,
        ack_hold_ms: masterInfo.ack_hold_ms,
        recv_topics: masterInfo.recv_topics,
        espnow_ui: masterInfo.espnow_ui,
        stream: masterInfo.stream,
        audio: masterInfo.audio,
        eq: masterInfo.eq,
        eq_engine: masterInfo.eq_engine,
        av_delay_ms: masterInfo.av_delay_ms,
        dsp_profile: masterInfo.dsp_profile,
        eq_iir: masterInfo.eq_iir,
        drc: masterInfo.drc,
        effect_3d: masterInfo.effect_3d,
        agc: masterInfo.agc,
      } : undefined)
    : infoCache[selectedIp]
  const wifiStatus = transport.isSerial
    ? (masterWifiStatus ?? undefined)
    : wifiStatusCache[selectedIp]
  const wifiProfiles = transport.isSerial
    ? { profiles: masterWifiProfiles, count: masterWifiProfiles.length, max: masterWifiProfileMax }
    : wifiProfilesCache[selectedIp]
  const debugDump = debugDumpCache[selectedIp]
  const kitList = kitListCache[selectedIp]
  const sensorMapping = sensorMappingCache[selectedIp]
  const sensorReading = sensorReadingCache[selectedIp]
  // get_info counter for the DuoWL v4 device-backed controls (finding 3):
  // serialMaster.refreshTick on the USB path, deviceStore.infoTick on LAN.
  const cachedSyncTick = transport.isSerial
    ? masterRefreshTick
    : infoTickCache[selectedIp]
  const apInfo = {
    mode: cachedInfo?.mode,
    ap_ssid: cachedInfo?.ap_ssid,
    ap_ip: cachedInfo?.ap_ip,
    ap_has_pass: cachedInfo?.ap_has_pass,
    ap_client_count: cachedInfo?.ap_client_count,
  }

  // ---- Resolve node role / transport (default receiver/udp) ----
  const nodeRole: NodeRole = cachedInfo?.role ?? device.role ?? 'receiver'
  const nodeTransports: NodeTransport[] =
    cachedInfo?.transports
    ?? (cachedInfo?.transport ? [cachedInfo.transport] : undefined)
    ?? device.transports
    ?? (device.transport ? [device.transport] : undefined)
    ?? ['udp']
  const nodeTransport: NodeTransport =
    cachedInfo?.transport ?? device.transport ?? nodeTransports[0] ?? 'udp'

  const subTabs = computeSubTabs(nodeRole, nodeTransport, nodeTransports, cachedInfo?.board)
  const activeSubTab: SubTab = subTabs.includes(subTab) ? subTab : (subTabs[0] ?? 'firmware')

  return (
    <section className="devices-detail">
      <div className="devices-detail-header">
        <div className="devices-detail-name">
          {device.name || '(unnamed)'}
        </div>
        <div className="devices-detail-sub">
          <span className="device-detail-pill selected-pill">SELECTED</span>
          {nodeRole !== 'receiver' && (
            <span className="device-detail-pill role-pill">{roleBadge(nodeRole)}</span>
          )}
          {apInfo.mode === 'ap' && (
            <span className="device-detail-pill ap-mode-badge">AP MODE</span>
          )}
          {device.ipAddress}
          {device.firmwareVersion && (
            <>
              {' '}· fw {device.firmwareVersion}
              {cachedInfo?.build && (
                <span className="device-detail-build-sha"> ({cachedInfo.build})</span>
              )}
            </>
          )}
          {device.address && <> · {device.address}</>}
          {!device.online && <> · offline</>}
        </div>
        <div className="form-action-row" style={{ marginTop: 10 }}>
          <button
            className="form-button-secondary"
            onClick={refreshInfo}
            disabled={!device.online}
            title="デバイスから get_info / get_wifi_status / list_wifi_profiles を取得"
          >
            ⟳ デバイスから読み込み
          </button>
          <button
            className="form-button-secondary"
            onClick={() => sendTo({ type: 'reboot', payload: {} })}
            disabled={!device.online}
            title="デバイスを再起動"
          >
            再起動
          </button>
          {globalStatus && (
            <span className={`form-status ${globalStatus.kind}`} style={{ alignSelf: 'center' }}>
              {globalStatus.msg}
            </span>
          )}
        </div>
      </div>

      <div className="device-subtabs">
        {subTabs.map((id) => (
          <button
            key={id}
            className={`device-subtab-btn${activeSubTab === id ? ' active' : ''}`}
            onClick={() => setSubTab(id)}
          >
            {SUB_TAB_LABEL[id]}
          </button>
        ))}
      </div>

      <div className="device-subtab-body">
        {activeSubTab === 'wifi' && (
          <>
            <WifiProfilesForm
              device={device}
              profiles={wifiProfiles?.profiles ?? []}
              count={wifiProfiles?.count ?? 0}
              max={wifiProfiles?.max ?? 5}
              wifiStatus={wifiStatus}
              sendTo={sendTo}
              onRefresh={refreshWifiProfiles}
              bulkCount={isSerialDevice ? bulkTargetIds.length : 0}
              onBulkApply={isSerialDevice ? bulkApply : undefined}
              configConnectedNotChecked={isSerialDevice && configConnectedNotChecked}
            />
            <ApModeSection
              device={device}
              apInfo={apInfo}
              sendTo={sendTo}
              onRefreshApStatus={refreshApStatus}
            />
          </>
        )}

        {activeSubTab === 'config' && (
          <>
            <IdentityForm
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
            />
            {nodeRole === 'receiver' && (
              <UiConfigForm device={device} sendTo={sendTo} />
            )}
            {cachedInfo?.board === 'duo_wl_v4' && (
              <DuoWlV4AudioSection
                device={device}
                cachedInfo={cachedInfo}
                sendTo={sendTo}
              />
            )}
            <DebugDumpSection
              device={device}
              dump={debugDump}
              sendTo={sendTo}
            />
            {/* Non-DuoWL-v4 (v3-family) haptic-only Wi-Fi/UDP receivers
                (necklace_v3 / band_v2/v3/v4): software haptic EQ, gated
                purely on eq_engine === "sw" (presence-driven — see
                SwHapticEqSection doc). DuoWL v4 never reports eq_engine
                "sw" (its EQ lives on the dedicated eq sub-tab instead). */}
            {cachedInfo?.eq_engine === 'sw' && (
              <SwHapticEqSection
                device={device}
                cachedInfo={cachedInfo}
                sendTo={sendTo}
                syncTick={cachedSyncTick}
                onReconcile={reconcileInfo}
              />
            )}
            {/* The compact Serial-connect link was removed here — USB
                connection now happens by clicking the card in the left
                Devices panel (user feedback 2026-06-13). */}
          </>
        )}

        {activeSubTab === 'mqtt' && (
          nodeRole === 'broker'
            ? <BrokerConfigSection device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
            : <MqttConfigSection
                device={device}
                cachedInfo={cachedInfo}
                sendTo={sendTo}
                role={nodeRole === 'sensor' ? 'sensor' : 'receiver'}
              />
        )}

        {activeSubTab === 'espnow' && (
          <>
            <EspNowConfigSection
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
              role={nodeRole === 'transmitter' ? 'transmitter' : 'receiver'}
            />
            {nodeRole === 'transmitter' && (
              <SolidTransmitterTuningSection
                device={device}
                cachedInfo={cachedInfo}
                sendTo={sendTo}
              />
            )}
            {nodeTransport === 'espnow_stream' && nodeRole !== 'transmitter' && (
              <>
                <EspNowDisplayPowerSection
                  device={device}
                  cachedInfo={cachedInfo}
                  oledLevel={cachedInfo?.oled_brightness}
                  sendTo={sendTo}
                />
                {/* DuoWL v4 gain stage / A-V delay / EQ moved to their own
                    音声 / EQ sub-tabs (computeSubTabs) — this tab stays
                    connection + display/power + diagnostics only. Non-
                    DuoWL-v4 (v3-family) receivers have no 音声/EQ/DSP
                    sub-tabs at all (computeSubTabs is unchanged for them),
                    so their software haptic EQ renders right here instead,
                    gated purely on eq_engine === "sw" (never true for
                    DuoWL v4 — its EQ lives on the dedicated eq sub-tab). */}
                <EspNowStreamReadout
                  cachedInfo={cachedInfo}
                  onRefresh={() => sendTo({ type: 'get_info', payload: {} })}
                  disabled={!device.online}
                />
                {cachedInfo?.eq_engine === 'sw' && (
                  <SwHapticEqSection
                    device={device}
                    cachedInfo={cachedInfo}
                    sendTo={sendTo}
                    syncTick={cachedSyncTick}
                    onReconcile={reconcileInfo}
                  />
                )}
              </>
            )}
          </>
        )}

        {activeSubTab === 'audio' && cachedInfo?.board === 'duo_wl_v4' && (
          <>
            {/* DuoWL v4 ESP-NOW hp48 receiver audio-DSP config
                (audio-dsp-config.md): the full gain-stage settings panel
                (入出力モード / 触覚アンプ / 触覚ライン出力 / DAC ブースト /
                ヘッドホン音量 / ストリームバッファ), then A-V delay, then the
                JSON backup pair covering both this tab AND the EQ tab. This
                is the only place these controls are reachable for a pure
                espnow_stream receiver — it has no 設定 tab (computeSubTabs). */}
            <DuoWlV4SettingsBackup device={device} cachedInfo={cachedInfo} sendTo={sendTo} />
            <DuoWlV4AudioSection
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
              syncTick={cachedSyncTick}
              onReconcile={reconcileInfo}
            />
            <DuoWlV4EspNowAudioSection
              device={device}
              cachedInfo={cachedInfo}
              sendTo={sendTo}
              syncTick={cachedSyncTick}
              onReconcile={reconcileInfo}
            />
          </>
        )}

        {activeSubTab === 'eq' && cachedInfo?.board === 'duo_wl_v4' && (
          <DuoWlV4EqSection
            device={device}
            cachedInfo={cachedInfo}
            sendTo={sendTo}
            syncTick={cachedSyncTick}
            onReconcile={reconcileInfo}
          />
        )}

        {activeSubTab === 'dsp' && cachedInfo?.board === 'duo_wl_v4' && (
          <DuoWlV4DspSection
            device={device}
            cachedInfo={cachedInfo}
            sendTo={sendTo}
            syncTick={cachedSyncTick}
            onReconcile={reconcileInfo}
          />
        )}

        {activeSubTab === 'mapping' && (
          <SensorMappingSection
            device={device}
            mappings={sensorMapping}
            reading={sensorReading}
            sensorType={cachedInfo?.sensor_types?.[0]}
            sendTo={sendTo}
            onRefresh={() => sendTo({ type: 'get_sensor_mapping', payload: {} })}
          />
        )}

        {activeSubTab === 'kit' && (
          <InstalledKitsSection
            device={device}
            kits={kitList}
            sendTo={sendTo}
            onPlayEvent={playEvent}
          />
        )}

        {activeSubTab === 'test' && <TestSubTab device={device} sendTo={sendTo} />}

        {activeSubTab === 'firmware' && (
          <FirmwareSubTab device={device} sendTo={sendTo} />
        )}
      </div>
    </section>
  )
}
