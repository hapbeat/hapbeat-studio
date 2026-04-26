import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface KitEntry {
  kit_id: string
  version?: string
  events?: string[]
}

interface Props {
  device: DeviceInfo
  kits?: KitEntry[]
  sendTo: (msg: ManagerMessage) => void
  onPlayEvent: (eventId: string) => void
}

/**
 * Mirrors the Manager's "インストール済み Kit" tree: per-kit list of
 * Event IDs, with refresh / delete + click-to-play on event rows.
 */
export function InstalledKitsSection({ device, kits, sendTo, onPlayEvent }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Default-expand the only kit so the events are visible without an extra click.
  useEffect(() => {
    if (!kits || kits.length === 0) return
    setExpanded((prev) => {
      const next = { ...prev }
      for (const k of kits) if (next[k.kit_id] === undefined) next[k.kit_id] = true
      return next
    })
  }, [kits])

  const refresh = () => sendTo({ type: 'kit_list', payload: {} })

  const remove = (kit_id: string) => {
    if (!confirm(`Kit "${kit_id}" をデバイスから削除しますか？`)) return
    sendTo({ type: 'kit_delete', payload: { kit_id } })
    setTimeout(refresh, 600)
  }

  return (
    <div className="form-section">
      <div
        className="form-section-title"
        style={{ display: 'flex', justifyContent: 'space-between' }}
      >
        <span>インストール済み Kit</span>
        <button
          className="form-button-secondary"
          onClick={refresh}
          disabled={!device.online}
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          ⟳ 一覧取得
        </button>
      </div>

      {!kits ? (
        <div className="form-status muted">
          「⟳ 一覧取得」を押してデバイスから Kit 一覧を読み込んでください。
        </div>
      ) : kits.length === 0 ? (
        <div className="form-status muted">（インストール済み Kit はありません）</div>
      ) : (
        <div className="installed-kits-list">
          {kits.map((k) => {
            const open = expanded[k.kit_id] ?? true
            return (
              <div key={k.kit_id} className="installed-kit">
                <div className="installed-kit-header">
                  <button
                    className="installed-kit-toggle"
                    onClick={() =>
                      setExpanded({ ...expanded, [k.kit_id]: !open })
                    }
                  >
                    {open ? '▾' : '▸'}
                  </button>
                  <span className="installed-kit-name">{k.kit_id}</span>
                  {k.version && (
                    <span className="installed-kit-version">v{k.version}</span>
                  )}
                  <span className="installed-kit-count">
                    {k.events?.length ?? 0} events
                  </span>
                  <button
                    className="form-button-danger wifi-profile-btn"
                    onClick={() => remove(k.kit_id)}
                    disabled={!device.online}
                  >
                    削除
                  </button>
                </div>
                {open && k.events && k.events.length > 0 && (
                  <ul className="installed-kit-events">
                    {k.events.map((ev) => (
                      <li key={ev}>
                        <button
                          className="installed-kit-event-btn"
                          onClick={() => onPlayEvent(ev)}
                          title="クリックで PLAY (選択デバイス)"
                        >
                          {ev}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
