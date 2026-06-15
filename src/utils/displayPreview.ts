import type { DisplayElementType } from '@/types/display'

/** シミュレーション状態
 *  - player / group はボタン操作で増減 (player_inc/dec, group_inc/dec)
 *  - position は設定で決まる固定値 (ボタン操作対象外) なのでサンプル表示用
 *  - volume / volumeAdcEnabled は volume / vib_mode 系ボタンで変化
 */
export interface SimState {
  player: number
  group: number
  position: number
  volume: number
  volumeAdcEnabled: boolean
}

export const DEFAULT_SIM_STATE: SimState = {
  player: 0,
  group: 0,
  position: 0,
  volume: 5,
  volumeAdcEnabled: true,
}

/**
 * 全角 (East-Asian Wide / Fullwidth) 判定。
 *
 * device 側 efont は日本語 1 文字を 16px = 2 グリッドセル (1 セル=8px) で
 * 描画する。プレビューの 1 文字=1 セル前提を崩すので、文字ごとに占有
 * セル数を出して padding / clip / 描画幅を合わせる。
 * 範囲はひらがな・カタカナ・漢字・全角記号 (Japanese 主要域) をカバー。
 */
export function charCells(ch: string): 1 | 2 {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return 1
  if (
    (cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) || // CJK 部首・康熙・記号
    (cp >= 0x3041 && cp <= 0x33FF) || // ひらがな・カタカナ・CJK 記号
    (cp >= 0x3400 && cp <= 0x4DBF) || // CJK 拡張 A
    (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK 統合漢字
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul 音節
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK 互換漢字
    (cp >= 0xFE30 && cp <= 0xFE4F) || // CJK 互換形
    (cp >= 0xFF00 && cp <= 0xFF60) || // 全角英数・記号
    (cp >= 0xFFE0 && cp <= 0xFFE6)
  ) {
    return 2
  }
  return 1
}

/** 文字列の占有セル数 (全角=2, 半角=1)。device の width*8px と対応。 */
export function textCells(str: string): number {
  let n = 0
  for (const ch of str) n += charCells(ch)
  return n
}

/**
 * セル数基準で clip → 末尾スペース pad して、ちょうど `cells` セル幅に揃える。
 * 全角がセル境界を跨ぐ場合はその文字を入れず手前で切る (半文字描画を防ぐ)。
 * device の `width*8px` ピクセルクリップと一致する。
 */
export function padClipToCells(str: string, cells: number): string {
  let out = ''
  let used = 0
  for (const ch of str) {
    const c = charCells(ch)
    if (used + c > cells) break
    out += ch
    used += c
  }
  return out + ' '.repeat(Math.max(0, cells - used))
}

/**
 * ファームウェア準拠のプレビューテキスト
 *
 * 重要: 文字数 = getElementSize() の幅と一致させること
 * 1文字 = 1グリッドセル = 8px
 */
export function getElementPreviewText(type: DisplayElementType, simState?: SimState, variant?: string, text?: string): string {
  const s = simState ?? DEFAULT_SIM_STATE
  switch (type) {
    case 'volume':            return `vol:${String(s.volume).padStart(2, '0')}`   // 6文字
    case 'volume_mode':       return s.volumeAdcEnabled ? 'Var' : 'Fix'          // 3文字
    case 'battery':
      if (variant === 'bar') return 'BAT\u2588\u2588\u2588\u2588\u2581'          // 8文字 (bar meter)
      return ' 85%'                                                               // 4文字 (percent)
    case 'wifi_status':       return 'W:---'                                     // 5文字 (padding)
    case 'wifi_ssid': {
      // 4/8/16 variant 対応。サンプル SSID 'MyAccessPoint01' を左から N 文字。
      const sample = 'MyAccessPoint01'
      if (variant === 'compact') return sample.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return sample.padEnd(16, ' ').slice(0, 16)
      return sample.padEnd(8, ' ').slice(0, 8)
    }
    case 'connection_status': return '[--]'                                      // 4文字
    case 'ip_address': {
      // 同 LAN は 192.168.x や 10.0.x のように前半オクテットが基本被るため、
      // **右から N 文字** で切出すと重要部分 (末尾 1-2 オクテット) を残せる。
      // compact=4 (".147"), standard=6 (".0.147"), wide=13 (フル "192.168.0.147")
      const sample = '192.168.0.147'
      const pickRight = (n: number) => sample.length >= n
        ? sample.slice(-n)
        : sample.padStart(n, ' ')
      if (variant === 'compact') return pickRight(4)
      if (variant === 'wide')    return pickRight(13)
      return pickRight(6)
    }
    case 'firmware_version': {
      // device 側は左 truncate / 右 pad で width に追従。
      // compact (6) = 'v0.1.0' (= 6 chars exact)
      // standard (8) = ' v0.1.0' を pad で 8 にする (右寄せ風)
      const sample = 'v0.1.0'
      if (variant === 'compact') return sample.padEnd(6, ' ').slice(0, 6)
      // 標準 8 chars: 左に space 2 個入れて見た目右寄せ風
      return sample.padStart(8, ' ').slice(0, 8)
    }
    case 'device_name': {
      // 設定された dev_name (NVS) を左から N 文字で切出し / 右 pad。
      // compact = 4 ('Duo1') / standard = 5 ('Duo-1') / wide = 16 (フル)
      const sample = 'MyHapbeat-Neck01'
      if (variant === 'compact') return sample.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return sample.padEnd(16, ' ').slice(0, 16)
      return sample.padEnd(8, ' ').slice(0, 8)
    }
    case 'app_name':
      // CONNECT_STATUS payload の app_name (Unity SDK 等が送信)。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      if (variant === 'compact') return 'N.C.'                                   // 4文字
      if (variant === 'wide')    return 'App: unconnected'                       // 16文字
      return 'App N.C.'                                                          // 8文字
    case 'player_number':     return `P:${String(s.player).padStart(2, '0')}`    // 4文字
    case 'position': {
      // NVS の `pos_xxx` 名を表示 (数値ではない)。サンプル `pos_l_wrist` を
      // 4/8/16 variant に成形する。
      //   compact (4) = name 部のみ truncate (e.g. 'l_wr')
      //   standard (8) = `pos:` + name 4 字 (e.g. 'pos:l_wr')
      //   wide (16)    = `pos: ` + full name pad (e.g. 'pos: l_wrist    ')
      const sample = 'pos_l_wrist'
      const name = sample.startsWith('pos_') ? sample.slice(4) : sample
      if (variant === 'compact') return name.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return `pos: ${name}`.padEnd(16, ' ').slice(0, 16)
      return `pos:${name}`.padEnd(8, ' ').slice(0, 8)
    }
    case 'page_indicator':    return '1/2'                                       // 3文字
    case 'group_id':          return `Gr:${String(s.group).padStart(2, '0').slice(-2)}` // 5文字 (Gr:01〜Gr:99)
    case 'address': {
      // address は player_ より前の prefix 部分のみ表示。
      // variant でプレビュー文字数を切替: compact=4 / standard=8 / wide=16
      // NVS は通常 `<prefix>/player_N/pos_xxx` 形式。prefix が無い
      // (`player_N/...` 形式 or 未設定) 場合は [unset] にフォールバックして
      // player_N が漏れて表示されないようにする (firmware 側も同 rule)。
      const fullSample = 'red/alpha/player_5/pos_neck'
      const idx = fullSample.indexOf('/player_')
      const headBeforePlayer = idx < 0
        ? (fullSample.startsWith('player_') ? '' : fullSample)
        : fullSample.slice(0, idx)
      const isUnset = headBeforePlayer.length === 0
      const text = isUnset
        ? (variant === 'compact' ? 'none'
          : variant === 'wide'    ? '[unset prefix]'
          :                         '[unset]')
        : headBeforePlayer
      if (variant === 'compact') return text.padEnd(4, ' ').slice(0, 4)
      if (variant === 'wide')    return text.padEnd(16, ' ').slice(0, 16)
      return text.padEnd(8, ' ').slice(0, 8)
    }
    case 'custom_text': {
      // 任意テキストを要素幅 (compact=4 / standard=8 / wide=16 セル) に
      // pad/clip。全角を含み得るので「セル幅 = getElementSize() の幅」で
      // 揃える (device の width*8px クリップと一致。全角は 2 セル消費)。
      const w = variant === 'compact' ? 4 : variant === 'wide' ? 16 : 8
      const txt = (text ?? '').trim() || 'テキスト'
      return padClipToCells(txt, w)
    }
    case 'alert_limit_mode': {
      // 受信制限モード。プレビューは既定 OFF(全て再生) の状態を表示。
      // compact = 全て (4 セル) / standard = 全て再生 (8 セル) を
      // 要素幅 (4/10 セル) にセル基準で pad。全角=2 セル。
      const w = variant === 'compact' ? 4 : 10
      const txt = variant === 'compact' ? '全て' : '全て再生'
      return padClipToCells(txt, w)
    }
    case 'mqtt_status': return '[NG]'  // 4文字。ブローカー未接続 (既定) を表示
  }
}

/** パレット表示用の説明文 */
export function getElementDescription(type: DisplayElementType): string {
  switch (type) {
    case 'volume':            return 'vol:00'
    case 'volume_mode':       return 'Fix/Var'
    case 'battery':           return 'XX%'
    case 'wifi_status':       return 'W:dBm'
    case 'wifi_ssid':         return 'SSID 左 N 文字'
    case 'connection_status': return '[OK]app'
    case 'ip_address':        return 'IP 右 N 文字'
    case 'firmware_version':  return 'FW ver'
    case 'device_name':       return 'Name'
    case 'app_name':          return 'App名'
    case 'address':           return 'prefix'
    case 'player_number':     return 'P:XX'
    case 'position':          return 'pos:xxx'
    case 'page_indicator':    return 'N/N'
    case 'group_id':          return 'Gr:XX'
    case 'custom_text':       return 'テキスト'
    case 'alert_limit_mode':  return '制限/全て'
    case 'mqtt_status':       return '[OK]/[NG]'
  }
}
