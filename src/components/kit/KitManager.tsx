import { useEffect, useCallback, useState, useRef } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import { useToast } from '@/components/common/Toast'
import { formatDuration, formatFileSize } from '@/utils/wavIO'
import { exportKitAsPack, downloadBlob, validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, KitEvent } from '@/types/library'
import './KitManager.css'

export function KitManager() {
  const isLoading = useLibraryStore((s) => s.isLoading)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  if (isLoading) {
    return (
      <div className="kit-manager">
        <div className="kit-loading">読み込み中...</div>
      </div>
    )
  }

  return (
    <div className="kit-manager">
      <div className="kit-manager-left">
        <ClipLibrary />
      </div>
      <div className="kit-manager-right">
        <KitEditor />
      </div>
    </div>
  )
}

// ---- Clip Library (Left Panel) ----

function ClipLibrary() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const clips = useLibraryStore((s) => s.clips)
  const filter = useLibraryStore((s) => s.filter)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const addClipFromFile = useLibraryStore((s) => s.addClipFromFile)
  const removeClip = useLibraryStore((s) => s.removeClip)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const allTags = useLibraryStore((s) => s.allTags)
  const allGroups = useLibraryStore((s) => s.allGroups)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragOverActive, setDragOverActive] = useState(false)

  const displayed = filteredClips()
  const tags = allTags()
  const groups = allGroups()

  const handleImport = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        await addClipFromFile(file)
      } catch (err) {
        console.error(`Failed to import ${file.name}:`, err)
      }
    }
  }, [addClipFromFile])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOverActive(false)
      if (e.dataTransfer.files.length > 0) {
        handleImport(e.dataTransfer.files)
      }
    },
    [handleImport]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOverActive(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverActive(false)
  }, [])

  return (
    <div
      className={`clip-library ${dragOverActive ? 'drag-over' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="library-header">
        <h3>Clip Library</h3>
        <span className="library-count">{clips.length} clips</span>
      </div>

      {/* Toolbar: search + import */}
      <div className="library-toolbar">
        <input
          type="text"
          className="library-search"
          placeholder="Search..."
          value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,.mp3,.ogg,.flac,.aac,.m4a,audio/*"
          multiple
          onChange={(e) => e.target.files && handleImport(e.target.files)}
          style={{ display: 'none' }}
        />
        <button
          className="library-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Import audio files"
        >
          + Import
        </button>
      </div>

      {/* Filters */}
      {(tags.length > 0 || groups.length > 0) && (
        <div className="library-filters">
          {groups.length > 0 && (
            <select
              className="library-filter-select"
              value={filter.selectedGroup ?? ''}
              onChange={(e) =>
                setFilter({ selectedGroup: e.target.value || null })
              }
            >
              <option value="">All Groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}
          {tags.length > 0 && (
            <div className="library-tags">
              {tags.map((tag) => (
                <button
                  key={tag}
                  className={`tag-chip ${filter.selectedTags.includes(tag) ? 'active' : ''}`}
                  onClick={() => {
                    const selected = filter.selectedTags.includes(tag)
                      ? filter.selectedTags.filter((t) => t !== tag)
                      : [...filter.selectedTags, tag]
                    setFilter({ selectedTags: selected })
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          <div className="library-sort">
            <select
              className="library-filter-select"
              value={filter.sortBy}
              onChange={(e) => setFilter({ sortBy: e.target.value as 'name' | 'date' | 'duration' })}
            >
              <option value="date">Date</option>
              <option value="name">Name</option>
              <option value="duration">Duration</option>
            </select>
            <button
              className="sort-order-btn"
              onClick={() =>
                setFilter({ sortOrder: filter.sortOrder === 'asc' ? 'desc' : 'asc' })
              }
              title={filter.sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            >
              {filter.sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
      )}

      {/* Clip List */}
      <div className="library-list">
        {displayed.length === 0 ? (
          <div className="library-empty">
            {clips.length === 0
              ? '音声ファイルをドラッグ＆ドロップまたは Import で追加'
              : 'フィルタに一致するクリップがありません'}
          </div>
        ) : (
          displayed.map((clip) => (
            <ClipRow
              key={clip.id}
              clip={clip}
              isEditing={editingId === clip.id}
              onStartEdit={() => setEditingId(clip.id)}
              onEndEdit={() => setEditingId(null)}
              onUpdate={updateClip}
              onDelete={removeClip}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ---- Clip Row ----

function ClipRow({
  clip,
  isEditing,
  onStartEdit,
  onEndEdit,
  onUpdate,
  onDelete,
}: {
  clip: LibraryClip
  isEditing: boolean
  onStartEdit: () => void
  onEndEdit: () => void
  onUpdate: (id: string, updates: Partial<LibraryClip>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [tagInput, setTagInput] = useState('')
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)

  const handleAddToKit = useCallback(() => {
    if (!activeKitId || !clip.eventId) return
    const event: KitEvent = {
      eventId: clip.eventId,
      clipId: clip.id,
      gain: 1.0,
      loop: false,
    }
    addEventToKit(activeKitId, event)
  }, [activeKitId, clip, addEventToKit])

  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim()
    if (!tag || clip.tags.includes(tag)) return
    onUpdate(clip.id, { tags: [...clip.tags, tag] })
    setTagInput('')
  }, [tagInput, clip, onUpdate])

  if (isEditing) {
    return (
      <div className="clip-row clip-row-editing">
        <div className="clip-edit-fields">
          <label className="clip-edit-field">
            <span>Name</span>
            <input
              type="text"
              value={clip.name}
              onChange={(e) => onUpdate(clip.id, { name: e.target.value })}
            />
          </label>
          <label className="clip-edit-field">
            <span>Event ID</span>
            <input
              type="text"
              value={clip.eventId}
              placeholder="impact.hit"
              onChange={(e) => onUpdate(clip.id, { eventId: e.target.value })}
            />
          </label>
          <label className="clip-edit-field">
            <span>Group</span>
            <input
              type="text"
              value={clip.group}
              placeholder="impacts"
              onChange={(e) => onUpdate(clip.id, { group: e.target.value })}
            />
          </label>
          <div className="clip-edit-field">
            <span>Tags</span>
            <div className="clip-edit-tags">
              {clip.tags.map((tag) => (
                <span key={tag} className="tag-chip removable">
                  {tag}
                  <button
                    onClick={() =>
                      onUpdate(clip.id, { tags: clip.tags.filter((t) => t !== tag) })
                    }
                  >
                    x
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                placeholder="+ tag"
                className="tag-input"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag() }}
              />
            </div>
          </div>
        </div>
        <div className="clip-edit-actions">
          <button className="library-btn" onClick={onEndEdit}>Done</button>
          <button
            className="library-btn danger"
            onClick={() => { onDelete(clip.id); onEndEdit() }}
          >
            Delete
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="clip-row" onDoubleClick={onStartEdit}>
      <div className="clip-info">
        <div className="clip-name">{clip.name}</div>
        <div className="clip-meta">
          <span>{formatDuration(clip.duration)}</span>
          <span>{clip.channels === 1 ? 'M' : 'St'}</span>
          <span>{clip.sampleRate / 1000}k</span>
          <span>{formatFileSize(clip.fileSize)}</span>
        </div>
      </div>
      <div className="clip-details">
        {clip.eventId && <span className="clip-event-id">{clip.eventId}</span>}
        {clip.group && <span className="clip-group">{clip.group}</span>}
        {clip.tags.length > 0 && (
          <div className="clip-tags">
            {clip.tags.map((t) => (
              <span key={t} className="tag-chip small">{t}</span>
            ))}
          </div>
        )}
      </div>
      <div className="clip-actions">
        <button
          className="clip-action-btn"
          onClick={handleAddToKit}
          disabled={!activeKitId || !clip.eventId}
          title={
            !activeKitId
              ? 'Kit を作成・選択してください'
              : !clip.eventId
                ? 'Event ID を設定してください (Edit で編集)'
                : 'Kit に追加'
          }
        >
          +Kit
        </button>
        <button className="clip-action-btn" onClick={onStartEdit} title="Edit">
          Edit
        </button>
      </div>
    </div>
  )
}

// ---- Kit Editor (Right Panel) ----

function KitEditor() {
  const kits = useLibraryStore((s) => s.kits)
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const clips = useLibraryStore((s) => s.clips)
  const createKit = useLibraryStore((s) => s.createKit)
  const removeKit = useLibraryStore((s) => s.removeKit)
  const setActiveKit = useLibraryStore((s) => s.setActiveKit)
  const removeEventFromKit = useLibraryStore((s) => s.removeEventFromKit)
  const updateKitEvent = useLibraryStore((s) => s.updateKitEvent)
  const updateKit = useLibraryStore((s) => s.updateKit)

  const { isConnected: managerConnected, devices } = useManagerConnection()

  const [isCreating, setIsCreating] = useState(false)
  const [newKitName, setNewKitName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)

  const activeKit = kits.find((k) => k.id === activeKitId)

  const handleCreate = useCallback(async () => {
    if (!newKitName.trim()) return
    await createKit(newKitName.trim())
    setNewKitName('')
    setIsCreating(false)
  }, [createKit, newKitName])

  const getClipName = useCallback(
    (clipId: string) => clips.find((c) => c.id === clipId)?.name ?? '(unknown)',
    [clips]
  )

  return (
    <div className="kit-editor">
      <div className="kit-editor-header">
        <h3>Kit</h3>
        {!isCreating ? (
          <button className="library-btn" onClick={() => setIsCreating(true)}>
            + New Kit
          </button>
        ) : (
          <div className="kit-create-inline">
            <input
              type="text"
              className="kit-create-input"
              placeholder="Kit name..."
              value={newKitName}
              onChange={(e) => setNewKitName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setIsCreating(false) }}
              autoFocus
            />
            <button className="library-btn primary small" onClick={handleCreate} disabled={!newKitName.trim()}>
              Create
            </button>
            <button className="library-btn small" onClick={() => { setIsCreating(false); setNewKitName('') }}>
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Kit selector */}
      {kits.length > 0 && (
        <div className="kit-selector">
          <select
            className="kit-select"
            value={activeKitId ?? ''}
            onChange={(e) => setActiveKit(e.target.value || null)}
          >
            <option value="">Select Kit...</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.events.length} events)
              </option>
            ))}
          </select>
          {activeKit && (
            confirmDeleteId === activeKit.id ? (
              <div className="kit-confirm-delete">
                <span>削除しますか？</span>
                <button className="library-btn danger small" onClick={() => { removeKit(activeKit.id); setConfirmDeleteId(null) }}>
                  Yes
                </button>
                <button className="library-btn small" onClick={() => setConfirmDeleteId(null)}>
                  No
                </button>
              </div>
            ) : (
              <button
                className="library-btn danger small"
                onClick={() => setConfirmDeleteId(activeKit.id)}
              >
                Delete Kit
              </button>
            )
          )}
        </div>
      )}

      {/* Kit details */}
      {activeKit ? (
        <div className="kit-details">
          <div className="kit-meta-fields">
            <label className="kit-meta-field">
              <span>Name</span>
              <input
                type="text"
                value={activeKit.name}
                onChange={(e) => updateKit(activeKit.id, { name: e.target.value })}
              />
            </label>
            <label className="kit-meta-field">
              <span>Version</span>
              <input
                type="text"
                value={activeKit.version}
                onChange={(e) => updateKit(activeKit.id, { version: e.target.value })}
              />
            </label>
            <label className="kit-meta-field full">
              <span>Description</span>
              <input
                type="text"
                value={activeKit.description}
                onChange={(e) => updateKit(activeKit.id, { description: e.target.value })}
              />
            </label>
          </div>

          <div className="kit-events-header">
            <span>Events ({activeKit.events.length})</span>
          </div>

          <div className="kit-events-list">
            {activeKit.events.length === 0 ? (
              <div className="kit-events-empty">
                左のライブラリからクリップを追加してください。
                クリップに Event ID を設定してから「+Kit」ボタンで追加できます。
              </div>
            ) : (
              activeKit.events.map((event) => (
                <div key={event.eventId} className="kit-event-row">
                  <div className="kit-event-info">
                    <span className="kit-event-id">{event.eventId}</span>
                    <span className="kit-event-clip">{getClipName(event.clipId)}</span>
                  </div>
                  <div className="kit-event-params">
                    <label>
                      <span>Gain</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={event.gain}
                        onChange={(e) =>
                          updateKitEvent(activeKit.id, event.eventId, {
                            gain: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="kit-event-loop">
                      <input
                        type="checkbox"
                        checked={event.loop}
                        onChange={(e) =>
                          updateKitEvent(activeKit.id, event.eventId, {
                            loop: e.target.checked,
                          })
                        }
                      />
                      <span>Loop</span>
                    </label>
                  </div>
                  <button
                    className="clip-action-btn danger"
                    onClick={() => removeEventFromKit(activeKit.id, event.eventId)}
                    title="Remove"
                  >
                    x
                  </button>
                </div>
              ))
            )}
          </div>

          <KitExportSection
            kit={activeKit}
            clips={clips}
            isExporting={isExporting}
            setIsExporting={setIsExporting}
            managerConnected={managerConnected}
            deviceCount={devices.length}
          />
        </div>
      ) : (
        <div className="kit-empty">
          {kits.length === 0
            ? 'Kit を作成して、イベントとクリップの対応を定義してください。'
            : 'Kit を選択してください。'}
        </div>
      )}
    </div>
  )
}

// ---- Kit Export / Deploy Section ----

function KitExportSection({
  kit,
  clips,
  isExporting,
  setIsExporting,
  managerConnected,
  deviceCount,
}: {
  kit: import('@/types/library').KitDefinition
  clips: LibraryClip[]
  isExporting: boolean
  setIsExporting: (v: boolean) => void
  managerConnected: boolean
  deviceCount: number
}) {
  const { toast } = useToast()
  const [lastExportInfo, setLastExportInfo] = useState<string | null>(null)

  const handleExport = useCallback(async () => {
    // Event ID バリデーション
    const validations = validateEventIds(kit)
    const invalid = validations.filter((v) => !v.valid)
    if (invalid.length > 0) {
      const ids = invalid.map((v) => `  - "${v.eventId}"`).join('\n')
      const proceed = confirm(
        `以下の Event ID が contracts の形式に準拠していません:\n${ids}\n\nこのままエクスポートしますか？`
      )
      if (!proceed) return
    }

    setIsExporting(true)
    setLastExportInfo(null)
    try {
      const result = await exportKitAsPack(kit, clips)

      if (result.warnings.length > 0) {
        console.warn('Kit Export warnings:', result.warnings)
      }

      downloadBlob(result.blob, result.filename)
      const msg = `"${result.filename}" をダウンロードしました`
      setLastExportInfo(
        msg +
        (result.warnings.length > 0
          ? ` (${result.warnings.length}件の警告あり — コンソールを確認)`
          : '')
      )
      toast(msg, 'success')
    } catch (err) {
      toast(`エクスポートに失敗しました: ${err instanceof Error ? err.message : err}`, 'error')
    } finally {
      setIsExporting(false)
    }
  }, [kit, clips, setIsExporting, toast])

  const handleExportAndTransfer = useCallback(async () => {
    await handleExport()
  }, [handleExport])

  return (
    <div className="kit-export-section">
      <button
        className="library-btn primary"
        disabled={kit.events.length === 0 || isExporting}
        onClick={handleExport}
        title="Pack 形式の ZIP をダウンロード"
      >
        {isExporting ? 'Exporting...' : 'Export Kit'}
      </button>
      <button
        className="library-btn primary"
        disabled={kit.events.length === 0 || isExporting}
        onClick={handleExportAndTransfer}
        title={
          managerConnected
            ? 'Kit をエクスポートし、Manager から転送してください'
            : 'Kit をエクスポートします（Manager 未接続）'
        }
      >
        Export & Transfer
      </button>

      {lastExportInfo && (
        <div className="kit-export-info">{lastExportInfo}</div>
      )}

      {managerConnected && deviceCount > 0 && (
        <div className="kit-export-info">
          Manager に {deviceCount} 台のデバイスが接続中です。
          エクスポートした Kit は Manager の Content ページから転送できます。
        </div>
      )}
      {!managerConnected && (
        <div className="kit-export-info muted">
          Manager 未接続 — Kit はファイルとしてエクスポートできます。
        </div>
      )}
    </div>
  )
}
