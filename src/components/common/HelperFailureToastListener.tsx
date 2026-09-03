import { useEffect } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'

/** デバイス書込みコマンド (write_result を返すもの) の日本語ラベル。
 *  結果トーストの文言に使う。未知の cmd は cmd 名そのまま。 */
const WRITE_CMD_LABEL: Record<string, MessageId> = {
  set_name: 'toast.command.name', set_address: 'toast.command.address',
  set_wifi: 'toast.command.wifi', clear_wifi: 'toast.command.wifiDelete',
  connect_wifi_profile: 'toast.command.wifiConnect', remove_wifi_profile: 'toast.command.wifiProfileDelete',
  set_sensor_mapping: 'toast.command.sensorMapping', set_broker_host: 'toast.command.broker', set_broker_config: 'toast.command.broker', set_recv_topics: 'toast.command.receiveTopics',
  set_alert_mode: 'toast.command.alertMode', set_espnow_channel: 'toast.command.espnowChannel', set_espnow_stream_gain: 'toast.command.gain', set_espnow_stream_input_level: 'toast.command.inputLevel', set_espnow_stream_ui: 'toast.command.power',
  write_ui_config: 'toast.command.ui', set_oled_brightness: 'toast.command.oledBrightness', enter_ap_mode: 'toast.command.apMode', enter_sta_mode: 'toast.command.apMode',
  set_ap_pass: 'toast.command.apPassword', clear_ap_pass: 'toast.command.apPasswordDelete', reboot: 'toast.command.reboot', kit_delete: 'toast.command.kitDelete',
  set_haptic_gain: 'toast.command.hapticGain', set_dac_boost: 'toast.command.dacBoost', set_headphone_volume: 'toast.command.headphoneVolume', set_stream_buffer: 'toast.command.streamBuffer', set_input_mode: 'toast.command.inputMode',
  set_espnow_stream_opus_complexity: 'toast.command.opusComplexity', set_espnow_stream_hp_buffer: 'toast.command.hpJitterBuffer', set_eq_band: 'toast.command.eqBand', set_av_delay: 'toast.command.avDelay',
}

/** 即リブートして ACK を返さない可能性が高い cmd。成功トーストはパネル側の
 *  info に任せる (失敗は接続不達として有用なので listener で出す)。 */
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
export function HelperFailureToastListener() {
  const { t: translate } = useI18n()
  const { lastMessage } = useHelperConnection()
  const { toast } = useToast()

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = (lastMessage.payload ?? {}) as Record<string, unknown>

    if (t === 'write_result') {
      const cmd = String(p.cmd ?? '')
      const label = WRITE_CMD_LABEL[cmd] ? translate(WRITE_CMD_LABEL[cmd]) : (cmd || translate('toast.command.default'))
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
        toast(translate('toast.writeFailed', { label, body }), 'error')
      } else if (!cmd) {
        // preview_event / stop は config write ではなく fire-and-forget の
        // ブロードキャスト *コマンド*。helper はログ用に write_result を返すが
        // `cmd` を持たず、device ACK も無い。これを「設定を反映しました」と
        // 出すのは誤り (bug 2026-06-24) なので「送信」と表現する。
        toast(translate('toast.commandSent'), 'info')
      } else if (!REBOOT_CMDS.has(cmd)) {
        // 実機が受理した時だけ成功トースト (操作ではなく結果ベース)。
        // 即リブート系 (reboot / mode 切替) は ACK 前に再起動して
        // write_result が信頼できないため、パネル側の info トーストに任せる。
        toast(translate('toast.writeApplied', { label }), 'success')
      }
      return
    }

    if (t === 'ota_result' && p.success === false) {
      const dev = String(p.device ?? '?')
      const msg = String(p.message ?? p.error ?? 'OTA failed')
      toast(translate('toast.otaFailed', { device: dev, message: msg }), 'error')
      return
    }

    if (t === 'error') {
      const msg = String(p.message ?? 'helper error')
      toast(translate('toast.helperError', { message: msg }), 'error')
      return
    }
  }, [lastMessage, toast, translate])

  return null
}
