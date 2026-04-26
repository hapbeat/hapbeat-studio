import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface OtaProgress {
  device: string
  phase: string
  percent: number
  message: string
}

interface Props {
  device: DeviceInfo
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Per-device ファームウェア pane — bin file picker + Wi-Fi OTA with
 * progress bar. USB Serial flashing (esptool-js + Web Serial API) is
 * deferred to Phase 3.
 */
export function FirmwareSubTab({ device, sendTo }: Props) {
  const { lastMessage } = useHelperConnection()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filename, setFilename] = useState<string>('')
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [progress, setProgress] = useState<OtaProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

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

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setResult(null)
    file.arrayBuffer().then((buf) => setBytes(new Uint8Array(buf)))
  }

  const submit = () => {
    if (!bytes) return
    const b64 = bytesToBase64(bytes)
    setProgress({
      device: device.ipAddress, phase: 'begin', percent: 0,
      message: 'OTA 開始要求…',
    })
    setResult(null)
    setRunning(true)
    sendTo({
      type: 'ota_data',
      payload: { bin_base64: b64 },
    })
  }

  return (
    <>
      <div className="form-section">
        <div className="form-section-title">バイナリファイル選択</div>
        <div className="form-row">
          <label>ファイル</label>
          <div className="form-row-multi" style={{ width: '100%' }}>
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
              className="form-input mono"
              style={{
                flex: 1,
                color: filename ? 'var(--text-primary)' : 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={filename || ''}
            >
              {filename || '未選択'}
            </span>
            {bytes && (
              <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {formatBytes(bytes.length)}
              </span>
            )}
          </div>
          <span />
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Wi-Fi OTA 書き込み</div>
        <div className="form-action-row">
          <button
            className="form-button"
            onClick={submit}
            disabled={!bytes || !device.online || running}
          >
            {running ? '送信中…' : 'OTA 書き込み'}
          </button>
          {!device.online && <span className="form-status muted">デバイスがオフラインです</span>}
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

      <div className="form-section">
        <div className="form-section-title">USB Serial 書き込み</div>
        <div className="form-status muted">
          USB 経由のファーム書込は esptool-js + Web Serial API での実装を
          予定しています（Phase 3）。当面は PlatformIO/esptool で書き込んで
          ください。
        </div>
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

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
