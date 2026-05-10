import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import './HelperOnboardingModal.css'

type OsTab = 'mac' | 'win'

interface HelperOnboardingModalProps {
  open: boolean
  onClose: () => void
  onRetry: () => void
}

function detectOs(): OsTab {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'mac'
  return 'win'
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* fallback: select text */
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

export function HelperOnboardingModal({
  open,
  onClose,
  onRetry,
}: HelperOnboardingModalProps) {
  const [activeTab, setActiveTab] = useState<OsTab>(detectOs)
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
        aria-label="Hapbeat Helper セットアップ"
      >
        {/* Header */}
        <div className="helper-modal-header">
          <span className="helper-modal-title">
            <span className="helper-modal-dot disconnected" />
            Helper が未接続です
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

        {/* Body */}
        <div className="helper-modal-body">
          <p className="helper-modal-desc">
            Hapbeat Studio はローカルデーモン <code>hapbeat-helper</code> 経由で
            デバイスと通信します。
            Helper が起動していないか、ポート <code>7703</code> が塞がっています。
          </p>

          {/* Recommended: auto-start service */}
          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">
              推奨 — ログイン時自動起動（1 回のみ）
            </h3>
            <p className="helper-modal-section-desc">
              OS サービスとして登録すると、以降はターミナル操作が不要になります。
            </p>

            {/* OS tabs */}
            <div className="helper-modal-tabs">
              {(['mac', 'win'] as OsTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`helper-modal-tab ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'mac' ? 'Mac' : 'Windows'}
                </button>
              ))}
            </div>

            {activeTab === 'mac' && (
              <div className="helper-modal-tab-body">
                <CopyableCommand cmd="hapbeat-helper install-service" />
                <p className="helper-modal-hint">
                  launchd 経由でログイン時に自動起動します。ログを確認するには:<br />
                  <code>tail -f ~/Library/Logs/hapbeat-helper.log</code>
                </p>
              </div>
            )}

            {activeTab === 'win' && (
              <div className="helper-modal-tab-body">
                <CopyableCommand cmd="hapbeat-helper install-service" />
                <p className="helper-modal-hint">
                  タスク スケジューラに登録されます。コンソールウィンドウは表示されません。
                </p>
              </div>
            )}
          </section>

          {/* Alternative: foreground */}
          <section className="helper-modal-section helper-modal-section--alt">
            <h3 className="helper-modal-section-title">
              今だけ起動（フォアグラウンド）
            </h3>
            <CopyableCommand cmd="hapbeat-helper start" />
            <p className="helper-modal-hint">
              未インストールの場合は先に:{' '}
              <code>pipx install hapbeat-helper</code>
            </p>
          </section>
        </div>

        {/* Footer */}
        <div className="helper-modal-footer">
          <a
            className="helper-modal-link"
            href="https://devtools.hapbeat.com/helper/getting-started/"
            target="_blank"
            rel="noreferrer"
          >
            Helper のドキュメント <ExternalLinkIcon />
          </a>
          <button
            type="button"
            className="form-button-secondary"
            onClick={onRetry}
          >
            接続を再試行
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
