import { useState, useCallback, useMemo, useRef, useEffect, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  DisplayElementType,
  DisplayLayout,
  DisplayPage,
  ButtonActionType,
  SingleButtonAction,
  PerButtonActions,
  DisplayOrientation,
  LedConfig,
  VolumeConfig,
} from '@/types/display'
import { ELEMENT_FIXED_SIZES, getElementSize, DEFAULT_LED_RULES, DEFAULT_VOLUME_CONFIG } from '@/types/display'
import type { DeviceModel, DeviceHardwareSpec } from '@/types/device'
import { DEVICE_SPECS } from '@/types/device'
import { ElementPalette, elementMetas, getElementMeta } from '@/components/common/ElementPalette'
import { getElementPreviewText, DEFAULT_SIM_STATE } from '@/utils/displayPreview'
import type { SimState } from '@/utils/displayPreview'
import { allTemplates, standardTemplate } from '@/utils/templates'
import {
  exportDisplayLayout,
  importDisplayLayout,
  saveDisplayToIDB,
  toFirmwareFormat,
  type DisplaySavedState,
} from '@/utils/displayLayoutIO'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import { useToast } from '@/components/common/Toast'
import { LedConfigModal } from './LedConfigModal'
import { VolumeConfigModal } from './VolumeConfigModal'
import './DisplayEditor.css'

/** パレットからドラッグ中の要素タイプ + variant */
let _dragTypeCallback: ((type: DisplayElementType | null) => void) | null = null
let _dragVariant: string | undefined
export function setCurrentDragType(type: DisplayElementType | null) {
  _dragTypeCallback?.(type)
}
export function setCurrentDragVariant(variant: string | undefined) {
  _dragVariant = variant
}
export function getCurrentDragVariant(): string | undefined {
  return _dragVariant
}

// OLED: 128x32 = 16文字×2行（8x16px/文字）
const GRID_COLS = 16
const GRID_ROWS = 2
const CELL_W = 32   // 1文字セルの表示幅
const CELL_H = 56   // 1文字セルの表示高さ
const GRID_WIDTH = GRID_COLS * CELL_W   // 512
const GRID_HEIGHT = GRID_ROWS * CELL_H  // 112
const BORDER_W = 2  // CSS border width on .oled-screen

/** グリッド行内のアイテム（空セルまたは要素カード） */
type GridItem =
  | { kind: 'empty'; col: number }
  | { kind: 'element'; col: number; span: number; el: import('@/types/display').DisplayElement; text: string }

/** 各行を「空セル / 要素カード」のリストに変換 */
function buildGridRows(page: DisplayPage | undefined, simState: SimState): GridItem[][] {
  const rows: GridItem[][] = Array.from({ length: GRID_ROWS }, () => [])
  if (!page) {
    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++) rows[r].push({ kind: 'empty', col: c })
    return rows
  }

  // 占有マップ: どのセルがどの要素に属するか
  const occupied: (string | null)[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => null)
  )
  for (const el of page.elements) {
    const size = getElementSize(el.type, el.variant)
    for (let dx = 0; dx < size[0]; dx++) {
      const col = el.pos[0] + dx
      if (col < GRID_COLS && el.pos[1] < GRID_ROWS) occupied[el.pos[1]][col] = el.id
    }
  }

  for (let r = 0; r < GRID_ROWS; r++) {
    let c = 0
    while (c < GRID_COLS) {
      const elId = occupied[r][c]
      if (elId) {
        const el = page.elements.find((e) => e.id === elId)!
        const size = getElementSize(el.type, el.variant)
        const text = getElementPreviewText(el.type, simState, el.variant)
        rows[r].push({ kind: 'element', col: c, span: size[0], el, text })
        c += size[0]
      } else {
        rows[r].push({ kind: 'empty', col: c })
        c++
      }
    }
  }
  return rows
}

const DEFAULT_BUTTON_ACTION: SingleButtonAction = {
  short_press: 'none', long_press: 'none', hold: 'none',
}

function generateId(): string {
  return `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function createDefaultPerButtonActions(spec: DeviceHardwareSpec): PerButtonActions {
  const actions: PerButtonActions = {}
  for (const btn of spec.buttons) actions[btn.id] = { ...DEFAULT_BUTTON_ACTION }
  return actions
}

/** アクション選択肢を2列グリッドで表示するためにグループ化 */
/** ページ名に応じた goto_page ラベルを動的生成 */
/** ドロップダウン用アイテム。value は ButtonActionType だが goto_page は "goto_page:0" 等の拡張形式 */
interface ActionItem { value: string; label: string }
interface ActionGroup { label: string; items: ActionItem[] }

/** 短押し・長押し用アクション */
function buildActionGroups(pages: DisplayPage[]): ActionGroup[] {
  const pageItems: ActionItem[] = [
    { value: 'prev_page', label: 'Prev Page' },
    { value: 'next_page', label: 'Next Page' },
  ]
  pages.forEach((p, i) => {
    pageItems.push({ value: `goto_page:${i}`, label: `\u2192 ${p.name}` })
  })

  return [
    { label: 'Page', items: pageItems },
    {
      label: 'Player / Position',
      items: [
        { value: 'player_inc', label: 'Player +1' },
        { value: 'player_dec', label: 'Player -1' },
        { value: 'position_inc', label: 'Pos +1' },
        { value: 'position_dec', label: 'Pos -1' },
      ],
    },
    {
      label: 'Other',
      items: [
        { value: 'mode_toggle', label: 'Mode Toggle' },
        { value: 'volume_up', label: 'Volume +' },
        { value: 'volume_down', label: 'Volume -' },
        { value: 'display_toggle', label: 'Display ON/OFF' },
        { value: 'none', label: '\u2014 (None)' },
      ],
    },
  ]
}

/** 押し続け用アクション（ページ一覧のみ） */
function buildHoldActionGroups(pages: DisplayPage[]): ActionGroup[] {
  const items: ActionItem[] = []
  pages.forEach((p, i) => {
    items.push({ value: `hold_page:${i}`, label: p.name })
  })
  items.push({ value: 'none', label: '\u2014 (None)' })
  return [{ label: 'Hold to show', items }]
}



/** 衝突チェック: 指定位置に要素を置けるか */
function canPlace(
  page: DisplayPage,
  type: DisplayElementType,
  pos: [number, number],
  excludeId?: string,
): boolean {
  const size = ELEMENT_FIXED_SIZES[type]
  if (pos[0] + size[0] > GRID_COLS || pos[1] + size[1] > GRID_ROWS) return false
  return !page.elements.some((el) => {
    if (el.id === excludeId) return false
    const s = getElementSize(el.type, el.variant)
    return (
      pos[0] < el.pos[0] + s[0] && pos[0] + size[0] > el.pos[0] &&
      pos[1] < el.pos[1] + s[1] && pos[1] + size[1] > el.pos[1]
    )
  })
}

// ========================================
// 自動保存
// ========================================

const STORAGE_KEY = 'hapbeat-studio-display'

interface SavedState {
  layout: DisplayLayout
  deviceModel: DeviceModel
  orientation: DisplayOrientation
  perButtonActions: PerButtonActions
  simState: SimState
  ledConfig: LedConfig
  volumeConfig: VolumeConfig
}

function loadSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SavedState
  } catch { return null }
}

function saveTo(state: SavedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    // sessionStorage にもバックアップ
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

// ========================================
// メインコンポーネント
// ========================================

export function DisplayEditor() {
  const saved = useRef(loadSaved()).current
  const [layout, setLayout] = useState<DisplayLayout>(saved?.layout ?? structuredClone(standardTemplate.layout))
  const [activePageIndex, setActivePageIndex] = useState(0)
  const [deviceModel, setDeviceModel] = useState<DeviceModel>(saved?.deviceModel ?? 'duo_wl')
  const [orientation, setOrientation] = useState<DisplayOrientation>(saved?.orientation ?? 'normal')
  const [perButtonActions, setPerButtonActions] = useState<PerButtonActions>(
    saved?.perButtonActions ?? createDefaultPerButtonActions(DEVICE_SPECS['duo_wl'])
  )
  const [popupPos, setPopupPos] = useState<{ col: number; row: number; x: number; y: number; screenX: number; screenY: number } | null>(null)
  const [simState, setSimState] = useState<SimState>(saved?.simState ?? { ...DEFAULT_SIM_STATE })
  const [ledConfig, setLedConfig] = useState<LedConfig>(saved?.ledConfig ?? { globalBrightness: 255, rules: [...DEFAULT_LED_RULES] })
  const [volumeConfig, setVolumeConfig] = useState<VolumeConfig>(saved?.volumeConfig ?? { ...DEFAULT_VOLUME_CONFIG })
  const [ledModalOpen, setLedModalOpen] = useState(false)
  const [volumeModalOpen, setVolumeModalOpen] = useState(false)
  const [dropHint, setDropHint] = useState<{ msg: string; x: number; y: number } | null>(null)
  const [externalDragType, setExternalDragType] = useState<DisplayElementType | null>(null)

  // パレットからのドラッグ通知を受け取る
  useEffect(() => {
    _dragTypeCallback = setExternalDragType
    return () => { _dragTypeCallback = null }
  }, [])

  // 自動保存: 状態変更のたびに localStorage + sessionStorage + IndexedDB に保存
  useEffect(() => {
    const state: DisplaySavedState = { layout, deviceModel, orientation, perButtonActions, simState, ledConfig, volumeConfig }
    saveTo(state)
    saveDisplayToIDB(state)
  }, [layout, deviceModel, orientation, perButtonActions, simState, ledConfig, volumeConfig])

  const oledRef = useRef<HTMLDivElement>(null)
  const deviceSpec = DEVICE_SPECS[deviceModel]
  const activePage = layout.pages[activePageIndex] ?? layout.pages[0]
  const isFlipped = orientation === 'flipped'

  const usedTypes = useMemo(() => {
    const set = new Set<DisplayElementType>()
    if (activePage) for (const el of activePage.elements) set.add(el.type)
    return set
  }, [activePage])

  const gridRows = useMemo(() => buildGridRows(activePage, simState), [activePage, simState])

  // --- ハンドラ ---

  const handleDeviceModelChange = useCallback((model: DeviceModel) => {
    setDeviceModel(model)
    // 既存のボタン設定はすべて保持。新モデルのボタンで未設定のもののみデフォルトで補完
    setPerButtonActions((prev) => {
      const defaults = createDefaultPerButtonActions(DEVICE_SPECS[model])
      return { ...prev, ...Object.fromEntries(
        Object.entries(defaults).filter(([id]) => !prev[id])
      ) }
    })
  }, [])

  const handleMoveElement = useCallback(
    (elementId: string, newPos: [number, number]) => {
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const page = newPages[activePageIndex]
        if (!page) return prev
        const el = page.elements.find((e) => e.id === elementId)
        if (!el) return prev
        const size = getElementSize(el.type, el.variant)
        const clamped: [number, number] = [
          Math.max(0, Math.min(newPos[0], GRID_COLS - size[0])),
          Math.max(0, Math.min(newPos[1], GRID_ROWS - size[1])),
        ]
        if (!canPlace(page, el.type, clamped, elementId)) return prev
        const updatedElements = page.elements.map((e) =>
          e.id === elementId ? { ...e, pos: clamped } : e
        )
        newPages[activePageIndex] = { ...page, elements: updatedElements }
        return { ...prev, pages: newPages }
      })
    },
    [activePageIndex]
  )

  const showToast = useCallback((msg: string, x: number, y: number) => {
    setDropHint({ msg, x, y })
    setTimeout(() => setDropHint(null), 2000)
  }, [])

  const addElement = useCallback(
    (type: DisplayElementType, pos: [number, number], mouseX?: number, mouseY?: number, variant?: string): boolean => {
      const page = layout.pages[activePageIndex]
      if (!page) return false
      // 同一 type + variant の重複チェック
      if (page.elements.some((el) => el.type === type && (el.variant ?? 'standard') === (variant ?? 'standard'))) {
        if (mouseX != null && mouseY != null) showToast('この要素は既に配置済みです', mouseX, mouseY)
        return false
      }
      const size = getElementSize(type, variant)
      const clampedPos: [number, number] = [
        Math.max(0, Math.min(pos[0], GRID_COLS - size[0])),
        Math.max(0, Math.min(pos[1], GRID_ROWS - size[1])),
      ]
      if (!canPlace(page, type, clampedPos)) {
        if (mouseX != null && mouseY != null) showToast('スペースが不足しています', mouseX, mouseY)
        return false
      }
      const newEl: import('@/types/display').DisplayElement = { id: generateId(), type, pos: clampedPos }
      if (variant && variant !== 'standard') newEl.variant = variant as 'compact' | 'bar'
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const p = newPages[activePageIndex]
        if (!p) return prev
        newPages[activePageIndex] = {
          ...p, elements: [...p.elements, newEl],
        }
        return { ...prev, pages: newPages }
      })
      return true
    },
    [activePageIndex, layout.pages, showToast]
  )

  // パレットからの mouse ドラッグ
  useEffect(() => {
    if (!externalDragType) return
    document.body.classList.add('is-dragging')
    const onMove = (e: MouseEvent) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const rawCol = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const rawRow = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      if (rawCol >= 0 && rawCol < GRID_COLS && rawRow >= 0 && rawRow < GRID_ROWS) {
        setDragPos((prev) => (prev?.col === rawCol && prev?.row === rawRow) ? prev : { col: rawCol, row: rawRow })
      } else {
        setDragPos((prev) => prev === null ? prev : null)
      }
    }
    const onUp = (e: MouseEvent) => {
      document.body.classList.remove('is-dragging')
      if (oledRef.current) {
        const rect = oledRef.current.getBoundingClientRect()
        const col = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
        const row = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
        if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
          addElement(externalDragType, [col, row], e.clientX, e.clientY, getCurrentDragVariant())
        }
      }
      setDragPos(null)
      setExternalDragType(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('is-dragging')
    }
  }, [externalDragType, addElement])

  const handleDeleteElement = useCallback(
    (elementId: string) => {
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const page = newPages[activePageIndex]
        if (!page) return prev
        newPages[activePageIndex] = {
          ...page, elements: page.elements.filter((el) => el.id !== elementId),
        }
        return { ...prev, pages: newPages }
      })
    },
    [activePageIndex]
  )

  // OLED クリック → ポップアップ
  const handleOledClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const row = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return
      const localX = col * CELL_W
      const localY = row * CELL_H
      setPopupPos({ col, row, x: localX, y: localY, screenX: rect.left + BORDER_W + localX, screenY: rect.top + BORDER_W + localY + CELL_H + 4 })
    },
    []
  )

  const handlePopupSelect = useCallback(
    (type: DisplayElementType) => {
      if (popupPos) addElement(type, [popupPos.col, popupPos.row])
      setPopupPos(null)
    },
    [popupPos, addElement]
  )

  // ドラッグ中の位置と配置可否を追跡
  const [dragPos, setDragPos] = useState<{ col: number; row: number } | null>(null)
  // 内部移動ドラッグ中の要素情報
  const [internalDrag, setInternalDrag] = useState<{ id: string; type: DisplayElementType; offsetCol: number } | null>(null)
  // 内部移動時の最後の有効位置
  const [lastValidPos, setLastValidPos] = useState<{ col: number; row: number } | null>(null)

  /** ドラッグ中の要素タイプ（パレット or 内部移動） */
  const dragType = externalDragType ?? internalDrag?.type ?? null
  const dragOffsetCol = internalDrag?.offsetCol ?? 0

  /** マウス位置をクランプした配置候補 */
  const clampedDragPos = useMemo(() => {
    if (!dragType || !dragPos) return null
    const size = ELEMENT_FIXED_SIZES[dragType]
    return {
      col: Math.max(0, Math.min(dragPos.col - dragOffsetCol, GRID_COLS - size[0])),
      row: Math.max(0, Math.min(dragPos.row, GRID_ROWS - size[1])),
    }
  }, [dragType, dragPos, dragOffsetCol])

  const dragCanPlace = useMemo(() => {
    if (!clampedDragPos || !activePage) return false
    return canPlace(activePage, dragType!, [clampedDragPos.col, clampedDragPos.row], internalDrag?.id)
  }, [clampedDragPos, activePage, dragType, internalDrag])

  // 内部ドラッグ時: 配置可能な位置を記録
  useEffect(() => {
    if (internalDrag && clampedDragPos && dragCanPlace) {
      setLastValidPos(clampedDragPos)
    }
  }, [internalDrag, clampedDragPos, dragCanPlace])

  /** ドラッグ中のプレビュー影 */
  const dragPreview = useMemo(() => {
    if (!dragType) return null
    const size = ELEMENT_FIXED_SIZES[dragType]
    if (internalDrag) {
      // 内部移動: 配置可能ならその位置、不可なら最後の有効位置にとどまる
      const pos = dragCanPlace ? clampedDragPos : lastValidPos
      if (!pos) return null
      return { col: pos.col, row: pos.row, w: size[0], h: size[1], canPlace: true }
    }
    // パレットからのドラッグ
    if (!clampedDragPos) return null
    return { col: clampedDragPos.col, row: clampedDragPos.row, w: size[0], h: size[1], canPlace: dragCanPlace }
  }, [dragType, internalDrag, clampedDragPos, dragCanPlace, lastValidPos])

  // 内部移動: mouse イベントで追跡（HTML5 drag を使わないのでカーソルが安定）
  const lastValidPosRef = useRef(lastValidPos)
  lastValidPosRef.current = lastValidPos
  useEffect(() => {
    if (!internalDrag) return
    document.body.classList.add('is-dragging')
    const onMove = (e: MouseEvent) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const rawCol = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const rawRow = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      const col = Math.max(0, Math.min(rawCol, GRID_COLS - 1))
      const row = Math.max(0, Math.min(rawRow, GRID_ROWS - 1))
      setDragPos((prev) => (prev?.col === col && prev?.row === row) ? prev : { col, row })
    }
    const onUp = () => {
      document.body.classList.remove('is-dragging')
      const pos = lastValidPosRef.current
      if (pos) handleMoveElement(internalDrag.id, [pos.col, pos.row])
      setDragPos(null)
      setInternalDrag(null)
      setLastValidPos(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('is-dragging')
    }
  }, [internalDrag, handleMoveElement])

  // HTML5 drag ハンドラは不要（全て mouse ベースに移行済み）

  const renamePages = (pages: DisplayPage[]): DisplayPage[] =>
    pages.map((p, i) => ({ ...p, name: `Page ${i + 1}` }))

  const handleAddPage = useCallback(() => {
    setLayout((prev) => {
      const newPages = renamePages([...prev.pages, { name: '', elements: [] }])
      return { ...prev, pages: newPages }
    })
    setActivePageIndex(layout.pages.length)
  }, [layout.pages.length])

  const handleDeletePage = useCallback(
    (index: number) => {
      if (layout.pages.length <= 1) return
      setLayout((prev) => {
        const newPages = renamePages(prev.pages.filter((_, i) => i !== index))
        return { ...prev, pages: newPages }
      })
      if (activePageIndex >= layout.pages.length - 1) {
        setActivePageIndex(Math.max(0, layout.pages.length - 2))
      }
    },
    [layout.pages.length, activePageIndex]
  )

  const handleApplyTemplate = useCallback((templateIndex: number) => {
    const template = allTemplates[templateIndex]
    if (!template || !window.confirm(`テンプレート「${template.name}」を適用？`)) return
    setLayout(structuredClone(template.layout))
    setActivePageIndex(0)
    setPopupPos(null)
  }, [])

  // --- Manager 接続 ---
  const { isConnected: managerConnected, lastMessage, send: managerSend } = useManagerConnection()
  const { toast, setAnchor: setToastAnchor } = useToast()
  const [isDeploying, setIsDeploying] = useState(false)
  const deployBtnRef = useCallback((el: HTMLButtonElement | null) => {
    setToastAnchor(el)
  }, [setToastAnchor])

  // write_result / deploy_result レスポンスの監視
  useEffect(() => {
    if (!lastMessage) return
    if (lastMessage.type === 'write_result' || lastMessage.type === 'deploy_result') {
      setIsDeploying(false)
      const success = lastMessage.payload.success as boolean
      const deviceConfirmed = lastMessage.payload.device_confirmed as boolean | undefined
      if (success) {
        if (deviceConfirmed) {
          toast('デバイスに書き込みました', 'success')
        } else {
          // Manager が受理したがデバイス応答未確認
          toast('Manager に送信しました', 'info')
        }
      } else {
        const errorMsg = (lastMessage.payload.error as string) || '不明なエラー'
        toast(`書き込みに失敗しました: ${errorMsg}`, 'error')
      }
    }
  }, [lastMessage, toast])

  // --- エクスポート / インポート / デバイス書き込み ---

  const buildSavedState = useCallback((): DisplaySavedState => ({
    layout, deviceModel, orientation, perButtonActions, simState, ledConfig, volumeConfig,
  }), [layout, deviceModel, orientation, perButtonActions, simState, ledConfig, volumeConfig])

  const handleDeploy = useCallback(() => {
    if (!managerConnected) {
      toast('Manager (hapbeat-desktop) を起動してください', 'error')
      return
    }
    setIsDeploying(true)
    const uiConfig = toFirmwareFormat(buildSavedState())
    managerSend({
      type: 'write_ui_config',
      payload: { config: uiConfig },
    })
  }, [managerConnected, managerSend, buildSavedState])

  const handleExport = useCallback(() => {
    exportDisplayLayout(buildSavedState())
    toast('ui-config.json をダウンロードしました', 'success')
  }, [buildSavedState, toast])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importDisplayLayout(file)
      if (imported.layout) setLayout(imported.layout)
      if (imported.deviceModel) setDeviceModel(imported.deviceModel)
      if (imported.orientation) setOrientation(imported.orientation)
      if (imported.perButtonActions) setPerButtonActions(imported.perButtonActions)
      if (imported.ledConfig) setLedConfig(imported.ledConfig)
      if (imported.volumeConfig) setVolumeConfig(imported.volumeConfig)
      setActivePageIndex(0)
      setPopupPos(null)
      toast('レイアウトを読み込みました', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'インポートに失敗しました', 'error')
    }
    e.target.value = ''
  }, [])

  const handlePerButtonActionChange = useCallback(
    (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => {
      setPerButtonActions((prev) => ({
        ...prev,
        [buttonId]: { ...(prev[buttonId] ?? DEFAULT_BUTTON_ACTION), [field]: value },
      }))
    },
    []
  )

  // ボタンシミュレーション — short_press をクリックで実行
  const holdReturnPageRef = useRef<number | null>(null)

  const handleSimButtonClick = useCallback(
    (buttonId: string) => {
      const action = perButtonActions[buttonId]?.short_press as string
      if (!action || action === 'none') return
      const n = layout.pages.length
      if (action === 'next_page' && n > 1) { setActivePageIndex((p) => Math.min(p + 1, n - 1)); return }
      if (action === 'prev_page' && n > 1) { setActivePageIndex((p) => Math.max(p - 1, 0)); return }
      if (action.startsWith('goto_page:')) {
        const idx = parseInt(action.split(':')[1], 10)
        if (!isNaN(idx) && idx >= 0 && idx < n) setActivePageIndex(idx)
        return
      }
      switch (action) {
        case 'volume_up': setSimState((s) => ({ ...s, volume: Math.min(s.volume + 1, volumeConfig.steps - 1) })); break
        case 'volume_down': setSimState((s) => ({ ...s, volume: Math.max(s.volume - 1, 0) })); break
        case 'player_inc': setSimState((s) => ({ ...s, player: s.player + 1 })); break
        case 'player_dec': setSimState((s) => ({ ...s, player: Math.max(0, s.player - 1) })); break
        case 'position_inc': setSimState((s) => ({ ...s, position: s.position + 1 })); break
        case 'position_dec': setSimState((s) => ({ ...s, position: Math.max(0, s.position - 1) })); break
        case 'mode_toggle': setSimState((s) => ({ ...s, volumeAdcEnabled: !s.volumeAdcEnabled })); break
      }
    },
    [perButtonActions, layout.pages.length, volumeConfig.steps]
  )

  // 押し続けシミュレーション — mousedown で画面遷移、mouseup で戻す
  const handleSimButtonDown = useCallback(
    (buttonId: string) => {
      const holdAction = perButtonActions[buttonId]?.hold as string | undefined
      if (!holdAction || holdAction === 'none' || !holdAction.startsWith('hold_page:')) return
      const idx = parseInt(holdAction.split(':')[1], 10)
      const n = layout.pages.length
      if (isNaN(idx) || idx < 0 || idx >= n) return
      if (idx === activePageIndex) return // 今のページなら何もしない
      holdReturnPageRef.current = activePageIndex
      setActivePageIndex(idx)
    },
    [perButtonActions, layout.pages.length, activePageIndex]
  )

  const handleSimButtonUp = useCallback(() => {
    if (holdReturnPageRef.current !== null) {
      setActivePageIndex(holdReturnPageRef.current)
      holdReturnPageRef.current = null
    }
  }, [])

  // --- レンダリング ---

  return (
    <div className="display-editor">
      {/* 上部固定エリア: シミュレータ + コントロールバー */}
      <div className="fixed-top-area">
        <OledSimulator
          deviceSpec={deviceSpec}
          isFlipped={isFlipped}
          oledRef={oledRef}
          gridRows={gridRows}
          activePage={activePage}
          popupPos={popupPos}
          usedTypes={usedTypes}
          onOledClick={handleOledClick}
          dragPreview={dragPreview}
          onInternalDragStart={(id, type, offsetCol) => {
            setInternalDrag({ id, type, offsetCol })
            const el = activePage?.elements.find((e) => e.id === id)
            if (el) setLastValidPos({ col: el.pos[0], row: el.pos[1] })
          }}
          onDeleteElement={handleDeleteElement}
          onPopupSelect={handlePopupSelect}
          onPopupClose={() => setPopupPos(null)}
          onSimButtonClick={handleSimButtonClick}
          onSimButtonDown={handleSimButtonDown}
          onSimButtonUp={handleSimButtonUp}
          pages={layout.pages}
          perButtonActions={perButtonActions}
          onActionChange={handlePerButtonActionChange}
          onLedClick={() => setLedModalOpen(true)}
          onVolumeClick={() => setVolumeModalOpen(true)}
        />
        <ControlBar
          pages={layout.pages}
          activePageIndex={activePageIndex}
          deviceModel={deviceModel}
          isFlipped={isFlipped}
          onPageChange={(idx) => { setActivePageIndex(idx); setPopupPos(null) }}
          onAddPage={handleAddPage}
          onDeletePage={handleDeletePage}
          onDeviceModelChange={handleDeviceModelChange}
          onApplyTemplate={handleApplyTemplate}
          onToggleOrientation={() => setOrientation(isFlipped ? 'normal' : 'flipped')}
          onExport={handleExport}
          onImport={() => fileInputRef.current?.click()}
          onDeploy={handleDeploy}
          managerConnected={managerConnected}
          isDeploying={isDeploying}
          deployBtnRef={deployBtnRef}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
      </div>

      {/* トースト警告 */}
      {dropHint && (
        <div className="drop-toast" style={{ left: dropHint.x, top: dropHint.y }}>
          {dropHint.msg}
        </div>
      )}

      {/* 3. パレット */}
      <ElementPalette selectedType={null} onSelectType={() => {}} usedTypes={usedTypes} />

      {/* LED 設定モーダル */}
      {ledModalOpen && (
        <LedConfigModal
          ledConfig={ledConfig}
          onLedChange={setLedConfig}
          onClose={() => setLedModalOpen(false)}
        />
      )}

      {/* Volume 設定モーダル */}
      {volumeModalOpen && (
        <VolumeConfigModal
          volumeConfig={volumeConfig}
          onVolumeChange={setVolumeConfig}
          onClose={() => setVolumeModalOpen(false)}
        />
      )}
    </div>
  )
}

// ========================================
// OledSimulator
// ========================================

interface OledSimulatorProps {
  deviceSpec: DeviceHardwareSpec
  isFlipped: boolean
  oledRef: React.RefObject<HTMLDivElement>
  gridRows: GridItem[][]
  activePage: DisplayPage | undefined
  popupPos: { col: number; row: number; x: number; y: number; screenX: number; screenY: number } | null
  usedTypes: Set<DisplayElementType>
  onOledClick: (e: React.MouseEvent<HTMLDivElement>) => void
  dragPreview: { col: number; row: number; w: number; h: number; canPlace: boolean } | null
  onInternalDragStart: (id: string, type: DisplayElementType, offsetCol: number) => void
  onDeleteElement: (id: string) => void
  onPopupSelect: (type: DisplayElementType) => void
  onPopupClose: () => void
  onSimButtonClick: (buttonId: string) => void
  onSimButtonDown: (buttonId: string) => void
  onSimButtonUp: () => void
  pages: DisplayPage[]
  perButtonActions: PerButtonActions
  onActionChange: (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => void
  onLedClick: () => void
  onVolumeClick: () => void
}

function OledSimulator({
  deviceSpec, isFlipped, oledRef, gridRows, activePage,
  popupPos, usedTypes,
  onOledClick,
  dragPreview, onInternalDragStart,
  onDeleteElement, onPopupSelect, onPopupClose, onSimButtonClick, onSimButtonDown, onSimButtonUp,
  pages, perButtonActions, onActionChange, onLedClick, onVolumeClick,
}: OledSimulatorProps) {
  return (
    <div className="hardware-preview-sticky">
      <div
        className="device-abs-container"
        style={{ transform: isFlipped ? 'rotate(180deg)' : undefined }}
      >
        <div
          className="device-abs-oled"
          style={{
            left: `${deviceSpec.oled.x}%`, top: `${deviceSpec.oled.y}%`,
            width: `${deviceSpec.oled.width}%`, height: `${deviceSpec.oled.height}%`,
          }}
        >
          <div style={{ transform: isFlipped ? 'rotate(180deg)' : undefined, position: 'relative' }}>
            <div
              ref={oledRef}
              className="oled-screen"
              style={{ width: GRID_WIDTH, height: GRID_HEIGHT }}
              onClick={onOledClick}
            >
              <div className="char-grid">
                {gridRows.map((row, rowIdx) =>
                  row.map((item) => {
                    if (item.kind === 'empty') {
                      return (
                        <div key={`${rowIdx}-${item.col}`} className="char-cell empty" />
                      )
                    }
                    const meta = getElementMeta(item.el.type)
                    return (
                      <div
                        key={item.el.id}
                        className="grid-element"
                        style={{ gridColumn: `span ${item.span}` }}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.preventDefault()
                          const cardRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const offsetCol = Math.floor((e.clientX - cardRect.left) / CELL_W)
                          onInternalDragStart(item.el.id, item.el.type, offsetCol)
                        }}
                        onClick={(e) => e.stopPropagation()}
                        title={meta?.label ?? item.el.type}
                      >
                        <span className="grid-element-name">{meta?.label ?? item.el.type}</span>
                        <div className="grid-element-chars">
                          {item.text.split('').map((ch, ci) => (
                            <span key={ci} className="char-text">{ch}</span>
                          ))}
                        </div>
                        <button
                          className="grid-element-delete"
                          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                          onClick={(e) => { e.stopPropagation(); onDeleteElement(item.el.id) }}
                          title="削除"
                        >×</button>
                      </div>
                    )
                  })
                )}
              </div>

              {/* ドラッグ中のプレビュー影 */}
              {dragPreview && (
                <div
                  className={`drag-preview-shadow ${dragPreview.canPlace ? '' : 'invalid'}`}
                  style={{
                    left: dragPreview.col * CELL_W,
                    top: dragPreview.row * CELL_H,
                    width: dragPreview.w * CELL_W,
                    height: dragPreview.h * CELL_H,
                  }}
                />
              )}

              {/* クリック時の位置マーカー */}
              {popupPos && (
                <div
                  className="placeholder-cell"
                  style={{
                    left: popupPos.x, top: popupPos.y,
                    width: CELL_W, height: CELL_H,
                  }}
                />
              )}
            </div>

            {/* ポップアップパレット */}
            {popupPos && (
              <PopupPalette
                screenX={popupPos.screenX}
                screenY={popupPos.screenY}
                gridCol={popupPos.col}
                gridRow={popupPos.row}
                page={activePage}
                usedTypes={usedTypes}
                onSelect={onPopupSelect}
                onClose={onPopupClose}
              />
            )}
          </div>
        </div>

        {/* ボタン + インライン設定 */}
        {deviceSpec.buttons.map((btn) => {
          const isLeft = deviceSpec.model === 'duo_wl' && ['btn_1', 'btn_2', 'btn_3'].includes(btn.id)
          const action = perButtonActions[btn.id] ?? DEFAULT_BUTTON_ACTION
          const actionGroups = buildActionGroups(pages)
          const holdGroups = buildHoldActionGroups(pages)
          const allItems = [...actionGroups, ...holdGroups].flatMap((g) => g.items)

          return (
            <div
              key={btn.id}
              className={`device-abs-button-row ${isLeft ? 'left-side' : 'right-side'}`}
              style={{
                left: isLeft ? undefined : `${btn.x}%`,
                right: isLeft ? `${100 - btn.x}%` : undefined,
                top: `${btn.y}%`,
                transform: isFlipped ? 'rotate(180deg)' : undefined,
              }}
            >
              {/* 左側ボタン: 設定 → ドット */}
              {isLeft && (
                <InlineButtonConfig
                  action={action}
                  allItems={allItems}
                  actionGroups={actionGroups}
                  holdGroups={holdGroups}
                  btnId={btn.id}
                  onActionChange={onActionChange}
                />
              )}
              <div
                className="device-button-dot-wrap"
                title={btn.label}
                onClick={() => onSimButtonClick(btn.id)}
                onMouseDown={() => onSimButtonDown(btn.id)}
                onMouseUp={onSimButtonUp}
                onMouseLeave={onSimButtonUp}
              >
                <div className="device-button-dot" />
                <span className="device-button-label">{btn.label}</span>
              </div>
              {/* 右側ボタン: ドット → 設定 */}
              {!isLeft && (
                <InlineButtonConfig
                  action={action}
                  allItems={allItems}
                  actionGroups={actionGroups}
                  holdGroups={holdGroups}
                  btnId={btn.id}
                  onActionChange={onActionChange}
                />
              )}
            </div>
          )
        })}

        <div className="device-config-item" style={{
          left: `${deviceSpec.led.x}%`, top: `${deviceSpec.led.y}%`,
          transform: `translate(-50%, -50%)${isFlipped ? ' rotate(180deg)' : ''}`,
        }} onClick={onLedClick}>
          <div className="device-abs-led" />
          <span className="device-config-label">LED 設定</span>
        </div>
        <div className="device-config-item" style={{
          left: `${deviceSpec.volumeIcon.x}%`, top: `${deviceSpec.volumeIcon.y}%`,
          transform: `translate(-50%, -50%)${isFlipped ? ' rotate(180deg)' : ''}`,
        }} onClick={onVolumeClick}>
          <svg className="device-config-vol-icon" viewBox="0 0 16 14" width="14" height="12">
            <polygon points="0,5 0,9 4,9 8,13 8,1 4,5" fill="currentColor" />
            <path d="M10,4 Q13,7 10,10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12,2 Q16,7 12,12" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span className="device-config-label">Volume 設定</span>
        </div>
      </div>
    </div>
  )
}

// ========================================
// PopupPalette — OLED クリック時のミニパレット（衝突チェック付き）
// ========================================

interface PopupPaletteProps {
  screenX: number; screenY: number
  gridCol: number; gridRow: number
  page: DisplayPage | undefined
  usedTypes: Set<DisplayElementType>
  onSelect: (type: DisplayElementType) => void
  onClose: () => void
}

function PopupPalette({ screenX, screenY, gridCol, gridRow, page, usedTypes, onSelect, onClose }: PopupPaletteProps) {
  const popupW = 400
  const clampedX = screenX + popupW > window.innerWidth ? window.innerWidth - popupW - 8 : screenX
  return createPortal(
    <>
      <div className="portal-overlay" onClick={onClose} />
      <div className="portal-dropdown popup-palette-content" style={{ left: clampedX, top: screenY }}>
        {elementMetas.map((meta) => {
          const used = usedTypes.has(meta.type)
          const noSpace = page ? !canPlace(page, meta.type, [gridCol, gridRow]) : true
          const disabled = used || noSpace
          return (
            <button
              key={meta.type}
              className={`popup-palette-item ${used ? 'used' : ''} ${noSpace && !used ? 'no-space' : ''}`}
              disabled={disabled}
              onClick={() => onSelect(meta.type)}
              title={used ? '使用中' : noSpace ? 'スペースが不足しています' : meta.label}
            >
              <span className="popup-palette-icon">{meta.icon}</span>
              {meta.label}
            </button>
          )
        })}
      </div>
    </>,
    document.body
  )
}

// ========================================
// ControlBar (sticky)
// ========================================

interface ControlBarProps {
  pages: DisplayPage[]
  activePageIndex: number
  deviceModel: DeviceModel
  isFlipped: boolean
  onPageChange: (idx: number) => void
  onAddPage: () => void
  onDeletePage: (idx: number) => void
  onDeviceModelChange: (model: DeviceModel) => void
  onApplyTemplate: (idx: number) => void
  onToggleOrientation: () => void
  onExport: () => void
  onImport: () => void
  onDeploy: () => void
  managerConnected: boolean
  isDeploying: boolean
  deployBtnRef?: (el: HTMLButtonElement | null) => void
}

function ControlBar({
  pages, activePageIndex, deviceModel, isFlipped,
  onPageChange, onAddPage, onDeletePage,
  onDeviceModelChange, onApplyTemplate, onToggleOrientation,
  onExport, onImport, onDeploy, managerConnected, isDeploying, deployBtnRef,
}: ControlBarProps) {
  return (
    <div className="editor-control-bar">
      <div className="page-tabs">
        {pages.map((page, idx) => (
          <div key={idx} className="page-tab-wrapper">
            <button
              className={`page-tab ${idx === activePageIndex ? 'active' : ''}`}
              onClick={() => onPageChange(idx)}
            >{page.name}</button>
            {pages.length > 1 && (
              <button className="page-tab-delete" onClick={() => onDeletePage(idx)}>x</button>
            )}
          </div>
        ))}
        <button className="btn btn-sm" onClick={onAddPage}>+ Page</button>
      </div>
      <div className="control-separator" />
      <div className="device-toggle">
        {(Object.keys(DEVICE_SPECS) as DeviceModel[]).map((model) => (
          <button
            key={model}
            className={`btn btn-sm device-toggle-btn ${deviceModel === model ? 'active' : ''}`}
            onClick={() => onDeviceModelChange(model)}
          >{DEVICE_SPECS[model].name}</button>
        ))}
      </div>
      <select className="select select-sm template-select" defaultValue=""
        onChange={(e) => { const i = parseInt(e.target.value, 10); if (!isNaN(i)) onApplyTemplate(i); e.target.value = '' }}
      >
        <option value="" disabled>テンプレート</option>
        {allTemplates.map((t, idx) => (
          <option key={t.name} value={idx}>{t.name}</option>
        ))}
      </select>
      <button className={`btn btn-sm ${isFlipped ? 'active' : ''}`} onClick={onToggleOrientation}>
        {isFlipped ? '\u21bb 180\u00b0' : '\u21bb \u901a\u5e38'}
      </button>
      <div className="control-separator" />
      <button className="btn btn-sm" onClick={onExport} title="display-layout.json をダウンロード">
        保存
      </button>
      <button className="btn btn-sm" onClick={onImport} title="display-layout.json を読み込み">
        読込
      </button>
      <div className="control-separator" />
      <span className="tooltip-wrap">
        <button
          ref={deployBtnRef}
          className="btn btn-sm btn-deploy"
          onClick={onDeploy}
          disabled={!managerConnected || isDeploying}
        >
          {isDeploying ? '書込中...' : 'デバイスに書込'}
        </button>
        {!managerConnected && (
          <span className="tooltip-text">Manager (hapbeat-desktop) を起動してください</span>
        )}
      </span>
    </div>
  )
}

// ========================================
// InlineButtonConfig — ボタン横のコンパクト設定 (press + hold)
// ========================================

interface InlineButtonConfigProps {
  action: SingleButtonAction
  allItems: ActionItem[]
  actionGroups: ActionGroup[]
  holdGroups: ActionGroup[]
  btnId: string
  onActionChange: (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => void
}

function InlineButtonConfig({ action, allItems, actionGroups, holdGroups, btnId, onActionChange }: InlineButtonConfigProps) {
  const [openField, setOpenField] = useState<keyof SingleButtonAction | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const handleSelect = (field: keyof SingleButtonAction, value: string) => {
    onActionChange(btnId, field, value as ButtonActionType)
    setOpenField(null)
  }

  const openMenu = (field: keyof SingleButtonAction) => {
    const el = btnRefs.current[field]
    if (el) {
      const rect = el.getBoundingClientRect()
      const menuW = 240
      // 右端からはみ出す場合は左にずらす
      const x = rect.left + menuW > window.innerWidth ? window.innerWidth - menuW - 8 : rect.left
      setMenuPos({ x, y: rect.bottom + 2 })
    }
    setOpenField(field)
  }

  return (
    <div className="inline-btn-config">
      {(['short_press', 'hold'] as const).map((field) => {
        const groups = field === 'hold' ? holdGroups : actionGroups
        const currentValue = (action[field] as string) ?? 'none'
        const currentLabel = allItems.find((i) => i.value === currentValue)?.label ?? '\u2014'
        const isOpen = openField === field
        return (
          <div key={field} className="inline-config-row">
            <span className="inline-config-label">{field === 'short_press' ? 'Press' : 'Hold'}</span>
            <button
              ref={(el) => { btnRefs.current[field] = el }}
              className="inline-config-btn"
              onClick={(e) => {
                e.stopPropagation()
                isOpen ? setOpenField(null) : openMenu(field)
              }}
            >
              {currentLabel}
            </button>
            {isOpen && createPortal(
              <>
                <div className="portal-overlay" onClick={() => setOpenField(null)} />
                <div className="portal-dropdown" style={{ left: menuPos.x, top: menuPos.y }}>
                  {groups.map((group) => (
                    <div key={group.label} className="action-dropdown-group">
                      <div className="action-dropdown-group-label">{group.label}</div>
                      <div className="action-dropdown-items">
                        {group.items.map((opt) => (
                          <button
                            key={opt.value + opt.label}
                            className={`action-dropdown-item ${opt.value === currentValue ? 'selected' : ''}`}
                            data-none={opt.value === 'none' ? 'true' : undefined}
                            onClick={() => handleSelect(field, opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>,
              document.body
            )}
          </div>
        )
      })}
    </div>
  )
}
