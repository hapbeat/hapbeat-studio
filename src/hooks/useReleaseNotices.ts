/**
 * 更新通知の hook 群。
 *
 * 方針 (hapbeat-contracts specs/release-feed.md §5, DEC-053):
 *  - 出すのは「気付いてほしいが、閉じたら二度と邪魔しない」もの **だけ**
 *  - 情報源が無い / 比較できない場合は何も出さない (失敗を通知しない)
 *  - 「見に行く場所」での常時表示は別 (dismiss 不要なのでここでは扱わない)
 */
import { useEffect, useState } from 'react'
import { loadReleaseFeed, type ReleaseProduct } from '@/config/releaseFeed'
import { CURRENT_STUDIO_VERSION, loadStudioVersions } from '@/utils/studioVersions'
import { useUpdateNotice } from '@/utils/updateNotice'

/**
 * release feed の 1 プロダクトを読む。取得できなければ null のまま。
 * feed 自体はモジュール単位でキャッシュされるので、何箇所から呼んでも
 * ネットワークアクセスは 1 回。
 */
export function useReleaseProduct(productId: string): ReleaseProduct | null {
  const [product, setProduct] = useState<ReleaseProduct | null>(null)

  useEffect(() => {
    let cancelled = false
    loadReleaseFeed().then((feed) => {
      if (!cancelled) setProduct(feed?.products?.[productId] ?? null)
    })
    return () => { cancelled = true }
  }, [productId])

  return product
}

/**
 * helper の更新通知。
 *
 * `MIN_HELPER_VERSION` 未満の「動かなくなる」警告 (App.tsx の既存バナー) とは別物で、
 * こちらは「使えてはいるが新しい版がある」お知らせ。severity=info 相当なので
 * バナーではなくヘッダの小さなチップに留める。
 */
export function useHelperUpdate(helperVersion: string | null) {
  const product = useReleaseProduct('helper')
  const { visible, dismiss } = useUpdateNotice('helper', helperVersion, product?.latest)
  return { product, visible, dismiss }
}

/**
 * 凍結版 (`/vX.Y/`) を開いている時だけ「最新版があります」を知らせる。
 *
 * 最新版デプロイを見ている人には出さない: Web アプリはリロードすれば必ず最新が
 * 来るので「新版が出ました」と伝えても行動が変わらず、ノイズにしかならない。
 * 一方、凍結 URL は**意図的に固定している**人が見ているので、最新が出たことは
 * 1 回だけ伝える価値がある (ロールバック理由が解消しているかもしれない)。
 */
export function useStudioFrozenNotice() {
  const [latest, setLatest] = useState<string | null>(null)
  // BASE_URL が `/vX.Y/` で終わる = 凍結版バンドルを配信している。
  const isFrozen = /v\d+\.\d+\/$/.test(import.meta.env.BASE_URL)

  useEffect(() => {
    if (!isFrozen) return
    let cancelled = false
    loadStudioVersions().then((m) => {
      if (!cancelled) setLatest(m?.latest ?? null)
    })
    return () => { cancelled = true }
  }, [isFrozen])

  const { visible, dismiss } = useUpdateNotice('studio', CURRENT_STUDIO_VERSION, latest)
  return { visible: isFrozen && visible, latest, dismiss }
}
