/**
 * Hapbeat 本体 (装着型) か否かの board 判定。
 *
 * board 文字列は get_info（→ infoCache）由来。`duo_wl_*` / `band_wl_*` が
 * Hapbeat 本体で、それ以外（sensor / broker などの周辺機器）は非 Hapbeat。
 * UI 設定 (display layout) は Hapbeat 本体専用なので、選択可否や Hapbeat
 * タグの判定に使う。
 *
 * 注意: receiver ロールでも board が非 Hapbeat のことがある（第三者機器が
 * 受信機になる場合）。役割ではなく board で判定すること。
 *
 * DeviceList（タグ/選択不可）と DisplayEditor（書込フィルタ）の両方から
 * 参照する単一の真実。ロジックを 2 箇所に複製してドリフトさせない。
 */
export function isHapbeatBoard(board?: string): boolean {
  return !!board && (board.startsWith('duo_wl') || board.startsWith('band_wl'))
}

/**
 * 「非 Hapbeat と確定している」board のみ true。board 未取得（undefined /
 * 'unknown'）は false を返す＝安全側（未 probe のデバイスを誤ってブロック
 * しない / 書込対象から外さない）。
 */
export function isKnownNonHapbeatBoard(board?: string): boolean {
  return !!board && board !== 'unknown' && !isHapbeatBoard(board)
}
