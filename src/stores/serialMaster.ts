import { create } from 'zustand'
import { useLogStore } from '@/stores/logStore'
import { useDeviceStore } from '@/stores/deviceStore'
import type { MqttClientEntry, NodeRole, NodeTransport } from '@/types/manager'
import {
  isWebSerialSupported,
  openConfigConnection,
  pickConfigPort,
  type SerialConfigConn,
} from '@/utils/serialConfig'
import { eraseFlash as eraseFlashImpl, flashRegions, type FlashProgress } from '@/utils/serialFlasher'

/**
 * SerialMaster — single source of truth for the Studio-wide USB
 * Serial connection.
 *
 * The browser only allows ONE consumer per `navigator.serial` port at
 * a time, so Studio must have exactly one master that arbitrates
 * config/flash modes. Onboarding wizard, the per-device 設定 sub-tab,
 * and the firmware flash UI are all *views* on this master — they
 * never touch `navigator.serial` directly.
 *
 * Mode transitions:
 *   idle  ──pick + openConfig──► config
 *   config ──flash──► flashing ──post-flash auto reopen──► config
 *   any   ──release──► idle
 */

export type SerialMasterMode = 'idle' | 'config' | 'flashing'
export type ProbeKind = 'idle' | 'connecting' | 'success' | 'failed'

// ---------------------------------------------------------------------
// Port registry — every Web-Serial port this origin has been granted.
//
// Web Serial allows MULTIPLE ports to be open simultaneously (the
// single-master invariant above is about one *consumer per port*, not
// one port per browser). The registry tracks every granted & currently
// connected port so the Devices sidebar can show them as cards — even
// before any firmware is flashed (`requestPort` works on a blank chip;
// only `getInfo()`'s VID/PID is known until a probe succeeds) — and so
// the firmware tab can flash several boards sequentially in one click.
//
// Identity note: Web Serial does NOT expose COM port names/paths. The
// stable identity within a session is the SerialPort object itself; we
// assign incremental ids and label cards by bridge chip (VID) + probe
// results.
// ---------------------------------------------------------------------

export type PortFlashState = 'idle' | 'waiting' | 'flashing' | 'done' | 'error'

export interface SerialPortEntry {
  id: string
  vid?: number
  pid?: number
  /** Human bridge-chip label derived from VID (FTDI / CP210x / …). */
  bridge: string
  probe: ProbeKind
  /** Last successful get_info for this port (manual probe / config). */
  info: SerialDeviceInfo | null
  flash: {
    state: PortFlashState
    progress: FlashProgress | null
    message?: string
  }
}

const portIdByPort = new WeakMap<SerialPort, string>()
const portById = new Map<string, SerialPort>()
let portIdCounter = 0

// Count of in-flight flashSelected batches. Lets concurrent independent
// flashes (different firmware on different ports) coexist: the global
// `flashRunning`/`mode` only clears when this returns to 0.
let activeFlashCount = 0

function ensurePortId(port: SerialPort): string {
  let id = portIdByPort.get(port)
  if (!id) {
    id = `usb-${++portIdCounter}`
    portIdByPort.set(port, id)
  }
  portById.set(id, port)
  return id
}

/** SerialPort handle for a registry id (undefined once unplugged). */
export function serialPortForId(id: string): SerialPort | undefined {
  return portById.get(id)
}

function bridgeLabelForVid(vid?: number): string {
  switch (vid) {
    case 0x303a: return 'USB-CDC (ESP32-S3/C3)'
    case 0x0403: return 'FTDI'
    case 0x10c4: return 'CP210x'
    case 0x1a86: return 'CH340'
    default: return vid !== undefined ? `VID 0x${vid.toString(16)}` : 'Serial'
  }
}

/** Card display label: probed device name > bridge chip + VID:PID. */
export function serialEntryLabel(e: SerialPortEntry): string {
  if (e.info?.name) return e.info.name
  const ids = e.vid !== undefined
    ? ` (${e.vid.toString(16).padStart(4, '0')}:${(e.pid ?? 0).toString(16).padStart(4, '0')})`
    : ''
  return `${e.bridge}${ids}`
}

export interface SerialDeviceInfo {
  name?: string
  group?: number
  fw?: string
  /** Firmware build commit short SHA (7 chars), firmware ≥ 0.1.2d*. */
  build?: string
  mac?: string
  board?: string
  wifi_connected?: boolean
  wifi_ssid?: string
  wifi_ip?: string
  // --- node-roles (DEC-034) ---
  role?: NodeRole
  transport?: NodeTransport
  transports?: NodeTransport[]
  espnow_channel?: number
  gain?: number
  input_level?: number
  broker_host?: string
  broker_port?: number
  topic_root?: string
  mqtt_qos?: number
  mqtt_connected?: boolean
  static_octet?: number
  mqtt_port?: number
  mqtt_running?: boolean
  mqtt_clients?: MqttClientEntry[]
  mqtt_pub_count?: number
  mqtt_last_topic?: string
  mqtt_last_payload?: string
  mappings_count?: number
  sensor_types?: string[]
  alert_loop?: boolean
  alert_limit?: boolean
  ack_hold_ms?: number
  recv_topics?: string[]
  /** ESP-NOW display/power policy (espnow_stream receiver, §4.19). */
  espnow_ui?: {
    auto_off_ms?: number
    wake_on_button?: boolean
    wake_on_volume?: boolean
    led_enabled?: boolean
    low_batt_pct?: number
  }
  /** ESP-NOW audio-stream statistics (espnow_stream receiver, §4.19 get_info stream). */
  stream?: {
    received?: number
    lost?: number
    recovered?: number
    dropped?: number
    max_gap?: number
    handoffs?: number
    sources?: number
    locked?: boolean
    locked_mac?: string
    delay_ms?: number
  }
}

/** Parse a firmware get_info JSON into a SerialDeviceInfo (shared by
 *  the probe and refreshAll paths so new fields stay in one place). */
function parseSerialInfo(r: Record<string, unknown>): SerialDeviceInfo {
  return {
    name: r.name as string | undefined,
    group: r.group as number | undefined,
    fw: r.fw as string | undefined,
    build: r.build as string | undefined,
    mac: r.mac as string | undefined,
    board: r.board as string | undefined,
    wifi_connected: r.wifi_connected as boolean | undefined,
    wifi_ssid: r.wifi_ssid as string | undefined,
    wifi_ip: r.wifi_ip as string | undefined,
    role: r.role as NodeRole | undefined,
    transport: r.transport as NodeTransport | undefined,
    transports: r.transports as NodeTransport[] | undefined,
    espnow_channel: r.espnow_channel as number | undefined,
    gain: r.gain as number | undefined,
    input_level: r.input_level as number | undefined,
    broker_host: r.broker_host as string | undefined,
    broker_port: r.broker_port as number | undefined,
    topic_root: r.topic_root as string | undefined,
    mqtt_qos: r.mqtt_qos as number | undefined,
    mqtt_connected: r.mqtt_connected as boolean | undefined,
    static_octet: r.static_octet as number | undefined,
    mqtt_port: r.mqtt_port as number | undefined,
    mqtt_running: r.mqtt_running as boolean | undefined,
    mqtt_clients: r.mqtt_clients as MqttClientEntry[] | undefined,
    mqtt_pub_count: r.mqtt_pub_count as number | undefined,
    mqtt_last_topic: r.mqtt_last_topic as string | undefined,
    mqtt_last_payload: r.mqtt_last_payload as string | undefined,
    mappings_count: r.mappings_count as number | undefined,
    sensor_types: r.sensor_types as string[] | undefined,
    alert_loop: r.alert_loop as boolean | undefined,
    alert_limit: r.alert_limit as boolean | undefined,
    ack_hold_ms: r.ack_hold_ms as number | undefined,
    recv_topics: r.recv_topics as string[] | undefined,
    espnow_ui: r.espnow_ui as SerialDeviceInfo['espnow_ui'],
    stream: r.stream as SerialDeviceInfo['stream'],
  }
}

export interface SerialWifiStatus {
  connected?: boolean
  ssid?: string
  ip?: string
  rssi?: number
  channel?: number
}

export interface SerialWifiProfile {
  index: number
  ssid: string
  /** パスワードは write-only: firmware は読み出しを許可しない。 */
  has_pass?: boolean
  active?: boolean
}

export interface SerialWifiNetwork {
  ssid: string
  rssi: number
  channel?: number
  /** "OPEN" / "WPA" / "WPA2" / "WPA3" / etc — string label. */
  auth?: string
}

interface SerialMasterState {
  // The physical port handle is kept across mode transitions so flash
  // → config doesn't re-prompt the user. Cleared only on `release()`.
  port: SerialPort | null
  mode: SerialMasterMode
  // Active line-based config conn while mode === 'config'. While
  // flashing this is null because esptool-js needs exclusive access.
  conn: SerialConfigConn | null
  info: SerialDeviceInfo | null
  wifiStatus: SerialWifiStatus | null
  wifiProfiles: SerialWifiProfile[]
  wifiProfileMax: number
  probeStatus: ProbeKind
  probeMessage: string | null
  flashProgress: FlashProgress | null
  flashRunning: boolean
  flashLastResult: { ok: boolean; message: string } | null
  /** Bumped each time the master finishes a `refreshAll()`. UI can
   *  watch this to trigger reactive updates beyond the named fields. */
  refreshTick: number

  // ── port registry (multi-device) ────────────────────────
  /** Every granted + currently-connected Web Serial port. */
  knownPorts: SerialPortEntry[]
  /** Registry id of the port the single-master flow holds (config /
   *  flash). Lets the sidebar mark the active card. */
  activePortId: string | null
  /** Multi-select for the sequential flash (registry ids). */
  selectedPortIds: string[]

  // ── actions ─────────────────────────────────────────────
  /**
   * Acquire a port via the COM picker (or reuse one we already hold).
   * Idempotent when `mode === 'config'` with a live conn — returns
   * the existing conn instead of re-prompting.
   */
  openConfig: (opts?: { forcePicker?: boolean }) => Promise<SerialConfigConn | null>
  /** Close the line conn but keep the SerialPort handle (so flash can
   *  reuse the same port without a re-pick). */
  closeConfig: () => Promise<void>
  /** Run any JSON command over the active config conn. */
  sendConfigCmd: (cmd: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /**
   * Run the firmware flash. Closes the config conn first if open,
   * runs `flashRegions` on the held port, and after success kicks off
   * an auto re-probe (config conn re-opens) with the supplied delay.
   */
  flash: (
    regions: ReadonlyArray<{ address: number; bytes: Uint8Array; label: string }>,
    opts?: { eraseAll?: boolean; compress?: boolean; postFlashReprobeMs?: number },
  ) => Promise<void>
  /** Run a chip erase on the held port (or pick one if not held). */
  eraseFlash: () => Promise<void>
  /** Re-pull `get_info` / Wi-Fi state into the store. */
  refreshAll: () => Promise<void>
  /** Release everything — close conn, close port, clear state. */
  release: () => Promise<void>
  /** Force a port re-selection (user wants to switch to a different
   *  Hapbeat). Releases the current state first. */
  rePick: () => Promise<SerialPort | null>

  // ── port registry actions ───────────────────────────────
  /** Re-sync `knownPorts` from `navigator.serial.getPorts()`. */
  syncPorts: () => Promise<void>
  /** Show the picker to grant one more port, then sync. */
  addPort: () => Promise<void>
  /** One-shot identity probe (open → get_info → close) for a card.
   *  Refused while the master is busy (config conn open / flashing). */
  probePort: (id: string) => Promise<void>
  toggleSelectPort: (id: string) => void
  /** Open the config conn on a specific registry port (sidebar card
   *  "接続" button). Closes any other active conn first. */
  openConfigFor: (id: string) => Promise<SerialConfigConn | null>
  /** Sequentially flash the same regions onto several registry ports.
   *  Per-port progress lands in each entry's `flash` slot; the overall
   *  summary in `flashLastResult`. */
  flashSelected: (
    ids: string[],
    regions: ReadonlyArray<{ address: number; bytes: Uint8Array; label: string }>,
    opts?: { eraseAll?: boolean; compress?: boolean },
  ) => Promise<void>
}

export const useSerialMaster = create<SerialMasterState>((set, get) => {
  const log = (line: string) => useLogStore.getState().push('serial-master', line)

  const setProbe = (kind: ProbeKind, message: string | null) =>
    set({ probeStatus: kind, probeMessage: message })

  /** Stamp `port` + `activePortId` together so the sidebar card that
   *  corresponds to the held port can render an "active" marker. */
  const setHeldPort = (port: SerialPort | null) =>
    set({ port, activePortId: port ? ensurePortId(port) : null })

  const patchEntry = (id: string, patch: Partial<SerialPortEntry>) =>
    set((s) => ({
      knownPorts: s.knownPorts.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }))

  /**
   * Internal — open `port` as a config conn, hook up disconnect
   * handler, and wait for `get_info`. Resolves to the conn on
   * success; null on timeout (caller decides whether to surface
   * "needs flash" UI).
   */
  async function attachConfigConn(port: SerialPort): Promise<SerialConfigConn | null> {
    let c: SerialConfigConn
    try {
      c = await openConfigConnection(port, {
        onLog: (line) => useLogStore.getState().push('serial-cfg', line),
        onDisconnect: (reason) => {
          useLogStore.getState().push('serial-cfg', `disconnected (${reason})`)
          // The chip rebooted (e.g. after `set_wifi`) or the cable was
          // pulled. Clear the conn so subscribers see we're back to
          // idle, but keep `port` so a re-probe can reuse it.
          // flashLastResult もクリア — そうしないと A の flash 成功後に
          // ケーブルを抜いて B を繋いだ時、Wizard が「flash 成功」を見て
          // step を 'configure' に固定したまま戻れなくなる
          // (User report 2026-05-09: 「Step 3 のままになる」)。
          set({
            conn: null,
            mode: 'idle',
            info: null,
            wifiStatus: null,
            wifiProfiles: [],
            flashLastResult: null,
          })
        },
      })
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      log(`openConfigConnection failed: ${msg}`)
      // Stamp probe status with the underlying error string so the
      // outer openConfig() can pattern-match `Failed to open serial
      // port` and re-prompt for a fresh COM grant. Without this the
      // probe finishes with no actionable feedback (no toast, no
      // picker re-open).
      setProbe('failed', `接続失敗: ${msg}`)
      return null
    }
    // CRITICAL: do NOT flip `mode` to 'config' yet. Subscribers (the
    // onboarding wizard especially) auto-advance to the Wi-Fi step
    // when they see `mode === 'config'`. If we set it here, they'll
    // jump too early — before we know whether the chip will answer
    // get_info — and a subsequent timeout would strand them in the
    // Wi-Fi step with a null conn. Keep the conn in a private slot
    // and only publish (mode='config' + conn) atomically after
    // get_info confirms there's actually a working firmware to talk
    // to. See user report 2026-04-30: "勝手に wi-fi設定に移って".
    setProbe('connecting', 'デバイス情報を確認中…')
    try {
      // Probe get_info with a few retries. A just-flashed / just-reset
      // classic ESP32 (ATOM Lite) reboots when the config port opens and
      // needs ~1 s to reach its loop, so a single 1 s shot is too eager
      // and mislabels a flashed device as "未書込". 3 × 1.2 s (~3.6 s)
      // still fails fast enough for a genuinely blank chip → Step 2.
      let info: Record<string, unknown> | null = null
      for (let attempt = 0; attempt < 3 && info === null; attempt++) {
        try {
          info = await c.send({ cmd: 'get_info' }, { timeoutMs: 1200 })
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 200))
        }
      }
      if (info === null) throw new Error('get_info no response after retries')
      // get_info answered → publish conn + mode atomically.
      const parsed = parseSerialInfo(info)
      // Role visibility diagnostic: when a node shows up with the wrong
      // sub-tabs, this line tells us whether the firmware reported a
      // role at all (old build) or the UI dropped it.
      log(`get_info ok: role=${parsed.role ?? '(none)'} transport=${parsed.transport ?? '(none)'} fw=${parsed.fw ?? '?'} board=${parsed.board ?? '?'}`)
      set({
        conn: c,
        mode: 'config',
        info: parsed,
      })
      // Best-effort Wi-Fi state — old firmware may lack these.
      try {
        const r = await c.send({ cmd: 'get_wifi_status' })
        set({ wifiStatus: r as SerialWifiStatus })
      } catch { /* skip */ }
      try {
        const r = await c.send({ cmd: 'list_wifi_profiles' })
        set({
          wifiProfiles: (r.profiles as SerialWifiProfile[] | undefined) ?? [],
          wifiProfileMax: (r.max as number | undefined) ?? 5,
        })
      } catch { /* skip */ }
      set((s) => ({ refreshTick: s.refreshTick + 1 }))
      setProbe('success', '接続成功')
      return c
    } catch (err) {
      log(`get_info timeout: ${(err as Error).message}`)
      // No firmware (or it's not in serial-config mode). Close conn
      // but keep the port so the user can flash without re-pick.
      // mode is still 'idle' here because we never published, so the
      // wizard's mode-watching effect won't fire by accident.
      await c.close().catch(() => { /* already closed */ })
      setProbe(
        'failed',
        'デバイスから応答がありません。ファームウェア未書込の場合は Step 2 で書き込んでください。'
        + '書込済みの場合はデバイスの電源を OFF→ON して再接続してください。',
      )
      return null
    }
  }

  return {
    port: null,
    mode: 'idle',
    conn: null,
    info: null,
    wifiStatus: null,
    wifiProfiles: [],
    wifiProfileMax: 5,
    probeStatus: 'idle',
    probeMessage: null,
    flashProgress: null,
    flashRunning: false,
    flashLastResult: null,
    refreshTick: 0,
    knownPorts: [],
    activePortId: null,
    selectedPortIds: [],

    openConfig: async ({ forcePicker = false } = {}) => {
      const cur = get()
      if (cur.mode === 'flashing') {
        log('openConfig: refused while flashing')
        return null
      }
      if (cur.mode === 'config' && cur.conn) {
        return cur.conn
      }
      if (!isWebSerialSupported()) {
        setProbe('failed', 'Web Serial API がこのブラウザでサポートされていません')
        return null
      }
      // 別個体に挿し替えて再 probe する場合、A の flash success を引きずらない
      // (User report 2026-05-09)。ここで毎回クリアしておけば B の flow は
      // 自然な状態 (= probe 成功 → configure / 失敗 → flash) で開始する。
      set({ flashLastResult: null, info: null, wifiStatus: null, wifiProfiles: [] })
      setProbe('connecting', 'COM ポートを確認中…')

      // Guardian timeout: probe='connecting' のまま 20 秒経過したら強制的に
      // 'failed' へ遷移させる。port.open() / get_info / 他の await が想定外に
      // 長引いた / 例外を握りつぶしている等の潜在バグでも、ユーザーが「接続中」
      // のまま動けなくなる事態を防ぐ最後の安全網
      // (報告 2026-05-08: 「ターゲットが見つからないとリロードしないと戻れない」)。
      const guardianTimer = setTimeout(() => {
        const s = get()
        if (s.probeStatus === 'connecting') {
          log('openConfig guardian: still "connecting" after 20s — forcing failed')
          setProbe(
            'failed',
            '接続処理が応答しません (20秒経過)。USB を抜き差ししてから再試行してください。',
          )
        }
      }, 20000)
      const clearGuardian = () => clearTimeout(guardianTimer)

      // Helper that prompts for a port, opening it via the picker.
      const promptForPort = async (): Promise<SerialPort | null> => {
        try {
          const p = await pickConfigPort({ forcePicker: true })
          setHeldPort(p)
          void get().syncPorts()
          return p
        } catch (err) {
          const msg = (err as Error).message ?? String(err)
          if ((err as Error).name === 'AbortError' || /cancel/i.test(msg)) {
            setProbe('idle', null)
            return null
          }
          setProbe('failed', `COM ポート選択失敗: ${msg}`)
          return null
        }
      }

      try {
        let port: SerialPort | null = cur.port
        if (forcePicker || !port) {
          port = forcePicker
            ? await promptForPort()
            : (await pickConfigPort({}).catch(() => null))
          if (!port) return null
          setHeldPort(port)
        }
        // Defensive close: if the port was previously opened (e.g. by
        // an earlier session that didn't tear down cleanly), we'd hit
        // `InvalidStateError: The port is already open` in
        // openConfigConnection. Closing first is a no-op when already
        // closed and idempotent so it's safe to do unconditionally.
        try { await port.close() } catch { /* not open / already closed */ }

        // First attach attempt with the held / freshly-picked port.
        const result = await attachConfigConn(port)
        if (result) return result

        // Re-attach failed (probeStatus is now 'failed' with a hint).
        // If the failure was specifically a `port.open()` error — the
        // port handle is stale (another app holds the COM port, USB
        // unplugged, etc.) — drop it and re-prompt the user. Without
        // this fallback the user is stuck: there's no COM picker
        // visible because we silently reused a now-invalid grant.
        const lastMsg = get().probeMessage ?? ''
        // 注: `timed out` (port.open 5s timeout) は **再 prompt 対象から外す**。
        // タイムアウトは「ユーザーが選んだ port は存在するがデバイスが応答
        // しない」ケースで、ピッカー再表示よりは明確な失敗メッセージを
        // 残してユーザー自身に判断させる方が UX が良い。
        if (/Failed to open serial port|InvalidStateError|already open|Failed to execute 'open'/.test(lastMsg)) {
          log(`stale port handle, re-prompting: ${lastMsg}`)
          setHeldPort(null)
          const fresh = await promptForPort()
          if (!fresh) return null
          try { await fresh.close() } catch { /* ignore */ }
          return await attachConfigConn(fresh)
        }
        return null
      } finally {
        // 必ず guardian を解除して、上で何が起きても (return / throw / 例外
        // 握りつぶし) 後続セッションに影響しないようにする。
        clearGuardian()
      }
    },

    closeConfig: async () => {
      const { conn } = get()
      if (!conn) return
      await conn.close().catch(() => { /* already closed */ })
      set({ conn: null, mode: 'idle', info: null, wifiStatus: null, wifiProfiles: [] })
    },

    sendConfigCmd: async (cmd) => {
      const { conn, mode } = get()
      if (!conn || mode !== 'config') {
        log(`sendConfigCmd skipped: mode=${mode}, hasConn=${!!conn}`)
        return null
      }
      try {
        return await conn.send(cmd)
      } catch (err) {
        log(`sendConfigCmd error: ${(err as Error).message}`)
        return null
      }
    },

    flash: async (regions, { eraseAll = false, compress = true, postFlashReprobeMs = 0 } = {}) => {
      const { port: holdPort, conn } = get()
      if (!holdPort && !isWebSerialSupported()) {
        set({ flashLastResult: { ok: false, message: 'Web Serial API 非対応ブラウザです' } })
        return
      }
      // Step 1: close any active config conn so esptool-js gets
      // exclusive ownership. Keep `port` reference around.
      if (conn) {
        log('flash: closing active config conn before esptool-js')
        await conn.close().catch(() => { /* already closed */ })
        set({ conn: null, info: null, wifiStatus: null, wifiProfiles: [] })
      }
      // Step 2: ensure we have a port handle. If not, prompt now.
      let port = holdPort
      if (!port) {
        try {
          port = await pickConfigPort()
          setHeldPort(port)
        } catch (err) {
          if ((err as Error).name === 'AbortError') return
          set({ flashLastResult: { ok: false, message: `COM ポート選択失敗: ${(err as Error).message}` } })
          return
        }
      }
      set({ mode: 'flashing', flashRunning: true, flashProgress: { phase: 'connect', percent: 0 }, flashLastResult: null })
      const totalBytes = regions.reduce((s, r) => s + r.bytes.length, 0)
      const pushLog = useLogStore.getState().push
      // Probe the merged image for an embedded BUILD_TAG (random_tag.py
      // bakes "vNN" into the binary). Surfacing it in the log gives the
      // user a verifiable identity for what they're about to flash —
      // critical because formatBytes rounds to 0.01 MB and two builds
      // with different code can have identical reported size.
      let foundTag: string | null = null
      try {
        const head = new TextDecoder('latin1').decode(regions[0].bytes.slice(0, 256 * 1024))
        const m = head.match(/v\d{2,}/)
        if (m) foundTag = m[0]
      } catch { /* ignore — diagnostic only */ }
      pushLog('serial', `flash → ${regions.map((r) => r.label).join(', ')} (${totalBytes.toLocaleString()} bytes${foundTag ? `, BUILD_TAG=${foundTag}` : ''}, compress=${compress})`)
      try {
        await flashRegions(port, regions, {
          eraseAll,
          compress,
          onLog: (line) => pushLog('serial', line),
          onProgress: (p) => set({ flashProgress: p }),
        })
        // Drop the cached `board` from `info`. The freshly flashed
        // firmware may target a different BOARD_ID; keeping the old
        // value would make the next flash's board pre-flight check
        // compare against stale data. The next openConfig() refills
        // `info` (including board) via get_info.
        set((s) => ({
          info: s.info ? { ...s.info, board: undefined } : s.info,
          flashLastResult: {
            ok: true,
            message: `Serial 書き込み完了 (${regions.map((r) => r.label).join(', ')})`
              + '\n👉 デバイスの電源を一度 OFF→ON してから「USB Serial で接続」を押してください。',
          },
          flashProgress: { phase: 'done', percent: 100 },
          mode: 'idle',
          // probeStatus を 'idle' に戻す。failed のまま残ると Wizard の
          // 「failed && step=configure → flash」効果が flash 完了直後の
          // configure 遷移で即発火し、step=2↔3 を行き来するバグになる
          // (User report 2026-05-09)。
          probeStatus: 'idle',
          probeMessage: null,
        }))
        pushLog('serial', `flash done`)
        // Step 3: drop the held port handle so the next openConfig
        // pulls a fresh one out of `navigator.serial.getPorts()`.
        // Without this, the post-flash port is in a half-closed state
        // (esptool-js's Transport.disconnect already released it but
        // the Web Serial port object remembers the previous baud and
        // streams) and the next `port.open()` either fails or reads
        // garbage — symptom: "再接続できない without page reload".
        setHeldPort(null)
        // Optional auto re-probe (kept for callers that explicitly
        // want it). Default is now 0 because USB-to-serial chips in
        // download mode require a manual power cycle to actually
        // reset onto the new firmware — the Web Serial DTR/RTS
        // sequence esptool-js fires post-flash isn't enough on
        // Hapbeat's BOOT-button bring-up.
        if (postFlashReprobeMs > 0) {
          setProbe('connecting', `書き込み完了 — 再起動を待機中… (${Math.round(postFlashReprobeMs / 1000)}s)`)
          await new Promise((r) => setTimeout(r, postFlashReprobeMs))
          await get().openConfig().catch(() => { /* probe failure is surfaced via probeStatus */ })
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        const tooMuch = /status 201/.test(msg)
        set({
          flashLastResult: {
            ok: false,
            message: `Serial 書き込み失敗: ${msg}${tooMuch
              ? '\n（ESP_TOO_MUCH_DATA — Web Serial と USB-CDC の書込みバッファ食い違いが原因。'
              + '別の USB ポート / 別ケーブル / 別 USB ハブを試すか、書込み中に他の Web Serial アプリ '
              + '(Arduino IDE / esptool 等) を閉じてから再度お試しください。）'
              : ''}`,
          },
          mode: 'idle',
        })
        pushLog('serial', `flash failed: ${msg}`)
      } finally {
        set({ flashRunning: false })
        setTimeout(() => set({ flashProgress: null }), 3000)
      }
    },

    eraseFlash: async () => {
      const { port: holdPort, conn } = get()
      if (conn) {
        await conn.close().catch(() => { /* already closed */ })
        set({ conn: null, info: null, wifiStatus: null, wifiProfiles: [] })
      }
      let port = holdPort
      if (!port) {
        try {
          port = await pickConfigPort()
          setHeldPort(port)
        } catch (err) {
          if ((err as Error).name === 'AbortError') return
          set({ flashLastResult: { ok: false, message: `COM ポート選択失敗: ${(err as Error).message}` } })
          return
        }
      }
      set({ mode: 'flashing', flashRunning: true, flashProgress: { phase: 'connect', percent: 0 }, flashLastResult: null })
      const pushLog = useLogStore.getState().push
      try {
        await eraseFlashImpl(port, {
          onLog: (line) => pushLog('serial', line),
          onProgress: (p) => set({ flashProgress: p }),
        })
        set({ flashLastResult: { ok: true, message: 'Flash 消去完了' }, mode: 'idle' })
        pushLog('serial', 'erase done')
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        set({ flashLastResult: { ok: false, message: `Flash 消去失敗: ${msg}` }, mode: 'idle' })
        pushLog('serial', `erase failed: ${msg}`)
      } finally {
        set({ flashRunning: false })
        setTimeout(() => set({ flashProgress: null }), 3000)
      }
    },

    refreshAll: async () => {
      const { conn } = get()
      if (!conn) return
      try {
        const r = await conn.send({ cmd: 'get_info' })
        set({ info: parseSerialInfo(r) })
      } catch { /* skip */ }
      try {
        const r = await conn.send({ cmd: 'get_wifi_status' })
        set({ wifiStatus: r as SerialWifiStatus })
      } catch { /* skip */ }
      try {
        const r = await conn.send({ cmd: 'list_wifi_profiles' })
        set({
          wifiProfiles: (r.profiles as SerialWifiProfile[] | undefined) ?? [],
          wifiProfileMax: (r.max as number | undefined) ?? 5,
        })
      } catch { /* skip */ }
      set((s) => ({ refreshTick: s.refreshTick + 1 }))
    },

    release: async () => {
      const { conn, port } = get()
      // Always close the conn first if present — this releases the
      // reader/writer locks that the line-based protocol holds.
      if (conn) {
        await conn.close().catch(() => { /* already closed */ })
      }
      // ALWAYS close the port too. Even when the conn closed it as
      // part of its teardown, calling close() on a closed port is a
      // no-op. Skipping this in the conn-present branch was causing
      // the "can't reconnect without page reload" symptom: the conn
      // close path in openConfigConnection cancels the reader and
      // releases the writer but doesn't actually call port.close()
      // in every error path, leaving Web Serial believing the port
      // was still open on the next openConfig.
      if (port) {
        try { await port.close() } catch { /* already closed */ }
      }
      set({
        port: null,
        activePortId: null,
        mode: 'idle',
        conn: null,
        info: null,
        wifiStatus: null,
        wifiProfiles: [],
        probeStatus: 'idle',
        probeMessage: null,
      })
    },

    rePick: async () => {
      await get().release()
      try {
        const port = await pickConfigPort({ forcePicker: true })
        setHeldPort(port)
        void get().syncPorts()
        return port
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          log(`rePick failed: ${(err as Error).message}`)
        }
        return null
      }
    },

    // ── port registry actions ───────────────────────────────

    syncPorts: async () => {
      if (!isWebSerialSupported()) return
      let ports: SerialPort[]
      try {
        ports = await navigator.serial.getPorts()
      } catch (err) {
        log(`syncPorts failed: ${(err as Error).message}`)
        return
      }
      const prev = get().knownPorts
      const entries: SerialPortEntry[] = ports.map((p) => {
        const id = ensurePortId(p)
        let vid: number | undefined
        let pid: number | undefined
        try {
          const gi = p.getInfo()
          vid = gi.usbVendorId
          pid = gi.usbProductId
        } catch { /* getInfo unavailable */ }
        const old = prev.find((e) => e.id === id)
        return {
          id,
          vid,
          pid,
          bridge: bridgeLabelForVid(vid),
          probe: old?.probe ?? 'idle',
          info: old?.info ?? null,
          flash: old?.flash ?? { state: 'idle', progress: null },
        }
      })
      const liveIds = new Set(entries.map((e) => e.id))
      // Unplugged ports drop out of getPorts() — prune their handles
      // and any selection so flashSelected can't target a ghost.
      for (const id of [...portById.keys()]) {
        if (!liveIds.has(id)) portById.delete(id)
      }
      set((s) => ({
        knownPorts: entries,
        selectedPortIds: s.selectedPortIds.filter((id) => liveIds.has(id)),
      }))
    },

    addPort: async () => {
      if (!isWebSerialSupported()) return
      try {
        const p = await navigator.serial.requestPort({})
        ensurePortId(p)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          log(`addPort failed: ${(err as Error).message}`)
        }
      }
      await get().syncPorts()
    },

    probePort: async (id) => {
      const { mode, activePortId, info } = get()
      // Active config port: identity already known — just mirror it.
      if (id === activePortId && mode === 'config' && info) {
        patchEntry(id, { probe: 'success', info })
        return
      }
      // Per-port gate (not the global flashRunning): probing port B is fine
      // while port A is flashing — they're independent Web Serial ports.
      // Only refuse if THIS port is mid-flash or holds the active config conn.
      const thisEntry = get().knownPorts.find((e) => e.id === id)
      if (thisEntry && (thisEntry.flash.state === 'flashing' || thisEntry.flash.state === 'waiting')) {
        log(`probePort(${id}) refused: this port is flashing`)
        return
      }
      if (id === activePortId && get().mode === 'config') {
        log(`probePort(${id}) refused: this port holds the active config conn`)
        return
      }
      const port = portById.get(id)
      if (!port) return
      // A manual probe also acknowledges/clears the last flash outcome
      // shown on the card (「書き込み完了」が消えない — 2026-06-13).
      patchEntry(id, { probe: 'connecting', flash: { state: 'idle', progress: null } })
      let c: SerialConfigConn | null = null
      try {
        try { await port.close() } catch { /* not open */ }
        c = await openConfigConnection(port, {
          onLog: (line) => useLogStore.getState().push('serial-cfg', `[probe:${id}] ${line}`),
        })
        let r: Record<string, unknown> | null = null
        for (let attempt = 0; attempt < 3 && r === null; attempt++) {
          try {
            r = await c.send({ cmd: 'get_info' }, { timeoutMs: 1200 })
          } catch {
            if (attempt < 2) await new Promise((res) => setTimeout(res, 200))
          }
        }
        if (r === null) throw new Error('get_info no response')
        patchEntry(id, { probe: 'success', info: parseSerialInfo(r) })
      } catch (err) {
        log(`probePort(${id}) failed: ${(err as Error).message}`)
        patchEntry(id, { probe: 'failed' })
      } finally {
        if (c) await c.close().catch(() => { /* already closed */ })
      }
    },

    toggleSelectPort: (id) => {
      set((s) => ({
        selectedPortIds: s.selectedPortIds.includes(id)
          ? s.selectedPortIds.filter((x) => x !== id)
          : [...s.selectedPortIds, id],
      }))
    },

    openConfigFor: async (id) => {
      const port = portById.get(id)
      if (!port) return null
      // Per-port gate: refuse only if THIS port is mid-flash (a flash on a
      // different port doesn't block opening a config conn here).
      const thisEntry = get().knownPorts.find((e) => e.id === id)
      if (thisEntry && (thisEntry.flash.state === 'flashing' || thisEntry.flash.state === 'waiting')) {
        return null
      }
      const { conn } = get()
      if (conn) await get().closeConfig()
      // Same acknowledgement as probePort — connecting supersedes the
      // card's stale flash-done/error banner.
      patchEntry(id, { flash: { state: 'idle', progress: null } })
      setHeldPort(port)
      const result = await get().openConfig()
      if (result) {
        // Mirror the conn's identity onto the registry card and make the
        // pseudo-device the primary selection so the detail pane opens on
        // it right away (the card itself is the only sidebar entry now —
        // no separate serial pseudo-card in the LAN section).
        const info = get().info
        if (info) patchEntry(id, { probe: 'success', info })
        useDeviceStore.getState().selectDevice(`serial:${info?.mac ?? 'active'}`)
      }
      return result
    },

    flashSelected: async (ids, regions, { eraseAll = false, compress = true } = {}) => {
      await get().syncPorts()
      // Independent per-port flashes: a port that's already flashing (or
      // queued) is skipped so the user can start a SECOND flash with a
      // DIFFERENT firmware on OTHER ports while the first runs (e.g. sensor
      // fw → sensor while broker fw → broker, concurrently — user request
      // 2026-06-13). Each esptool-js Transport binds its own Web Serial
      // port, so concurrent flashes on distinct ports never interact.
      const targets = get().knownPorts.filter(
        (e) => ids.includes(e.id)
          && e.flash.state !== 'flashing' && e.flash.state !== 'waiting',
      )
      if (targets.length === 0) {
        set({ flashLastResult: { ok: false, message: '書き込み対象の USB デバイスが見つかりません (抜かれた / 既に書込中)' } })
        return
      }
      const targetIds = new Set(targets.map((e) => e.id))
      // Close the active config conn only if one of THESE targets is the
      // held port (esptool-js needs exclusive access to that port).
      const { conn, activePortId } = get()
      if (conn && activePortId && targetIds.has(activePortId)) {
        log('flashSelected: closing active config conn (target is the held port)')
        await conn.close().catch(() => { /* already closed */ })
        set({ conn: null, info: null, wifiStatus: null, wifiProfiles: [], activePortId: null, port: null })
      }
      activeFlashCount += 1
      set({ mode: 'flashing', flashRunning: true, flashLastResult: null })
      const pushLog = useLogStore.getState().push
      const totalBytes = regions.reduce((s, r) => s + r.bytes.length, 0)
      pushLog('serial', `flash → ${targets.length} 台 並列 (${totalBytes.toLocaleString()} bytes each)`)
      for (const e of targets) {
        patchEntry(e.id, { flash: { state: 'waiting', progress: null } })
      }
      // Flash every target CONCURRENTLY. Each Web Serial port is an
      // independent stream and each esptool-js Transport binds to its own
      // port, so the per-port flows never interact; the per-entry
      // progress/log already key on entry id. USB bus bandwidth is the
      // only shared resource — at ≤460800 baud per device that's a few
      // hundred kB/s total, nowhere near a USB2 hub's budget. State
      // outside the entries (mode/flashRunning/flashLastResult) is only
      // touched before the fan-out and after Promise.all, so the
      // single-flash path and the rest of the UI see the same lifecycle
      // as the previous sequential version.
      const flashOne = async (e: SerialPortEntry): Promise<string | null> => {
        const label = serialEntryLabel(e)
        const port = portById.get(e.id)
        if (!port) {
          patchEntry(e.id, { flash: { state: 'error', progress: null, message: 'port lost' } })
          return `${label}: ポートが見つかりません (抜かれた?)`
        }
        patchEntry(e.id, { flash: { state: 'flashing', progress: { phase: 'connect', percent: 0 } } })
        pushLog('serial', `[${label}] flash start`)
        try {
          try { await port.close() } catch { /* not open */ }
          await flashRegions(port, regions, {
            eraseAll,
            compress,
            onLog: (line) => pushLog('serial', `[${label}] ${line}`),
            onProgress: (p) => patchEntry(e.id, { flash: { state: 'flashing', progress: p } }),
          })
          // Old probe identity is stale after a flash (board/role/fw may
          // all change) — clear it so the card shows the bridge label
          // until the next probe.
          patchEntry(e.id, {
            flash: { state: 'done', progress: { phase: 'done', percent: 100 } },
            probe: 'idle',
            info: null,
          })
          pushLog('serial', `[${label}] flash done`)
          return null
        } catch (err) {
          const msg = (err as Error).message ?? String(err)
          patchEntry(e.id, { flash: { state: 'error', progress: null, message: msg } })
          pushLog('serial', `[${label}] flash FAILED: ${msg}`)
          return `${label}: ${msg}`
        }
      }
      const outcomes = await Promise.all(targets.map(flashOne))
      const failures = outcomes.filter((x): x is string => x !== null)
      const okCount = targets.length - failures.length
      const ok = failures.length === 0
      activeFlashCount = Math.max(0, activeFlashCount - 1)
      // Only clear the global flashing lifecycle when NO other flash batch
      // is still running concurrently (a second different-firmware flash
      // may have started while this one ran).
      const stillFlashing = activeFlashCount > 0
      set({
        mode: stillFlashing ? 'flashing' : 'idle',
        flashRunning: stillFlashing,
        flashLastResult: {
          ok,
          message: `Serial 書き込み: 成功 ${okCount} / 失敗 ${failures.length}`
            + (failures.length > 0 ? `\n${failures.join('\n')}` : '')
            + '\n👉 各デバイスの電源を OFF→ON してから接続してください。',
        },
      })
      // Clear per-card progress after a beat (mirror single-flash UX).
      setTimeout(() => {
        for (const e of targets) {
          const cur = get().knownPorts.find((x) => x.id === e.id)
          if (cur && (cur.flash.state === 'done' || cur.flash.state === 'error')) {
            patchEntry(e.id, { flash: { ...cur.flash, progress: null } })
          }
        }
      }, 5000)
    },
  }
})

// Keep the registry in sync with physical plug/unplug events. The
// listener is registered once at module load; syncPorts is cheap
// (getPorts + map) so firing on every connect/disconnect is fine.
if (isWebSerialSupported()) {
  navigator.serial.addEventListener('connect', () => {
    void useSerialMaster.getState().syncPorts()
  })
  navigator.serial.addEventListener('disconnect', () => {
    void useSerialMaster.getState().syncPorts()
  })
  // Initial fill (page load with previously-granted ports plugged in).
  void useSerialMaster.getState().syncPorts()
}
