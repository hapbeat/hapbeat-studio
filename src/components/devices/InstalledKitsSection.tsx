import { useEffect, useMemo, useState } from 'react'
import type { DeviceInfo, ManagerMessage } from '@/types/manager'

/**
 * Event entry shape inside a `kit_list_result` payload.
 *
 * Old firmware (≤ v0.1.x) returns events as **bare strings** or as
 * `{ name, mode }` — no per-event parameters. The UI then has no
 * way to display the manifest-side amp value without falling back
 * to a Studio-local lookup (which doesn't survive browser restart).
 *
 * New firmware (≥ v0.1.3, see
 * `hapbeat-device-firmware/instructions/instructions-kit-list-include-intensity-…`)
 * embeds the manifest's `parameters.*` directly in each event row,
 * so the UI can render amp / loop / device_wiper without any
 * client-side state. `intensity` / `loop` / `device_wiper` are all
 * optional — old firmware drops them, and we degrade to "amp ?"
 * with a one-line banner explaining the version requirement.
 */
type EventEntry =
  | string
  | {
      name: string
      mode?: string
      intensity?: number
      loop?: boolean
      device_wiper?: number
    }

interface KitEntry {
  kit_id: string
  version?: string
  events?: EventEntry[]
}

interface Props {
  device: DeviceInfo
  kits?: KitEntry[]
  sendTo: (msg: ManagerMessage) => void
  /** Plays the event via UDP PLAY broadcast. `intensity` is the
   *  manifest-side amp value from the device's kit_list response —
   *  forwarded so the wire-time gain matches what the panel shows.
   *  `null` when unavailable (old firmware) → DeviceDetail's playEvent
   *  falls back to gain=1.0. */
  onPlayEvent: (eventId: string, intensity: number | null) => void
}

interface NormalizedEvent {
  /** Full event id including kit_id prefix — what the wire format expects. */
  id: string
  /** Display name with the redundant `<kit_id>.` prefix stripped. */
  display: string
  mode: string
  /** Manifest-side amp (0.0–1.0). `null` when the firmware response
   *  didn't include the field (i.e. fw < v0.1.3). */
  intensity: number | null
}

function normalizeEvents(kit: KitEntry): NormalizedEvent[] {
  const evs = kit.events ?? []
  return evs.map((ev) => {
    const id = typeof ev === 'string' ? ev : ev.name
    const mode = typeof ev === 'string' ? 'command' : (ev.mode ?? 'command')
    const intensity = typeof ev === 'string'
      ? null
      : typeof ev.intensity === 'number' ? ev.intensity : null
    const display = id.startsWith(`${kit.kit_id}.`)
      ? id.slice(kit.kit_id.length + 1)
      : id
    return { id, display, mode, intensity }
  })
}

const STREAM_MODES = new Set(['stream_clip'])

/** Minimum firmware version that emits `parameters.intensity` (and
 *  friends) in `kit_list_result` event rows. Bumped here when the
 *  firmware spec for the response shape changes. */
const KIT_LIST_PARAMS_MIN_FW = '0.1.3'

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

  // Detect "old firmware" by checking whether ANY event in the
  // response carried an `intensity` field. If the firmware returns
  // only `{name, mode}` for every event, the panel can't show amp
  // values from device data alone — surface a one-line banner so
  // the user knows to update firmware (≥ v0.1.3).
  //
  // We treat "kits present but all events lack intensity" as the
  // signal — an empty kits array doesn't tell us anything about
  // firmware capabilities.
  const oldFirmware = useMemo(() => {
    if (!kits || kits.length === 0) return false
    const allNormalized = kits.flatMap(normalizeEvents)
    if (allNormalized.length === 0) return false
    return allNormalized.every((e) => e.intensity === null)
  }, [kits])

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

      {oldFirmware && (
        <div
          className="form-status muted"
          style={{
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            background: 'rgba(251, 191, 36, 0.08)',
            color: 'var(--text-secondary)',
            marginBottom: 4,
          }}
          title={
            `Firmware が古いため amp 値が取得できません。\n` +
            `kit_list_result の event 行に parameters.intensity を含める firmware (v${KIT_LIST_PARAMS_MIN_FW} 以上) が必要です。\n` +
            `Manage → Firmware から更新してください。`
          }
        >
          ⚠ amp 値は firmware v{KIT_LIST_PARAMS_MIN_FW} 以上で取得できます (現在 "amp ?" 表示)
        </div>
      )}
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
                            const ampPct = ev.intensity != null
                              ? Math.round(ev.intensity * 100)
                              : null
                            const ampLabel = ampPct != null ? `amp ${ampPct}%` : 'amp ?'
                            return (
                              <li key={ev.id}>
                                <button
                                  className="installed-kit-event-btn"
                                  onClick={() => onPlayEvent(ev.id, ev.intensity)}
                                  title={ampPct != null
                                    ? `クリックで PLAY: event_id=${ev.id}, gain=${(ev.intensity ?? 1).toFixed(2)} (device manifest amp ${ampPct}%)`
                                    : `クリックで PLAY: event_id=${ev.id}, gain=1.0 (firmware が古いため amp 未取得 — v${KIT_LIST_PARAMS_MIN_FW} 以上で device 側から取得可)`}
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
                            const ampPct = ev.intensity != null
                              ? Math.round(ev.intensity * 100)
                              : null
                            const ampLabel = ampPct != null ? `amp ${ampPct}%` : 'amp ?'
                            return (
                              <li key={ev.id}>
                                <button
                                  className="installed-kit-event-btn disabled"
                                  disabled
                                  title={`${ev.id} は CLIP モード（SDK ストリーム経由で再生）${ampPct != null ? ` · device manifest amp ${ampPct}%` : ''}`}
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
