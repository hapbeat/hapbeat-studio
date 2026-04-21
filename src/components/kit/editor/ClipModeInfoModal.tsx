import { useEffect } from 'react'
import './ClipModeInfoModal.css'

export interface ClipModeInfoModalProps {
  onClose: () => void
}

/**
 * 3 つの再生モード（FIRE / CLIP / LIVE）が「デバイス側で何が起きるか」
 * を並べて比較するモーダル。Kit カード右サイドの `?` から開く。
 *
 * ラベルと先頭記号は KitEventRow の MODE_OPTIONS と揃えること。
 */
export function ClipModeInfoModal({ onClose }: ClipModeInfoModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="clip-mode-info-backdrop" onClick={onClose}>
      <div className="clip-mode-info-modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="clip-mode-info-header">
          <h3>再生モードの種類</h3>
          <button className="clip-mode-info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="clip-mode-info-body">
          <p className="clip-mode-info-intro">
            Kit の各イベントには 3 つの再生モードがあります。
            Event ID は同じでも、Hapbeat デバイス側の扱いが変わります。
          </p>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge fire"><span className="sym">&gt;</span>FIRE</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">デバイス内蔵ファイルを再生</div>
              <p>
                SDK は Event ID と強度だけを小さな UDP コマンドで送ります。
                デバイスは Kit で flash に書き込んだ WAV を自分で再生します。
              </p>
              <ul className="clip-mode-info-pros">
                <li>低遅延・低帯域</li>
                <li>オフラインで動作</li>
                <li>Kit の事前デプロイが必要</li>
              </ul>
            </div>
          </div>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge clip"><span className="sym">♪</span>CLIP</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">SDK が WAV をストリーム</div>
              <p>
                SDK が Kit の WAV を 16 kHz PCM に変換しながら UDP でデバイスに送ります。
                デバイスは受信した音をそのまま鳴らします。
              </p>
              <ul className="clip-mode-info-pros">
                <li>flash 書き換え不要でクリップ差し替え可</li>
                <li>Wi-Fi 帯域とレイテンシに影響</li>
                <li>SDK 側のランタイム処理で強度変更も可能</li>
              </ul>
            </div>
          </div>

          <div className="clip-mode-info-row">
            <div className="clip-mode-info-badge live"><span className="sym">~</span>LIVE</div>
            <div className="clip-mode-info-text">
              <div className="clip-mode-info-title">ライブ音声をそのまま送信</div>
              <p>
                SDK がゲーム内 AudioSource やマイクなどの生音をキャプチャして
                リアルタイムでデバイスにストリームします。Kit に WAV は含まれません。
              </p>
              <ul className="clip-mode-info-pros">
                <li>合成音・環境音などに追従</li>
                <li>Kit に事前クリップを置く必要なし</li>
                <li>Wi-Fi 帯域と同期精度に依存</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="clip-mode-info-footer">
          <button className="library-btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
