/**
 * 更新通知の表示可否 — 「1 版につき 1 回だけ」を実装する共通ロジック。
 *
 * hapbeat-contracts `specs/release-feed.md` §5.1 (DEC-053):
 *   ユーザーが通知を閉じたら、その版に対しては二度と表示しない。
 *   より新しい版が出たら、また 1 回だけ表示してよい。
 *
 * セッション単位の抑制にしない理由: 意図的に版を固定して開発している人にとって、
 * 起動のたびに同じ通知を手で閉じさせるのは純粋なノイズだから。閉じた版を
 * localStorage に永続化し、それより新しい版が出るまで黙る。
 *
 * 「見に行く場所」(HelperManageModal / Firmware タブ / デバイス詳細) の常時表示は
 * この抑制の対象外 — ユーザーが能動的に開いた画面なので邪魔にならない。
 */
import { useCallback, useMemo, useState } from 'react'
import { compareVersion } from '@/config/helperCompat'

const KEY_PREFIX = 'hapbeat.updateNotice.'

/** 直近に「閉じた」版を読む。未 dismiss / 破損時は null。 */
export function getDismissedVersion(product: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + product)
  } catch {
    return null
  }
}

/** その版について通知済みとして記録する。 */
export function dismissVersion(product: string, version: string) {
  try {
    localStorage.setItem(KEY_PREFIX + product, version)
  } catch {
    /* private mode 等。抑制できないだけなので握る */
  }
}

/**
 * `latest` を通知すべきか。
 * - `latest` が無い (feed 未取得) → false
 * - dismiss 済みの版と同じか古い → false
 */
export function shouldNotify(product: string, latest: string | null | undefined): boolean {
  if (!latest) return false
  const dismissed = getDismissedVersion(product)
  if (!dismissed) return true
  return compareVersion(latest, dismissed) > 0
}

/**
 * 「更新あり」表示の状態を返す hook。
 *
 * @param product  永続化キー ('helper' / 'studio' 等)
 * @param current  いま動いている版 (不明なら null — 比較できないので通知しない)
 * @param latest   利用可能な最新版 (feed 未取得なら null)
 */
export function useUpdateNotice(
  product: string,
  current: string | null | undefined,
  latest: string | null | undefined,
) {
  // dismiss 済み版を state に持ち、閉じた瞬間に再描画する。初期値は
  // localStorage から 1 回だけ読む (以後の外部変更は追わない)。
  const [dismissed, setDismissed] = useState<string | null>(() => getDismissedVersion(product))

  const outdated = useMemo(() => {
    if (!current || !latest) return false
    return compareVersion(current, latest) < 0
  }, [current, latest])

  const visible = useMemo(() => {
    if (!outdated || !latest) return false
    if (!dismissed) return true
    return compareVersion(latest, dismissed) > 0
  }, [outdated, latest, dismissed])

  const dismiss = useCallback(() => {
    if (!latest) return
    dismissVersion(product, latest)
    setDismissed(latest)
  }, [product, latest])

  return { visible, outdated, dismiss }
}
