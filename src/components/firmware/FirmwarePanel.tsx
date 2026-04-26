import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import './Firmware.css'

interface OtaProgress {
  device: string
  phase: string  // 'begin' | 'upload' | 'flash' | 'done'
  percent: number
  message: string
}

/**
 * Wi-Fi OTA firmware update.
 *
 * USB-Serial firmware writes (esptool-js) are intentionally deferred —
 * they require Web Serial API + esptool-js bundle and live in their own
 * Phase 3 work. This panel covers the wireless half.
 */
export function FirmwarePanel() {
  const { isConnected, devices, lastMessage, send } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filename, setFilename] = useState<string>('')
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [progress, setProgress] = useState<OtaProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Listen for OTA push events from helper.
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
      setResult({
        ok: p.success === true,
        message: String(p.message ?? ''),
      })
      // Hide progress after a short pause.
      setTimeout(() => setProgress(null), 3000)
    }
  }, [lastMessage])

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setResult(null)
    file.arrayBuffer().then((buf) => setBytes(new Uint8Array(buf)))
  }

  const submit = () => {
    if (!bytes || !selectedIp) return
    const b64 = bytesToBase64(bytes)
    setProgress({
      device: selectedIp, phase: 'begin', percent: 0,
      message: 'OTA 開始要求…',
    })
    setResult(null)
    setRunning(true)
    send({
      type: 'ota_data',
      payload: { ip: selectedIp, bin_base64: b64 },
    })
  }

  const selDev = devices.find((d) => d.ipAddress === selectedIp)

  return (
    <div className="firmware-page">
      {!isConnected && (
        <div className="firmware-banner warn">
          Helper 未接続 — OTA は Helper を介して送信します
        </div>
      )}

      <div className="firmware-section">
        <div className="firmware-section-title">バイナリファイル選択</div>
        <div className="firmware-row">
          <input
            ref={inputRef}
            type="file"
            accept=".bin,application/octet-stream"
            onChange={onFile}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="form-button-secondary"
            onClick={() => inputRef.current?.click()}
          >
            参照…
          </button>
          <span
            className="firmware-filename mono"
            title={filename || ''}
          >
            {filename || '未選択'}
          </span>
          {bytes && (
            <span className="firmware-size">
              {formatBytes(bytes.length)}
            </span>
          )}
        </div>
      </div>

      <div className="firmware-section">
        <div className="firmware-section-title">
          Wi-Fi OTA 書き込み
          {selDev && (
            <span className="firmware-section-sub">
              {' '}— {selDev.name} ({selDev.ipAddress})
            </span>
          )}
        </div>
        <div className="firmware-row">
          <button
            className="form-button"
            onClick={submit}
            disabled={
              !isConnected
              || !bytes
              || !selDev
              || !selDev.online
              || running
            }
          >
            {running ? '送信中…' : 'OTA 書き込み'}
          </button>
          {!selDev && <span className="form-status muted">デバイス未選択</span>}
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

      <div className="firmware-section">
        <div className="firmware-section-title">USB Serial 書き込み</div>
        <div className="form-status muted">
          USB 経由のファーム書込は esptool-js + Web Serial API での実装を
          予定しています（Phase 3）。当面は Manager の「ファームウェア」タブ、
          または PlatformIO/esptool で書き込んでください。
        </div>
      </div>
    </div>
  )
}

// btoa() chokes on non-ASCII; chunk-encode raw bytes to base64.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    )
  }
  return btoa(binary)
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
