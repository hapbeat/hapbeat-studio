import { useRef, useState, type ChangeEvent } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Pick a UI config JSON from disk and POST it to the device.
 *
 * The file `<input>` is hidden and triggered from a styled button so
 * the control matches the rest of the form (the browser default file
 * picker has no themable surface in our dark Studio palette).
 */
export function UiConfigForm({ device, sendTo }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filename, setFilename] = useState<string>('')
  const [config, setConfig] = useState<unknown | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'muted'; msg: string } | null>(null)

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        setConfig(parsed)
        setStatus({ kind: 'muted', msg: 'OK — 「書込」を押してください' })
      } catch (err) {
        setConfig(null)
        setStatus({ kind: 'err', msg: `JSON パース失敗: ${err}` })
      }
    }
    reader.onerror = () => setStatus({ kind: 'err', msg: 'ファイル読み込み失敗' })
    reader.readAsText(file)
  }

  const submit = () => {
    if (!config) return
    sendTo({
      type: 'write_ui_config',
      payload: { config },
    })
    setStatus({ kind: 'muted', msg: '送信中…' })
  }

  return (
    <div className="form-section">
      <div className="form-section-title">UI Config (display layout)</div>
      <div className="form-row">
        <label>ファイル</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          {/* Hidden native input — triggered by the styled button below */}
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            onChange={onFile}
            disabled={!device.online}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="form-button-secondary"
            onClick={() => inputRef.current?.click()}
            disabled={!device.online}
          >
            参照…
          </button>
          <span
            className="form-input mono"
            style={{
              flex: 1,
              padding: '6px 8px',
              color: filename ? 'var(--text-primary)' : 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filename || ''}
          >
            {filename || '未選択'}
          </span>
        </div>
        <button
          className="form-button"
          onClick={submit}
          disabled={!device.online || !config}
        >
          書込
        </button>
      </div>
      {status && (
        <div className={`form-status ${status.kind}`}>{status.msg}</div>
      )}
      <div className="form-status muted" style={{ marginTop: 6 }}>
        Display エディタからの直接デプロイは「Display」タブの書込ボタンが便利です。
      </div>
    </div>
  )
}
