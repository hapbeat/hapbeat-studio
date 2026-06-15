import { useEffect } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'

/** デバイス書込みコマンド (write_result を返すもの) の日本語ラベル。
 *  結果トーストの文言に使う。未知の cmd は cmd 名そのまま。 */
const WRITE_CMD_LABEL: Record<string, string> = {
  set_name: '名前', set_address: 'アドレス', set_group: 'グループ',
  set_wifi: 'Wi-Fi 設定', clear_wifi: 'Wi-Fi 削除',
  connect_wifi_profile: 'Wi-Fi 接続', remove_wifi_profile: 'Wi-Fi プロファイル削除',
  set_sensor_mapping: 'センサーマッピング', set_broker_host: 'ブローカー設定',
  set_broker_config: 'ブローカー設定', set_recv_topics: '受信トピック',
  set_alert_mode: 'アラート動作', set_espnow_channel: 'ESP-NOW ch',
  set_gain: 'ゲイン', set_input_level: '入力レベル',
  write_ui_config: 'UI 設定', set_oled_brightness: 'OLED 輝度',
  enter_ap_mode: 'AP モード切替', enter_sta_mode: 'STA モード切替',
  set_ap_pass: 'AP パスワード', clear_ap_pass: 'AP パスワード削除',
  reboot: '再起動', kit_delete: 'Kit 削除',
}

/** 即リブートして ACK を返さない可能性が高い cmd。成功トーストはパネル側の
 *  info に任せる (失敗は接続不達として有用なので bridge で出す)。 */
const REBOOT_CMDS = new Set(['reboot', 'enter_ap_mode', 'enter_sta_mode'])

/**
 * デバイス書込み結果 (write_result / ota_result) を **唯一の出どころ** として
 * トースト表示する。各パネルは「送信したから成功」と楽観的に出すのではなく
 * **送信のみ** 行い (anchor は設定する)、実際の結果が来たらここが成功/失敗を
 * 出す。これにより「TCP 失敗なのに成功トースト」を構造的に防ぐ。
 *
 * - `write_result` → success なら成功トースト、failure なら helper の
 *   メッセージ (per-target "TCP 7701 connect failed → 電源入れ直し" 等) 付き
 *   エラートースト。serial も useDeviceTransport が write_result を inject する
 *   ので同経路。
 * - `ota_result` failure / `error` push → エラートースト。
 * - kit deploy は `deploy_result` (別イベント) で KitManager が own するので対象外。
 *
 * App root に 1 度だけマウント。anchor は直前のボタンクリックで各パネルが
 * setAnchor 済みなので、結果トーストもそのボタン近傍に出る。
 */
export function HelperToastBridge() {
  const { lastMessage } = useHelperConnection()
  const { toast } = useToast()

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = (lastMessage.payload ?? {}) as Record<string, unknown>

    if (t === 'write_result') {
      const cmd = String(p.cmd ?? '')
      const label = WRITE_CMD_LABEL[cmd] ?? (cmd || '設定')
      if (p.success === false) {
        // Helper composes a multi-line summary + per-target detail.
        // Toast the headline + first detail so the most useful info is
        // visible without a giant tooltip.
        const msg = String(p.message ?? p.error ?? 'failed')
        const lines = msg.split('\n').map((s) => s.trim()).filter(Boolean)
        const headline = lines[0] ?? msg
        const firstDetail = lines.find((l) => l.startsWith('✗') || l.includes(':'))
        const body = firstDetail && firstDetail !== headline
          ? `${headline} — ${firstDetail.replace(/^✗\s*/, '')}`
          : headline
        toast(`${label}: 失敗 — ${body}`, 'error')
      } else if (!REBOOT_CMDS.has(cmd)) {
        // 実機が受理した時だけ成功トースト (操作ではなく結果ベース)。
        // 即リブート系 (reboot / mode 切替) は ACK 前に再起動して
        // write_result が信頼できないため、パネル側の info トーストに任せる。
        toast(`${label}を反映しました`, 'success')
      }
      return
    }

    if (t === 'ota_result' && p.success === false) {
      const dev = String(p.device ?? '?')
      const msg = String(p.message ?? p.error ?? 'OTA failed')
      toast(`${dev} OTA 失敗: ${msg}`, 'error')
      return
    }

    if (t === 'error') {
      const msg = String(p.message ?? 'helper error')
      toast(`Helper: ${msg}`, 'error')
      return
    }
  }, [lastMessage, toast])

  return null
}
