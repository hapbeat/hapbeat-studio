import { useEffect, useCallback, useMemo, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import { useToast } from '@/components/common/Toast'
import { formatFileSize } from '@/utils/wavIO'
import { exportKitAsPack, validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, LibraryViewMode } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import { CapacityGauge } from './CapacityGauge'
import { KitEventRow } from './editor/KitEventRow'
import { ClipCard } from './shared/ClipCard'
import { ClipEditModal } from './shared/ClipEditModal'
import './KitManager.css'

const DND_TYPE_CLIP = 'application/x-hapbeat-clip'
const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

function randomKitName(): string {
  const adj = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Zeta', 'Nova', 'Pulse', 'Volt', 'Rush']
  const noun = ['Kit', 'Pack', 'Set', 'Mix', 'Drop', 'Vibe', 'Hit', 'Boom', 'Wave', 'Beat']
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}`
}

// ============================================================
// Resize handle hook
// ============================================================

function useResizeHandle(dir: 'horizontal' | 'vertical', initialPct: number) {
  const [pct, setPct] = useState(initialPct)
  const containerRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()

    const onMove = (ev: globalThis.MouseEvent) => {
      if (dir === 'vertical') {
        const y = ev.clientY - rect.top
        setPct(Math.max(15, Math.min(85, (y / rect.height) * 100)))
      } else {
        const x = ev.clientX - rect.left
        setPct(Math.max(15, Math.min(85, (x / rect.width) * 100)))
      }
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [dir])

  return { pct, containerRef, onMouseDown }
}

// ============================================================
// Main
// ============================================================

export function KitManager() {
  const isLoading = useLibraryStore((s) => s.isLoading)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)

  // Stacked mode keeps a vertical resize handle so the user can trade library
  // vs kit height. Side mode uses fixed widths — the draggable range was too
  // small to be useful, and fixing removes a whole class of layout bugs.
  const stackedResize = useResizeHandle('vertical', 50)

  useEffect(() => { loadLibrary() }, [loadLibrary])

  if (isLoading) return <div className="kit-manager-wrapper"><div className="kit-loading">Loading...</div></div>

  return (
    <div className="kit-manager-wrapper">
      {!workDirSupported && (
        <div className="browser-warning">
          Your browser does not support local folder access. Use <strong>Chrome</strong> or <strong>Edge</strong>.
        </div>
      )}
      <WorkDirBar />
      {viewMode === 'stacked' ? (
        <div className="kit-manager kit-manager-stacked" ref={stackedResize.containerRef}>
          <div className="kit-manager-top" style={{ height: `${stackedResize.pct}%` }}><ClipsPanel /></div>
          <div className="resize-handle v" onMouseDown={stackedResize.onMouseDown} />
          <div className="kit-manager-bottom" style={{ flex: 1 }}><KitEditor /></div>
        </div>
      ) : (
        <div className="kit-manager">
          <div className="kit-manager-left"><ClipsPanel /></div>
          <div className="kit-manager-right"><KitEditor /></div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Amp Preset Bar — Library の amp 一括セーブ/適用
// ============================================================

const NEW_PRESET_VALUE = '__new__'

/** Save as のデフォルト名: `amp-YYYYMMDD` */
function defaultPresetName(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `amp-${y}${m}${day}`
}

function AmpPresetBar() {
  const clips = useLibraryStore((s) => s.clips)
  const presets = useLibraryStore((s) => s.ampPresets)
  const savePreset = useLibraryStore((s) => s.saveAmpPreset)
  const applyPreset = useLibraryStore((s) => s.applyAmpPreset)
  const deletePreset = useLibraryStore((s) => s.deleteAmpPreset)
  const setLibraryIntensity = useLibraryStore((s) => s.setLibraryIntensity)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const { toast } = useToast()
  const [selected, setSelected] = useState<string>(NEW_PRESET_VALUE)
  const [dialog, setDialog] = useState<null | 'save' | 'confirm-delete' | 'confirm-overwrite'>(null)
  const [nameInput, setNameInput] = useState('')

  if (!workDirHandle) return null

  const close = () => { setDialog(null); setNameInput('') }

  const onSelectChange = async (value: string) => {
    setSelected(value)
    if (value === NEW_PRESET_VALUE) {
      // (new) = 全クリップ amp を 0.5 にリセット
      for (const c of clips) {
        if ((c.libraryIntensity ?? 0.5) !== 0.5) await setLibraryIntensity(c.id, 0.5)
      }
      toast('Reset amps to 0.5', 'success')
    } else {
      await applyPreset(value)
      toast(`Applied "${value}"`, 'success')
    }
  }

  const onSaveClick = () => { setNameInput(defaultPresetName()); setDialog('save') }
  const onSubmitSave = async () => {
    const name = nameInput.trim()
    if (!name) return
    if (presets.some((p) => p.name === name)) { setDialog('confirm-overwrite'); return }
    await savePreset(name)
    setSelected(name)
    close()
    toast(`Saved "${name}"`, 'success')
  }
  const onConfirmOverwrite = async () => {
    const name = nameInput.trim()
    await savePreset(name)
    setSelected(name)
    close()
    toast(`Overwrote "${name}"`, 'success')
  }

  const hasRealSelection = selected && selected !== NEW_PRESET_VALUE
  const onDeleteClick = () => { if (hasRealSelection) setDialog('confirm-delete') }
  const onConfirmDelete = async () => {
    await deletePreset(selected)
    toast(`Deleted "${selected}"`, 'success')
    setSelected(NEW_PRESET_VALUE)
    close()
  }

  return (
    <div className="amp-preset-bar">
      <span className="amp-preset-label" title="Library 側の amp プリセット。選択すると即適用。">Amp Preset:</span>
      <select
        className="amp-preset-select"
        value={selected}
        onChange={(e) => void onSelectChange(e.target.value)}
        title="(new) = 全クリップ amp を 0.5 に戻す。保存済みプリセットを選ぶと即適用。"
      >
        <option value={NEW_PRESET_VALUE}>(new)</option>
        {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <button className="library-btn" onClick={onSaveClick} title="現在の amp 設定を新しいプリセットとして保存">Save as…</button>
      <button className="library-btn danger" onClick={onDeleteClick} disabled={!hasRealSelection}
        title={hasRealSelection ? `プリセット "${selected}" を削除` : '削除するプリセットを選択'}>Delete</button>

      {dialog && (
        <div className="amp-preset-dialog-backdrop" onClick={close}>
          <div className="amp-preset-dialog" onClick={(e) => e.stopPropagation()}>
            {dialog === 'save' && (
              <>
                <div className="amp-preset-dialog-title">新規プリセット名</div>
                <input
                  type="text" autoFocus
                  value={nameInput}
                  placeholder={defaultPresetName()}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); onSubmitSave() }
                    if (e.key === 'Escape') close()
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn primary" onClick={onSubmitSave} disabled={!nameInput.trim()}>Save</button>
                </div>
              </>
            )}
            {dialog === 'confirm-overwrite' && (
              <>
                <div className="amp-preset-dialog-title">"{nameInput.trim()}" を上書きしますか？</div>
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn primary" onClick={onConfirmOverwrite}>Overwrite</button>
                </div>
              </>
            )}
            {dialog === 'confirm-delete' && (
              <>
                <div className="amp-preset-dialog-title">プリセット "{selected}" を削除しますか？</div>
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn danger" onClick={onConfirmDelete}>Delete</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Shortcut Help — ヘルプボタン + ポップオーバー
// ============================================================

function ShortcutHelp({ scope }: { scope: 'library' | 'kit' }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <span className="shortcut-help-wrap" ref={wrapRef}>
      <button
        className="shortcut-help-btn"
        onClick={() => setOpen((o) => !o)}
        title="キーボード/マウス操作の説明"
        aria-label="Show shortcut help"
      >?</button>
      {open && (
        <div className="shortcut-help-panel" role="dialog">
          <div className="shortcut-help-title">マウス操作</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">クリック</span>カードを選択</li>
            <li><span className="shortcut-help-key">▶</span>再生 / 停止</li>
            <li><span className="shortcut-help-key">☰ ドラッグ</span>
              {scope === 'library' ? 'Kit にドロップして追加' : 'Kit 内で並び替え'}</li>
            <li><span className="shortcut-help-key">Amp スライダー</span>強度 (0–100%)</li>
            <li><span className="shortcut-help-key">Edit ボタン</span>名前 / Event ID / タグ編集</li>
            {scope === 'library' && <li><span className="shortcut-help-key">+ Kit ボタン</span>選択中の Kit に追加</li>}
            {scope === 'kit' && <li><span className="shortcut-help-key">Loop (↻)</span>ループ ON/OFF</li>}
            {scope === 'kit' && <li><span className="shortcut-help-key">×</span>Kit から削除</li>}
          </ul>

          <div className="shortcut-help-title">キーボード（選択中）</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">↑ / ↓</span>選択を上下に移動</li>
            <li><span className="shortcut-help-key">← / →</span>Amp を ±5%</li>
            <li><span className="shortcut-help-key">Space</span>再生 / 停止</li>
            {scope === 'library' && <li><span className="shortcut-help-key">Enter</span>アクティブ Kit に追加</li>}
          </ul>

          <div className="shortcut-help-note">
            パネル内にカーソルがある / フォーカスしているときだけ反応します。
            テキスト入力中は無効。Amp スライダーの矢印キーはスライダー自身の微調整が優先されます。
          </div>
        </div>
      )}
    </span>
  )
}

// ============================================================
// Work Dir Bar
// ============================================================

function WorkDirBar() {
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const workDirName = useLibraryStore((s) => s.workDirName)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const disconnectWorkDir = useLibraryStore((s) => s.disconnectWorkDir)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const setShowClipDetails = useLibraryStore((s) => s.setShowClipDetails)
  const { devices } = useManagerConnection()
  const volumeWiper = devices[0]?.volumeWiper ?? null
  const { toast } = useToast()

  const views: { value: LibraryViewMode; label: string; title: string }[] = [
    { value: 'side', label: '\u2503', title: 'Clips left, kit editor right' },
    { value: 'stacked', label: '\u2501', title: 'Clips top, kit editor full width bottom' },
  ]

  return (
    <div className="workdir-bar">
      <div className="view-mode-group">
        {views.map((m) => (
          <button key={m.value} className={`view-mode-btn ${viewMode === m.value ? 'active' : ''}`}
            onClick={() => setViewMode(m.value)} title={m.title}>{m.label}</button>
        ))}
      </div>
      <button
        className={`view-mode-btn info-toggle ${showClipDetails ? 'active' : ''}`}
        onClick={() => setShowClipDetails(!showClipDetails)}
        title={showClipDetails ? 'Hide clip details (duration, sample rate, tags…)' : 'Show clip details'}
      >i</button>
      <span className="workdir-divider" />
      {workDirSupported && (
        <>
          <span className="workdir-icon">&#x1F4C2;</span>
          {workDirName ? (
            <>
              <span className="workdir-path">{workDirName}/</span>
              <span className="workdir-status connected">Connected</span>
              <button className="workdir-btn" onClick={async () => { if (await pickWorkDir()) toast('Folder changed', 'success') }}>Change</button>
              <button className="workdir-btn disconnect" onClick={async () => { await disconnectWorkDir(); toast('Disconnected', 'success') }}>Disconnect</button>
              {volumeWiper !== null && (
                <>
                  <span className="workdir-divider" />
                  <span className="workdir-vol" title="Connected Hapbeat device volume (MCP4018 wiper 0–127, 128段階)">Vol {volumeWiper}/128 ({Math.round((volumeWiper / 127) * 100)}%)</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="workdir-hint">No work folder</span>
              <button className="workdir-btn primary" onClick={async () => { if (await pickWorkDir()) toast('Folder set', 'success') }}>Choose Folder</button>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================
// Audio preview hook
// ============================================================

function useAudioPreview() {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const { isConnected, devices, send } = useManagerConnection()

  const hasDevice = isConnected && devices.length > 0

  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    setPlayingId(null)
  }, [])

  /** Toggle play/stop. intensity (0.0-1.0) is applied to PCM before streaming. */
  const toggle = useCallback(async (id: string, getBlob: () => Promise<Blob | undefined>, intensity = 1.0) => {
    if (playingId === id) { stop(); return }
    stop()
    const blob = await getBlob()
    if (!blob) return

    setPlayingId(id)

    if (hasDevice) {
      // Query volume (wiper) — Manager resolves which device(s) based on its own selection
      send({ type: 'query_volume', payload: {} })

      const { streamClip } = await import('@/utils/audioStreamer')
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await streamClip(blob, send, { signal: controller.signal, intensity })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') { /* cancelled */ }
        else console.error('Streaming failed:', err)
      }
      setPlayingId(null)
      abortRef.current = null
    } else {
      // Fallback: browser audio (apply intensity as volume)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.volume = Math.min(1, Math.max(0, intensity))
      audioRef.current = audio
      audio.onended = () => { setPlayingId(null); URL.revokeObjectURL(url); audioRef.current = null }
      audio.play()
    }
  }, [playingId, stop, hasDevice, devices, send])

  /** Get current device wiper value (null if unavailable) */
  const getDeviceWiper = useCallback((): number | null => {
    if (!hasDevice) return null
    const d = devices[0]
    return (d as DeviceInfo).volumeWiper ?? null
  }, [hasDevice, devices])

  return { playingId, toggle, hasDevice, getDeviceWiper }
}

// ============================================================
// Tree grouping — builds a nested folder tree from clip.sourceFilename
// ("template/booster.wav" → template / booster.wav). Clips with no
// path prefix land in the root bucket.
// ============================================================

interface ClipTreeNode {
  name: string
  path: string
  children: Map<string, ClipTreeNode>
  clips: LibraryClip[]
}

function buildClipTree(clips: LibraryClip[]): ClipTreeNode {
  const root: ClipTreeNode = { name: '', path: '', children: new Map(), clips: [] }
  for (const clip of clips) {
    const src = clip.sourceFilename || ''
    const parts = src.split('/').filter(Boolean)
    if (parts.length <= 1) {
      root.clips.push(clip)
      continue
    }
    // All but the last segment are folder names.
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let child = node.children.get(name)
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, children: new Map(), clips: [] }
        node.children.set(name, child)
      }
      node = child
    }
    node.clips.push(clip)
  }
  return root
}

/** Stable hue palette — high-contrast, easily distinguishable colours.
 *  Order: red, blue, orange, cyan, pink, yellow, teal, magenta, lime, purple
 *  （green=130 は template 専用に予約して除外） */
const TREE_HUES = [0, 220, 30, 185, 330, 50, 165, 290, 90, 260]
const TEMPLATE_HUE = 130

/** path からハッシュで hue を決定。同名の兄弟でも path 全体で分散する。
 *  ただし "template" だけは常に緑に固定。 */
function hueForPath(path: string): number {
  if (path === 'template' || path.startsWith('template/')) return TEMPLATE_HUE
  let h = 0
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0
  return TREE_HUES[Math.abs(h) % TREE_HUES.length]
}

function TreeFolder({ node, defaultOpen, children }: { node: ClipTreeNode; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const clipCount = countClipsInTree(node)
  const hue = hueForPath(node.path)
  return (
    <div className={`tree-group ${open ? 'is-open' : ''}`} style={{ '--tree-hue': hue } as React.CSSProperties}>
      <button className="tree-group-header" onClick={() => setOpen(!open)}>
        <span className="tree-arrow">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="tree-label">{node.name}</span>
        <span className="tree-count">{clipCount}</span>
      </button>
      {open && <div className="tree-group-children">{children}</div>}
    </div>
  )
}

function countClipsInTree(node: ClipTreeNode): number {
  let n = node.clips.length
  for (const c of node.children.values()) n += countClipsInTree(c)
  return n
}

/** Tree の表示順（renderTreeNode の順）で flat 化した clip リスト。
 *  フォルダを先に再帰処理し、各レベルで clip を後に足す。 */
function flattenTreeInRenderOrder(node: ClipTreeNode): LibraryClip[] {
  const result: LibraryClip[] = []
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const f of folders) result.push(...flattenTreeInRenderOrder(f))
  const clips = [...node.clips].sort((a, b) => a.name.localeCompare(b.name))
  result.push(...clips)
  return result
}

// ============================================================
// Clips Panel — unified list (built-ins are auto-imported into the
// user's work folder so there is no separate built-in/user split)
// ============================================================

type ClipListMode = 'flat' | 'tree'

function ClipsPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const clips = useLibraryStore((s) => s.clips)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const addClipFromFile = useLibraryStore((s) => s.addClipFromFile)
  const archiveClip = useLibraryStore((s) => s.archiveClip)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const commitClipRename = useLibraryStore((s) => s.commitClipRename)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const refreshClipsFromDir = useLibraryStore((s) => s.refreshClipsFromDir)
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const editingClipId = useLibraryStore((s) => s.editingClipId)
  const setEditingClipId = useLibraryStore((s) => s.setEditingClipId)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const { toast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const [listMode, setListMode] = useState<ClipListMode>('tree')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { playingId, toggle } = useAudioPreview()
  const displayed = filteredClips()
  const editingClip = editingClipId ? clips.find((c) => c.id === editingClipId) ?? null : null
  const setLibraryIntensity = useLibraryStore((s) => s.setLibraryIntensity)

  const getIntensity = useCallback((id: string) => {
    const c = clips.find((x) => x.id === id)
    return c?.libraryIntensity ?? 0.5
  }, [clips])
  const setIntensity = useCallback((id: string, v: number) => {
    void setLibraryIntensity(id, v)
  }, [setLibraryIntensity])

  useEffect(() => {
    if (!workDirHandle) return
    const onFocus = () => refreshClipsFromDir()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workDirHandle, refreshClipsFromDir])

  // 選択が変わったら画面内にスクロール（tree で折りたたみ内にある場合はそのフォルダも開く）
  useEffect(() => {
    if (!selectedId) return
    const panel = panelRef.current
    if (!panel) return
    const el = panel.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  // 表示順と一致するナビゲーション順。tree mode では renderTreeNode の順で flat 化する。
  const orderedClips = useMemo(() => {
    if (listMode === 'flat') {
      return [...displayed].sort((a, b) => a.name.localeCompare(b.name))
    }
    return flattenTreeInRenderOrder(buildClipTree(displayed))
  }, [displayed, listMode])

  const addClipToActiveKit = useCallback(async (clip: LibraryClip) => {
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }
    if (!clip.eventId) { toast('Set Event ID first', 'error'); return }
    const newId = await addEventToKit(activeKitId, {
      eventId: clip.eventId, clipId: clip.id, loop: false, intensity: getIntensity(clip.id), deviceWiper: null,
    })
    if (newId) toast(`Added "${clip.name}" to kit`, 'success')
    else toast('Kit not found', 'error')
  }, [activeKitId, addEventToKit, toast, getIntensity])

  // キーボードショートカット: Space=再生、↑↓=選択移動、←→=Amp 増減
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel) return
      // テキスト入力中はスキップ。range スライダー上では Space は通すが矢印はネイティブに任せる
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && e.key.startsWith('Arrow')) return
      if (editingClipId) return
      if (!panel.contains(active) && !panel.matches(':hover')) return
      if (orderedClips.length === 0) return

      const curIdx = selectedId ? orderedClips.findIndex((c) => c.id === selectedId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(orderedClips.length - 1, idx))
        const next = orderedClips[clamped]
        if (next) setSelectedId(next.id)
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx - 1)
          break
        case 'ArrowRight':
          if (selectedId) { e.preventDefault(); setIntensity(selectedId, getIntensity(selectedId) + 0.05) }
          break
        case 'ArrowLeft':
          if (selectedId) { e.preventDefault(); setIntensity(selectedId, getIntensity(selectedId) - 0.05) }
          break
        case ' ':
        case 'Spacebar':
          if (selectedId) {
            e.preventDefault()
            toggle(selectedId, () => getClipAudio(selectedId), getIntensity(selectedId))
          }
          break
        case 'Enter': {
          if (!selectedId) break
          const clip = clips.find((c) => c.id === selectedId)
          if (!clip) break
          e.preventDefault()
          addClipToActiveKit(clip)
          break
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [orderedClips, selectedId, editingClipId, toggle, getClipAudio, getIntensity, setIntensity, clips, addClipToActiveKit])

  const handleImport = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) { try { await addClipFromFile(f) } catch (e) { console.error(e) } }
  }, [addClipFromFile])

  const renderClipRow = (c: LibraryClip) => (
    <ClipRow
      key={c.id}
      clip={c}
      onStartEdit={() => setEditingClipId(c.id)}
      playingId={playingId}
      onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)}
      onAddToKit={() => addClipToActiveKit(c)}
      kitAvailable={!!activeKitId}
      showDetails={showClipDetails}
      intensity={getIntensity(c.id)}
      onIntensityChange={(v) => setIntensity(c.id, v)}
      selected={selectedId === c.id}
      onSelect={() => setSelectedId(c.id)}
    />
  )

  const renderTreeNode = (node: ClipTreeNode, isRoot: boolean): React.ReactNode => {
    const childFolders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const sortedClips = [...node.clips].sort((a, b) => a.name.localeCompare(b.name))
    const body = (
      <>
        {childFolders.map((child) => (
          <TreeFolder key={child.path} node={child} defaultOpen={false}>
            {renderTreeNode(child, false)}
          </TreeFolder>
        ))}
        {sortedClips.map((c) => renderClipRow(c))}
      </>
    )
    return isRoot ? body : body
  }

  if (!workDirHandle) {
    return (
      <div className="clip-panel">
        <div className="panel-header"><h3>Clips</h3></div>
        <div className="library-list">
          <div className="library-empty workdir-prompt">
            <div className="workdir-prompt-content">
              <div className="workdir-prompt-icon">&#x1F4C2;</div>
              <div className="workdir-prompt-text">
                {workDirSupported
                  ? 'Pick a work folder to start. We\'ll copy the built-in clips into it so you can edit anything freely.'
                  : 'Use Chrome or Edge.'}
              </div>
              {workDirSupported && <button className="library-btn primary" onClick={pickWorkDir}>Choose Folder</button>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={panelRef} className={`clip-panel ${dragOver ? 'drag-over' : ''}`}
      tabIndex={-1}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length > 0) handleImport(e.dataTransfer.files) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}>
      <div className="panel-header">
        <h3>Clips</h3>
        <span className="library-count">{clips.length}</span>
        <div className="panel-header-actions">
          <button
            className={`panel-mode-btn ${listMode === 'flat' ? 'active' : ''}`}
            onClick={() => setListMode('flat')}
            title="Flat list (all clips, no folders)"
          >=</button>
          <button
            className={`panel-mode-btn ${listMode === 'tree' ? 'active' : ''}`}
            onClick={() => setListMode('tree')}
            title="Tree view (grouped by folder)"
          >&#x25B8;</button>
          <ShortcutHelp scope="library" />
        </div>
      </div>
      <div className="library-toolbar">
        <input type="text" className="library-search" placeholder="Search..." value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })} />
        <input ref={fileInputRef} type="file" accept=".wav,.mp3,.ogg,.flac,.aac,.m4a,audio/*" multiple
          onChange={(e) => e.target.files && handleImport(e.target.files)} style={{ display: 'none' }} />
        <button className="library-btn" onClick={() => fileInputRef.current?.click()}>+ Import</button>
        <button className="library-btn" onClick={refreshClipsFromDir}>Refresh</button>
      </div>
      <AmpPresetBar />
      <div className="library-list">
        {displayed.length === 0
          ? <div className="library-empty">{clips.length === 0 ? 'Drop files or + Import.' : 'No match.'}</div>
          : listMode === 'flat'
            ? displayed.map((c) => renderClipRow(c))
            : renderTreeNode(buildClipTree(displayed), true)
        }
      </div>

      {editingClip && (
        <ClipEditModal
          clip={editingClip}
          onClose={() => setEditingClipId(null)}
          onUpdate={updateClip}
          onArchive={async (id) => { await archiveClip(id) }}
          onCommitRename={commitClipRename}
        />
      )}
    </div>
  )
}

// ============================================================
// Clip Row — uses unified ClipCard primitive
// ============================================================

interface ClipRowProps {
  clip: LibraryClip
  onStartEdit: () => void
  playingId: string | null
  onToggle: (id: string, intensity: number) => void
  onAddToKit: () => void
  kitAvailable: boolean
  showDetails: boolean
  intensity: number
  onIntensityChange: (v: number) => void
  selected: boolean
  onSelect: () => void
}

function ClipRow({
  clip,
  onStartEdit,
  playingId,
  onToggle,
  onAddToKit,
  kitAvailable,
  showDetails,
  intensity,
  onIntensityChange,
  selected,
  onSelect,
}: ClipRowProps) {
  const metaSummary = `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatFileSize(clip.fileSize)}`
  return (
    <ClipCard
      name={clip.name}
      eventId={clip.eventId}
      eventIdEmpty={!clip.eventId}
      details={metaSummary}
      tags={clip.tags}
      showDetails={showDetails}
      intensity={intensity}
      onIntensityChange={onIntensityChange}
      playing={playingId === clip.id}
      onTogglePlay={() => onToggle(clip.id, intensity)}
      selected={selected}
      onSelect={onSelect}
      dataCardId={clip.id}
      wiper={null}
      title={`${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`}
      drag={{ type: DND_TYPE_CLIP, payload: clip.id, dragTitle: 'ドラッグして Kit に追加' }}
      actions={[
        { label: '+ Kit', variant: 'primary', onClick: onAddToKit, disabled: !kitAvailable || !clip.eventId,
          title: kitAvailable ? 'Add to active kit' : 'Select a kit first' },
        { label: 'Edit', onClick: onStartEdit, title: 'Edit name, event ID, tags…' },
      ]}
    />
  )
}

// ============================================================
// Kit Editor
// ============================================================

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
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)
  const setEditingClipId = useLibraryStore((s) => s.setEditingClipId)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const { isConnected: managerConnected, devices, send } = useManagerConnection()
  const { toast } = useToast()
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const { playingId, toggle: togglePreview, getDeviceWiper } = useAudioPreview()

  const [isExporting, setIsExporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const placeholderName = useRef(randomKitName())
  const kitPanelRef = useRef<HTMLDivElement>(null)

  const activeKit = kits.find((k) => k.id === activeKitId)

  // Kit を切り替えたら選択をクリア
  useEffect(() => {
    setSelectedEventId(null)
  }, [activeKitId])

  // 選択変更時に画面内にスクロール（Kit Editor 内で完結）
  useEffect(() => {
    if (!selectedEventId) return
    const panel = kitPanelRef.current
    if (!panel) return
    const el = panel.querySelector<HTMLElement>(`[data-card-id="${selectedEventId}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedEventId])

  // Kit 内のキーボード操作: Space=再生、↑↓=選択移動、←→=intensity ±0.05
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = kitPanelRef.current
      if (!panel || !activeKit) return
      // テキスト入力中はスキップ。range スライダー上では Space は通すが矢印はネイティブに任せる
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && e.key.startsWith('Arrow')) return
      if (!panel.contains(active) && !panel.matches(':hover')) return
      const events = activeKit.events
      if (events.length === 0) return

      const curIdx = selectedEventId ? events.findIndex((ev) => ev.id === selectedEventId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(events.length - 1, idx))
        const next = events[clamped]
        if (next) setSelectedEventId(next.id)
      }
      const currentEvent = selectedEventId ? events.find((ev) => ev.id === selectedEventId) : null

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx - 1)
          break
        case 'ArrowRight':
          if (currentEvent) {
            e.preventDefault()
            const next = Math.max(0, Math.min(1, currentEvent.intensity + 0.05))
            updateKitEvent(activeKit.id, currentEvent.id, { intensity: next })
          }
          break
        case 'ArrowLeft':
          if (currentEvent) {
            e.preventDefault()
            const next = Math.max(0, Math.min(1, currentEvent.intensity - 0.05))
            updateKitEvent(activeKit.id, currentEvent.id, { intensity: next })
          }
          break
        case ' ':
        case 'Spacebar':
          if (currentEvent) {
            e.preventDefault()
            togglePreview(currentEvent.id, () => getClipAudio(currentEvent.clipId), currentEvent.intensity)
            const w = getDeviceWiper()
            if (w !== null && w !== currentEvent.deviceWiper) {
              updateKitEvent(activeKit.id, currentEvent.id, { deviceWiper: w })
            }
          }
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeKit, selectedEventId, updateKitEvent, togglePreview, getClipAudio, getDeviceWiper])

  const handleCreate = useCallback(async (name?: string) => {
    const n = (name ?? placeholderName.current).trim()
    if (!n) return
    await createKit(n)
    placeholderName.current = randomKitName()
  }, [createKit])

  const handleKitDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDropActive(false); setDragOverIdx(null)
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }

    const cid = e.dataTransfer.getData(DND_TYPE_CLIP)
    if (cid) {
      const c = clips.find((x) => x.id === cid); if (!c) return
      if (!c.eventId) { toast('Set Event ID first', 'error'); return }
      const newId = await addEventToKit(activeKitId, { eventId: c.eventId, clipId: c.id, loop: false, intensity: 0.5, deviceWiper: null })
      if (newId) toast(`Added "${c.name}"`, 'success')
      else toast('Kit not found', 'error')
      return
    }
    const evd = e.dataTransfer.getData(DND_TYPE_KIT_EVENT)
    if (evd && activeKit && dragOverIdx !== null) {
      try {
        const { kitEventId } = JSON.parse(evd)
        const evts = [...activeKit.events]
        const from = evts.findIndex((e) => e.id === kitEventId)
        if (from < 0) return
        const [moved] = evts.splice(from, 1)
        evts.splice(dragOverIdx > from ? dragOverIdx - 1 : dragOverIdx, 0, moved)
        await updateKit(activeKitId, { events: evts })
      } catch { /* */ }
    }
  }, [activeKitId, activeKit, clips, dragOverIdx, addEventToKit, updateKit, toast])

  const kitSize = activeKit ? activeKit.events.reduce((s, ev) => s + (clips.find((c) => c.id === ev.clipId)?.fileSize ?? 0), 0) + 1024 : 0

  return (
    <div className="kit-editor" ref={kitPanelRef} tabIndex={-1}>
      {/* Create bar with placeholder */}
      <div className="kit-create-bar">
        <input type="text" className="kit-create-input" placeholder={placeholderName.current}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const input = e.currentTarget
              handleCreate(input.value || undefined)
              input.value = ''
            }
          }} />
        <button className="library-btn primary small" onClick={(e) => {
          const input = (e.currentTarget.previousElementSibling as HTMLInputElement)
          handleCreate(input.value || undefined)
          input.value = ''
        }}>Create</button>
      </div>

      {/* Kit list with inline details */}
      <div className="kit-list-container"
        onDrop={handleKitDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true) }}
        onDragLeave={() => { setDropActive(false); setDragOverIdx(null) }}>
        {kits.length === 0 ? (
          <div className="kit-empty">Type a name above and press Enter.</div>
        ) : kits.map((k) => {
          const isActive = activeKitId === k.id
          const isThisKit = isActive && activeKit
          return (
            <div key={k.id}>
              {/* Kit header row */}
              <div className={`kit-list-item ${isActive ? 'active' : ''}`}
                onClick={() => setActiveKit(isActive ? null : k.id)}>
                <span className="kit-list-arrow">{isActive ? '\u25BE' : '\u25B8'}</span>
                <span className="kit-list-name">{k.name}</span>
                <span className="kit-list-count">{k.events.length} events</span>
                <button className="kit-list-delete" onClick={(e) => { e.stopPropagation(); removeKit(k.id) }} title="Delete">x</button>
              </div>

              {/* Inline details (only for selected kit) */}
              {isThisKit && (
                <div className={`kit-details-inline ${dropActive ? 'drop-active' : ''}`}>
                  <div className="kit-meta-fields">
                    <label className="kit-meta-field"><span>Name</span>
                      <input type="text" value={activeKit.name} onChange={(e) => updateKit(activeKit.id, { name: e.target.value })} /></label>
                    <label className="kit-meta-field"><span>Version</span>
                      <input type="text" value={activeKit.version} onChange={(e) => updateKit(activeKit.id, { version: e.target.value })} /></label>
                  </div>

                  <CapacityGauge kitSize={kitSize} managerConnected={managerConnected} devices={devices} send={send} />

                  <div className="kit-events-header">
                    <span>Events ({activeKit.events.length})</span>
                    <span className="kit-size-label">{formatFileSize(kitSize)}</span>
                    <ShortcutHelp scope="kit" />
                  </div>

                  <div className="kit-events-list">
                    {activeKit.events.length === 0
                      ? <div className="kit-events-empty kit-drop-zone">Drag clips here.</div>
                      : activeKit.events.map((ev, i) => (
                        <KitEventRow
                          key={ev.id}
                          event={ev}
                          clip={clips.find((c) => c.id === ev.clipId) ?? null}
                          playing={playingId === ev.id}
                          showDetails={showClipDetails}
                          selected={selectedEventId === ev.id}
                          onSelect={() => setSelectedEventId(ev.id)}
                          onTogglePlay={() => {
                            togglePreview(ev.id, () => getClipAudio(ev.clipId), ev.intensity)
                            const w = getDeviceWiper()
                            if (w !== null && w !== ev.deviceWiper) updateKitEvent(activeKit.id, ev.id, { deviceWiper: w })
                          }}
                          onIntensityChange={(v) => updateKitEvent(activeKit.id, ev.id, { intensity: v })}
                          onLoopChange={(loop) => updateKitEvent(activeKit.id, ev.id, { loop })}
                          onModeChange={(mode) => updateKitEvent(activeKit.id, ev.id, { mode })}
                          onEditClip={() => setEditingClipId(ev.clipId)}
                          onDelete={() => removeEventFromKit(activeKit.id, ev.id)}
                          onDragOverRow={() => setDragOverIdx(i)}
                          dragOverIndicator={dragOverIdx === i}
                        />
                      ))}
                  </div>

                  <KitExportSection kit={activeKit} clips={clips} isExporting={isExporting} setIsExporting={setIsExporting}
                    managerConnected={managerConnected} devices={devices} send={send} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// Kit Export
// ============================================================

function KitExportSection({ kit, clips, isExporting, setIsExporting, managerConnected, devices, send }: {
  kit: import('@/types/library').KitDefinition; clips: LibraryClip[]
  isExporting: boolean; setIsExporting: (v: boolean) => void
  managerConnected: boolean
  devices: import('@/types/manager').DeviceInfo[]
  send: (msg: import('@/types/manager').ManagerMessage) => void
}) {
  const { toast } = useToast()
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)

  /** Kit を ZIP 化して workDir/kits/<packId>/ に展開書き出し。
   *  workDir が必須 (未選択時は呼ばれない前提)。返り値は生成した ZIP Blob + packId。 */
  const buildAndSave = useCallback(async () => {
    if (!workDirHandle) throw new Error('Work directory not selected')
    const validations = validateEventIds(kit)
    const invalid = validations.filter((v) => !v.valid)
    if (invalid.length > 0) {
      const ids = invalid.map((v) => `  "${v.eventId}" — must be category.name`).join('\n')
      if (!confirm(`Invalid Event IDs:\n${ids}\n\nContinue anyway?`)) return null
    }
    const result = await exportKitAsPack(kit, clips)
    const { writeKitFolder } = await import('@/utils/localDirectory')
    const zip = await import('jszip').then((m) => m.default)
    const zipData = await zip.loadAsync(result.blob)
    const files: { path: string; blob: Blob }[] = []
    for (const [path, entry] of Object.entries(zipData.files)) {
      if (!entry.dir) {
        const blob = await entry.async('blob')
        const relPath = path.includes('/') ? path.substring(path.indexOf('/') + 1) : path
        if (relPath) files.push({ path: relPath, blob })
      }
    }
    const packId = kit.name.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'unnamed-kit'
    await writeKitFolder(workDirHandle, packId, files)
    return { blob: result.blob, packId }
  }, [kit, clips, workDirHandle])

  const handleSave = useCallback(async () => {
    if (!workDirHandle) { toast('Select a work folder first', 'error'); return }
    setIsExporting(true)
    try {
      const out = await buildAndSave()
      if (out) toast(`Saved to kits/${out.packId}/`, 'success')
    } catch (err) { toast(`Save failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [buildAndSave, workDirHandle, setIsExporting, toast])

  const handleDeploy = useCallback(async () => {
    if (!workDirHandle) { toast('Select a work folder first', 'error'); return }
    if (!managerConnected || devices.length === 0) { toast('No devices', 'error'); return }
    setIsExporting(true)
    try {
      const out = await buildAndSave()
      if (!out) return
      const ab = await out.blob.arrayBuffer(); const bytes = new Uint8Array(ab)
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      send({ type: 'deploy_pack_data', payload: { pack_id: out.packId, zip_base64: btoa(bin), targets: devices.map((d) => d.ipAddress) }})
      toast(`Saved + sent "${out.packId}" to ${devices.length} device(s)`, 'success')
    } catch (err) { toast(`Deploy failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [buildAndSave, managerConnected, devices, send, workDirHandle, setIsExporting, toast])

  return (
    <div className="kit-export-section">
      <button className="library-btn primary" disabled={kit.events.length === 0 || isExporting || !workDirHandle} onClick={handleSave}
        title="Kit を workDir/kits/<packId>/ に書き出す">
        {isExporting ? '...' : 'Save'}</button>
      <button className="library-btn primary" disabled={kit.events.length === 0 || isExporting || !managerConnected || devices.length === 0 || !workDirHandle}
        onClick={handleDeploy}
        title="Save したうえで Manager 経由でデバイスに転送する">Deploy</button>
      {managerConnected && devices.length > 0 && <div className="kit-export-info">{devices.length} device(s)</div>}
      {!managerConnected && <div className="kit-export-info muted">Manager offline</div>}
    </div>
  )
}
