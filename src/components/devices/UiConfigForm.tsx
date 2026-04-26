import { useState, type ChangeEvent } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  sendTo: (msg: ManagerMessage) => void
}

/**
 * Pick a UI config JSON from disk and POST it to the device.
 *
 * For users who edit display layouts in the Display tab, the more
 * usual path is "Deploy from Display Editor" (already wired). This
 * form handles the case where the JSON was authored externally and
 * just needs to be flashed.
 */
export function UiConfigForm({ device, sendTo }: Props) {
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
          <input
            type="file"
            accept=".json,application/json"
            onChange={onFile}
            disabled={!device.online}
            style={{ color: 'var(--text-secondary)', fontSize: 12 }}
          />
        </div>
        <button
          className="form-button"
          onClick={submit}
          disabled={!device.online || !config}
        >
          書込
        </button>
      </div>
      {filename && (
        <div className="form-status muted">
          選択: {filename}
        </div>
      )}
      {status && (
        <div className={`form-status ${status.kind}`}>{status.msg}</div>
      )}
      <div className="form-status muted" style={{ marginTop: 6 }}>
        Display エディタからの直接デプロイは「Display」タブの書込ボタンが便利です。
      </div>
    </div>
  )
}
