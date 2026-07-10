import { useEffect } from 'react'

export interface UsbInfoModalProps {
  onClose: () => void
}

/**
 * "USB カードの見方" modal — the legend that used to sit inline under the
 * cards (poor visibility) / then as a popover (pushed cards down). Now a
 * proper modal opened by the ⓘ button, styled like the other info modals
 * (same chrome as ClipModeInfoModal). Content only — no state.
 *
 * Keep the chip labels/symbols in sync with UsbPortCard (☑ checkbox = flash
 * target, ⚙ 設定 = config-connect, ↻ 識別 = probe, ✕ = close card).
 */
export function UsbInfoModal({ onClose }: UsbInfoModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="usb-info-backdrop" onClick={onClose}>
      <div className="usb-info-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="USB カードの見方">
        <div className="usb-info-header">
          <h3>USB Serial カードの見方</h3>
          <button className="usb-info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="usb-info-body">
          <p className="usb-info-intro">
            USB カードには「書き込み対象の選択」と「設定接続」という 2 つの独立した操作があります。
            COM ポート名はブラウザから取得できないため、<b>#番号</b> と識別結果でカードを区別します。
          </p>

          <div className="usb-info-row">
            <span className="usb-info-chip select">☑ チェック</span>
            <div>
              <b>書き込み対象</b>に選ぶ操作。複数チェックできます（Firmware タブで一斉書き込み）。
              <span className="usb-info-note">書き込みはこのチェックだけで OK — 「⚙ 設定」接続は不要です。</span>
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip conn">⚙ 設定</span>
            <div>
              <b>設定接続</b>（get_info / Wi-Fi 設定など）。<b>1 台ずつ</b>で、接続中はカード枠が<b>緑</b>になります。
              別のカードを設定 ON にすると、前のカードは自動で OFF になります。
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip probe">↻ 識別</span>
            <div>
              情報取得（get_info）だけを実行します。<b>USB を繋ぐと自動でも走ります</b>ので、通常は押す必要はありません。
            </div>
          </div>

          <div className="usb-info-row">
            <span className="usb-info-chip close">✕</span>
            <div>
              カードを閉じます（COM ポートの許可を取り消し）。通常は不要 — <b>抜けば消えます</b>。
              Hapbeat 以外の COM を誤って追加したときの削除用です。
            </div>
          </div>
        </div>

        <div className="usb-info-footer">
          <button className="form-button" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
