import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useLogStore } from '@/stores/logStore'
import { useDeviceStore } from '@/stores/deviceStore'
import type { DeviceInfo, ManagerMessage, NodeRole, NodeTransport } from '@/types/manager'
import { useConfirm } from '@/components/common/useConfirm'
import { useSerialMaster } from '@/stores/serialMaster'
import {
  assertMergedImage,
  isMergedImage,
  isWebSerialSupported,
} from '@/utils/serialFlasher'
import {
  loadFileHandle,
  pickFile,
  saveFileHandle,
  verifyPermission,
} from '@/utils/localDirectory'
import {
  boardLabel,
  fetchFirmwareAppOta,
  fetchFirmwareSerialRegions,
  formatBytes,
  formatMtime,
  inferVariantFromEnv,
  listFirmwareBuilds,
  type FirmwareLibraryEntry,
  type FirmwareRegion,
} from '@/utils/firmwareLibrary'
import { validateOtaImage } from '@/utils/otaImageValidation'

const ROLE_ORDER: NodeRole[] = ['receiver', 'sensor', 'broker', 'transmitter']
const ROLE_LABEL: Record<NodeRole, string> = {
  receiver: 'Hapbeat',
  sensor: 'センサ送信機',
  broker: 'ブローカー',
  transmitter: 'ライブ送信機',
}

/**
 * Library groups: the wearable (Hapbeat) is the common case and gets top
 * billing; every other node type (sensor / broker / transmitter) is rare
 * and tucked under a single 周辺機器 tab so it doesn't crowd the UI.
 * (Exported — the onboarding wizard uses the same grouping.)
 */
export type FirmwareGroup = 'hapbeat' | 'peripheral'
const GROUP_ORDER: FirmwareGroup[] = ['hapbeat', 'peripheral']
const GROUP_LABEL: Record<FirmwareGroup, string> = {
  hapbeat: 'Hapbeat',
  peripheral: '周辺機器',
}
function entryGroup(e: FirmwareLibraryEntry): FirmwareGroup {
  return entryRole(e) === 'receiver' ? 'hapbeat' : 'peripheral'
}
const TRANSPORT_LABEL: Record<NodeTransport, string> = {
  udp: 'Wi-Fi UDP',
  mqtt: 'MQTT',
  espnow_stream: 'ESP-NOW',
}

/** The role a library entry implements (explicit, else inferred). */
function entryRole(e: FirmwareLibraryEntry): NodeRole {
  return e.role ?? inferVariantFromEnv(e.env).role
}

/** The board a library entry expects (explicit manifest board, else inferred). */
function entryBoard(e: FirmwareLibraryEntry): string | null {
  return e.board ?? inferVariantFromEnv(e.env).board ?? null
}

/** Human label for a variant button (manifest label, else env name). */
function entryLabel(e: FirmwareLibraryEntry): string {
  return e.label ?? e.env
}

interface OtaProgress {
  device: string
  phase: string
  percent: number
  message: string
}

interface Props {
  /** When omitted (onboarding pane / no device selected), only Serial
   *  flashing is offered — OTA needs an online IP. */
  device?: DeviceInfo
  sendTo?: (msg: ManagerMessage) => void
  /** Hide the OTA section even when a device is provided. Used by the
   *  empty-state onboarding view to keep focus on Serial bring-up. */
  serialOnly?: boolean
  /**
   * After a successful Serial flash, ask the SerialMaster to wait this
   * many ms then re-probe the device (re-open the config conn). Used
   * by the onboarding wizard so the user lands in Wi-Fi setup
   * automatically. The per-device ファームウェア sub-tab passes 0 to
   * skip the auto re-probe (the device is already an LAN peer).
   */
  postFlashReprobeMs?: number
  /**
   * Pre-filter the firmware library to one group (Hapbeat | 周辺機器).
   * Set by the onboarding wizard once the user picks a node type, so the
   * group toggle is hidden and only that group's variants show. When
   * omitted, the toggle row is shown and defaults to the connected
   * device's group (or Hapbeat).
   */
  groupFilter?: FirmwareGroup
}

/**
 * Per-device ファームウェア pane.
 *
 * Firmware sources:
 *   1. Library (top): builds discovered via the dev plugin (dev) or the
 *      aggregated manifest.json (prod). Variants are grouped by node
 *      role (装着デバイス / センサ / ブローカー / ライブ送信機) so the
 *      right firmware for each ESP32 node type is one click away.
 *   2. Local file (below): user-picked .bin via the File System Access API.
 *
 * Wi-Fi OTA and USB Serial both consume whichever source is selected.
 */
export function FirmwareSubTab({
  device,
  sendTo,
  serialOnly = false,
  postFlashReprobeMs = 0,
  groupFilter,
}: Props) {
  const showOta = !serialOnly && !!device && !!sendTo
  const { lastMessage, send: helperSend, devices } = useHelperConnection()
  const pushLog = useLogStore((s) => s.push)
  const selectedIps = useDeviceStore((s) => s.selectedIps)

  // Role reported by the connected device (drives the default role chip).
  const deviceRole = useDeviceStore((s) =>
    device ? s.infoCache[device.ipAddress]?.role : undefined,
  )

  // ---- Source selection ------------------------------------------------
  type Source = 'library' | 'local'
  const [source, setSource] = useState<Source>('library')

  const LIB_SELECTED_KEY = 'hapbeat-studio-firmware-lib-selected'
  const GROUP_SELECTED_KEY = 'hapbeat-studio-firmware-group-selected'
  const [libEntries, setLibEntries] = useState<FirmwareLibraryEntry[]>([])
  const [libLoading, setLibLoading] = useState(false)
  const [libError, setLibError] = useState<string | null>(null)
  const [libSelected, setLibSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LIB_SELECTED_KEY)
    } catch { return null }
  })
  const [selectedGroup, setSelectedGroup] = useState<FirmwareGroup | null>(() => {
    try {
      const v = localStorage.getItem(GROUP_SELECTED_KEY)
      return v === 'hapbeat' || v === 'peripheral' ? v : null
    } catch { return null }
  })

  useEffect(() => {
    try {
      if (libSelected) localStorage.setItem(LIB_SELECTED_KEY, libSelected)
      else localStorage.removeItem(LIB_SELECTED_KEY)
    } catch { /* localStorage unavailable */ }
  }, [libSelected])

  useEffect(() => {
    try {
      if (selectedGroup) localStorage.setItem(GROUP_SELECTED_KEY, selectedGroup)
    } catch { /* localStorage unavailable */ }
  }, [selectedGroup])

  // Local file state — handle is the source of truth, bytes is read on demand
  const [localHandle, setLocalHandle] = useState<FileSystemFileHandle | null>(null)
  const [localMeta, setLocalMeta] = useState<{
    name: string
    size: number
    mtime: number
  } | null>(null)
  const [localPermissionDenied, setLocalPermissionDenied] = useState(false)

  // Wi-Fi OTA state
  const [progress, setProgress] = useState<OtaProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [otaStuck, setOtaStuck] = useState(false)
  const lastOtaProgressAtRef = useRef<number>(0)

  // USB Serial state lives in the SerialMaster.
  const serialRunning = useSerialMaster((s) => s.flashRunning)
  const serialProgress = useSerialMaster((s) => s.flashProgress)
  const serialResult = useSerialMaster((s) => s.flashLastResult)
  const masterFlash = useSerialMaster((s) => s.flash)
  const masterEraseFlash = useSerialMaster((s) => s.eraseFlash)
  const masterRePick = useSerialMaster((s) => s.rePick)
  const serialMasterBoard = useSerialMaster((s) => s.info?.board)
  const [eraseAll, setEraseAll] = useState(false)
  const { ask, dialog: confirmDialog } = useConfirm()
  const lanBoard = useDeviceStore((s) =>
    device ? s.infoCache[device.ipAddress]?.board : undefined,
  )
  const lastFlashedBoardForIp = useDeviceStore((s) => {
    const key = device?.ipAddress
    return key ? s.lastFlashedBoard[key] : undefined
  })
  const invalidateBoard = useDeviceStore((s) => s.invalidateBoard)
  const setLastFlashedBoard = useDeviceStore((s) => s.setLastFlashedBoard)
  const knownBoard = lanBoard ?? serialMasterBoard ?? lastFlashedBoardForIp ?? null

  // The currently-selected library entry (before version resolution).
  const baseEntry = useMemo(
    () => libEntries.find((e) => e.env === libSelected) ?? null,
    [libEntries, libSelected],
  )

  // Archive support: the user can pick an older published version of the
  // selected variant (null = latest). Reset when switching variants.
  const [selectedVersionFw, setSelectedVersionFw] = useState<string | null>(null)
  useEffect(() => {
    setSelectedVersionFw(null)
  }, [libSelected])

  // Resolved entry: artifacts/fwVersion swapped to the chosen version so all
  // downstream consumers (OTA / Serial / verify) need no version awareness.
  const selectedEntry = useMemo(() => {
    if (!baseEntry) return null
    if (!selectedVersionFw || !baseEntry.versions) return baseEntry
    const v = baseEntry.versions.find((x) => x.fwVersion === selectedVersionFw)
    if (!v) return baseEntry
    return {
      ...baseEntry,
      fwVersion: v.fwVersion,
      appOta: v.appOta,
      fullSerial: v.fullSerial,
    }
  }, [baseEntry, selectedVersionFw])

  /**
   * Pre-flight: warn when the selected library variant targets a board
   * different from what the connected device reports.
   */
  const checkBoardMatch = useCallback(async (
    via: 'OTA' | 'Serial',
  ): Promise<boolean> => {
    if (source !== 'library' || !selectedEntry) return true
    const expected = entryBoard(selectedEntry)
    if (!expected) return true
    if (!knownBoard || knownBoard === 'unknown') return true
    if (expected === knownBoard) return true
    const ok = await ask({
      title: '基板バージョン不一致',
      message: (
        `選択中のファームウェアは ${boardLabel(expected)} 用ですが、`
        + `デバイスは ${boardLabel(knownBoard)} を報告しています。\n`
        + `異なるバージョン用のビルドを書き込むと OLED が表示されない等の `
        + `不具合が起きます。書き込みを続行しますか？\n\n`
        + `(${via} で書き込もうとしている)`
      ),
      confirmLabel: '不一致のまま書き込む',
      danger: true,
    })
    if (!ok) {
      pushLog(
        'firmware',
        `flash aborted — board mismatch (env=${selectedEntry.env} expects ${expected}, device=${knownBoard})`,
      )
    }
    return ok
  }, [source, selectedEntry, knownBoard, ask, pushLog])
  const [localError, setLocalError] = useState<string | null>(null)

  // ---- Library: refresh on mount + on demand --------------------------

  const refreshLibrary = useCallback(async () => {
    setLibLoading(true)
    setLibError(null)
    try {
      const raw = await listFirmwareBuilds()
      // Stable display order: by role, then env name.
      const entries = [...raw].sort((a, b) => {
        const ra = ROLE_ORDER.indexOf(entryRole(a))
        const rb = ROLE_ORDER.indexOf(entryRole(b))
        if (ra !== rb) return ra - rb
        return a.env.localeCompare(b.env)
      })
      setLibEntries(entries)
      pushLog('firmware', `library refreshed: ${entries.length} variant(s) at ${new Date().toLocaleTimeString()}`)
      for (const e of entries) {
        const tag = e.fwVersion ? ` fw=${e.fwVersion}` : ''
        const ota = e.appOta ? `${e.appOta.size.toLocaleString()} B` : 'n/a'
        const ser = e.fullSerial ? `${e.fullSerial.size.toLocaleString()} B` : 'n/a'
        pushLog('firmware', `  · [${entryRole(e)}/${e.transport ?? '?'}] ${e.env}:${tag} app_ota=${ota} full_serial=${ser}`)
      }
      const entryMtime = (e: FirmwareLibraryEntry): number =>
        Math.max(e.appOta?.mtime ?? 0, e.fullSerial?.mtime ?? 0)
      setLibSelected((prev) => {
        if (prev && entries.some((e) => e.env === prev)) return prev
        if (entries.length === 0) return null
        return [...entries].sort((a, b) => entryMtime(b) - entryMtime(a))[0].env
      })
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      setLibError(`一覧取得失敗: ${msg}`)
      pushLog('firmware', `library refresh failed: ${msg}`)
      setLibEntries([])
    } finally {
      setLibLoading(false)
    }
  }, [pushLog])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  // ---- Group / variant selection --------------------------------------

  /** Groups present in the library, Hapbeat first. */
  const groupsPresent = useMemo<FirmwareGroup[]>(() => {
    const seen = new Set<FirmwareGroup>()
    for (const e of libEntries) seen.add(entryGroup(e))
    return GROUP_ORDER.filter((g) => seen.has(g))
  }, [libEntries])

  /** Effective group: forced groupFilter > user pick > device role > Hapbeat. */
  const effectiveGroup = useMemo<FirmwareGroup | null>(() => {
    if (groupFilter) return groupFilter
    if (selectedGroup && groupsPresent.includes(selectedGroup)) return selectedGroup
    if (deviceRole) {
      const g: FirmwareGroup = deviceRole === 'receiver' ? 'hapbeat' : 'peripheral'
      if (groupsPresent.includes(g)) return g
    }
    if (groupsPresent.includes('hapbeat')) return 'hapbeat'
    return groupsPresent[0] ?? null
  }, [groupFilter, selectedGroup, deviceRole, groupsPresent])

  /** Entries shown: the effective group's variants. */
  const entriesShown = useMemo(() => {
    if (!effectiveGroup) return []
    return libEntries.filter((e) => entryGroup(e) === effectiveGroup)
  }, [libEntries, effectiveGroup])

  // Keep libSelected inside the shown set: if the current selection
  // belongs to a different group, jump to the first shown variant.
  useEffect(() => {
    if (entriesShown.length === 0) return
    if (libSelected && entriesShown.some((e) => e.env === libSelected)) return
    setLibSelected(entriesShown[0].env)
    setSource('library')
  }, [entriesShown, libSelected])

  const selectGroup = useCallback((group: FirmwareGroup) => {
    setSelectedGroup(group)
    const inGroup = libEntries.filter((e) => entryGroup(e) === group)
    if (inGroup.length > 0) {
      setLibSelected(inGroup[0].env)
      setSource('library')
    }
  }, [libEntries])

  // ---- Local file: restore handle from IDB on mount ------------------

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const handle = await loadFileHandle('firmwarefile').catch(() => null)
      if (cancelled || !handle) return
      const ok = await verifyPermission(handle, false).catch(() => false)
      if (!ok || cancelled) {
        setLocalPermissionDenied(true)
        setLocalHandle(handle)
        return
      }
      try {
        const f = await handle.getFile()
        if (cancelled) return
        setLocalHandle(handle)
        setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
        setLocalPermissionDenied(false)
      } catch {
        setLocalPermissionDenied(true)
        setLocalHandle(handle)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const [expectedFwVersion, setExpectedFwVersion] = useState<string | null>(null)

  // ---- Wi-Fi OTA result drain ---------------------------------------

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>
    if (t === 'ota_progress' && typeof p.device === 'string') {
      setProgress({
        device: p.device,
        phase: String(p.phase ?? ''),
        percent: Number(p.percent ?? 0),
        message: String(p.message ?? ''),
      })
      lastOtaProgressAtRef.current = Date.now()
      if (otaStuck) setOtaStuck(false)
    } else if (t === 'ota_result' && typeof p.device === 'string') {
      setRunning(false)
      setOtaStuck(false)
      const ok = p.success === true
      setResult({ ok, message: String(p.message ?? '') })
      setTimeout(() => setProgress(null), 3000)
      if (ok && device) {
        invalidateBoard(device.ipAddress)
        if (source === 'library' && selectedEntry) {
          const flashed = entryBoard(selectedEntry)
          if (flashed) setLastFlashedBoard(device.ipAddress, flashed)
        }
      }
      if (ok && expectedFwVersion && device && sendTo) {
        const ip = device.ipAddress
        pushLog('ota', `verify scheduled in 8 s (expected fw=${expectedFwVersion})`)
        setTimeout(() => {
          sendTo({ type: 'get_info', payload: { ip } })
        }, 8000)
      }
    } else if (t === 'get_info_result' && expectedFwVersion) {
      const deviceFw = (p.fw as string | undefined) ?? ''
      if (!deviceFw) {
        pushLog('ota', 'verify skipped — device get_info did not include fw')
      } else if (deviceFw !== expectedFwVersion) {
        setResult({
          ok: false,
          message: (
            `OTA は完了したが、再起動後のファームウェアバージョンが一致しません`
            + ` (期待 ${expectedFwVersion}, 実際 ${deviceFw})。`
            + ` otadata の切替に失敗している可能性があります — `
            + `デバイスを電源 OFF/ON してから再度 OTA を試してください。`
          ),
        })
        pushLog('ota', `verify FAILED — expected=${expectedFwVersion} got=${deviceFw}`)
      } else {
        pushLog('ota', `verify OK — fw=${deviceFw}`)
      }
      setExpectedFwVersion(null)
    }
  }, [lastMessage, expectedFwVersion, device, sendTo, pushLog,
      source, selectedEntry, invalidateBoard, setLastFlashedBoard, otaStuck])

  useEffect(() => {
    if (!running) {
      setOtaStuck(false)
      return
    }
    lastOtaProgressAtRef.current = Date.now()
    const tick = window.setInterval(() => {
      const elapsed = Date.now() - lastOtaProgressAtRef.current
      if (elapsed >= 3000) setOtaStuck(true)
    }, 500)
    return () => window.clearInterval(tick)
  }, [running])

  const cancelStuckOta = useCallback(() => {
    pushLog('ota', 'user cancelled stuck OTA — UI released, helper session may still drain')
    setRunning(false)
    setOtaStuck(false)
    setProgress(null)
    setExpectedFwVersion(null)
    setResult({
      ok: false,
      message:
        'ユーザーによりキャンセルされました。デバイス側で書込が完了している可能性は'
        + '残るため、再起動後に fw バージョンを確認してください。',
    })
  }, [pushLog])

  // ---- Reading freshly from disk ------------------------------------

  const readLocalRaw = useCallback(async (): Promise<{
    bytes: Uint8Array
    label: string
    mtime: number
    path: string
  }> => {
    if (!localHandle) throw new Error('ローカル .bin ファイルを選んでください')
    const ok = await verifyPermission(localHandle, false)
    if (!ok) {
      setLocalPermissionDenied(true)
      throw new Error('ファイル読込権限がありません — 「参照…」で再選択してください')
    }
    const f = await localHandle.getFile()
    if (f.size === 0) throw new Error('ファイルが空です — 正しい .bin か確認してください')
    const buf = await f.arrayBuffer()
    setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
    return {
      bytes: new Uint8Array(buf),
      label: f.name,
      mtime: f.lastModified,
      path: f.name,
    }
  }, [localHandle])

  const readSelectedBin = useCallback(async (): Promise<{
    bytes: Uint8Array
    label: string
    mtime: number
    path: string
  }> => {
    if (source === 'library') {
      if (!selectedEntry) throw new Error('ファームウェアを選んでください')
      if (!selectedEntry.appOta) {
        throw new Error(
          `firmware_app_ota.bin が ${selectedEntry.env} のビルド出力にありません — `
          + `この役割は USB Serial 書込のみ対応の可能性があります（Wi-Fi 非接続ノード）。`,
        )
      }
      const r = await fetchFirmwareAppOta(selectedEntry)
      if (r.bytes.length === 0) {
        throw new Error(`ビルドファイルが空です (${selectedEntry.env}) — pio run の完了後に再試行してください`)
      }
      return {
        bytes: r.bytes,
        label: `${selectedEntry.env} app-ota (built ${formatMtime(r.mtime)})`,
        mtime: r.mtime,
        path: r.path,
      }
    }
    const raw = await readLocalRaw()
    const APP_START = 0x10000
    if (isMergedImage(raw.bytes)) {
      const sliced = raw.bytes.slice(APP_START)
      pushLog(
        'ota',
        `merged image detected — sending app slice only `
        + `(${sliced.length.toLocaleString()} of ${raw.bytes.length.toLocaleString()} bytes)`,
      )
      return { ...raw, bytes: sliced }
    }
    return raw
  }, [source, selectedEntry, readLocalRaw, pushLog])

  const readSelectedRegions = useCallback(async (): Promise<{
    regions: FirmwareRegion[]
    label: string
  }> => {
    if (source === 'library') {
      if (!selectedEntry) throw new Error('ファームウェアを選んでください')
      if (!selectedEntry.fullSerial) {
        throw new Error(
          `firmware_full_serial.bin が ${selectedEntry.env} のビルド出力にありません — `
          + `pio run の post-build で merged image を出力する設定になっていない可能性があります。`,
        )
      }
      const regions = await fetchFirmwareSerialRegions(selectedEntry)
      return {
        regions,
        label: `${selectedEntry.env} full-serial (built ${formatMtime(selectedEntry.fullSerial.mtime)})`,
      }
    }
    const raw = await readLocalRaw()
    assertMergedImage(raw.bytes)
    const NVS_GAP_START = 0x9000
    const OTADATA_START = 0xE000
    const APP_START = 0x10000
    const OTADATA_SIZE = APP_START - OTADATA_START
    return {
      regions: [
        {
          address: 0x0,
          bytes: raw.bytes.slice(0, NVS_GAP_START),
          label: 'bootloader+partitions (0x0..0x9000)',
        },
        {
          address: OTADATA_START,
          bytes: new Uint8Array(OTADATA_SIZE).fill(0xff),
          label: 'otadata erase (0xE000..0x10000)',
        },
        {
          address: APP_START,
          bytes: raw.bytes.slice(APP_START),
          label: `app (0x10000..${raw.bytes.length.toString(16)})`,
        },
      ],
      label: raw.label,
    }
  }, [source, selectedEntry, readLocalRaw])

  // ---- UI handlers ---------------------------------------------------

  const onPickLocal = useCallback(async () => {
    try {
      const handle = await pickFile('firmwarefile', {
        types: [{ description: 'ESP32 firmware binary', accept: { 'application/octet-stream': ['.bin'] } }],
      })
      if (!handle) {
        if (typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker !== 'function') {
          await pickViaLegacyInput()
        }
        return
      }
      await saveFileHandle(handle, 'firmwarefile')
      const f = await handle.getFile()
      setLocalHandle(handle)
      setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
      setLocalPermissionDenied(false)
      setSource('local')
    } catch (err) {
      pushLog('firmware', `ファイル選択失敗: ${String((err as Error).message ?? err)}`)
    }
  }, [pushLog])

  const pickViaLegacyInput = useCallback(async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.bin,application/octet-stream'
    return new Promise<void>((resolve) => {
      input.onchange = async () => {
        const f = input.files?.[0]
        if (!f) { resolve(); return }
        const buf = await f.arrayBuffer()
        const fakeHandle = {
          name: f.name,
          kind: 'file',
          getFile: async () => f,
        } as unknown as FileSystemFileHandle
        setLocalHandle(fakeHandle)
        setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
        setLocalPermissionDenied(false)
        setSource('local')
        void buf
        resolve()
      }
      input.click()
    })
  }, [])

  // ---- Wi-Fi OTA submit ---------------------------------------------

  const submit = async () => {
    if (!device || !sendTo) return
    if (!device.online) {
      setResult({
        ok: false,
        message: 'デバイスがオフラインです — 電源 OFF/ON してから再試行してください',
      })
      pushLog('ota', 'abort — device offline before OTA start')
      return
    }
    if (!(await checkBoardMatch('OTA'))) return
    setResult(null)
    let bin: Awaited<ReturnType<typeof readSelectedBin>>
    try {
      bin = await readSelectedBin()
    } catch (err) {
      setResult({ ok: false, message: String((err as Error).message ?? err) })
      return
    }

    const validation = validateOtaImage(bin.bytes)
    if (!validation.ok) {
      pushLog('ota', `pre-flight FAILED: ${validation.reason}`)
      setResult({
        ok: false,
        message: `書き込みを中止しました (プリフライト検証失敗): ${validation.reason}`,
      })
      return
    }
    pushLog(
      'ota',
      `pre-flight OK: ${validation.info!.chipName} app, `
      + `${formatBytes(validation.info!.sizeBytes)}, `
      + `segments=${validation.info!.segments}, `
      + `hash=${validation.info!.hashAppended ? 'appended' : 'header-only'}`,
    )

    setRunning(true)
    pushLog('ota', `flash → ${bin.label} (${formatBytes(bin.bytes.length)})`)
    if (source === 'library') {
      setExpectedFwVersion(selectedEntry?.fwVersion ?? null)
    } else {
      setExpectedFwVersion(null)
    }
    const lanCandidates = selectedIps.filter((ip) => !ip.startsWith('serial:'))
    const onlineLan = lanCandidates
      .map((ip) => devices.find((d) => d.ipAddress === ip))
      .filter((d): d is DeviceInfo => !!d && d.online)
      .map((d) => d.ipAddress)
    const targets = onlineLan.length > 1
      ? onlineLan
      : [device.ipAddress]
    if (targets.length > 1) {
      pushLog(
        'ota',
        `multi-target: streaming to ${targets.length} devices sequentially `
        + `[${targets.join(', ')}]`,
      )
    }
    setProgress({
      device: device.ipAddress, phase: 'begin', percent: 0,
      message: targets.length > 1
        ? `OTA 開始要求… (${targets.length} 台 / ${bin.label})`
        : `OTA 開始要求… (${bin.label})`,
    })
    if (targets.length > 1) {
      helperSend({
        type: 'ota_data',
        payload: {
          bin_base64: bytesToBase64(bin.bytes),
          targets,
        },
      })
    } else {
      sendTo({
        type: 'ota_data',
        payload: { bin_base64: bytesToBase64(bin.bytes) },
      })
    }
  }

  // ---- Serial flash --------------------------------------------------

  async function onSerialFlash() {
    setLocalError(null)
    if (!(await checkBoardMatch('Serial'))) return
    let plan: Awaited<ReturnType<typeof readSelectedRegions>>
    try {
      plan = await readSelectedRegions()
    } catch (err) {
      setLocalError(String((err as Error).message ?? err))
      return
    }
    await masterFlash(plan.regions, {
      eraseAll,
      postFlashReprobeMs,
    })
    if (source === 'library' && selectedEntry && device?.ipAddress) {
      const flashed = entryBoard(selectedEntry)
      if (flashed) {
        setLastFlashedBoard(device.ipAddress, flashed)
      }
    }
  }

  async function onSerialErase() {
    const ok = await ask({
      title: 'Flash 全消去',
      message:
        'Flash を全消去しますか？\n'
        + 'デバイスのファームウェア・Wi-Fi profiles・グループ ID 等の'
        + ' 設定情報がすべて消えます。',
      confirmLabel: '全消去する',
      danger: true,
    })
    if (!ok) return
    setLocalError(null)
    await masterEraseFlash()
  }

  // ---- Computed bits for the toolbar / disable states ----------------

  const haveSelection = source === 'library'
    ? Boolean(selectedEntry)
    : Boolean(localHandle && !localPermissionDenied)

  return (
    <>
      {confirmDialog}
      {/* --------- Source: Firmware Library --------- */}
      <div className="form-section">
        <div
          className="form-section-title"
          style={{ display: 'flex', justifyContent: 'space-between' }}
        >
          <span>
            <input
              type="radio"
              name="firmware-source"
              checked={source === 'library'}
              onChange={() => setSource('library')}
              style={{ marginRight: 6, verticalAlign: 'middle' }}
            />
            ファームウェア ライブラリ
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button
              className="form-button-secondary"
              onClick={refreshLibrary}
              disabled={libLoading}
              style={{ fontSize: 13, padding: '2px 8px' }}
            >
              {libLoading ? '更新中…' : '⟳ 更新'}
            </button>
          </span>
        </div>

        {libError && (
          <div className="form-status err">{libError}</div>
        )}

        {!libError && libEntries.length === 0 && !libLoading && (
          <div className="form-status muted">
            ファームウェアが見つかりません。
          </div>
        )}

        {libEntries.length > 0 && (
          <>
            {/* Group tabs: Hapbeat | 周辺機器 (hidden when a groupFilter is
              * forced by the caller, or when only Hapbeat builds exist). */}
            {!groupFilter && groupsPresent.length > 1 && (
              <div
                className="firmware-lib-toggle"
                role="tablist"
                aria-label="ファームウェア種別"
              >
                {groupsPresent.map((group) => {
                  const isSelected = effectiveGroup === group
                  return (
                    <button
                      key={group}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`firmware-lib-toggle-btn variant-${group}${isSelected ? ' selected' : ''}`}
                      onClick={() => selectGroup(group)}
                    >
                      <span className="firmware-lib-toggle-label">
                        {GROUP_LABEL[group]}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Variant list — uniform 2-column grid. */}
            {entriesShown.length > 0 && (
              <div
                className="firmware-variant-grid"
                role="listbox"
                aria-label="ファームウェア"
              >
                {entriesShown.map((e) => {
                  const isSelected = source === 'library' && libSelected === e.env
                  const tp = e.transport ? TRANSPORT_LABEL[e.transport] : null
                  const role = entryRole(e)
                  return (
                    <button
                      key={e.env}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`firmware-variant-cell${isSelected ? ' selected' : ''}`}
                      onClick={() => {
                        setSource('library')
                        setLibSelected(e.env)
                      }}
                      title={`${e.env}${e.repo ? ` (${e.repo})` : ''}`}
                    >
                      <span className="firmware-variant-cell-label">{entryLabel(e)}</span>
                      <span className="firmware-variant-cell-meta">
                        {role !== 'receiver' && <span>{ROLE_LABEL[role]}</span>}
                        {tp && <span className="firmware-variant-cell-tp">{tp}</span>}
                        {e.fwVersion && <span className="firmware-variant-cell-ver">v{e.fwVersion}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {selectedEntry && (
              <div className="firmware-lib-detail" role="tabpanel">
                <div
                  className="firmware-lib-detail-meta"
                  style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
                >
                  {selectedEntry.fwVersion && (
                    <span
                      style={{
                        fontSize: 13,
                        padding: '2px 8px',
                        borderRadius: 3,
                        background: 'var(--accent)',
                        color: 'white',
                        fontFamily: 'var(--font-mono)',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                      title="ファームウェアバージョン (FIRMWARE_VERSION)。OTA 完了後の起動バージョン照合に使用。"
                    >
                      v{selectedEntry.fwVersion}
                    </span>
                  )}
                  <span className="form-section-sub-inline" style={{ fontSize: 12 }}>
                    {ROLE_LABEL[entryRole(selectedEntry)]}
                    {selectedEntry.transport && ` · ${TRANSPORT_LABEL[selectedEntry.transport]}`}
                    {entryBoard(selectedEntry) && ` · ${boardLabel(entryBoard(selectedEntry))}`}
                  </span>
                </div>

                {/* Version picker — latest + archive (older releases stay
                  * downloadable so users can roll back anytime). */}
                {baseEntry?.versions && baseEntry.versions.length > 1 && (
                  <div className="firmware-version-row">
                    <span className="firmware-version-row-label">バージョン</span>
                    {baseEntry.versions.map((v, i) => {
                      const activeFw = selectedVersionFw ?? baseEntry.versions![0].fwVersion
                      const isActive = activeFw === v.fwVersion
                      return (
                        <button
                          key={v.fwVersion}
                          type="button"
                          className={`firmware-version-chip${isActive ? ' selected' : ''}${i > 0 ? ' archive' : ''}`}
                          onClick={() => setSelectedVersionFw(i === 0 ? null : v.fwVersion)}
                          title={v.tag ?? `v${v.fwVersion}`}
                        >
                          v{v.fwVersion}
                          {i === 0 && <span className="firmware-version-chip-latest"> 最新</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
                {selectedVersionFw && (
                  <div className="form-status warn" style={{ marginTop: 4 }}>
                    アーカイブ版 v{selectedVersionFw} を選択中 — 最新版より古いファームを書き込みます。
                  </div>
                )}

                {selectedEntry.description && (
                  <div className="form-section-sub-inline" style={{ marginTop: 4, fontSize: 12 }}>
                    {selectedEntry.description}
                  </div>
                )}
                <div
                  className="firmware-lib-detail-artifacts"
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    fontSize: 13,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div title={selectedEntry.appOta?.path ?? ''}>
                    <span style={{ marginRight: 6 }}>OTA  app:</span>
                    {selectedEntry.appOta
                      ? `${formatBytes(selectedEntry.appOta.size)} · ${formatMtime(selectedEntry.appOta.mtime)}`
                      : '— (Wi-Fi 非接続ノード / 未生成)'}
                  </div>
                  <div title={selectedEntry.fullSerial?.path ?? ''}>
                    <span style={{ marginRight: 6 }}>SERIAL full:</span>
                    {selectedEntry.fullSerial
                      ? `${formatBytes(selectedEntry.fullSerial.size)} · ${formatMtime(selectedEntry.fullSerial.mtime)}`
                      : '— firmware_full_serial.bin が未生成'}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* --------- Source: User-picked .bin (FileSystemFileHandle) -------- */}
      <div className="form-section">
        <div className="form-section-title">
          <input
            type="radio"
            name="firmware-source"
            checked={source === 'local'}
            onChange={() => setSource('local')}
            style={{ marginRight: 6, verticalAlign: 'middle' }}
            disabled={!localHandle}
          />
          ローカル .bin
          <span className="form-section-sub-inline">
            {' '}— 任意の .bin ファイルを直接指定して書き込む
          </span>
        </div>
        <div className="form-row">
          <label>ファイル</label>
          <div className="form-row-multi" style={{ width: '100%' }}>
            <button
              type="button"
              className="form-button-secondary"
              onClick={onPickLocal}
            >
              参照…
            </button>
            <span
              className="form-input mono"
              style={{
                flex: 1,
                color: localMeta ? 'var(--text-primary)' : 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={localMeta?.name || ''}
            >
              {localMeta?.name ?? '未選択'}
            </span>
            {localMeta && (
              <span style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
                {formatBytes(localMeta.size)} · {formatMtime(localMeta.mtime)}
              </span>
            )}
          </div>
          <span />
        </div>
        {localPermissionDenied && (
          <div className="form-status warn" style={{ padding: '0 4px' }}>
            ファイル読み取り権限がありません。「参照…」で再選択してください。
          </div>
        )}
      </div>

      {/* --------- Wi-Fi OTA write -------------------------------------- */}
      {showOta && (
      <div className="form-section">
        <div className="form-section-title">
          Wi-Fi OTA 書き込み
          <span className="form-section-sub-inline">
            {' '}— LAN 経由で選択中ファームを上書き (デバイスは自動再起動)
          </span>
        </div>
        {(() => {
          const lan = selectedIps.filter((ip) => !ip.startsWith('serial:'))
          const onlineLan = lan
            .map((ip) => devices.find((d) => d.ipAddress === ip))
            .filter((d) => !!d && d.online).length
          if (onlineLan > 1) {
            return (
              <div className="form-section-sub-inline" style={{ opacity: 0.85 }}>
                サイドバーで {onlineLan} 台選択中 — 順番に書き込みます
              </div>
            )
          }
          return null
        })()}
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={submit}
            disabled={!haveSelection || !device?.online || running}
          >
            {running ? '送信中…' : (() => {
              const lan = selectedIps.filter((ip) => !ip.startsWith('serial:'))
              const onlineLan = lan
                .map((ip) => devices.find((d) => d.ipAddress === ip))
                .filter((d) => !!d && d.online).length
              return onlineLan > 1
                ? `OTA 書き込み (${onlineLan} 台)`
                : 'OTA 書き込み'
            })()}
          </button>
          {running && otaStuck && (
            <button
              type="button"
              className="form-button-secondary"
              onClick={cancelStuckOta}
              title="3 秒以上進捗が無いため UI を解放します。helper 側の TCP セッションは drain します"
            >
              中止する
            </button>
          )}
          {!device?.online && <span className="form-status muted">デバイスがオフラインです</span>}
        </div>

        {progress && (
          <>
            <div className="firmware-progress">
              <div
                className={`firmware-progress-fill ${otaStuck ? 'stuck' : ''}`}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="form-status muted">
              [{progress.phase}] {progress.percent}% — {progress.message}
            </div>
            {otaStuck && (
              <div className="form-status warn">
                ⚠ OTA の進捗が 3 秒以上途絶えています。デバイスの再起動（電源 OFF/ON）を試してください。
                Wi-Fi 接続が切れた、デバイスがフリーズしている、TCP セッションが詰まっている等の
                可能性があります。それでも改善しなければUSB Serial 経由での書込を推奨します。
              </div>
            )}
          </>
        )}

        {result && (
          <div className={`form-status ${result.ok ? 'ok' : 'err'}`}>
            {result.ok ? '✓ ' : '✗ '}{result.message}
          </div>
        )}
      </div>
      )}

      {/* --------- USB Serial write ------------------------------------- */}
      <div className="form-section">
        <div className="form-section-title">
          USB Serial 書き込み
          <span className="form-section-sub-inline">
            {' '}— USB ケーブル直結で書き込む (Wi-Fi 不要)
          </span>
        </div>
        {!isWebSerialSupported() && (
          <div className="form-status err">
            このブラウザは Web Serial API 非対応です (Chrome / Edge を使用してください)。
          </div>
        )}
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={onSerialFlash}
            disabled={!haveSelection || serialRunning || !isWebSerialSupported()}
          >
            {serialRunning ? '送信中…' : 'Serial 書き込み'}
          </button>
          <button
            className="form-button-secondary"
            onClick={onSerialErase}
            disabled={serialRunning || !isWebSerialSupported()}
            title="Flash 全消去 (chip erase)"
          >
            Flash 消去
          </button>
          <label
            className="form-status muted"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12 }}
          >
            <input
              type="checkbox"
              checked={eraseAll}
              onChange={(e) => setEraseAll(e.target.checked)}
              disabled={serialRunning}
            />
            書き込み前に Flash を全消去する
          </label>
          <button
            className="form-button-secondary"
            onClick={async () => {
              const p = await masterRePick()
              if (p) pushLog('serial', 'COM ポートを再選択しました')
            }}
            disabled={serialRunning}
            style={{ marginLeft: 12, fontSize: 13, padding: '4px 10px' }}
            title="別の Hapbeat に書き込み先を切り替える"
          >
            COM ポート再選択
          </button>
        </div>
        {eraseAll && (
          <div className="form-status warn" style={{ marginTop: 4 }}>
            ⚠ 全消去すると Wi-Fi 設定・デバイス名などもすべて消えます。
          </div>
        )}

        {serialProgress && (
          <>
            <div className="firmware-progress">
              <div
                className="firmware-progress-fill"
                style={{ width: `${serialProgress.percent}%` }}
              />
            </div>
            <div className="form-status muted">
              [{serialProgress.phase}] {serialProgress.percent}%
              {serialProgress.message ? ` — ${serialProgress.message}` : ''}
            </div>
          </>
        )}

        {localError && (
          <div className="form-status err">
            ✗ {localError}
          </div>
        )}

        {serialResult && (
          <div className={`form-status ${serialResult.ok ? 'ok' : 'err'}`}>
            {serialResult.ok ? '✓ ' : '✗ '}
            {serialResult.message.split('\n').map((line, i) => (
              <span key={i}>{i > 0 ? <><br />{line}</> : line}</span>
            ))}
          </div>
        )}

        {serialRunning && (
          <div className="form-status warn" style={{ marginTop: 4 }}>
            ⚠ 書き込み中はタブを切り替えないでください。
          </div>
        )}
      </div>
    </>
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null, Array.from(bytes.subarray(i, i + chunk)),
    )
  }
  return btoa(binary)
}
