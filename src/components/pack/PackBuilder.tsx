import { useState, useCallback } from 'react'
import type { EventDefinition } from '@/types/project'
import './PackBuilder.css'

export function PackBuilder() {
  const [events, setEvents] = useState<EventDefinition[]>([])
  const [newEventId, setNewEventId] = useState('')
  const [newIntensity, setNewIntensity] = useState(1.0)

  const handleAddEvent = useCallback(() => {
    if (!newEventId.trim()) return
    if (events.some((e) => e.eventId === newEventId.trim())) {
      alert('同じ Event ID は登録できません。')
      return
    }
    const event: EventDefinition = {
      eventId: newEventId.trim(),
      intensity: newIntensity,
      loop: false,
    }
    setEvents((prev) => [...prev, event])
    setNewEventId('')
    setNewIntensity(1.0)
  }, [newEventId, newIntensity, events])

  const handleDeleteEvent = useCallback((eventId: string) => {
    setEvents((prev) => prev.filter((e) => e.eventId !== eventId))
  }, [])

  const handleToggleLoop = useCallback((eventId: string) => {
    setEvents((prev) =>
      prev.map((e) => (e.eventId === eventId ? { ...e, loop: !e.loop } : e))
    )
  }, [])

  const handleExport = useCallback(() => {
    if (events.length === 0) {
      alert('エクスポートするイベントがありません。')
      return
    }
    // Kit ビルドは将来的に JSZip で実装
    alert('Kit エクスポート機能は準備中です。')
  }, [events])

  return (
    <div className="pack-builder">
      <div className="pack-builder-main">
        {/* イベント一覧 */}
        <div className="panel">
          <div className="panel-title">イベント定義</div>

          {/* 追加フォーム */}
          <div className="event-add-form">
            <div className="config-field">
              <label className="label">Event ID</label>
              <input
                type="text"
                className="input mono"
                placeholder="例: hit_strong"
                value={newEventId}
                onChange={(e) => setNewEventId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddEvent()
                }}
              />
            </div>
            <div className="config-field">
              <label className="label">Intensity</label>
              <input
                type="number"
                className="input mono"
                value={newIntensity}
                min={0}
                max={1}
                step={0.1}
                onChange={(e) => setNewIntensity(parseFloat(e.target.value) || 0)}
              />
            </div>
            <button className="btn btn-primary" onClick={handleAddEvent}>
              追加
            </button>
          </div>

          {/* イベントリスト */}
          {events.length > 0 ? (
            <div className="event-list">
              <div className="event-list-header">
                <span className="event-col-id">Event ID</span>
                <span className="event-col-gain">Intensity</span>
                <span className="event-col-loop">ループ</span>
                <span className="event-col-clip">クリップ</span>
                <span className="event-col-actions">操作</span>
              </div>
              {events.map((event) => (
                <div key={event.eventId} className="event-row">
                  <span className="event-col-id mono">{event.eventId}</span>
                  <span className="event-col-gain mono">{event.intensity.toFixed(1)}</span>
                  <span className="event-col-loop">
                    <button
                      className={`loop-toggle ${event.loop ? 'active' : ''}`}
                      onClick={() => handleToggleLoop(event.eventId)}
                    >
                      {event.loop ? 'ON' : 'OFF'}
                    </button>
                  </span>
                  <span className="event-col-clip mono">
                    {event.clipFile ?? '(未設定)'}
                  </span>
                  <span className="event-col-actions">
                    <button
                      className="btn btn-sm"
                      style={{ color: 'var(--error)' }}
                      onClick={() => handleDeleteEvent(event.eventId)}
                    >
                      削除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="event-empty">
              イベントが定義されていません。上のフォームからイベントを追加してください。
            </div>
          )}
        </div>

        {/* エクスポート */}
        <div className="panel">
          <div className="panel-title">Kit エクスポート</div>
          <div className="pack-export-section">
            <div className="pack-export-info">
              定義されたイベントと設定を Hapbeat Kit ファイル (.hapbeat-kit)
              としてエクスポートします。
            </div>
            <div className="pack-export-stats mono">
              イベント数: {events.length}
            </div>
            <button className="btn btn-primary" onClick={handleExport}>
              Kit をエクスポート
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
