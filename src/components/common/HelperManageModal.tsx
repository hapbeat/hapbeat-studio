import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MIN_HELPER_VERSION, type HelperCompat } from '@/config/helperCompat'
import { VersionSwitcher } from './VersionSwitcher'
import './HelperOnboardingModal.css'

interface HelperManageModalProps {
  open: boolean
  onClose: () => void
  helperVersion: string | null
  /** Optional — when omitted the modal hides the upgrade-required section.
   *  Treat absent as 'unknown' so older callers keep working. */
  helperCompat?: HelperCompat
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

export function HelperManageModal({ open, onClose, helperVersion, helperCompat }: HelperManageModalProps) {
  const outdated = helperCompat === 'outdated'
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
            <span className={`helper-modal-dot ${outdated ? 'outdated' : 'connected'}`} />
            {outdated
              ? `Helper 要更新${helperVersion ? ` (v${helperVersion} → v${MIN_HELPER_VERSION}+)` : ''}`
              : `Helper 接続中${helperVersion ? ` (v${helperVersion})` : ''}`}
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
          {outdated && (
            <section className="helper-modal-section helper-modal-section--warning">
              <h3 className="helper-modal-section-title">⚠ Helper の更新が必要です</h3>
              <p className="helper-modal-section-desc">
                現在の Helper は <code>v{helperVersion ?? '?'}</code> です。
                Studio はバージョン <code>v{MIN_HELPER_VERSION}</code> 以上を必要としています
                (Kit deploy / device 情報取得などで破壊的な変更があるため)。
                以下の手順で更新してください:
              </p>
              <p className="helper-modal-section-desc">
                <strong>1. 動作中の daemon を停止:</strong>
              </p>
              <CopyableCommand cmd="hapbeat-helper stop" />
              <p className="helper-modal-section-desc">
                <strong>2. 最新版へ更新:</strong>
              </p>
              <CopyableCommand cmd="pipx upgrade hapbeat-helper" />
              <p className="helper-modal-section-desc">
                <strong>3. 再起動</strong> (Task Scheduler / launchd 経由なら自動、手動なら下記):
              </p>
              <CopyableCommand cmd="hapbeat-helper start" />
              <p className="helper-modal-section-desc">
                完了後この modal を閉じて、Helper pill が緑色 (Helper 接続中) になれば OK。
              </p>
            </section>
          )}

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

          {/* Studio バージョン表示 + ロールバック用の版切替 (versions.json) */}
          <section className="helper-modal-section">
            <h3 className="helper-modal-section-title">バージョン</h3>
            <p className="helper-modal-section-desc">
              新しい版で不具合が出た場合は、旧バージョンに切り替えて作業を続けられます
              （各版はマイナー単位で <code>/v0.2/</code> のような固定 URL に残ります）。
            </p>
            <VersionSwitcher />
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
