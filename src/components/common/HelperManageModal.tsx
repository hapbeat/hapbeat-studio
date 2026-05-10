import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './HelperOnboardingModal.css'

interface HelperManageModalProps {
  open: boolean
  onClose: () => void
  helperVersion: string | null
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="helper-modal-cmd-row">
      <code className="helper-modal-code">{cmd}</code>
      <button
        type="button"
        className="helper-modal-copy-btn"
        onClick={handleCopy}
        title="クリップボードにコピー"
      >
        {copied ? '✓ コピー済み' : 'コピー'}
      </button>
    </div>
  )
}

export function HelperManageModal({ open, onClose, helperVersion }: HelperManageModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="helper-modal-backdrop" onClick={onClose}>
      <div
        className="helper-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Hapbeat Helper 管理"
      >
        <div className="helper-modal-header">
          <span className="helper-modal-title">
            <span className="helper-modal-dot connected" />
            Helper 接続中{helperVersion ? ` (v${helperVersion})` : ''}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="helper-modal-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>

        <div className="helper-modal-body">
          <p className="helper-modal-desc">
            <code>hapbeat-helper</code> はバックグラウンドで動作中です。
            停止・自動起動の解除・アンインストールはターミナルから以下のコマンドを実行してください。
          </p>

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">一時的に停止</h3>
            <p className="helper-modal-section-desc">
              現在動いている helper プロセスを停止します。OS サービスに登録されている場合は次回ログイン時に再起動します。
            </p>
            <CopyableCommand cmd="hapbeat-helper stop" />
          </section>

          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">自動起動を解除</h3>
            <p className="helper-modal-section-desc">
              ログイン時自動起動の登録を解除します（プロセス自体は次の停止まで残ります）。
            </p>
            <CopyableCommand cmd="hapbeat-helper uninstall-service" />
          </section>

          <section className="helper-modal-section helper-modal-section--alt">
            <h3 className="helper-modal-section-title">完全アンインストール</h3>
            <p className="helper-modal-section-desc">
              pipx 経由で導入している場合に helper パッケージごと削除します。
            </p>
            <CopyableCommand cmd="hapbeat-helper uninstall-service" />
            <CopyableCommand cmd="pipx uninstall hapbeat-helper" />
          </section>

          {/* Studio build metadata — for debugging / bug reports.
              目立たない位置 (modal フッター) に配置。 */}
          <p className="helper-modal-build-meta">
            Studio build: <code>{import.meta.env.VITE_BUILD_SHA}</code>
            {' · '}
            <code>{(import.meta.env.VITE_BUILD_DATE ?? '').replace(/\.\d+Z$/, 'Z')}</code>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
