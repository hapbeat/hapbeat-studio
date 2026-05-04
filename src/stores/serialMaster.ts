import { create } from 'zustand'
import { useLogStore } from '@/stores/logStore'
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

export interface SerialDeviceInfo {
  name?: string
  group?: number
  fw?: string
  mac?: string
  board?: string
  wifi_connected?: boolean
  wifi_ssid?: string
  wifi_ip?: string
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
}

export const useSerialMaster = create<SerialMasterState>((set, get) => {
  const log = (line: string) => useLogStore.getState().push('serial-master', line)

  const setProbe = (kind: ProbeKind, message: string | null) =>
    set({ probeStatus: kind, probeMessage: message })

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
          set({ conn: null, mode: 'idle', info: null, wifiStatus: null })
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
    setProbe('connecting', 'デバイス情報を取得中…')
    try {
      const info = await c.send({ cmd: 'get_info' })
      // get_info answered → publish conn + mode atomically.
      set({
        conn: c,
        mode: 'config',
        info: {
          name: info.name as string | undefined,
          group: info.group as number | undefined,
          fw: info.fw as string | undefined,
          mac: info.mac as string | undefined,
          board: info.board as string | undefined,
          wifi_connected: info.wifi_connected as boolean | undefined,
          wifi_ssid: info.wifi_ssid as string | undefined,
          wifi_ip: info.wifi_ip as string | undefined,
        },
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
        'デバイスから応答がありません — ファームウェアが書き込まれていない可能性があります。',
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
      setProbe('connecting', 'COM ポートを確認中…')

      // Helper that prompts for a port, opening it via the picker.
      const promptForPort = async (): Promise<SerialPort | null> => {
        try {
          const p = await pickConfigPort({ forcePicker: true })
          set({ port: p })
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

      let port: SerialPort | null = cur.port
      if (forcePicker || !port) {
        port = forcePicker
          ? await promptForPort()
          : (await pickConfigPort({}).catch(() => null))
        if (!port) return null
        set({ port })
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
      if (/Failed to open serial port|InvalidStateError|already open|Failed to execute 'open'/.test(lastMsg)) {
        log(`stale port handle, re-prompting: ${lastMsg}`)
        set({ port: null })
        const fresh = await promptForPort()
        if (!fresh) return null
        try { await fresh.close() } catch { /* ignore */ }
        return attachConfigConn(fresh)
      }
      return null
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
          set({ port })
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
        set({
          flashLastResult: {
            ok: true,
            message: `Serial 書き込み完了 (${regions.map((r) => r.label).join(', ')})`
              + '\n👉 デバイスの電源を一度 OFF→ON してから「USB Serial で接続」を押してください。',
          },
          flashProgress: { phase: 'done', percent: 100 },
          mode: 'idle',
        })
        pushLog('serial', `flash done`)
        // Step 3: drop the held port handle so the next openConfig
        // pulls a fresh one out of `navigator.serial.getPorts()`.
        // Without this, the post-flash port is in a half-closed state
        // (esptool-js's Transport.disconnect already released it but
        // the Web Serial port object remembers the previous baud and
        // streams) and the next `port.open()` either fails or reads
        // garbage — symptom: "再接続できない without page reload".
        set({ port: null })
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
          set({ port })
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
        set({
          info: {
            name: r.name as string | undefined,
            group: r.group as number | undefined,
            fw: r.fw as string | undefined,
            mac: r.mac as string | undefined,
            board: r.board as string | undefined,
            wifi_connected: r.wifi_connected as boolean | undefined,
            wifi_ssid: r.wifi_ssid as string | undefined,
            wifi_ip: r.wifi_ip as string | undefined,
          },
        })
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
        set({ port })
        return port
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          log(`rePick failed: ${(err as Error).message}`)
        }
        return null
      }
    },
  }
})
