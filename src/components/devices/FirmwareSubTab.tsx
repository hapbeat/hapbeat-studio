import { useCallback, useEffect, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useConfirm } from '@/components/common/useConfirm'
import { useSerialMaster } from '@/stores/serialMaster'
import {
  assertMergedImage,
  isWebSerialSupported,
} from '@/utils/serialFlasher'
import {
  loadFileHandle,
  pickFile,
  saveFileHandle,
  verifyPermission,
} from '@/utils/localDirectory'
import {
  fetchFirmwareBinary,
  fetchFirmwareRegions,
  formatBytes,
  formatMtime,
  listFirmwareBuilds,
  type FirmwareLibraryEntry,
  type FirmwareRegion,
} from '@/utils/firmwareLibrary'

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
}

/**
 * Per-device ファームウェア pane.
 *
 * Two firmware sources:
 *   1. Library (top): merged binaries that the Vite dev plugin relays
 *      from `hapbeat-device-firmware/.pio/build/<env>/firmware.bin`.
 *      Re-running PlatformIO is reflected on the next "更新" or flash
 *      because the plugin reads the file fresh and the response is
 *      sent with `Cache-Control: no-store`.
 *   2. Local file (below): user-picked .bin via the File System Access
 *      API. Stored as a `FileSystemFileHandle`, re-read with
 *      `handle.getFile()` immediately before every flash, so a
 *      rebuild on disk is picked up automatically — no stale browser
 *      cache the way `<input type=file>` could go silent on
 *      same-path re-pick.
 *
 * Wi-Fi OTA and USB Serial both consume whichever source is selected.
 */
export function FirmwareSubTab({
  device,
  sendTo,
  serialOnly = false,
  postFlashReprobeMs = 0,
}: Props) {
  // Show the OTA section only when we actually have a target device
  // and the caller hasn't asked for serial-only mode.
  const showOta = !serialOnly && !!device && !!sendTo
  const { lastMessage } = useHelperConnection()
  const pushLog = useLogStore((s) => s.push)

  // ---- Source selection ------------------------------------------------
  type Source = 'library' | 'local'
  const [source, setSource] = useState<Source>('library')

  // Library state
  const [libEntries, setLibEntries] = useState<FirmwareLibraryEntry[]>([])
  const [libLoading, setLibLoading] = useState(false)
  const [libError, setLibError] = useState<string | null>(null)
  const [libSelected, setLibSelected] = useState<string | null>(null)

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

  // USB Serial state lives in the SerialMaster so the wizard, the
  // per-device 設定 sub-tab, and any future entry point all see the
  // same progress/result without re-implementing the plumbing.
  const serialRunning = useSerialMaster((s) => s.flashRunning)
  const serialProgress = useSerialMaster((s) => s.flashProgress)
  const serialResult = useSerialMaster((s) => s.flashLastResult)
  const masterFlash = useSerialMaster((s) => s.flash)
  const masterEraseFlash = useSerialMaster((s) => s.eraseFlash)
  const masterRePick = useSerialMaster((s) => s.rePick)
  const [eraseAll, setEraseAll] = useState(false)
  const { ask, dialog: confirmDialog } = useConfirm()
  // Local-only error for "before-flash" issues (file read, etc.) —
  // these never reach the master. Cleared when a real flash starts.
  const [localError, setLocalError] = useState<string | null>(null)

  // ---- Library: refresh on mount + on demand --------------------------

  const refreshLibrary = useCallback(async () => {
    setLibLoading(true)
    setLibError(null)
    try {
      const raw = await listFirmwareBuilds()
      // Stable display order: necklace → band → anything else, alpha
      // within each group. Mtime-based ordering moved which device was
      // first depending on which one was rebuilt last, which made the
      // toggle feel disorientating. The visual prominence should
      // match the physical product line, not the build timestamp.
      const entries = [...raw].sort((a, b) => {
        const rank = (env: string) =>
          env.startsWith('necklace') ? 0 : env.startsWith('band') ? 1 : 2
        const ra = rank(a.env), rb = rank(b.env)
        if (ra !== rb) return ra - rb
        return a.env.localeCompare(b.env)
      })
      setLibEntries(entries)
      // Verbose diagnostics — each refresh dumps every env's exact
      // bytes and mtime to the log drawer so the user can prove the
      // fetch actually returned new data even when the displayed
      // formatted size happens to be unchanged (formatBytes rounds
      // to 0.01 MB, masking small deltas).
      pushLog('firmware', `library refreshed: ${entries.length} env(s) at ${new Date().toLocaleTimeString()}`)
      for (const e of entries) {
        const tag = e.fwVersion ? ` fw=${e.fwVersion}` : ''
        pushLog('firmware', `  · ${e.env}:${tag} ${e.size.toLocaleString()} bytes mtime=${formatMtime(e.mtime)}`)
      }
      // Default-select the most-recently-built env on first load —
      // typically the one the user just rebuilt. Preserve a manual
      // selection across refreshes if it still exists.
      setLibSelected((prev) => {
        if (prev && entries.some((e) => e.env === prev)) return prev
        if (entries.length === 0) return null
        return [...entries].sort((a, b) => b.mtime - a.mtime)[0].env
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

  // ---- Local file: restore handle from IDB on mount ------------------

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const handle = await loadFileHandle('firmwarefile').catch(() => null)
      if (cancelled || !handle) return
      // Probe permission silently; if revoked, leave it for the user
      // to re-grant via 「参照…」 — don't auto-prompt on mount.
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

  // FIRMWARE_VERSION of the binary the user just sent — captured at
  // submit time so the post-OTA verify can compare it against the
  // device's get_info `fw` field. Old firmware behavior:
  // `Update.end(true)` returns ok but the bootloader never flips
  // otadata, so the chip boots the previous slot. The user reported
  // (2026-04-30) that this happens "sometimes", which is exactly the
  // kind of silent failure a mismatch check catches.
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
    } else if (t === 'ota_result' && typeof p.device === 'string') {
      setRunning(false)
      const ok = p.success === true
      setResult({ ok, message: String(p.message ?? '') })
      setTimeout(() => setProgress(null), 3000)
      // Post-flight verify: device reboots ~1 s after Update.end
      // returns. Wait long enough for it to come back on the LAN
      // (~6 s for STA reconnect), then ask for `get_info` and compare
      // BUILD_TAG. Mismatch implies otadata didn't flip — the
      // "sometimes runs old version" symptom from the user report.
      if (ok && expectedFwVersion && device && sendTo) {
        const ip = device.ipAddress
        pushLog('ota', `verify scheduled in 8 s (expected fw=${expectedFwVersion})`)
        setTimeout(() => {
          sendTo({ type: 'get_info', payload: { ip } })
        }, 8000)
      }
    } else if (t === 'get_info_result' && expectedFwVersion) {
      // Compare against `fw` (FIRMWARE_VERSION baked into the binary).
      // After the BUILD_TAG / FIRMWARE_VERSION unification (2026-05-01)
      // there is exactly one version concept — the semver in
      // hapbeat_config.h — so this single comparison covers OLED
      // display, get_info response, and OTA verify all at once.
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
  }, [lastMessage, expectedFwVersion, device, sendTo, pushLog])

  // ---- Reading freshly from disk ------------------------------------

  /**
   * Resolve the currently-selected source to fresh bytes for **Wi-Fi OTA**.
   *
   * The device's OTA endpoint (firmware Update.begin/.write/.end) takes
   * an APP-ONLY image. Hapbeat builds emit a *merged* firmware.bin that
   * starts with a bootloader at 0x0, the partition table at 0x8000, and
   * the app at 0x10000. Sending the whole blob to OTA writes bootloader
   * bytes into the OTA app partition — the image-header check at the end
   * appears to pass (the bootloader also begins with 0xE9), but the
   * resulting partition is corrupt and the bootloader rolls back to the
   * previous slot on the next boot. Symptom: Studio reports OTA success
   * but the device keeps booting the previous version.
   *
   * Fix: detect the merged-image markers and slice off `[0x10000, end)`
   * (the app portion) before pushing to OTA. Local-picked binaries that
   * are already app-only (i.e. don't start with the merged-layout
   * markers) are passed through unchanged so users can still flash a
   * standalone .bin built without the merge step.
   */
  const readSelectedBin = useCallback(async (): Promise<{
    bytes: Uint8Array
    label: string
    mtime: number
    path: string
  }> => {
    let raw: Uint8Array
    let label: string
    let mtime: number
    let path: string
    if (source === 'library') {
      if (!libSelected) throw new Error('ファームウェアを選んでください')
      const r = await fetchFirmwareBinary(libSelected)
      // Guard against partially-written bins (PlatformIO build still
      // running or a failed previous build leaving 0-byte stubs).
      // Letting esptool flash an empty image bricks the device.
      if (r.bytes.length === 0) {
        throw new Error(`ビルドファイルが空です (${libSelected}) — pio run の完了後に再試行してください`)
      }
      raw = r.bytes
      label = `${libSelected} (built ${formatMtime(r.mtime)})`
      mtime = r.mtime
      path = r.path
    } else {
      if (!localHandle) throw new Error('ローカル .bin ファイルを選んでください')
      const ok = await verifyPermission(localHandle, false)
      if (!ok) {
        setLocalPermissionDenied(true)
        throw new Error('ファイル読込権限がありません — 「参照…」で再選択してください')
      }
      const f = await localHandle.getFile()
      if (f.size === 0) {
        throw new Error('ファイルが空です — 正しい .bin か確認してください')
      }
      const buf = await f.arrayBuffer()
      setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
      raw = new Uint8Array(buf)
      label = f.name
      mtime = f.lastModified
      path = f.name // browser hides absolute path; show name only
    }
    // Detect the merged firmware.bin layout (bootloader 0xE9 at 0x0,
    // partitions 0xAA50 magic at 0x8000, app 0xE9 at 0x10000) and
    // slice to the app slot only. Same markers `assertMergedImage`
    // (Serial path) checks for.
    const APP_START = 0x10000
    const isMerged =
      raw.length >= APP_START + 1
      && raw[0] === 0xe9
      && raw[0x8000] === 0xaa
      && raw[0x8001] === 0x50
      && raw[APP_START] === 0xe9
    const appBytes = isMerged ? raw.slice(APP_START) : raw
    if (isMerged) {
      pushLog(
        'ota',
        `merged image detected — sending app slice only `
        + `(${appBytes.length.toLocaleString()} of ${raw.length.toLocaleString()} bytes)`,
      )
    }
    return { bytes: appBytes, label, mtime, path }
  }, [source, libSelected, localHandle, pushLog])

  /**
   * Resolve the currently-selected source to **Serial flash regions**.
   * Hapbeat builds emit a merged firmware.bin (bootloader 0x0 +
   * partitions 0x8000 + 0xFF gap covering NVS/otadata + app 0x10000).
   * To keep distribution as a single binary while still preserving
   * NVS data on flash, we split it into 2 regions here:
   *   [0x0,    0x9000)  bootloader + partitions
   *   [0x10000, end  )  app
   * The 0x9000–0x10000 gap (NVS + otadata) is left untouched so
   * Wi-Fi profiles / device name / group ID survive a reflash.
   * `assertMergedImage` rejects local-picked .bin files that don't
   * have the merged-layout markers.
   */
  const readSelectedRegions = useCallback(async (): Promise<{
    regions: FirmwareRegion[]
    label: string
  }> => {
    if (source === 'library') {
      if (!libSelected) throw new Error('ファームウェアを選んでください')
      const entry = libEntries.find((e) => e.env === libSelected)
      if (!entry) throw new Error('選択中のビルドが見つかりません')
      const regions = await fetchFirmwareRegions(entry)
      return {
        regions,
        label: `${entry.env} (built ${formatMtime(entry.mtime)})`,
      }
    }
    // Local file: validate it's a merged image then split with the
    // same NVS-skipping layout the library path uses.
    const single = await readSelectedBin()
    assertMergedImage(single.bytes)
    const NVS_GAP_START = 0x9000
    const APP_START = 0x10000
    return {
      regions: [
        {
          address: 0x0,
          bytes: single.bytes.slice(0, NVS_GAP_START),
          label: 'bootloader+partitions (0x0..0x9000)',
        },
        {
          address: APP_START,
          bytes: single.bytes.slice(APP_START),
          label: `app (0x10000..${single.bytes.length.toString(16)})`,
        },
      ],
      label: single.label,
    }
  }, [source, libSelected, libEntries, readSelectedBin])

  // ---- UI handlers ---------------------------------------------------

  const onPickLocal = useCallback(async () => {
    try {
      const handle = await pickFile('firmwarefile', {
        types: [{ description: 'ESP32 firmware binary', accept: { 'application/octet-stream': ['.bin'] } }],
      })
      if (!handle) {
        // showOpenFilePicker either cancelled or unavailable — fall
        // back to the legacy <input type=file> for non-Chromium browsers.
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

  /**
   * Fallback for non-FSAPI browsers (Firefox, Safari). The user has to
   * re-pick after every rebuild because there's no handle to retain.
   */
  const pickViaLegacyInput = useCallback(async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.bin,application/octet-stream'
    return new Promise<void>((resolve) => {
      input.onchange = async () => {
        const f = input.files?.[0]
        if (!f) { resolve(); return }
        const buf = await f.arrayBuffer()
        // We have no handle to persist, but we can keep the in-memory
        // bytes by faking a one-shot handle. For the common dev flow
        // (Chromium), the FSAPI path runs and this is unused.
        const fakeHandle = {
          name: f.name,
          kind: 'file',
          getFile: async () => f,
          // no permission API — verifyPermission will short-circuit
        } as unknown as FileSystemFileHandle
        setLocalHandle(fakeHandle)
        setLocalMeta({ name: f.name, size: f.size, mtime: f.lastModified })
        setLocalPermissionDenied(false)
        setSource('local')
        // Keep bytes around so verifyPermission failures still flash:
        // we cache via a closure on the fake getFile above.
        void buf
        resolve()
      }
      input.click()
    })
  }, [])

  // ---- Wi-Fi OTA submit ---------------------------------------------

  const submit = async () => {
    if (!device || !sendTo) return  // OTA disabled in serial-only mode
    // Pre-flight: device must be online (reachable via TCP 7701).
    // If the device's Wi-Fi service is hanging (e.g. after a Wi-Fi
    // profile switch), OTA will silently fail. Prompt the user to
    // power-cycle rather than firing a blind OTA that's doomed to fail.
    if (!device.online) {
      setResult({
        ok: false,
        message: 'デバイスがオフラインです — 電源 OFF/ON してから再試行してください',
      })
      pushLog('ota', 'abort — device offline before OTA start')
      return
    }
    setResult(null)
    let bin: Awaited<ReturnType<typeof readSelectedBin>>
    try {
      bin = await readSelectedBin()
    } catch (err) {
      setResult({ ok: false, message: String((err as Error).message ?? err) })
      return
    }
    setRunning(true)
    pushLog('ota', `flash → ${bin.label} (${formatBytes(bin.bytes.length)})`)
    // Capture the firmware version so the post-OTA verify can compare
    // it against the device's `fw` after reboot (see ota_result effect
    // above). User-reported "old version remains" symptom (2026-04-30)
    // = otadata didn't flip; this catches it explicitly instead of
    // trusting `Update.end` ok status alone.
    if (source === 'library') {
      const e = libEntries.find((x) => x.env === libSelected)
      setExpectedFwVersion(e?.fwVersion ?? null)
    } else {
      setExpectedFwVersion(null)
    }
    setProgress({
      device: device.ipAddress, phase: 'begin', percent: 0,
      message: `OTA 開始要求… (${bin.label})`,
    })
    sendTo({
      type: 'ota_data',
      payload: { bin_base64: bytesToBase64(bin.bytes) },
    })
  }

  // ---- Serial flash --------------------------------------------------

  async function onSerialFlash() {
    setLocalError(null)
    let plan: Awaited<ReturnType<typeof readSelectedRegions>>
    try {
      plan = await readSelectedRegions()
    } catch (err) {
      setLocalError(String((err as Error).message ?? err))
      return
    }
    // Hand the firmware bytes off to the master. It owns the port,
    // closes any active config conn first, runs esptool-js, and
    // (when postFlashReprobeMs > 0) auto re-probes for the wizard.
    await masterFlash(plan.regions, {
      eraseAll,
      postFlashReprobeMs,
    })
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
    ? Boolean(libSelected)
    : Boolean(localHandle && !localPermissionDenied)

  return (
    <>
      {confirmDialog}
      {/* --------- Source: Firmware Library (hosted by dev plugin) --------- */}
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
            <span className="form-section-sub-inline">
              {' '}— Studio 同梱のビルド済みファームから選ぶ
            </span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button
              className="form-button-secondary"
              onClick={refreshLibrary}
              disabled={libLoading}
              style={{ fontSize: 11, padding: '2px 8px' }}
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
            <div className="firmware-lib-toggle" role="tablist" aria-label="ファームウェア種別">
              {libEntries.map((e) => {
                const selected = source === 'library' && libSelected === e.env
                const variant = e.env.startsWith('necklace')
                  ? 'necklace'
                  : e.env.startsWith('band')
                    ? 'band'
                    : 'other'
                return (
                  <button
                    key={e.env}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`firmware-lib-toggle-btn variant-${variant}${selected ? ' selected' : ''}`}
                    onClick={() => {
                      setSource('library')
                      setLibSelected(e.env)
                    }}
                  >
                    <span className="firmware-lib-toggle-icon" aria-hidden="true">
                      {variant === 'necklace' ? <NecklaceIcon /> : variant === 'band' ? <BandIcon /> : '◇'}
                    </span>
                    <span className="firmware-lib-toggle-label">
                      {variant === 'necklace'
                        ? 'NECKLACE'
                        : variant === 'band'
                          ? 'BAND'
                          : e.env.toUpperCase()}
                    </span>
                  </button>
                )
              })}
            </div>

            {(() => {
              const e = libEntries.find((x) => x.env === libSelected)
              if (!e) return null
              return (
                <div className="firmware-lib-detail" role="tabpanel">
                  <div
                    className="firmware-lib-detail-meta"
                    style={{
                      // Allow the meta row to wrap when the version +
                      // size + date sequence overflows the card. Long
                      // semver strings (`1.234.567` etc) used to clip
                      // when the row was kept single-line.
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {e.fwVersion && (
                      <span
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 3,
                          background: 'var(--accent)',
                          color: 'white',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                        title="ファームウェアバージョン (hapbeat_config.h FIRMWARE_VERSION)。OTA 完了後の起動バージョン照合に使用。"
                      >
                        v{e.fwVersion}
                      </span>
                    )}
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {formatBytes(e.size)} · {formatMtime(e.mtime)}
                    </span>
                  </div>
                </div>
              )
            })()}
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
              <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
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
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={submit}
            disabled={!haveSelection || !device?.online || running}
          >
            {running ? '送信中…' : 'OTA 書き込み'}
          </button>
          {!device?.online && <span className="form-status muted">デバイスがオフラインです</span>}
        </div>

        {progress && (
          <>
            <div className="firmware-progress">
              <div
                className="firmware-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="form-status muted">
              [{progress.phase}] {progress.percent}% — {progress.message}
            </div>
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
            style={{ marginLeft: 12, fontSize: 11, padding: '4px 10px' }}
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

/** Inline SVG icons for the firmware-type toggle. Drawn as flat
 *  monochrome glyphs with `currentColor` so they pick up the parent
 *  button's text color (variant tint when selected). */
function NecklaceIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* chain — open at top, drooping curve */}
      <path d="M5 4 C 5 12, 19 12, 19 4" />
      {/* clasp / link circles along the chain */}
      <circle cx="9" cy="9.4" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9.4" r="0.7" fill="currentColor" stroke="none" />
      {/* pendant: small ring + diamond drop */}
      <circle cx="12" cy="13" r="1.2" />
      <path d="M12 14.2 L9.8 18 L12 21 L14.2 18 Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BandIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* wristband — wide ring with strap visible at top + bottom */}
      <ellipse cx="12" cy="12" rx="8" ry="5.5" />
      {/* clasp marks */}
      <path d="M4 12 L2 12 M20 12 L22 12" />
      {/* haptic pad face */}
      <rect x="9" y="9.5" width="6" height="5" rx="0.6" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
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

