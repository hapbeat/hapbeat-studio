import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import type { DeviceInfo } from '@/types/manager'
import { streamClip } from '@/utils/audioStreamer'

interface Props {
  device: DeviceInfo
}

const INTENSITY_KEY = 'hapbeat-studio-stream-intensity'

/**
 * In-tab streaming test — pick a local audio file (any format the
 * browser can decode), resample to 16 kHz PCM16, and stream it to the
 * selected device via Helper's stream_begin/data/end pipeline.
 *
 * Replaces the Manager TestPage's folder browser + WAV player. The
 * folder navigation UX is intentionally pared back to a single file
 * picker — for repeated testing, the OS file picker remembers the
 * last directory.
 */
export function StreamingTestSection({ device }: Props) {
  const { send } = useHelperConnection()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [filename, setFilename] = useState('')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'muted'; msg: string } | null>(null)
  const [intensity, setIntensity] = useState<number>(() => {
    const v = Number(localStorage.getItem(INTENSITY_KEY))
    return Number.isFinite(v) && v > 0 && v <= 200 ? v : 100
  })

  useEffect(() => {
    localStorage.setItem(INTENSITY_KEY, String(intensity))
  }, [intensity])

  // Stop any in-flight stream when the device changes / the section unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [device.ipAddress])

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setBlob(file)
    setStatus({ kind: 'muted', msg: `${formatSize(file.size)} 読み込み済み` })
  }

  const startStream = async () => {
    if (!blob) return
    if (streaming) return
    setStatus({ kind: 'muted', msg: 'デコード + リサンプリング中…' })
    setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      // Helper resolves "this device" because the WS message will include
      // the selected device IP — but streamClip itself doesn't pass an
      // ip. We rely on Helper's _resolve_targets falling back to the
      // explicit `target` payload field. Inject it via a thin wrapper.
      const sendForStream = (msg: Parameters<typeof send>[0]) => {
        send({
          type: msg.type,
          payload: { ...msg.payload, ip: device.ipAddress },
        })
      }
      setStatus({ kind: 'muted', msg: 'ストリーミング送信中…' })
      await streamClip(blob, sendForStream, {
        intensity: intensity / 100,
        signal: ctrl.signal,
      })
      setStatus({ kind: 'ok', msg: '完了' })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStatus({ kind: 'muted', msg: '停止しました' })
      } else {
        setStatus({ kind: 'err', msg: `エラー: ${String(err)}` })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const stopStream = () => {
    abortRef.current?.abort()
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        ストリーミングテスト
        <span className="form-section-sub-inline">
          {' '}— 任意の音源ファイルを 16 kHz PCM16 に変換して送信
        </span>
      </div>

      <div className="form-row">
        <label>ファイル</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,video/*,.wav,.mp3,.m4a,.ogg,.flac"
            onChange={onFile}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            className="form-button-secondary"
            onClick={() => inputRef.current?.click()}
            disabled={streaming}
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
        <span />
      </div>

      <div className="form-row">
        <label>Intensity</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            type="range"
            min={0}
            max={200}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span
            className="form-input mono short"
            style={{ textAlign: 'right' }}
          >
            {intensity}%
          </span>
        </div>
        <span />
      </div>

      <div className="form-action-row">
        <button
          className="form-button"
          onClick={startStream}
          disabled={!blob || !device.online || streaming}
        >
          ▶ 再生 (stream)
        </button>
        <button
          className="form-button-secondary"
          onClick={stopStream}
          disabled={!streaming}
        >
          ■ 停止
        </button>
        {status && (
          <span className={`form-status ${status.kind}`} style={{ alignSelf: 'center' }}>
            {status.msg}
          </span>
        )}
      </div>

      <div className="form-status muted" style={{ marginTop: 6 }}>
        ステレオ素材は LR 両方が送信されます (デバイスがステレオ対応の場合のみ意味あり)。
      </div>
    </div>
  )
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
