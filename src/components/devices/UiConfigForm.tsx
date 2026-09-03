import { useRef, useState, type ChangeEvent } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useToast } from '@/components/common/Toast'
import { useI18n } from '@/i18n/I18nProvider'

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
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filename, setFilename] = useState<string>('')
  const [config, setConfig] = useState<unknown | null>(null)
  const { toast, setAnchor } = useToast()

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        setConfig(parsed)
        toast(t('uiConfig.loaded'), 'success')
      } catch (err) {
        setConfig(null)
        toast(t('uiConfig.parseFailed', { message: String(err) }), 'error')
      }
    }
    reader.onerror = () => toast(t('uiConfig.fileReadFailed'), 'error')
    reader.readAsText(file)
  }

  const submit = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!config) return
    setAnchor(e.currentTarget)
    sendTo({
      type: 'write_ui_config',
      payload: { config },
    })
    // 書込み成功/失敗は HelperFailureToastListener が write_result ベースで出す。
  }

  return (
    <div className="form-section">
      <div className="form-section-title">UI Config (display layout)</div>
      <div className="form-row">
        <label>{t('uiconfig.file')}</label>
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
            onClick={(e) => { setAnchor(e.currentTarget); inputRef.current?.click() }}
            disabled={!device.online}
          >
            {t('common.browse')}
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
            {filename || t('uiconfig.none')}
          </span>
        </div>
        <button
          className="form-button"
          onClick={submit}
          disabled={!device.online || !config}
        >
          {t('uiconfig.write')}
        </button>
      </div>
      <div className="form-status muted" style={{ marginTop: 6 }}>
        {t('uiconfig.note')}
      </div>
    </div>
  )
}
