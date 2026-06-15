import { useEffect, useState } from 'react'
import './VersionSwitcher.css'

interface VersionEntry { version: string; path: string }
interface VersionsManifest { latest: string | null; versions: VersionEntry[]; generated?: string }

/**
 * Studio バージョン表示 + ロールバック用の版切替。
 *
 * 現在の版は build 時に注入された `VITE_APP_VERSION`。利用可能な凍結版は
 * `/studio/versions.json`（リリース毎に CI が生成）から取得し、`<select>` で
 * `/studio/v<X.Y.Z>/` へ移動できる。新版に不具合が出ても、ユーザーは旧
 * immutable 版へ即戻れる（URL 自体が永続的なロールバック手段で、この
 * スイッチャはその導線）。dev / versions.json 未配信時は現在版のみ表示。
 */
export function VersionSwitcher() {
  const current = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
  const [versions, setVersions] = useState<VersionEntry[]>([])

  useEffect(() => {
    let cancelled = false
    // host-absolute path: `/studio/` 直下でも `/studio/vX.Y.Z/` 配下でも同じ
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
