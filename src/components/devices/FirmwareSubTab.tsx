import { useCallback, useEffect, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useLogStore } from '@/stores/logStore'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import {
  assertMergedImage,
  eraseFlash,
  flashRegions,
  isWebSerialSupported,
  pickSerialPort,
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

interface SerialProgress {
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
export function FirmwareSubTab({ device, sendTo, serialOnly = false }: Props) {
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

  // USB Serial state — separate from Wi-Fi OTA so the user can run them
  // independently without the result of one stomping the other.
  const [serialRunning, setSerialRunning] = useState(false)
  const [serialProgress, setSerialProgress] = useState<SerialProgress | null>(null)
  const [serialResult, setSerialResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [eraseAll, setEraseAll] = useState(false)

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
      // Default-select the most-recently-built env on first load —
      // typically the one the user just rebuilt. Preserve a manual
      // selection across refreshes if it still exists.
      setLibSelected((prev) => {
        if (prev && entries.some((e) => e.env === prev)) return prev
        if (entries.length === 0) return null
        return [...entries].sort((a, b) => b.mtime - a.mtime)[0].env
      })
    } catch (err) {
      setLibError(`一覧取得失敗: ${(err as Error).message}`)
      setLibEntries([])
    } finally {
      setLibLoading(false)
    }
  }, [])

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
      setResult({ ok: p.success === true, message: String(p.message ?? '') })
      setTimeout(() => setProgress(null), 3000)
    }
  }, [lastMessage])

  // ---- Reading freshly from disk ------------------------------------

  /**
   * Resolve the currently-selected source to fresh bytes for **Wi-Fi OTA**
   * (the device's OTA endpoint takes a single app image at 0x10000).
   * Library rebuilds are fetched no-store; local handles are re-read via
   * `getFile()` so a disk overwrite is picked up on every flash.
   */
  const readSelectedBin = useCallback(async (): Promise<{
    bytes: Uint8Array
    label: string
    mtime: number
    path: string
  }> => {
    if (source === 'library') {
      if (!libSelected) throw new Error('ファームウェアを選んでください')
      const r = await fetchFirmwareBinary(libSelected)
      // Guard against partially-written bins (PlatformIO build still
      // running or a failed previous build leaving 0-byte stubs).
      // Letting esptool flash an empty image bricks the device.
      if (r.bytes.length === 0) {
        throw new Error(`ビルドファイルが空です (${libSelected}) — pio run の完了後に再試行してください`)
      }
      return {
        bytes: r.bytes,
        label: `${libSelected} (built ${formatMtime(r.mtime)})`,
        mtime: r.mtime,
        path: r.path,
      }
    }
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
    return {
      bytes: new Uint8Array(buf),
      label: f.name,
      mtime: f.lastModified,
      path: f.name, // browser hides absolute path; show name only
    }
  }, [source, libSelected, localHandle])

  /**
   * Resolve the currently-selected source to a **Serial flash region**.
   * Hapbeat builds always emit merged firmware.bin (bootloader 0x0 +
   * partitions 0x8000 + app 0x10000 in one file), so the region is
   * always `[{ address: 0x0, bytes: firmware.bin }]`. `assertMergedImage`
   * throws if the local-picked .bin doesn't match — better than
   * silently writing a non-merged blob to 0x0 and corrupting the
   * bootloader area.
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
    // Local file: validate it's a merged image and write at 0x0.
    const single = await readSelectedBin()
    assertMergedImage(single.bytes)
    return {
      regions: [{
        address: 0x0,
        bytes: single.bytes,
        label: 'firmware.bin (merged)',
      }],
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
    setResult(null)
    let bin: Awaited<ReturnType<typeof readSelectedBin>>
    try {
      bin = await readSelectedBin()
    } catch (err) {
      setResult({ ok: false, message: String((err as Error).message ?? err) })
      return
    }
    pushLog('ota', `flash → ${bin.label} (${formatBytes(bin.bytes.length)})`)
    setProgress({
      device: device.ipAddress, phase: 'begin', percent: 0,
      message: `OTA 開始要求… (${bin.label})`,
    })
    setRunning(true)
    sendTo({
      type: 'ota_data',
      payload: { bin_base64: bytesToBase64(bin.bytes) },
    })
  }

  // ---- Serial flash --------------------------------------------------

  async function onSerialFlash() {
    setSerialResult(null)
    let plan: Awaited<ReturnType<typeof readSelectedRegions>>
    try {
      plan = await readSelectedRegions()
    } catch (err) {
      setSerialResult({ ok: false, message: String((err as Error).message ?? err) })
      return
    }
    // No app-only confirm needed: every Hapbeat firmware.bin is a
    // merged image (bootloader + partitions + app), so eraseAll is
    // always safe to combine with a flash — the merged blob restores
    // every region.
    setSerialProgress({ phase: 'pick', percent: 0, message: 'COM ポート選択待ち…' })
    let port: SerialPort
    try {
      port = await pickSerialPort()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if ((err as Error).name === 'AbortError' || /cancel/i.test(msg)) {
        setSerialProgress(null)
        return
      }
      setSerialProgress(null)
      setSerialResult({ ok: false, message: msg })
      pushLog('serial', `flash failed: ${msg}`)
      return
    }
    setSerialRunning(true)
    const totalBytes = plan.regions.reduce((s, r) => s + r.bytes.length, 0)
    pushLog('serial', `flash → ${plan.label} (${formatBytes(totalBytes)} across ${plan.regions.length} region(s))`)
    for (const r of plan.regions) {
      pushLog('serial', `  ${r.label} → 0x${r.address.toString(16).padStart(4, '0')} (${formatBytes(r.bytes.length)})`)
    }
    try {
      await flashRegions(port, plan.regions, {
        eraseAll,
        onLog: (line) => pushLog('serial', line),
        onProgress: (p) => {
          const phaseLabel: Record<string, string> = {
            connect: 'チップ検出 / 同期',
            erase: 'Flash 消去中',
            write: '書き込み中',
            reset: 'リセット中',
            done: '完了',
          }
          setSerialProgress({
            phase: p.phase,
            percent: p.percent,
            message: p.message
              ? `${phaseLabel[p.phase] ?? p.phase} — ${p.message}`
              : (phaseLabel[p.phase] ?? p.phase),
          })
        },
      })
      const summary = plan.regions
        .map((r) => `${r.label}@0x${r.address.toString(16)}`)
        .join(', ')
      setSerialResult({
        ok: true,
        message: `Serial 書き込み完了 (${plan.label}; ${summary})`,
      })
      pushLog('serial', `flash done: ${plan.label}`)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      setSerialResult({ ok: false, message: `Serial 書き込み失敗: ${msg}` })
      pushLog('serial', `flash failed: ${msg}`)
    } finally {
      setSerialRunning(false)
      setTimeout(() => setSerialProgress(null), 3000)
    }
  }

  async function onSerialErase() {
    if (!confirm(
      'Flash を全消去しますか？\n'
      + 'デバイスのファームウェア・Wi-Fi profiles・グループ ID 等の'
      + ' 設定情報がすべて消えます。',
    )) {
      return
    }
    setSerialResult(null)
    setSerialProgress({ phase: 'pick', percent: 0, message: 'COM ポート選択待ち…' })
    let port: SerialPort
    try {
      port = await pickSerialPort()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if ((err as Error).name === 'AbortError' || /cancel/i.test(msg)) {
        setSerialProgress(null)
        return
      }
      setSerialProgress(null)
      setSerialResult({ ok: false, message: msg })
      return
    }
    setSerialRunning(true)
    try {
      await eraseFlash(port, {
        onLog: (line) => pushLog('serial', line),
        onProgress: (p) => setSerialProgress({
          phase: p.phase,
          percent: p.percent,
          message: p.phase === 'erase' ? 'Flash 消去中…' : p.phase,
        }),
      })
      setSerialResult({ ok: true, message: 'Flash 消去完了' })
      pushLog('serial', 'erase done')
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      setSerialResult({ ok: false, message: `Flash 消去失敗: ${msg}` })
      pushLog('serial', `erase failed: ${msg}`)
    } finally {
      setSerialRunning(false)
      setTimeout(() => setSerialProgress(null), 3000)
    }
  }

  // ---- Computed bits for the toolbar / disable states ----------------

  const haveSelection = source === 'library'
    ? Boolean(libSelected)
    : Boolean(localHandle && !localPermissionDenied)

  const selectedSummary = source === 'library'
    ? (() => {
        const e = libEntries.find((x) => x.env === libSelected)
        return e
          ? `${e.env} · ${formatBytes(e.size)} · built ${formatMtime(e.mtime)}`
          : ''
      })()
    : (localMeta
      ? `${localMeta.name} · ${formatBytes(localMeta.size)} · modified ${formatMtime(localMeta.mtime)}`
      : '')

  const selectedPath = source === 'library'
    ? (libEntries.find((x) => x.env === libSelected)?.path ?? '')
    : '' // browser hides absolute path for security; full path only available for library entries

  return (
    <>
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
              {' '}— device-firmware の最新ビルドを直接ロード
            </span>
          </span>
          <button
            className="form-button-secondary"
            onClick={refreshLibrary}
            disabled={libLoading}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {libLoading ? '更新中…' : '⟳ 更新'}
          </button>
        </div>

        {libError && (
          <div className="form-status err">
            {libError}
            <br />
            開発時のみ利用可能です — Vite dev server (localhost:5173) 越しに{' '}
            <code>../hapbeat-device-firmware/.pio/build/&lt;env&gt;/firmware.bin</code>
            {' '}を読みます。
          </div>
        )}

        {!libError && libEntries.length === 0 && !libLoading && (
          <div className="form-status muted">
            ビルド済みファームウェアが見つかりません。device-firmware repo で
            {' '}<code>pio run -e necklace_v3_claude</code> 等を実行してください。
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
                  <div className="firmware-lib-detail-name">{e.env}</div>
                  <div className="firmware-lib-detail-meta">
                    {formatBytes(e.size)} · built {formatMtime(e.mtime)}
                  </div>
                  <div className="firmware-lib-detail-path" title={e.path}>
                    {e.path}
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
            {' '}— 任意のビルド済み .bin を直接指定
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
            前回ピックしたファイルの読み取り権限がありません。「参照…」で再選択してください。
          </div>
        )}
        <div className="form-status muted" style={{ padding: '0 4px' }}>
          ※ ブラウザはセキュリティ上 OS フルパスを公開しません。同じファイルを
          指定し続ける場合、書き込みのたびにディスクから最新バイトを読み直します
          （ビルド更新は自動反映）。
        </div>
      </div>

      {/* --------- Wi-Fi OTA write -------------------------------------- */}
      {showOta && (
      <div className="form-section">
        <div className="form-section-title">Wi-Fi OTA 書き込み</div>
        <div className="form-status muted" style={{ marginBottom: 6 }}>
          書き込み対象: <span className="mono firmware-target-bright">{selectedSummary || '(未選択)'}</span>
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
        <div className="form-section-title">USB Serial 書き込み</div>
        {!isWebSerialSupported() && (
          <div className="form-status err">
            お使いのブラウザは Web Serial API をサポートしていません
            (Chrome / Edge を使用してください)。Web Serial は HTTPS または
            {' '}<code>http://localhost</code> でのみ動作します。
          </div>
        )}
        <div className="form-status" style={{ marginBottom: 6, color: 'var(--text-primary)' }}>
          書き込み対象: <span className="mono firmware-target-bright">{selectedSummary || '(未選択)'}</span>
          {selectedPath && (
            <div
              style={{
                fontSize: 11,
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={selectedPath}
            >
              パス: <span className="mono">{selectedPath}</span>
            </div>
          )}
        </div>
        <div className="form-status muted" style={{ marginBottom: 6 }}>
          esptool-js + Web Serial API で書き込みます。デバイスを USB 接続し、
          {' '}「Serial 書き込み」を押すとブラウザの COM ポート選択ダイアログが
          開きます。Hapbeat の firmware.bin は merged image なので 0x0 に書き込まれます
          (ESP32-S3 想定)。
        </div>
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
        </div>
        {eraseAll && (
          <div className="form-status warn" style={{ marginTop: 4 }}>
            ⚠ 全消去すると Wi-Fi profiles・グループ ID・device 名などの
            NVS 設定もすべて消えます。
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
              [{serialProgress.phase}] {serialProgress.percent}% — {serialProgress.message}
            </div>
          </>
        )}

        {serialResult && (
          <div className={`form-status ${serialResult.ok ? 'ok' : 'err'}`}>
            {serialResult.ok ? '✓ ' : '✗ '}{serialResult.message}
          </div>
        )}

        {serialRunning && (
          <div className="form-status warn" style={{ marginTop: 4 }}>
            ⚠ 書き込み中はタブを切り替えないでください (進捗表示が消えます)。
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

