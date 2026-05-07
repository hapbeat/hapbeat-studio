import { useEffect, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'
import { useLibraryStore } from '@/stores/libraryStore'

type EventEntry = string | { name: string; mode?: string }

interface KitEntry {
  kit_id: string
  version?: string
  events?: EventEntry[]
}

interface Props {
  device: DeviceInfo
  kits?: KitEntry[]
  sendTo: (msg: ManagerMessage) => void
  onPlayEvent: (eventId: string) => void
}

interface NormalizedEvent {
  /** Full event id including kit_id prefix — what the wire format expects. */
  id: string
  /** Display name with the redundant `<kit_id>.` prefix stripped. */
  display: string
  mode: string
}

function normalizeEvents(kit: KitEntry): NormalizedEvent[] {
  const evs = kit.events ?? []
  return evs.map((ev) => {
    const id = typeof ev === 'string' ? ev : ev.name
    const mode = typeof ev === 'string' ? 'command' : (ev.mode ?? 'command')
    const display = id.startsWith(`${kit.kit_id}.`)
      ? id.slice(kit.kit_id.length + 1)
      : id
    return { id, display, mode }
  })
}

const STREAM_MODES = new Set(['stream_clip', 'stream_source'])

/**
 * Mirrors the Manager's "インストール済み Kit" tree: per-kit list of
 * Event IDs, with refresh / delete + click-to-play on event rows.
 *
 * Events are split into FIRE (command) and CLIP (stream) groups.
 * CLIP entries are visually present so users can verify their kit
 * exported correctly, but their PLAY buttons are disabled — those
 * events are only playable via the SDK's UDP stream pipeline, not
 * by the device's installed-clips audio engine.
 */
export function InstalledKitsSection({ device, kits, sendTo, onPlayEvent }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Local Kit library — used to resolve manifest `intensity` per event
  // so the PLAY tooltip can show the wire gain value the user is
  // about to send. Fallback to 1.0 (= 100%) when the eventId isn't in
  // any locally-known Kit.
  const localKits = useLibraryStore((s) => s.kits)
  const intensityForEvent = (eventId: string): number | null => {
    for (const k of localKits) {
      const ev = k.events.find((e) => e.eventId === eventId)
      if (ev && typeof ev.intensity === 'number') return ev.intensity
    }
    return null
  }

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
          style={{ fontSize: 13, padding: '2px 8px' }}
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
            const events = normalizeEvents(k)
            const fireEvents = events.filter((e) => !STREAM_MODES.has(e.mode))
            const clipEvents = events.filter((e) => STREAM_MODES.has(e.mode))
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
                    {events.length} events
                    {clipEvents.length > 0 && ` (FIRE ${fireEvents.length} / CLIP ${clipEvents.length})`}
                  </span>
                  <button
                    className="form-button-danger wifi-profile-btn"
                    onClick={() => remove(k.kit_id)}
                    disabled={!device.online}
                  >
                    削除
                  </button>
                </div>

                {open && (
                  <>
                    {fireEvents.length > 0 && (
                      <div className="installed-kit-group">
                        <div className="installed-kit-group-title">
                          <span className="mode-prefix mode-prefix-fire">&gt;&nbsp;FIRE</span>
                          install-clips ({fireEvents.length})
                        </div>
                        <ul className="installed-kit-events">
                          {fireEvents.map((ev) => {
                            const localIntensity = intensityForEvent(ev.id)
                            const ampPct = localIntensity != null
                              ? Math.round(localIntensity * 100)
                              : null
                            const ampLabel = ampPct != null ? `amp ${ampPct}%` : 'amp ?'
                            return (
                              <li key={ev.id}>
                                <button
                                  className="installed-kit-event-btn"
                                  onClick={() => onPlayEvent(ev.id)}
                                  title={ampPct != null
                                    ? `クリックで PLAY: event_id=${ev.id}, gain=${(localIntensity ?? 1).toFixed(2)} (manifest amp ${ampPct}%)`
                                    : `クリックで PLAY: event_id=${ev.id}, gain=1.0 (manifest 未取得)`}
                                >
                                  <span className="installed-kit-event-name">{ev.display}</span>
                                  <span
                                    className={`installed-kit-event-amp${ampPct == null ? ' missing' : ''}`}
                                  >
                                    {ampLabel}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}

                    {clipEvents.length > 0 && (
                      <div className="installed-kit-group">
                        <div className="installed-kit-group-title">
                          <span className="mode-prefix mode-prefix-clip">♪&nbsp;CLIP</span>
                          stream-clips ({clipEvents.length})
                          <span className="installed-kit-group-hint">
                            {' '}— SDK のストリーム経由でのみ再生されるため、ここからは送信不可
                          </span>
                        </div>
                        <ul className="installed-kit-events">
                          {clipEvents.map((ev) => {
                            const localIntensity = intensityForEvent(ev.id)
                            const ampPct = localIntensity != null
                              ? Math.round(localIntensity * 100)
                              : null
                            const ampLabel = ampPct != null ? `amp ${ampPct}%` : 'amp ?'
                            return (
                              <li key={ev.id}>
                                <button
                                  className="installed-kit-event-btn disabled"
                                  disabled
                                  title={`${ev.id} は CLIP モード（SDK ストリーム経由で再生）${ampPct != null ? ` · manifest amp ${ampPct}%` : ''}`}
                                >
                                  <span className="installed-kit-event-name">{ev.display}</span>
                                  <span
                                    className={`installed-kit-event-amp${ampPct == null ? ' missing' : ''}`}
                                  >
                                    {ampLabel}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}

                    {events.length === 0 && (
                      <div className="form-status muted" style={{ paddingLeft: 22 }}>
                        （events なし）
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
