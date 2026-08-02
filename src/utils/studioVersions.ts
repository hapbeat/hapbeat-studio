/**
 * Studio 自身の版一覧 (`versions.json`) の取得。
 *
 * CI がリリース毎に生成し、デプロイルート直下に 1 つだけ置かれる
 * (凍結版 dir の中ではない — 旧版からでも最新の一覧を読めるように)。
 * `VersionSwitcher` (ロールバック UI) と更新通知の両方が読むため、
 * モジュールレベルで promise をキャッシュして取得は 1 回に抑える。
 *
 * Studio 自身の版だけは release feed ではなくこれを見る: 同一オリジンで
 * CORS もオフラインリスクも無く、「実際にデプロイされている版」という
 * 意味でも feed より直接的なため。
 */

export interface VersionEntry {
  version: string
  path: string
}

export interface VersionsManifest {
  latest: string | null
  versions: VersionEntry[]
  generated?: string
}

/**
 * デプロイルート (= versions.json と各凍結版 dir が並ぶ場所)。
 *
 * `import.meta.env.BASE_URL` はその「ビルドの」base なので、最新版は `/`
 * (studio.hapbeat.com)、凍結版は `/vX.Y/` になる。versions.json は凍結版 dir の
 * *中* ではなくデプロイルート直下に置かれるため、base から末尾の `vX.Y/`
 * セグメントを剥がした値がデプロイルート。
 */
export const DEPLOY_ROOT = import.meta.env.BASE_URL.replace(/v\d+\.\d+\/$/, '')

let inflight: Promise<VersionsManifest | null> | null = null
let cached: VersionsManifest | null | undefined

/** dev / 未配信時は null。呼び出し側は「情報なし」として扱うこと。 */
export function loadStudioVersions(): Promise<VersionsManifest | null> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (inflight) return inflight

  inflight = fetch(`${DEPLOY_ROOT}versions.json`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<VersionsManifest>) : null))
    .then((m) => {
      cached = m?.versions ? m : null
      return cached
    })
    .catch(() => {
      cached = null
      return null
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** build 時に注入された、いま動いている版。 */
export const CURRENT_STUDIO_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'
