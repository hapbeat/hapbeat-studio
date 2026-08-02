/**
 * Release feed — 全 Hapbeat ツール / SDK の「いま取得できる最新版」。
 *
 * 生成は devtools-site の CI (`scripts/gen-release-feed.mjs`)、仕様は
 * hapbeat-contracts `specs/release-feed.md` (DEC-053)。情報源は GitHub の
 * タグではなく実際の配布チャネル (PyPI / npm / PlatformIO) なので、ここに
 * 出る版は必ず `upgrade` のコマンドで取得できる。
 *
 * Studio がこれを読むのは今のところ **helper** の更新通知のため。
 * - Studio 自身の版 → 同一オリジンの `versions.json` (utils/studioVersions.ts)
 * - デバイスファーム → 既にローカルに持っている firmware manifest
 * どちらも feed より確実な情報源があるので、そちらを優先する。
 *
 * 取得は失敗しても**完全に沈黙**する。Hapbeat は外部ネットワークの無い現場
 * (ルーターのみの展示ブース等) で使われるため、「最新版を取得できません」の
 * 類の通知はノイズにしかならない。
 */

export const RELEASE_FEED_URL = 'https://devtools.hapbeat.com/releases.json'

/** 取得結果のキャッシュ TTL。feed 自体 deploy 単位でしか変わらない。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const CACHE_KEY = 'hapbeat.releaseFeed.cache'
const FETCH_TIMEOUT_MS = 3000

export interface ReleaseProduct {
  name: string
  channel: 'pypi' | 'npm' | 'upm-git' | 'platformio' | 'web'
  /** Canonical semver, no leading "v". */
  latest: string
  published_at?: string
  severity: 'info' | 'recommended'
  /** Upgrade command, or the URL to update to. */
  upgrade?: string
  /** Changelog page. */
  notes?: string
}

export interface ReleaseFeed {
  schema_version: number
  generated_at: string
  products: Record<string, ReleaseProduct>
}

interface CacheEnvelope {
  fetchedAt: number
  feed: ReleaseFeed
}

function readCache(): ReleaseFeed | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const env = JSON.parse(raw) as CacheEnvelope
    if (!env?.feed?.products) return null
    if (Date.now() - env.fetchedAt > CACHE_TTL_MS) return null
    return env.feed
  } catch {
    return null
  }
}

function writeCache(feed: ReleaseFeed) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), feed } satisfies CacheEnvelope))
  } catch {
    /* quota / private mode — キャッシュできないだけなので無視 */
  }
}

// モジュールレベルで in-flight promise を握り、複数コンポーネントから呼ばれても
// ネットワークアクセスは 1 回にする。
let inflight: Promise<ReleaseFeed | null> | null = null

/**
 * feed を取得する。キャッシュが生きていればそれを返す。
 * 失敗時は `null` (呼び出し側は「情報なし = 何も表示しない」を守ること)。
 */
export function loadReleaseFeed(): Promise<ReleaseFeed | null> {
  const cached = readCache()
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(RELEASE_FEED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) return null
      const feed = (await res.json()) as ReleaseFeed
      if (feed?.schema_version !== 1 || !feed?.products) return null
      writeCache(feed)
      return feed
    } catch {
      return null // offline / CORS / timeout — 静かに諦める
    } finally {
      inflight = null
    }
  })()

  return inflight
}
