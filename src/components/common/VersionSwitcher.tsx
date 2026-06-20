import { useEffect, useState } from 'react'
import './VersionSwitcher.css'

interface VersionEntry { version: string; path: string }
interface VersionsManifest { latest: string | null; versions: VersionEntry[]; generated?: string }

/**
 * Studio バージョン表示 + ロールバック用の版切替。
 *
 * 現在の版は build 時に注入された `VITE_APP_VERSION`。利用可能な凍結版は
 * `/studio/versions.json`（リリース毎に CI が生成）から取得し、`<select>` で
 * `/studio/v<X.Y>/`（マイナー単位の凍結 dir）へ移動できる。新マイナーに不具合が
 * 出ても、ユーザーは旧マイナー線へ即戻れる（URL が永続的なロールバック手段で、
 * このスイッチャはその導線）。dev / versions.json 未配信時は現在版のみ表示。
 */
export function VersionSwitcher({ compact = false }: { compact?: boolean }) {
  const current = import.meta.env.VITE_APP_VERSION || '0.0.0'
  const [versions, setVersions] = useState<VersionEntry[]>([])

  useEffect(() => {
    let cancelled = false
    // host-absolute path: `/studio/` 直下でも `/studio/vX.Y/` 配下でも同じ
    // 場所を指す。dev (base `/`) では 404 → catch で無視し現在版のみ表示。
    fetch('/studio/versions.json', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<VersionsManifest>) : null))
      .then((m) => { if (!cancelled && m?.versions) setVersions(m.versions) })
      .catch(() => { /* dev / 未配信時は無視 */ })
    return () => { cancelled = true }
  }, [])

  const onPick = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const path = e.target.value
    if (path) window.location.assign(path)
  }

  // ---- compact: ヘッダのバージョンバッジ自体をプルダウン化 -------------------
  // 初見でも「ここで版を切り替えられる」と分かるよう、タイトル横の版を
  // そのまま選択式にする。versions.json が無い (dev) 時は静的バッジ。
  if (compact) {
    if (versions.length === 0) {
      return <span className="app-version-badge" title="Studio バージョン">v{current}</span>
    }
    // If the running build isn't one of the listed frozen releases (e.g. a
    // master/dev build whose version is ahead of the latest tag), a bare
    // `<select value="">` would silently DISPLAY its first <option> — which
    // misreports the version (e.g. shows "v0.2.0" while actually running
    // 0.2.1). Prepend a synthetic, non-navigable "current" entry so the badge
    // always shows the real running version.
    //
    // Also drop any listed entry that points at the SAME minor dir as the
    // running build (e.g. a lagging "0.2.0 → /studio/v0.2/" row while we
    // actually run 0.2.1 from the same minor line) so the same /studio/vX.Y/
    // doesn't appear twice in the dropdown.
    const hasCurrent = versions.some((v) => v.version === current)
    const currentMinorPath = `/studio/v${current.split('.').slice(0, 2).join('.')}/`
    const options = hasCurrent
      ? versions
      : [{ version: current, path: '' }, ...versions.filter((v) => v.path !== currentMinorPath)]
    const currentValue = options.find((v) => v.version === current)?.path ?? ''
    return (
      <select
        className="app-version-badge app-version-select"
        value={currentValue}
        onChange={onPick}
        aria-label="Studio バージョンを切り替え"
        title="バージョンを選んで切替（旧版にロールバック）"
      >
        {options.map((v) => (
          <option key={v.version} value={v.path}>
            v{v.version}{v.version === current ? '（現在）' : ''}
          </option>
        ))}
      </select>
    )
  }

  return (
    <div className="version-switcher">
      <span className="version-switcher-label">
        Studio <strong>v{current}</strong>
      </span>
      {versions.length > 0 && (
        <label className="version-switcher-pick">
          版を切替:
          <select value="" onChange={onPick} aria-label="Studio バージョンを切り替え">
            <option value="" disabled>選択…</option>
            {versions.map((v) => (
              <option key={v.version} value={v.path}>
                v{v.version}{v.version === current ? '（現在）' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
