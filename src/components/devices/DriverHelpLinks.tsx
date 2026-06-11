/**
 * USB-serial driver download links for non-S3 nodes.
 *
 * A missing driver can't be detected from the browser: the OS never
 * creates a COM port, so the device simply doesn't appear in the Web
 * Serial picker (indistinguishable from "not plugged in"). The best we
 * can do is point the user at the right installers when their device
 * doesn't show up. Hapbeat wearables (ESP32-S3) use native USB and
 * need no driver; only the classic-ESP32 peripherals do.
 */
export function DriverHelpLinks() {
  return (
    <details className="driver-help">
      <summary>ポート選択にデバイスが表示されない場合（USB ドライバ）</summary>
      <div className="driver-help-body">
        <p>
          Hapbeat 本体（ESP32-S3）はドライバ不要です。周辺機器
          （M5 ATOM Lite / M5Stack Basic など）は USB-Serial ドライバの
          インストールが必要な場合があります:
        </p>
        <ul>
          <li>
            <a href="https://ftdichip.com/drivers/vcp-drivers/" target="_blank" rel="noreferrer">
              FTDI VCP ドライバ
            </a>
            {' '}— M5 ATOM Lite
          </li>
          <li>
            <a href="https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers" target="_blank" rel="noreferrer">
              Silicon Labs CP210x ドライバ
            </a>
            {' '}— M5Stack Basic など
          </li>
          <li>
            <a href="https://docs.m5stack.com/en/download" target="_blank" rel="noreferrer">
              M5Stack 公式ドライバ一覧
            </a>
            {' '}— CH9102 等その他のチップ
          </li>
        </ul>
        <p className="driver-help-note">
          インストール後、USB ケーブルを挿し直してから再度ポート選択してください。
        </p>
      </div>
    </details>
  )
}
