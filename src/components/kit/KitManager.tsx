import { useEffect, useCallback, useMemo, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibraryStore, validateKitName, composeKitEventId } from '@/stores/libraryStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'
import { formatFileSize } from '@/utils/wavIO'
import { validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, LibraryViewMode, KitDefinition } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import { CapacityGauge } from './CapacityGauge'
import { KitEventRow } from './editor/KitEventRow'
import { KitEventEditModal } from './editor/KitEventEditModal'
import { ClipModeInfoModal } from './editor/ClipModeInfoModal'
import { ClipCard } from './shared/ClipCard'
import { ClipEditModal } from './shared/ClipEditModal'
import { DevicePill } from '@/components/devices/DevicePill'
import './KitManager.css'

const DND_TYPE_CLIP = 'application/x-hapbeat-clip'
const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

function randomKitName(): string {
  // Lowercase + hyphen-only by default so the suggestion already
  // obeys contracts' kit_id regex (`^[a-z][a-z0-9-]*$`).
  const adj = ['alpha', 'beta', 'gamma', 'delta', 'echo', 'zeta', 'nova', 'pulse', 'volt', 'rush']
  const noun = ['kit', 'pack', 'set', 'mix', 'drop', 'vibe', 'hit', 'boom', 'wave', 'beat']
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

  // キーボード操作中はマウスカーソル / hover 状態を抑制する。
  // キーボードでカードを選択移動している最中に、別のカードの hover が
  // 効いていると「どちらが選択中か」が視覚的にわかりにくくなるため。
  // keydown を検知した時点で body に .using-keyboard を付け、
  // 次の mousemove で外す。CSS 側で hover と cursor を殺している。
  useEffect(() => {
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Enter', 'Delete', 'Backspace', 'Tab'])
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key)) return
      document.body.classList.add('using-keyboard')
    }
    const onMouse = () => { document.body.classList.remove('using-keyboard') }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousemove', onMouse)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousemove', onMouse)
      document.body.classList.remove('using-keyboard')
    }
  }, [])

  // Don't block the whole pane on `isLoading`. The reload flow (browser
  // refresh) has to re-restore the FileSystem handle + re-scan the
  // disk; gating render behind that just made the user stare at a
  // "Loading…" splash for ~half a second every refresh. Render the
  // normal layout immediately, with a small inline badge while the
  // background sync is in flight. The library list is empty until
  // the sync finishes — that's an OK transient state since the
  // WorkDirBar is already visible.
  return (
    <div className="kit-manager-wrapper">
      {isLoading && (
        <div className="kit-loading-badge">
          <span className="kit-loading-spinner" /> ライブラリ読込中…
        </div>
      )}
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

/**
 * 操作説明 — マウス/キーボードの全操作を 1 つのポップオーバーにまとめた
 * トップバー配置用ヘルプ。Library と Kit の両方のパネルの操作を同時に示す。
 */
function ShortcutHelp() {
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
        className="shortcut-help-btn labeled"
        onClick={() => setOpen((o) => !o)}
        title="マウス/キーボード操作の一覧を開く"
        aria-label="操作説明"
      ><span className="shortcut-help-btn-icon">?</span>操作説明</button>
      {open && (
        <div className="shortcut-help-panel" role="dialog">
          <div className="shortcut-help-title">マウス操作 (Library)</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">クリック</span>カードを選択</li>
            <li><span className="shortcut-help-key">▶</span>再生 / 停止</li>
            <li><span className="shortcut-help-key">☰ ドラッグ</span>Kit にドロップして追加</li>
            <li><span className="shortcut-help-key">Amp スライダー</span>強度 (0–100%)</li>
            <li><span className="shortcut-help-key">Edit ボタン</span>名前 / Event ID / タグ編集</li>
            <li><span className="shortcut-help-key">+ Kit ボタン</span>選択中の Kit に追加</li>
          </ul>

          <div className="shortcut-help-title">マウス操作 (Kit)</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">☰ ドラッグ</span>Kit 内で並び替え</li>
            <li><span className="shortcut-help-key">FIRE / CLIP / LIVE</span>再生モード切替 (ヘッダーの「モード説明」参照)</li>
            <li><span className="shortcut-help-key">×</span>Kit から削除</li>
          </ul>

          <div className="shortcut-help-title">キーボード（選択中）</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">↑ / ↓</span>選択を上下に移動</li>
            <li><span className="shortcut-help-key">← / →</span>Amp を ±5%</li>
            <li><span className="shortcut-help-key">Space</span>再生 / 停止</li>
            <li><span className="shortcut-help-key">Enter</span>アクティブ Kit に追加 (Library 側)</li>
            <li><span className="shortcut-help-key">Delete / Backspace</span>Kit から削除 (Kit 側)</li>
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

/**
 * Reusable folder chip — icon + path + action buttons in one compact pill.
 * Used in both the Clips panel header (library folder) and the Kit panel
 * header (kit-out folder). Keeps each folder UI next to the panel it scopes.
 */
interface FolderChipProps {
  icon: string
  name: string | null
  onPick: () => Promise<boolean>
  onClear: () => Promise<void>
  label: string          // e.g. "Library" / "Kit"
  setTitle?: string
  emptyTitle?: string
  setLabel?: string      // "+ Library" / "+ Kit"
  changeTitle?: string
  clearTitle?: string
  clearLabel?: string    // "×" or custom
}
function FolderChip({
  icon, name, onPick, onClear, label,
  setTitle, emptyTitle,
  setLabel, changeTitle, clearTitle, clearLabel = '×',
}: FolderChipProps) {
  const { toast } = useToast()
  return (
    <span className="workdir-chip" title={name ? (setTitle ?? `${label}: ${name}`) : (emptyTitle ?? `Choose ${label} folder`)}>
      <span className="workdir-icon">{icon}</span>
      {name ? (
        <>
          <span className="workdir-path" title={name}>{name}</span>
          <button className="workdir-icon-btn" onClick={async () => { if (await onPick()) toast(`${label} folder changed`, 'success') }}
            title={changeTitle ?? `Change ${label} folder`}>⇄</button>
          <button className="workdir-icon-btn danger" onClick={async () => { await onClear(); toast(`${label} folder cleared`, 'success') }}
            title={clearTitle ?? `Clear ${label} folder`}>{clearLabel}</button>
        </>
      ) : (
        <button className="workdir-icon-btn primary" onClick={async () => { if (await onPick()) toast(`${label} folder set`, 'success') }}
          title={emptyTitle ?? `Choose ${label} folder`}>{setLabel ?? `+ ${label}`}</button>
      )}
    </span>
  )
}

function WorkDirBar() {
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const setShowClipDetails = useLibraryStore((s) => s.setShowClipDetails)
  const { devices } = useHelperConnection()
  const dev0 = devices[0]
  const volumeWiper = dev0?.volumeWiper ?? null

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
      <ShortcutHelp />
      {/* Pin the device pill to the right side of the bar — original
          layout used margin-left:auto on the pill itself; the shared
          DevicePill stays layout-neutral so this divider takes the
          push instead. */}
      <span className="workdir-divider" style={{ marginLeft: 'auto' }} />
      <DevicePill />
      {volumeWiper !== null && (
        <>
          <span className="workdir-divider" />
          <span className="workdir-vol" title="Connected Hapbeat device volume (MCP4018 wiper 0–127, 128段階)">Vol {volumeWiper}/128 ({Math.round((volumeWiper / 127) * 100)}%)</span>
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
  const { isConnected, devices, send } = useHelperConnection()

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

  return { playingId, toggle, stop, hasDevice, getDeviceWiper }
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

interface TreeFolderProps {
  node: ClipTreeNode
  /** 親から受け取る open 判定。キーボード選択時に親が強制的に開くため、
   *  ローカル state ではなく parent 管理の Set<string> を参照する。 */
  isOpen: (path: string) => boolean
  toggle: (path: string) => void
  children: React.ReactNode
}
function TreeFolder({ node, isOpen, toggle, children }: TreeFolderProps) {
  const open = isOpen(node.path)
  const clipCount = countClipsInTree(node)
  const hue = hueForPath(node.path)
  return (
    <div className={`tree-group ${open ? 'is-open' : ''}`} style={{ '--tree-hue': hue } as React.CSSProperties}>
      <button className="tree-group-header" onClick={() => toggle(node.path)}>
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
 *  フォルダを先に再帰処理し、各レベルで clip を後に足す。
 *
 *  buildClipTree が clips を入力順 (= filteredClips の sort 順) で
 *  push するので、ここでは並び替えしない — フォルダだけ名前順で
 *  畳む。これによりユーザーがソート select を切り替えると tree
 *  内のクリップ並びも追従する。 */
function flattenTreeInRenderOrder(node: ClipTreeNode): LibraryClip[] {
  const result: LibraryClip[] = []
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const f of folders) result.push(...flattenTreeInRenderOrder(f))
  result.push(...node.clips)
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
  const workDirName = useLibraryStore((s) => s.workDirName)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const disconnectWorkDir = useLibraryStore((s) => s.disconnectWorkDir)
  const refreshClipsFromDir = useLibraryStore((s) => s.refreshClipsFromDir)
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const editingClipId = useLibraryStore((s) => s.editingClipId)
  const setEditingClipId = useLibraryStore((s) => s.setEditingClipId)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  // Page-wide single selection — see `LibraryState.activeSelection`.
  // Clicking a library card sets `{ panel: 'library', id }`, which
  // automatically deselects any kit-side highlight.
  const activeSelection = useLibraryStore((s) => s.activeSelection)
  const setActiveSelection = useLibraryStore((s) => s.setActiveSelection)
  const selectedId = activeSelection?.panel === 'library' ? activeSelection.id : null
  const setSelectedId = useCallback((id: string | null) => {
    setActiveSelection(id === null ? null : { panel: 'library', id })
  }, [setActiveSelection])
  const { toast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const [listMode, setListMode] = useState<ClipListMode>('tree')
  // Tree view で開いているフォルダ集合 (path で管理)。キーボード選択が
  // 別フォルダに移ったときに自動で祖先フォルダを開いて、選択カードが
  // 画面からも見えるようにするため、parent 管理にする。
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const { playingId, toggle, stop: stopPreview } = useAudioPreview()
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

  // 選択が変わったら: 祖先フォルダを全部開く → 画面内にスクロール。
  // 閉じたフォルダに選択が移ると DOM に要素が無く、選択のハイライトが
  // 画面から消えてしまうため、キーボード移動に追従して自動展開する。
  useEffect(() => {
    if (!selectedId) return
    const clip = clips.find((c) => c.id === selectedId)
    if (clip) {
      const src = clip.sourceFilename || ''
      const parts = src.split('/').filter(Boolean)
      if (parts.length > 1) {
        // 末尾はファイル名なので除き、すべての祖先 path を open 集合に追加
        const ancestors: string[] = []
        let cur = ''
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? `${cur}/${parts[i]}` : parts[i]
          ancestors.push(cur)
        }
        setOpenFolders((prev) => {
          const missing = ancestors.filter((p) => !prev.has(p))
          if (missing.length === 0) return prev
          const next = new Set(prev)
          for (const p of missing) next.add(p)
          return next
        })
      }
    }
    // open 反映を待つため次フレームでスクロール
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const el = panel.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedId, clips])

  // 表示順と一致するナビゲーション順。
  // - flat mode: displayed をそのまま (filteredClips の sort 順)
  // - tree mode: renderTreeNode 順で flat 化 (フォルダ名順 + 中の clip は filter 順)
  const orderedClips = useMemo(() => {
    if (listMode === 'flat') return [...displayed]
    return flattenTreeInRenderOrder(buildClipTree(displayed))
  }, [displayed, listMode])

  const addClipToActiveKit = useCallback(async (clip: LibraryClip) => {
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }
    // Independence: copy the library clip's metadata + audio bytes into
    // a fresh KitEvent. After this the kit owns its own snapshot — the
    // library can be archived, renamed, or deleted without affecting
    // this row. The audio blob is read once and saved under the new
    // event id inside `addEventToKit`.
    const blob = await getClipAudio(clip.id)
    if (!blob) { toast(`"${clip.name}" の audio data が見つかりません`, 'error'); return }
    const newId = await addEventToKit(activeKitId, {
      eventId: '',
      clipName: clip.name,
      clipSourceFilename: clip.sourceFilename,
      clipDuration: clip.duration,
      clipChannels: clip.channels,
      clipSampleRate: clip.sampleRate,
      clipFileSize: clip.fileSize,
      // Inherit the library clip's note — the original filename auto-
      // captured at import (or anything the user typed manually) is
      // useful to keep alongside the kit event. The user can edit it
      // independently afterwards; library renames don't propagate.
      ...(clip.note ? { note: clip.note } : {}),
      modes: ['command'],
      loop: false,
      intensity: getIntensity(clip.id),
      deviceWiper: null,
    }, blob)
    if (newId) toast(`Added "${clip.name}" to kit`, 'success')
    else toast('Kit not found', 'error')
  }, [activeKitId, addEventToKit, toast, getIntensity, getClipAudio])

  // キーボードショートカット: Space=再生、↑↓=選択移動、←→=Amp 増減
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel) return
      // テキスト入力中はスキップ。range スライダー (intensity) 上では:
      //   - ←→ は native の value adjust に任せる (既存挙動)
      //   - ↑↓ は card 切替に振る (panel handler で扱う + e.preventDefault で
      //     native value change も同時に抑制する)。
      //   こうしないとスライダーに focus している間 ↑↓ で intensity も
      //   動いてカード移動できない問題が起きる。
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
      if (editingClipId) return
      // Page-wide single selection: this handler only runs when the
      // library panel "owns" the current selection. If kit has it,
      // bail so ↑↓/Space don't fire here. When nothing is selected
      // yet, fall back to mouse hover / focus so a first key press
      // still picks up the first card under the user's cursor.
      const myPanelActive = activeSelection?.panel === 'library'
      const otherPanelActive = activeSelection?.panel === 'kit'
      if (otherPanelActive) return
      if (!myPanelActive) {
        if (!panel.contains(active) && !panel.matches(':hover')) return
      }
      if (orderedClips.length === 0) return

      const curIdx = selectedId ? orderedClips.findIndex((c) => c.id === selectedId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(orderedClips.length - 1, idx))
        const next = orderedClips[clamped]
        if (!next || next.id === selectedId) return
        // Blur any range input that still has focus from the previous
        // row — without this, ←→ continues to target the OLD slider
        // because the browser routes the key event to the focused
        // input instead of bubbling to the panel handler.
        if (isRange) (active as HTMLInputElement).blur()
        // 選択を動かすときは再生中のプレビューを停止 (= 停止ボタンと同じ挙動)
        stopPreview()
        setSelectedId(next.id)
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
  }, [orderedClips, selectedId, setSelectedId, editingClipId, activeSelection, toggle, stopPreview, getClipAudio, getIntensity, setIntensity, clips, addClipToActiveKit])

  const handleImport = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) { try { await addClipFromFile(f) } catch (e) { console.error(e) } }
  }, [addClipFromFile])

  const renderClipRow = (c: LibraryClip) => (
    <ClipRow
      key={c.id}
      clip={c}
      onStartEdit={() => setEditingClipId(c.id)}
      onRenameCommit={async (next) => {
        await updateClip(c.id, { name: next })
        await commitClipRename(c.id)
      }}
      playingId={playingId}
      onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)}
      onAddToKit={() => addClipToActiveKit(c)}
      kitAvailable={!!activeKitId}
      showDetails={showClipDetails}
      intensity={getIntensity(c.id)}
      onIntensityChange={(v) => setIntensity(c.id, v)}
      selected={selectedId === c.id}
      onSelect={() => setSelectedId(c.id)}
      onArchive={() => {
        // Archive moves the wav into clips/archive/ and drops the row.
        // The file stays on disk so users can drag it back to recover.
        // Same UX as the Kit list's × button (which moves a kit folder
        // into _archive/<kit>/). No confirm dialog: the action is
        // reversible — adding a confirm here would over-fortify a
        // non-destructive operation.
        void archiveClip(c.id)
      }}
      onSwap={async () => {
        // Resolve the *current* clip from the store on every click
        // instead of trusting the `c` closure — the closure can latch
        // a stale snapshot if `renderClipRow` was last called between
        // an in-flight rename and its store update. The lock in
        // ClipCard already prevents a second swap from starting
        // while the first is mid-flight, but reading fresh here is a
        // belt-and-suspenders guarantee.
        const cur = useLibraryStore.getState().clips.find((x) => x.id === c.id)
        if (!cur) return
        const prevName = cur.name
        const prevNote = (cur.note ?? '').trim()
        if (!prevNote) return
        const stripped = prevNote.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
        const newName = stripped.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
        if (!newName) return
        await updateClip(cur.id, { name: newName, note: prevName })
        // Wait for the on-disk WAV rename to settle BEFORE letting
        // the swap lock release (ClipCard handles that). Without this
        // the second click would catch an in-progress filename
        // transition and corrupt one of the two strings.
        await commitClipRename(cur.id)
      }}
    />
  )

  const renderTreeNode = (node: ClipTreeNode, isRoot: boolean): React.ReactNode => {
    // Folders alphabetical (familiar from OS Explorer); clips inside
    // each folder honour the global sort because buildClipTree pushed
    // them in the order from `filteredClips()` (= filter.sortBy).
    const childFolders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const body = (
      <>
        {childFolders.map((child) => (
          <TreeFolder key={child.path} node={child}
            isOpen={(p) => openFolders.has(p)}
            toggle={(p) => setOpenFolders((prev) => {
              const next = new Set(prev)
              if (next.has(p)) next.delete(p); else next.add(p)
              return next
            })}>
            {renderTreeNode(child, false)}
          </TreeFolder>
        ))}
        {node.clips.map((c) => renderClipRow(c))}
      </>
    )
    return isRoot ? body : body
  }

  if (!workDirHandle) {
    return (
      <div className="clip-panel">
        <div className="panel-header">
          <h3>Clips</h3>
          {workDirSupported && (
            <FolderChip
              icon="&#x1F4C2;"
              name={null}
              onPick={pickWorkDir}
              onClear={disconnectWorkDir}
              label="Library"
              emptyTitle="クリップ本体 (wav) を置くフォルダ。ここから Studio が clips / kits-meta を読み書きする。"
              setLabel="+ Library"
            />
          )}
        </div>
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
        {workDirSupported && (
          <FolderChip
            icon="&#x1F4C2;"
            name={workDirName}
            onPick={pickWorkDir}
            onClear={disconnectWorkDir}
            label="Library"
            emptyTitle="クリップ本体 (wav) を置くフォルダ。ここから Studio が clips / kits-meta を読み書きする。"
            setLabel="+ Library"
          />
        )}
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
        </div>
      </div>
      <div className="library-toolbar">
        <input type="text" className="library-search" placeholder="Search..." value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })} />
        <select
          className="library-sort"
          value={`${filter.sortBy}:${filter.sortOrder}`}
          onChange={(e) => {
            const [sortBy, sortOrder] = e.target.value.split(':') as ['name' | 'date' | 'duration', 'asc' | 'desc']
            setFilter({ sortBy, sortOrder })
          }}
          title="並び順"
        >
          <option value="name:asc">名前 ↑</option>
          <option value="name:desc">名前 ↓</option>
          <option value="date:desc">更新日時 (新しい順)</option>
          <option value="date:asc">更新日時 (古い順)</option>
          <option value="duration:asc">長さ (短い順)</option>
          <option value="duration:desc">長さ (長い順)</option>
        </select>
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
  onRenameCommit: (next: string) => void | Promise<void>
  playingId: string | null
  onToggle: (id: string, intensity: number) => void
  onAddToKit: () => void
  kitAvailable: boolean
  showDetails: boolean
  intensity: number
  onIntensityChange: (v: number) => void
  selected: boolean
  onSelect: () => void
  /** Archive (move to clips/archive/) — same UX as Kit list's × button. */
  onArchive: () => void
  /** Swap clip.name ↔ clip.note. Returns once IDB + on-disk file
   *  rename have settled, so the card-level lock stays held for the
   *  whole sequence. */
  onSwap: () => Promise<void>
}

function ClipRow({
  clip,
  onStartEdit,
  onRenameCommit,
  playingId,
  onToggle,
  onAddToKit,
  kitAvailable,
  showDetails,
  intensity,
  onIntensityChange,
  selected,
  onSelect,
  onArchive,
  onSwap,
}: ClipRowProps) {
  const metaSummary = `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatFileSize(clip.fileSize)}`
  return (
    <ClipCard
      name={clip.name}
      // Library no longer carries an eventId — kit composes it on add.
      eventId={null}
      eventIdEmpty={false}
      details={metaSummary}
      tags={clip.tags}
      showDetails={showDetails}
      note={clip.note}
      intensity={intensity}
      onIntensityChange={onIntensityChange}
      playing={playingId === clip.id}
      onTogglePlay={() => onToggle(clip.id, intensity)}
      selected={selected}
      onSelect={onSelect}
      dataCardId={clip.id}
      wiper={null}
      title={
        clip.note
          ? `${clip.note}\n\n${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`
          : `${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`
      }
      drag={{ type: DND_TYPE_CLIP, payload: clip.id, dragTitle: 'ドラッグして Kit に追加' }}
      onRenameCommit={(next) => { void onRenameCommit(next) }}
      onClose={onArchive}
      closeTitle="Archive — Studio から非表示 (元ファイルは管理ディレクトリに退避)"
      onSwap={onSwap}
      swapDisabled={!(clip.note ?? '').trim()}
      swapTitle={`Name ↔ Note を入れ替え (現在: "${clip.name}" ↔ "${clip.note ?? ''}")`}
      actions={[
        { label: '+ Kit', variant: 'primary', onClick: onAddToKit, disabled: !kitAvailable,
          title: kitAvailable ? 'Add to active kit' : 'Select a kit first' },
        { label: 'Edit', onClick: onStartEdit, title: 'Edit note, tags…' },
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
  const getKitEventAudio = useLibraryStore((s) => s.getKitEventAudio)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const kitDirName = useLibraryStore((s) => s.kitDirName)
  const pickKitDir = useLibraryStore((s) => s.pickKitDir)
  const disconnectKitDir = useLibraryStore((s) => s.disconnectKitDir)
  const { isConnected: managerConnected, devices, send } = useHelperConnection()
  const { toast } = useToast()
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const { playingId, toggle: togglePreview, stop: stopPreview, getDeviceWiper } = useAudioPreview()

  const [isExporting, setIsExporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  // Page-wide single selection — see `LibraryState.activeSelection`.
  // The kit panel "owns" the selection only when panel === 'kit'; if
  // the user last clicked a library card, this returns null and the
  // kit's keyboard handler stays out of the way.
  const activeSelection = useLibraryStore((s) => s.activeSelection)
  const setActiveSelection = useLibraryStore((s) => s.setActiveSelection)
  const selectedEventId = activeSelection?.panel === 'kit' ? activeSelection.id : null
  const setSelectedEventId = useCallback((id: string | null) => {
    setActiveSelection(id === null ? null : { panel: 'kit', id })
  }, [setActiveSelection])
  const [modeInfoOpen, setModeInfoOpen] = useState(false)
  // KitEvent edit modal — opens when the user clicks a row's Edit
  // action. Lives at the KitEditor level (not inside KitEventRow) so
  // it overlays the whole panel rather than the single row.
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const placeholderName = useRef(randomKitName())
  const kitPanelRef = useRef<HTMLDivElement>(null)
  // Throttled "invalid character" toast — same shape as the one inside
  // ClipCard (1.2 s rearm). Used by the Kit Name rename input below.
  const kitNameWarnArmedRef = useRef(true)
  const flagKitNameInvalid = useCallback(() => {
    if (!kitNameWarnArmedRef.current) return
    kitNameWarnArmedRef.current = false
    toast('英小文字 / 数字 / - のみ使用できます (先頭は英小文字)', 'warning')
    window.setTimeout(() => { kitNameWarnArmedRef.current = true }, 1200)
  }, [toast])

  const activeKit = kits.find((k) => k.id === activeKitId)

  // Auto-sync active kit's targetDevice with the first connected
  // device. Fires whenever the device's volume_* values change (incl.
  // the initial PONG after a fresh connection). Manual override is
  // still available via the "⟳ デバイスから取り込む" button — that
  // button is just a convenience now.
  //
  // We intentionally only mirror values that the device reports as
  // numbers; missing fields stay untouched so the user can hand-edit
  // them without us clobbering on the next push.
  const dev0 = devices[0]
  const dev0Wiper = dev0?.volumeWiper ?? null
  const dev0Level = dev0?.volumeLevel ?? null
  const dev0Steps = dev0?.volumeSteps ?? null
  useEffect(() => {
    if (!activeKit) return
    const cur = activeKit.targetDevice ?? {}
    const next: NonNullable<KitDefinition['targetDevice']> = { ...cur }
    let changed = false
    if (typeof dev0Wiper === 'number' && dev0Wiper !== cur.volume_wiper) {
      next.volume_wiper = dev0Wiper; changed = true
    }
    if (typeof dev0Level === 'number' && dev0Level !== cur.volume_level) {
      next.volume_level = dev0Level; changed = true
    }
    if (typeof dev0Steps === 'number' && dev0Steps !== cur.volume_steps) {
      next.volume_steps = dev0Steps; changed = true
    }
    if (changed) updateKit(activeKit.id, { targetDevice: next })
  // intentionally skip activeKit reference — drive only off device
  // numbers so editing the kit doesn't retrigger the sync
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev0Wiper, dev0Level, dev0Steps, activeKitId])

  // Sort UI for kit events. Persisted in localStorage so the user's
  // last choice carries between sessions (one global preference, not
  // per-kit — feels closer to OS file explorers).
  const KIT_SORT_KEY = 'hapbeat-studio-kit-sort'
  type KitSortBy = 'name' | 'date' | 'duration' | 'order'
  type KitSortOrder = 'asc' | 'desc'
  const [kitSort, setKitSort] = useState<{ by: KitSortBy; order: KitSortOrder }>(() => {
    try {
      const raw = localStorage.getItem(KIT_SORT_KEY)
      if (raw) {
        const v = JSON.parse(raw)
        if (v?.by && v?.order) return v
      }
    } catch { /* ignore */ }
    return { by: 'name', order: 'asc' }
  })
  useEffect(() => {
    try { localStorage.setItem(KIT_SORT_KEY, JSON.stringify(kitSort)) } catch { /* ignore */ }
  }, [kitSort])

  const sortedEvents = useMemo(() => {
    if (!activeKit) return []
    const arr = [...activeKit.events]
    if (kitSort.by === 'order') {
      // Insertion order — reflect the array as stored. `desc` reverses
      // it so newest-added shows up first.
      return kitSort.order === 'asc' ? arr : arr.reverse()
    }
    arr.sort((a, b) => {
      // Independence: sort by the event's OWN copied clip metadata
      // rather than looking it up in the library (which may have
      // archived/renamed the source entry). 'date' sort falls back
      // to the kit's updatedAt — KitEvents don't carry their own
      // updatedAt so per-event date sort isn't meaningful here.
      let cmp = 0
      if (kitSort.by === 'name') {
        cmp = (a.clipName ?? '').toLowerCase().localeCompare((b.clipName ?? '').toLowerCase())
      } else if (kitSort.by === 'date') {
        // No per-event date — leave order stable (cmp stays 0).
      } else if (kitSort.by === 'duration') {
        cmp = (a.clipDuration ?? 0) - (b.clipDuration ?? 0)
      }
      return kitSort.order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [activeKit, kitSort])

  // Kit を切り替えたら選択をクリアし、再生中のプレビューも止める。
  // Only clear OUR side of the shared selection — don't wipe a
  // library selection the user might have set.
  useEffect(() => {
    if (activeSelection?.panel === 'kit') setActiveSelection(null)
    stopPreview()
    // setActiveSelection / activeSelection deps left out intentionally:
    // we only want to react to activeKitId changes, not selection
    // churn (which would re-clear on every click).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKitId, stopPreview])

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
      // テキスト入力中はスキップ。range スライダー (intensity) 上では:
      //   - ←→ は native の value adjust に任せる (既存挙動)
      //   - ↑↓ は card 切替に振る (panel handler で扱う + e.preventDefault で
      //     native value change も同時に抑制する)。
      //   こうしないとスライダーに focus している間 ↑↓ で intensity も
      //   動いてカード移動できない問題が起きる。
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
      // Page-wide single selection: only the panel that owns the
      // current selection handles arrow keys. If library has it, bail
      // here. When nothing is selected yet, fall back to focus / hover
      // so a first key press still picks up a card under the cursor.
      const myPanelActive = activeSelection?.panel === 'kit'
      const otherPanelActive = activeSelection?.panel === 'library'
      if (otherPanelActive) return
      if (!myPanelActive) {
        if (!panel.contains(active) && !panel.matches(':hover')) return
      }
      // 視覚順 (name 昇順) に揃える。追加順で辿ると表示とバラバラに動く。
      const events = sortedEvents
      if (events.length === 0) return

      const curIdx = selectedEventId ? events.findIndex((ev) => ev.id === selectedEventId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(events.length - 1, idx))
        const next = events[clamped]
        if (!next || next.id === selectedEventId) return
        // Blur the range input that still has focus on the previous
        // row — otherwise ←→ keeps adjusting the OLD card's intensity
        // because the browser routes the event to the focused input.
        if (isRange) (active as HTMLInputElement).blur()
        // 選択を動かすときは再生中のプレビューを停止 (= 停止ボタンと同じ挙動)
        stopPreview()
        setSelectedEventId(next.id)
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
            togglePreview(currentEvent.id, () => getKitEventAudio(currentEvent.id), currentEvent.intensity)
            const w = getDeviceWiper()
            if (w !== null && w !== currentEvent.deviceWiper) {
              updateKitEvent(activeKit.id, currentEvent.id, { deviceWiper: w })
            }
          }
          break
        case 'Delete':
        case 'Backspace':
          // Delete / Backspace — remove the selected event (= × button).
          // 削除後は同位置 (末尾ならその前) のイベントに選択を移す。
          if (currentEvent) {
            e.preventDefault()
            const removedIdx = curIdx
            removeEventFromKit(activeKit.id, currentEvent.id)
            const remaining = events.length - 1
            if (remaining <= 0) {
              setSelectedEventId(null)
            } else {
              const nextIdx = Math.min(removedIdx, remaining - 1)
              const nextEv = activeKit.events.filter((ev) => ev.id !== currentEvent.id)[nextIdx]
              setSelectedEventId(nextEv?.id ?? null)
            }
          }
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeKit, sortedEvents, selectedEventId, setSelectedEventId, activeSelection, updateKitEvent, togglePreview, stopPreview, getKitEventAudio, getDeviceWiper, removeEventFromKit])

  const handleCreate = useCallback(async (name?: string) => {
    // Match the same constraint applied in the rename input — strip
    // disallowed characters silently before persisting.
    const raw = (name ?? placeholderName.current).trim()
    // Strip everything that isn't lowercase a-z / 0-9 / hyphen so
    // the resulting name passes validateKitName + serves as a valid
    // contracts kit_id without further normalisation.
    let cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
    // Drop leading non-letters — kit_id must start with a-z.
    cleaned = cleaned.replace(/^[^a-z]+/, '')
    if (!cleaned) {
      toast('Kit 名は英小文字 / 数字 / - のみ・先頭は英小文字', 'error')
      return
    }
    await createKit(cleaned)
    placeholderName.current = randomKitName()
  }, [createKit, toast])

  const handleKitDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDropActive(false); setDragOverIdx(null)
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }

    const cid = e.dataTransfer.getData(DND_TYPE_CLIP)
    if (cid) {
      const c = clips.find((x) => x.id === cid); if (!c) return
      // Same copy-on-add semantics as `addClipToActiveKit` — the dropped
      // clip's audio bytes get duplicated into the kit-event-owned IDB
      // slot so the kit is independent of the library entry.
      const blob = await getClipAudio(c.id)
      if (!blob) { toast(`"${c.name}" の audio data が見つかりません`, 'error'); return }
      const newId = await addEventToKit(activeKitId, {
        eventId: '',
        clipName: c.name,
        clipSourceFilename: c.sourceFilename,
        clipDuration: c.duration,
        clipChannels: c.channels,
        clipSampleRate: c.sampleRate,
        clipFileSize: c.fileSize,
        // Inherit library note (see addClipToActiveKit comment).
        ...(c.note ? { note: c.note } : {}),
        modes: ['command'],
        loop: false,
        intensity: 0.5,
        deviceWiper: null,
      }, blob)
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

  // Kit のデバイス flash 使用量は FIRE (command) モードのイベントだけ数える。
  // CLIP / LIVE はデバイスに WAV を載せず SDK 側ストリームで送るため flash を消費しない。
  // multi-mode (FIRE+CLIP) は command 側だけが install-clips/ に焼かれる
  // ので、ev.modes に 'command' が含まれていれば 1 回だけ計上する。
  const kitSize = activeKit
    ? activeKit.events.reduce((s, ev) => {
        const hasCommand = ev.modes?.length
          ? ev.modes.includes('command')
          : true  // legacy event without modes[] — assume command
        if (!hasCommand) return s
        // Independence: each event carries its own clipFileSize snapshot
        // (no library lookup). The estimate is roughly the source byte
        // count — the actual on-disk install-clips/ WAV is 16 kHz PCM16
        // which may be smaller, but this is the right ballpark for the
        // user's "is this kit going to fit on flash?" sanity check.
        return s + (ev.clipFileSize ?? 0)
      }, 0) + 1024
    : 0

  return (
    <div className="kit-editor" ref={kitPanelRef} tabIndex={-1}>
      {/* One-row header: title + count + folder chip + create bar.
          Clips 側と違い Kit は検索/import 行が不要なので 1 行にまとめる。 */}
      <div className="panel-header kit-panel-header">
        <h3>Kits</h3>
        <span className="library-count">{kits.length}</span>
        {workDirSupported && (
          <FolderChip
            icon="&#x1F4E6;"
            name={kitDirName}
            onPick={pickKitDir}
            onClear={disconnectKitDir}
            label="Kit"
            emptyTitle="Kit の書き出し先フォルダ。未指定なら Library フォルダ直下に <packId>/ を作る。Unity Assets 等を選ぶと直接そこに書き出せる。"
            setLabel="+ Kit"
          />
        )}
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
                    <label className="kit-meta-field">
                      <span>Name <span className="field-hint">英小文字 / 数字 / - のみ・先頭は英小文字</span></span>
                      <input
                        type="text"
                        value={activeKit.name}
                        // Strip-on-input: silently drop disallowed chars and
                        // lowercase as the user types, so they cannot create
                        // an invalid kit name in the first place. Pasting
                        // "My_Kit 2" becomes "mykit2" — a (throttled) toast
                        // explains *why* their character disappeared.
                        onChange={(e) => {
                          const raw = e.target.value
                          let cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
                          cleaned = cleaned.replace(/^[^a-z]+/, '')
                          if (cleaned !== raw) flagKitNameInvalid()
                          if (cleaned !== activeKit.name) updateKit(activeKit.id, { name: cleaned })
                        }}
                        maxLength={64}
                        pattern="[a-z][a-z0-9-]*"
                        title={validateKitName(activeKit.name) ?? '英小文字 / 数字 / - のみ・先頭は英小文字'}
                        style={validateKitName(activeKit.name) ? { borderColor: 'var(--error)' } : undefined}
                      />
                      {validateKitName(activeKit.name) && (
                        <span className="kit-meta-error" style={{ color: 'var(--error)', fontSize: 13, marginTop: 2 }}>
                          {validateKitName(activeKit.name)}
                        </span>
                      )}
                    </label>
                    <label className="kit-meta-field"><span>Version</span>
                      <input type="text" value={activeKit.version} onChange={(e) => updateKit(activeKit.id, { version: e.target.value })} /></label>
                  </div>

                  <details className="kit-target-device">
                    <summary>
                      Target Device
                      <span className="field-hint">
                        Kit 作者が調整したハードウェア / 設定を manifest に記録（任意）
                      </span>
                    </summary>
                    <div className="kit-meta-fields">
                      <label className="kit-meta-field">
                        <span>Board <span className="field-hint">例: duo_wl_v3</span></span>
                        <input
                          type="text"
                          value={activeKit.targetDevice?.board ?? ''}
                          onChange={(e) => {
                            const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                board: cleaned || undefined,
                              },
                            })
                          }}
                          placeholder="duo_wl_v3"
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>FW min</span>
                        <input
                          type="text"
                          value={activeKit.targetDevice?.firmware_version_min ?? ''}
                          onChange={(e) => updateKit(activeKit.id, {
                            targetDevice: {
                              ...activeKit.targetDevice,
                              firmware_version_min: e.target.value || undefined,
                            },
                          })}
                          placeholder="0.1.0"
                        />
                      </label>
                    </div>
                    <div className="kit-meta-fields">
                      <label className="kit-meta-field">
                        <span>Volume level</span>
                        <input
                          type="number"
                          min={0}
                          value={activeKit.targetDevice?.volume_level ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_level: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>Wiper (0-127)</span>
                        <input
                          type="number"
                          min={0} max={127}
                          value={activeKit.targetDevice?.volume_wiper ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_wiper: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>Volume steps</span>
                        <input
                          type="number"
                          min={1}
                          value={activeKit.targetDevice?.volume_steps ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_steps: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      className="library-btn"
                      style={{ marginTop: 6 }}
                      disabled={!devices[0]?.online}
                      title="現在選択中のデバイスから wiper / volume を取得して反映"
                      onClick={() => {
                        const dev = devices[0]
                        if (!dev) return
                        updateKit(activeKit.id, {
                          targetDevice: {
                            ...activeKit.targetDevice,
                            volume_level: dev.volumeLevel ?? activeKit.targetDevice?.volume_level,
                            volume_wiper: dev.volumeWiper ?? activeKit.targetDevice?.volume_wiper,
                            volume_steps: dev.volumeSteps ?? activeKit.targetDevice?.volume_steps,
                          },
                        })
                      }}
                    >⟳ デバイスから取り込む</button>
                  </details>

                  <CapacityGauge kitSize={kitSize} managerConnected={managerConnected} devices={devices} send={send} />

                  <div className="kit-events-header">
                    <span>Events ({activeKit.events.length})</span>
                    <span className="kit-size-label" title="FIRE (command) モードのクリップだけがデバイス flash に載る容量">{formatFileSize(kitSize)}</span>
                    <select
                      className="library-sort"
                      value={`${kitSort.by}:${kitSort.order}`}
                      onChange={(e) => {
                        const [by, order] = e.target.value.split(':') as [KitSortBy, KitSortOrder]
                        setKitSort({ by, order })
                      }}
                      title="並び順"
                    >
                      <option value="name:asc">名前 ↑</option>
                      <option value="name:desc">名前 ↓</option>
                      <option value="date:desc">更新日時 (新しい順)</option>
                      <option value="date:asc">更新日時 (古い順)</option>
                      <option value="duration:asc">長さ (短い順)</option>
                      <option value="duration:desc">長さ (長い順)</option>
                      <option value="order:asc">追加順</option>
                      <option value="order:desc">追加順 (逆)</option>
                    </select>
                    <button
                      className="kit-events-mode-help-btn"
                      onClick={() => setModeInfoOpen(true)}
                      title="FIRE / CLIP の各モードとデバイス側の挙動を説明"
                    ><span className="kit-events-mode-help-icon">?</span>モード説明</button>
                    <select
                      className="kit-events-mode-bulk"
                      value=""
                      disabled={activeKit.events.length === 0}
                      onChange={(e) => {
                        const v = e.target.value
                        if (!v) return
                        // モードが変わると再生挙動 (device 内蔵 / stream) が変わるので
                        // 鳴りっぱなしを防ぐために現在のプレビューを止める。
                        stopPreview()
                        // Bulk replace each event's modes wholesale.
                        // `both` = ['command', 'stream_clip'] (FIRE+CLIP
                        // → schema 2.0.0 で `events` (command) + stream_events
                        // の両 bucket に同 base eventId を emit)。
                        // Single-mode options replace with `[mode]` so any
                        // existing multi-mode events collapse to one.
                        type KEM = import('@/types/library').KitEventMode
                        const nextModes: KEM[] =
                          v === 'both'    ? ['command', 'stream_clip'] :
                          v === 'command' ? ['command'] :
                          v === 'stream_clip' ? ['stream_clip'] :
                          ['command']
                        const nextEvents = activeKit.events.map((ev) => {
                          const same =
                            ev.modes &&
                            ev.modes.length === nextModes.length &&
                            ev.modes.every((m, i) => m === nextModes[i])
                          return same ? ev : { ...ev, modes: [...nextModes] }
                        })
                        void updateKit(activeKit.id, { events: nextEvents })
                      }}
                      title="Kit 内の全イベントを選択したモードに一括変更"
                    >
                      <option value="" disabled>一括変更…</option>
                      <option value="command">&gt; FIRE — 全て</option>
                      <option value="stream_clip">♪ CLIP — 全て</option>
                      <option value="both">&gt;♪ BOTH — 全て (command + stream 両 bucket)</option>
                    </select>
                  </div>

                  <div className="kit-events-list">
                    {sortedEvents.length === 0
                      ? <div className="kit-events-empty kit-drop-zone">Drag clips here.</div>
                      // sortedEvents は keyboard navigation と同じ参照を使い、
                      // 視覚順と keyboard 順を必ず一致させる。
                      : sortedEvents.map((ev, i) => (
                        <KitEventRow
                          key={ev.id}
                          event={ev}
                          playing={playingId === ev.id}
                          showDetails={showClipDetails}
                          selected={selectedEventId === ev.id}
                          onSelect={() => setSelectedEventId(ev.id)}
                          onTogglePlay={() => {
                            togglePreview(ev.id, () => getKitEventAudio(ev.id), ev.intensity)
                            const w = getDeviceWiper()
                            if (w !== null && w !== ev.deviceWiper) updateKitEvent(activeKit.id, ev.id, { deviceWiper: w })
                          }}
                          onIntensityChange={(v) => updateKitEvent(activeKit.id, ev.id, { intensity: v })}
                          onModesChange={(modes) => {
                            // Stop playback before mutating modes — the same
                            // KitEvent can switch transport (device-flash
                            // FIRE vs SDK CLIP), and leaving an in-flight
                            // preview behind would race the new state.
                            stopPreview()
                            void updateKitEvent(activeKit.id, ev.id, { modes })
                          }}
                          onDelete={() => removeEventFromKit(activeKit.id, ev.id)}
                          onRenameCommit={async (next) => {
                            // Kit-side rename: mutates this KitEvent's owned
                            // clipName (and recomposed eventId). Independent
                            // of the source library entry — the library clip
                            // the user originally dragged in stays untouched.
                            const cleaned = next.trim()
                            if (!cleaned) return
                            const newEventId = composeKitEventId(activeKit.name, cleaned)
                            await updateKitEvent(activeKit.id, ev.id, {
                              clipName: cleaned,
                              eventId: newEventId,
                            })
                          }}
                          // 常に名前順表示のため drag-reorder は意味を持たない (= 無効)。
                          // clip を新規 drop する場合は末尾追加にフォールバックする。
                          onDragOverRow={() => { /* noop: 名前順表示のため挿入位置を固定できない */ void i }}
                          dragOverIndicator={false}
                          onStartEdit={() => setEditingEventId(ev.id)}
                          onSwap={async () => {
                            // Resolve fresh state (not the loop's `ev`
                            // closure) — see ClipRow.onSwap comment.
                            const kits = useLibraryStore.getState().kits
                            const cur = kits
                              .find((k) => k.id === activeKit.id)
                              ?.events.find((e) => e.id === ev.id)
                            if (!cur) return
                            const prevName = cur.clipName
                            const prevNote = (cur.note ?? '').trim()
                            if (!prevNote) return
                            const stripped = prevNote.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')
                            const newName = stripped.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
                            if (!newName) return
                            // updateKitEvent does NOT auto-recompose
                            // eventId from clipName changes, so we set
                            // it explicitly here (same as the in-row
                            // rename path).
                            const newEventId = composeKitEventId(activeKit.name, newName)
                            await updateKitEvent(activeKit.id, ev.id, {
                              clipName: newName,
                              eventId: newEventId,
                              note: prevName,
                            })
                          }}
                        />
                      ))}
                  </div>

                  <KitExportSection kit={activeKit} isExporting={isExporting} setIsExporting={setIsExporting}
                    managerConnected={managerConnected} devices={devices} send={send} />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {modeInfoOpen && <ClipModeInfoModal onClose={() => setModeInfoOpen(false)} />}
      {editingEventId && activeKit && (() => {
        // Resolve fresh each render so the modal reflects the latest
        // event state (e.g. clipName edits that auto-recompose eventId).
        // If the event was removed elsewhere mid-edit, drop the modal.
        const ev = activeKit.events.find((e) => e.id === editingEventId)
        if (!ev) {
          setEditingEventId(null)
          return null
        }
        return (
          <KitEventEditModal
            event={ev}
            onClose={() => setEditingEventId(null)}
            onUpdate={async (updates) => {
              // When clipName changes, recompose eventId in the same
              // patch so the on-disk filename + manifest stay in sync
              // — same rule the in-row rename uses.
              if (updates.clipName !== undefined && updates.clipName !== ev.clipName) {
                const cleaned = updates.clipName.trim()
                if (!cleaned) return
                const newEventId = composeKitEventId(activeKit.name, cleaned)
                await updateKitEvent(activeKit.id, ev.id, {
                  ...updates,
                  clipName: cleaned,
                  eventId: newEventId,
                })
                return
              }
              await updateKitEvent(activeKit.id, ev.id, updates)
            }}
            onRemove={async () => {
              await removeEventFromKit(activeKit.id, ev.id)
            }}
          />
        )
      })()}
    </div>
  )
}

// ============================================================
// Kit Export
// ============================================================

function KitExportSection({ kit, isExporting, setIsExporting, managerConnected, devices, send }: {
  kit: import('@/types/library').KitDefinition
  isExporting: boolean; setIsExporting: (v: boolean) => void
  managerConnected: boolean
  devices: import('@/types/manager').DeviceInfo[]
  send: (msg: import('@/types/manager').ManagerMessage) => void
}) {
  const { toast } = useToast()
  const { lastMessage } = useHelperConnection()
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)

  // Per-IP deploy progress sourced from Helper's `deploy_progress` push.
  // Cleared on a new deploy (`deploy started`) and on completion.
  const [progressByIp, setProgressByIp] = useState<Record<string, { pct: number; msg: string; done?: boolean; ok?: boolean }>>({})

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>
    if (t === 'deploy_progress' && typeof p.ip === 'string') {
      setProgressByIp((cur) => ({
        ...cur,
        [p.ip as string]: {
          pct: Math.max(0, Math.min(100, Number(p.percent ?? 0))),
          msg: String(p.message ?? ''),
        },
      }))
    } else if (t === 'deploy_result' && typeof p.ip === 'string') {
      // Per-device finish (helper sends one of these per target after
      // its run). We only mark done for the one that finished.
      const ip = p.ip as string
      const ok = p.success === true
      const msg = String(p.message ?? (ok ? 'complete' : 'failed'))
      setProgressByIp((cur) => ({
        ...cur,
        [ip]: {
          pct: ok ? 100 : (cur[ip]?.pct ?? 0),
          msg,
          done: true,
          ok,
        },
      }))
      // Surface failures via toast — the inline progress row also
      // shows the same message but the user often misses it. Helper
      // already includes the "TCP 7701 connect failed → power-cycle
      // the device" hint in its message text.
      if (!ok) toast(`${ip} 配信失敗: ${msg}`, 'error')
    }
  }, [lastMessage, toast])
  const kitDirHandle = useLibraryStore((s) => s.kitDirHandle)
  // kit-out dir が設定されていればそちらを、無ければ library workDir を root にする。
  // どちらの場合も root 直下に `<packId>/` フォルダを作る (kits/ 階層は挟まない)。
  const outRoot = kitDirHandle ?? workDirHandle

  // Persistence is owned by libraryStore: every kit-mutating action
  // (createKit / updateKit / addEventToKit / updateKitEvent /
  //  removeEventFromKit) calls scheduleKitFlush on its own, so the
  // <outRoot>/<packId>/ folder stays in lockstep with the store
  // regardless of which kit is "active" or whether KitExportSection
  // is even mounted. This component only owns Deploy + status display.

  // Mirror libraryStore's localFsStatus into a local label so the
  // pending → saving → saved transition shows next to Deploy.
  const fsStatus = useLibraryStore((s) => s.localFsStatus)
  const fsLastMsg = useLibraryStore((s) => s.localFsLastMsg)

  /**
   * Shared pre-flight for Deploy and Save Folder. Returns true when
   * the kit is OK to build (valid name, all events have well-formed
   * eventIds). On failure, surfaces the reason via toast / alert and
   * returns false so the caller bails. `requireDevices` is the only
   * difference between the two flows — Save Folder doesn't need
   * Helper / devices, just an outRoot.
   */
  const preflightKit = useCallback((requireDevices: boolean): boolean => {
    if (!outRoot) {
      toast('Library / Kit Folder を選択してください', 'error')
      return false
    }
    if (requireDevices && (!managerConnected || devices.length === 0)) {
      toast('No devices', 'error')
      return false
    }
    const kitErr = validateKitName(kit.name)
    if (kitErr) { toast(`Kit name invalid: ${kitErr}`, 'error'); return false }

    // FIRE / CLIP どちらも eventId を manifest key として使うので、
    // mode の如何にかかわらず非空の eventId が必須。
    const missing = kit.events.filter((e) => !e.eventId)
    if (missing.length > 0) {
      alert(
        `${missing.length} event(s) have no Event ID.\n` +
        `These usually have a clip with an empty Name — open the clip and set one.`
      )
      return false
    }

    const validations = validateEventIds(kit)
    const invalid = validations.filter((v) => !v.valid)
    if (invalid.length > 0) {
      const ids = invalid.map((v) => `  "${v.eventId}"`).join('\n')
      alert(
        `${invalid.length} event(s) have an Event ID that breaks the contracts format ` +
        `(category.name, only [a-z 0-9 _ -]):\n${ids}`
      )
      return false
    }
    return true
  }, [outRoot, managerConnected, devices, kit, toast])

  /**
   * Save Folder = Kit メタ + manifest + WAV を kit フォルダに書き出す。
   * 内部的には Deploy と同じ exportKitAsPack を通すが、Helper への
   * 送信は行わない。
   *
   * パフォーマンス: WAV の re-encode は IDB の encoded-WAV キャッシュ
   * (キーは event の source-blob SHA-1 hash) で skip される。前回保存
   * 以降に音声が変わっていない event は decode + 16 kHz resample +
   * encode を全部 skip するので、amp / intensity / device_wiper を
   * 触っただけのケースは manifest 書き換えのみで完了する。
   *
   * Kit メタ (kits-meta.json) は各編集アクションで自動保存されるが、
   * Kit フォルダ内の WAV / manifest の書き出しは明示クリック必須
   * (2026-05-25 で per-edit auto-flush を廃止)。
   */
  const handleSaveFolder = useCallback(async () => {
    if (!preflightKit(false)) return
    setIsExporting(true)
    try {
      const out = await useLibraryStore.getState().requestKitFolderSave(
        kit.id,
        `kit "${kit.name}" をフォルダに保存`,
      )
      if (out) {
        toast(`Saved "${out.packId}" to kit folder`, 'success')
      } else {
        // requestKitFolderSave's underlying flushKitFolderNow already
        // pushed an error / retrying pill — toast a top-level summary
        // so the user sees something even if they're not watching the
        // footer.
        toast('フォルダ保存に失敗しました (詳細はステータス表示)', 'error')
      }
    } catch (err) {
      toast(`Save failed: ${err instanceof Error ? err.message : err}`, 'error')
    } finally { setIsExporting(false) }
  }, [kit, preflightKit, setIsExporting, toast])

  const handleDeploy = useCallback(async () => {
    if (!preflightKit(true)) return

    setIsExporting(true)
    setProgressByIp(
      Object.fromEntries(devices.map((d) => [d.ipAddress, { pct: 0, msg: 'queued…' }])),
    )
    try {
      // Prefer the cached ZIP from the most recent auto-save. If none
      // exists (e.g. user just changed something and the debounce
      // hasn't fired yet), force a synchronous flush to get a fresh
      // blob aligned with the on-disk folder.
      const store = useLibraryStore.getState()
      const out = store.getLastBuiltKit(kit.id) ?? await store.flushKitFolderNow(kit.id)
      if (!out) { toast('Build failed', 'error'); return }
      const ab = await out.blob.arrayBuffer(); const bytes = new Uint8Array(ab)
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      send({ type: 'deploy_kit_data', payload: { kit_id: out.packId, zip_base64: btoa(bin), targets: devices.map((d) => d.ipAddress) }})
      // Don't claim "sent" success here — the helper hasn't reached the
      // device yet. Per-device deploy_result will toast either
      // success or failure once the TCP write actually settles.
      toast(`Sending "${out.packId}" to ${devices.length} device(s)…`, 'info')
    } catch (err) { toast(`Deploy failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [kit, devices, send, preflightKit, setIsExporting, toast])

  // Status copy shown beside the Deploy button. Save Folder / Deploy
  // both push their `saving → saved` transition through the store's
  // localFsStatus, so this label reflects whichever ran last. Blocker
  // conditions (no outRoot / invalid kit name) take precedence so the
  // user always knows why nothing is happening.
  const saveStatusLabel = (() => {
    if (!outRoot) return '⚠ Library / Kit Folder を選択してください'
    if (validateKitName(kit.name)) return '⚠ kit 名が無効'
    // fsLastMsg references the last touched kit name — show the
    // current kit's status only when the message refers to it, so
    // editing kit B doesn't flash kit A's "saved" label.
    const refersToThisKit = fsLastMsg.includes(`"${kit.name}"`)
    if (!refersToThisKit) return ''
    switch (fsStatus) {
      case 'saving': return '保存中…'
      case 'saved': return '✓ 保存済み'
      case 'retrying': return `⟳ ${fsLastMsg}`
      case 'error': return `✗ ${fsLastMsg}`
      case 'idle':
      default: return ''
    }
  })()

  // Save Folder is enabled whenever a folder is picked and the kit
  // name is valid — device / Helper presence is irrelevant. Deploy
  // additionally requires Helper online + at least one device.
  const saveBlocked = kit.events.length === 0 || isExporting || !outRoot || !!validateKitName(kit.name)
  const deployBlocked = saveBlocked || !managerConnected || devices.length === 0

  return (
    <div className="kit-export-section-wrap">
      <div className="kit-export-section">
        <button
          className="library-btn primary"
          disabled={deployBlocked}
          onClick={handleDeploy}
          title="Kit folder をビルド後、Helper 経由でデバイスに転送する"
        >Deploy</button>
        <button
          className="library-btn"
          disabled={saveBlocked}
          onClick={handleSaveFolder}
          title={
            'Kit メタ + manifest + WAV を kit フォルダに保存する。\n' +
            'Device には送らない (Deploy せずローカル保存だけしたい時に使う)。\n' +
            '音声が前回保存時から変わっていない event は WAV 再 encode を skip するので、amp / intensity 調整のみのケースは高速。'
          }
        >Save Folder</button>

        {/* Per-device deploy progress sits to the *right* of the
            Deploy button — the user's eye stays on the same row.
            Multiple devices stack vertically inside this column. */}
        <div className="kit-deploy-progress-inline">
          {Object.keys(progressByIp).length === 0 ? (
            <span className="kit-export-info muted">
              {/* Save status (saving / saved / error) takes precedence
                  over the passive deploy-readiness hints — explicit
                  Save Folder works without devices, so a
                  "デバイスが見つかりません" message would lie about what's
                  actually happening. */}
              {!outRoot
                ? 'Library または Kit Folder を選択してください'
                : saveStatusLabel
                  ? saveStatusLabel
                  : !managerConnected ? 'Helper offline'
                  : devices.length === 0 ? 'デバイスが見つかりません'
                  : `${devices.length} device(s) ready`}
            </span>
          ) : (
            // 1-line compact rows: [ip] [bar] [pct] [msg]
            // Keeps section height stable regardless of how many
            // devices are deploying (>2 devices scroll inside).
            Object.entries(progressByIp).map(([ip, st]) => (
              <div key={ip} className="kit-deploy-progress-row">
                <span className="kit-deploy-progress-ip">{ip}</span>
                <div className="kit-deploy-progress-bar">
                  <div
                    className={`kit-deploy-progress-fill ${st.done ? (st.ok ? 'ok' : 'err') : ''}`}
                    style={{ width: `${st.pct}%` }}
                  />
                </div>
                <span className="kit-deploy-progress-pct">{st.pct}%</span>
                <span className="kit-deploy-progress-msg">{st.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
