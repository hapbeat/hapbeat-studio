import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import GridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type {
  DisplayElementType,
  DisplayLayout,
  DisplayPage,
  ButtonActionType,
  SingleButtonAction,
  PerButtonActions,
  DisplayOrientation,
} from '@/types/display'
import { ELEMENT_FIXED_SIZES } from '@/types/display'
import type { DeviceModel, DeviceHardwareSpec } from '@/types/device'
import { DEVICE_SPECS } from '@/types/device'
import { ElementPalette, elementMetas, getElementMeta } from '@/components/common/ElementPalette'
import { getElementPreviewText, DEFAULT_SIM_STATE } from '@/utils/displayPreview'
import type { SimState } from '@/utils/displayPreview'
import { allTemplates, standardTemplate } from '@/utils/templates'
import './DisplayEditor.css'

/** パレットからドラッグ中の要素タイプ */
let _dragTypeCallback: ((type: DisplayElementType | null) => void) | null = null
export function setCurrentDragType(type: DisplayElementType | null) {
  _dragTypeCallback?.(type)
}

// OLED: 128x32 = 4:1
const GRID_COLS = 16
const GRID_ROWS = 2
const CELL_WIDTH = 32
const CELL_HEIGHT = 64
const GAP = 2
// GridLayout: containerPadding=0, margin=GAP. CSS padding で外枠余白
const GRID_WIDTH = GRID_COLS * CELL_WIDTH + GAP * (GRID_COLS - 1)   // 512 + 30 = 542
const GRID_HEIGHT = GRID_ROWS * CELL_HEIGHT + GAP * (GRID_ROWS - 1) // 128 + 2 = 130
const OLED_PAD = 2 // CSS padding on .oled-screen — GAP と同じ

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
    { value: 'next_page', label: '次ページ' },
    { value: 'prev_page', label: '前ページ' },
  ]
  pages.forEach((p, i) => {
    pageItems.push({ value: `goto_page:${i}`, label: `\u2192 ${p.name}` })
  })

  return [
    { label: 'ページ', items: pageItems },
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
      label: 'その他',
      items: [
        { value: 'toggle_volume_adc', label: 'VOL ADC切替' },
        { value: 'none', label: '\u2014 (なし)' },
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
  items.push({ value: 'none', label: '\u2014 (なし)' })
  return [{ label: '押している間表示', items }]
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
    const s = ELEMENT_FIXED_SIZES[el.type]
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
  const [popupPos, setPopupPos] = useState<{ col: number; row: number; x: number; y: number } | null>(null)
  const [simState, setSimState] = useState<SimState>(saved?.simState ?? { ...DEFAULT_SIM_STATE })
  const [toast, setToast] = useState<{ msg: string; x: number; y: number } | null>(null)
  const [externalDragType, setExternalDragType] = useState<DisplayElementType | null>(null)

  // パレットからのドラッグ通知を受け取る
  useEffect(() => {
    _dragTypeCallback = setExternalDragType
    return () => { _dragTypeCallback = null }
  }, [])

  // 自動保存: 状態変更のたびに localStorage + sessionStorage に保存
  useEffect(() => {
    saveTo({ layout, deviceModel, orientation, perButtonActions, simState })
  }, [layout, deviceModel, orientation, perButtonActions, simState])

  const oledRef = useRef<HTMLDivElement>(null)
  const deviceSpec = DEVICE_SPECS[deviceModel]
  const activePage = layout.pages[activePageIndex] ?? layout.pages[0]
  const isFlipped = orientation === 'flipped'

  const usedTypes = useMemo(() => {
    const set = new Set<DisplayElementType>()
    if (activePage) for (const el of activePage.elements) set.add(el.type)
    return set
  }, [activePage])

  const gridLayoutItems = useMemo(() => {
    if (!activePage) return []
    return activePage.elements.map((el) => {
      const size = ELEMENT_FIXED_SIZES[el.type]
      return {
        i: el.id, x: el.pos[0], y: el.pos[1],
        w: size[0], h: size[1],
        minW: size[0], maxW: size[0], minH: size[1], maxH: size[1],
      }
    })
  }, [activePage])

  // --- ハンドラ ---

  const handleDeviceModelChange = useCallback((model: DeviceModel) => {
    setDeviceModel(model)
    setPerButtonActions(createDefaultPerButtonActions(DEVICE_SPECS[model]))
  }, [])

  const handleLayoutChange = useCallback(
    (newGridLayout: GridLayout.Layout[]) => {
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const page = newPages[activePageIndex]
        if (!page) return prev
        const updatedElements = page.elements.map((el) => {
          const item = newGridLayout.find((l) => l.i === el.id)
          if (!item) return el
          return { ...el, pos: [item.x, item.y] as [number, number] }
        })
        newPages[activePageIndex] = { ...page, elements: updatedElements }
        return { ...prev, pages: newPages }
      })
    },
    [activePageIndex]
  )

  const showToast = useCallback((msg: string, x: number, y: number) => {
    setToast({ msg, x, y })
    setTimeout(() => setToast(null), 2000)
  }, [])

  const addElement = useCallback(
    (type: DisplayElementType, pos: [number, number], mouseX?: number, mouseY?: number): boolean => {
      const page = layout.pages[activePageIndex]
      if (!page) return false
      if (page.elements.some((el) => el.type === type)) {
        if (mouseX != null && mouseY != null) showToast('この要素は既に配置済みです', mouseX, mouseY)
        return false
      }
      const size = ELEMENT_FIXED_SIZES[type]
      const clampedPos: [number, number] = [
        Math.max(0, Math.min(pos[0], GRID_COLS - size[0])),
        Math.max(0, Math.min(pos[1], GRID_ROWS - size[1])),
      ]
      if (!canPlace(page, type, clampedPos)) {
        if (mouseX != null && mouseY != null) showToast('スペースが不足しています', mouseX, mouseY)
        return false
      }
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const p = newPages[activePageIndex]
        if (!p) return prev
        newPages[activePageIndex] = {
          ...p, elements: [...p.elements, { id: generateId(), type, pos: clampedPos }],
        }
        return { ...prev, pages: newPages }
      })
      return true
    },
    [activePageIndex, layout.pages, showToast]
  )

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
      const col = Math.floor((e.clientX - rect.left - OLED_PAD) / (CELL_WIDTH + GAP))
      const row = Math.floor((e.clientY - rect.top - OLED_PAD) / (CELL_HEIGHT + GAP))
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return
      setPopupPos({ col, row, x: col * (CELL_WIDTH + GAP) + OLED_PAD, y: row * (CELL_HEIGHT + GAP) + OLED_PAD })
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

  const dragCanPlace = useMemo(() => {
    if (!externalDragType || !dragPos || !activePage) return false
    const size = ELEMENT_FIXED_SIZES[externalDragType]
    const pos: [number, number] = [
      Math.max(0, Math.min(dragPos.col, GRID_COLS - size[0])),
      Math.max(0, Math.min(dragPos.row, GRID_ROWS - size[1])),
    ]
    return canPlace(activePage, externalDragType, pos)
  }, [externalDragType, dragPos, activePage])

  // GridLayout の isDroppable は配置可能な時のみ有効
  const droppingItem = useMemo(() => {
    if (!externalDragType || !dragCanPlace) return undefined
    const size = ELEMENT_FIXED_SIZES[externalDragType]
    return { i: '__dropping__', w: size[0], h: size[1] }
  }, [externalDragType, dragCanPlace])

  // ドラッグ位置追跡（配置不可時の赤枠表示用）
  const handleOledDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left - OLED_PAD) / (CELL_WIDTH + GAP))
      const row = Math.floor((e.clientY - rect.top - OLED_PAD) / (CELL_HEIGHT + GAP))
      setDragPos(col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS ? { col, row } : null)
    },
    []
  )

  const handleOledDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragPos(null)
      const type = e.dataTransfer.getData('text/plain') as DisplayElementType
      if (!type || !ELEMENT_FIXED_SIZES[type]) return
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left - OLED_PAD) / (CELL_WIDTH + GAP))
      const row = Math.floor((e.clientY - rect.top - OLED_PAD) / (CELL_HEIGHT + GAP))
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return
      addElement(type, [col, row], e.clientX, e.clientY)
      setPopupPos(null)
    },
    [addElement]
  )

  /** ページ名を「画面1」「画面2」...に正規化 */
  const renamePages = (pages: DisplayPage[]): DisplayPage[] =>
    pages.map((p, i) => ({ ...p, name: `画面${i + 1}` }))

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
      if (action === 'next_page' && n > 1) { setActivePageIndex((p) => (p + 1) % n); return }
      if (action === 'prev_page' && n > 1) { setActivePageIndex((p) => (p + n - 1) % n); return }
      if (action.startsWith('goto_page:')) {
        const idx = parseInt(action.split(':')[1], 10)
        if (!isNaN(idx) && idx >= 0 && idx < n) setActivePageIndex(idx)
        return
      }
      switch (action) {
        case 'player_inc': setSimState((s) => ({ ...s, player: s.player + 1 })); break
        case 'player_dec': setSimState((s) => ({ ...s, player: Math.max(0, s.player - 1) })); break
        case 'position_inc': setSimState((s) => ({ ...s, position: s.position + 1 })); break
        case 'position_dec': setSimState((s) => ({ ...s, position: Math.max(0, s.position - 1) })); break
        case 'toggle_volume_adc': setSimState((s) => ({ ...s, volumeAdcEnabled: !s.volumeAdcEnabled })); break
      }
    },
    [perButtonActions, layout.pages.length]
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
          gridLayoutItems={gridLayoutItems}
          activePage={activePage}
          simState={simState}
          popupPos={popupPos}
          usedTypes={usedTypes}
          onLayoutChange={handleLayoutChange}
          onOledClick={handleOledClick}
          onOledDragOver={handleOledDragOver}
          onOledDragLeave={() => setDragPos(null)}
          onOledDrop={handleOledDrop}
          onDropElement={(type, pos, mx, my) => addElement(type, pos, mx, my)}
          droppingItem={droppingItem}
          dragFallback={externalDragType && dragPos && !dragCanPlace ? {
            col: dragPos.col, row: dragPos.row,
            w: ELEMENT_FIXED_SIZES[externalDragType][0],
            h: ELEMENT_FIXED_SIZES[externalDragType][1],
          } : null}
          onDeleteElement={handleDeleteElement}
          onPopupSelect={handlePopupSelect}
          onPopupClose={() => setPopupPos(null)}
          onSimButtonClick={handleSimButtonClick}
          onSimButtonDown={handleSimButtonDown}
          onSimButtonUp={handleSimButtonUp}
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
        />
      </div>

      {/* トースト警告 */}
      {toast && (
        <div className="drop-toast" style={{ left: toast.x, top: toast.y }}>
          {toast.msg}
        </div>
      )}

      {/* 3. パレット + ボタン設定 */}
      <div className="bottom-panels">
        <ElementPalette selectedType={null} onSelectType={() => {}} usedTypes={usedTypes} />
        <ButtonConfigPanel
          deviceSpec={deviceSpec}
          pages={layout.pages}
          perButtonActions={perButtonActions}
          onActionChange={handlePerButtonActionChange}
        />
      </div>
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
  gridLayoutItems: GridLayout.Layout[]
  activePage: DisplayPage | undefined
  simState: SimState
  popupPos: { col: number; row: number; x: number; y: number } | null
  usedTypes: Set<DisplayElementType>
  onLayoutChange: (layout: GridLayout.Layout[]) => void
  onOledClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onOledDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onOledDragLeave: () => void
  onOledDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onDropElement: (type: DisplayElementType, pos: [number, number], mouseX: number, mouseY: number) => void
  droppingItem: { i: string; w: number; h: number } | undefined
  dragFallback: { col: number; row: number; w: number; h: number } | null
  onDeleteElement: (id: string) => void
  onPopupSelect: (type: DisplayElementType) => void
  onPopupClose: () => void
  onSimButtonClick: (buttonId: string) => void
  onSimButtonDown: (buttonId: string) => void
  onSimButtonUp: () => void
}

function OledSimulator({
  deviceSpec, isFlipped, oledRef, gridLayoutItems, activePage, simState,
  popupPos, usedTypes,
  onLayoutChange, onOledClick,
  onOledDragOver, onOledDragLeave, onOledDrop, onDropElement, droppingItem, dragFallback,
  onDeleteElement, onPopupSelect, onPopupClose, onSimButtonClick, onSimButtonDown, onSimButtonUp,
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
              onDragOver={onOledDragOver}
              onDragLeave={onOledDragLeave}
              onDrop={onOledDrop}
            >
              {activePage && (
                <GridLayout
                  className="grid-layout"
                  layout={gridLayoutItems}
                  cols={GRID_COLS}
                  rowHeight={CELL_HEIGHT}
                  width={GRID_WIDTH}
                  maxRows={GRID_ROWS}
                  compactType={null}
                  preventCollision={true}
                  isResizable={false}
                  isDraggable={true}
                  isDroppable={!!droppingItem}
                  droppingItem={droppingItem}
                  onLayoutChange={onLayoutChange}
                  onDrop={(_layout, item, e) => {
                    const type = (e as DragEvent).dataTransfer?.getData('text/plain') as DisplayElementType
                    if (type && ELEMENT_FIXED_SIZES[type]) {
                      // GridLayout の onDrop で配置位置を取得
                      const mouseE = e as unknown as MouseEvent
                      onDropElement(type, [item.x, item.y], mouseE.clientX, mouseE.clientY)
                    }
                  }}
                  margin={[GAP, GAP]}
                  containerPadding={[0, 0]}
                >
                  {activePage.elements.map((el) => {
                    const meta = getElementMeta(el.type)
                    return (
                    <div key={el.id} className="grid-element" onClick={(e) => e.stopPropagation()}>
                      <span className="grid-element-name">{meta?.label ?? el.type}</span>
                      <span className="grid-element-preview">
                        {getElementPreviewText(el.type, simState)}
                      </span>
                      <button
                        className="grid-element-delete"
                        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                        onClick={(e) => { e.stopPropagation(); onDeleteElement(el.id) }}
                        title="削除"
                      >×</button>
                    </div>
                    )
                  })}
                </GridLayout>
              )}

              {/* 配置不可時の赤い影（コライダーなし fallback） */}
              {dragFallback && (
                <div
                  className="drag-fallback-shadow"
                  style={{
                    left: dragFallback.col * (CELL_WIDTH + GAP) + OLED_PAD,
                    top: dragFallback.row * (CELL_HEIGHT + GAP) + OLED_PAD,
                    width: dragFallback.w * CELL_WIDTH + GAP * (dragFallback.w - 1),
                    height: dragFallback.h * CELL_HEIGHT,
                  }}
                />
              )}

              {/* クリック時の位置マーカー */}
              {popupPos && (
                <div
                  className="placeholder-cell"
                  style={{
                    left: popupPos.x, top: popupPos.y,
                    width: CELL_WIDTH, height: CELL_HEIGHT,
                  }}
                />
              )}
            </div>

            {/* ポップアップパレット */}
            {popupPos && (
              <PopupPalette
                displayX={popupPos.x}
                displayY={popupPos.y + CELL_HEIGHT + 4}
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

        {/* ボタン */}
        {deviceSpec.buttons.map((btn) => (
          <div
            key={btn.id}
            className="device-abs-button"
            style={{ left: `${btn.x}%`, top: `${btn.y}%` }}
            title={btn.label}
            onClick={() => onSimButtonClick(btn.id)}
            onMouseDown={() => onSimButtonDown(btn.id)}
            onMouseUp={onSimButtonUp}
            onMouseLeave={onSimButtonUp}
          >
            <div className="device-button-dot" />
            <span className="device-button-label"
              style={{ transform: isFlipped ? 'rotate(180deg)' : undefined }}
            >{btn.label}</span>
          </div>
        ))}

        <div className="device-abs-led"
          style={{ left: `${deviceSpec.led.x}%`, top: `${deviceSpec.led.y}%` }}
        />
      </div>
    </div>
  )
}

// ========================================
// PopupPalette — OLED クリック時のミニパレット（衝突チェック付き）
// ========================================

interface PopupPaletteProps {
  displayX: number; displayY: number
  gridCol: number; gridRow: number
  page: DisplayPage | undefined
  usedTypes: Set<DisplayElementType>
  onSelect: (type: DisplayElementType) => void
  onClose: () => void
}

function PopupPalette({ displayX, displayY, gridCol, gridRow, page, usedTypes, onSelect, onClose }: PopupPaletteProps) {
  return (
    <>
      <div className="popup-overlay" onClick={onClose} />
      <div className="popup-palette" style={{ left: displayX, top: displayY }}>
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
    </>
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
}

function ControlBar({
  pages, activePageIndex, deviceModel, isFlipped,
  onPageChange, onAddPage, onDeletePage,
  onDeviceModelChange, onApplyTemplate, onToggleOrientation,
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
        <button className="btn btn-sm" onClick={onAddPage}>+ ページ</button>
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
    </div>
  )
}

// ========================================
// ButtonConfigPanel
// ========================================

interface ButtonConfigPanelProps {
  deviceSpec: DeviceHardwareSpec
  pages: DisplayPage[]
  perButtonActions: PerButtonActions
  onActionChange: (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => void
}

function ButtonConfigPanel({ deviceSpec, pages, perButtonActions, onActionChange }: ButtonConfigPanelProps) {
  const [openDropdown, setOpenDropdown] = useState<{
    btnId: string; field: keyof SingleButtonAction; above: boolean; alignRight: boolean
  } | null>(null)
  const actionGroups = useMemo(() => buildActionGroups(pages), [pages])
  const holdGroups = useMemo(() => buildHoldActionGroups(pages), [pages])
  const allItems = useMemo(() => [...actionGroups, ...holdGroups].flatMap((g) => g.items), [actionGroups, holdGroups])

  const handleSelect = (value: string) => {
    if (openDropdown) {
      onActionChange(openDropdown.btnId, openDropdown.field, value as ButtonActionType)
    }
    setOpenDropdown(null)
  }

  const openAt = (btnId: string, field: keyof SingleButtonAction, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceRight = window.innerWidth - rect.right
    setOpenDropdown({ btnId, field, above: spaceBelow < 300, alignRight: spaceRight < 280 })
  }

  // DuoWL: 左列(1,2,3) + 右列(5,4) の順で並べる
  const orderedButtons = useMemo(() => {
    if (deviceSpec.model === 'duo_wl') {
      const ids = ['btn_1', 'btn_4', 'btn_2', 'btn_5', 'btn_3']
      return ids.map((id) => deviceSpec.buttons.find((b) => b.id === id)).filter(Boolean) as typeof deviceSpec.buttons
    }
    return deviceSpec.buttons
  }, [deviceSpec])

  return (
    <div className="panel per-button-config-panel">
      <div className="panel-title">ボタン設定（{deviceSpec.name}）</div>
      <div className="per-button-grid">
        {orderedButtons.map((btn) => {
          const action = perButtonActions[btn.id] ?? DEFAULT_BUTTON_ACTION
          return (
            <div key={btn.id} className="per-button-card">
              <div className="per-button-label">{btn.label}</div>
              <div className="per-button-fields">
                {(['short_press', 'long_press', 'hold'] as const).map((field) => {
                  const groups = field === 'hold' ? holdGroups : actionGroups
                  const currentValue = (action[field] as string) ?? 'none'
                  const currentLabel = allItems.find((i) => i.value === currentValue)?.label ?? '\u2014'
                  const isOpen = openDropdown?.btnId === btn.id && openDropdown?.field === field
                  return (
                    <div key={field} className="config-field-inline">
                      <label className="label-sm">
                        {field === 'short_press' ? '短' : field === 'long_press' ? '長' : '押続'}
                      </label>
                      <button
                        className="action-select-btn"
                        onClick={(e) => isOpen ? setOpenDropdown(null) : openAt(btn.id, field, e)}
                      >
                        {currentLabel}
                        <span className="action-select-arrow">{isOpen ? '\u25b2' : '\u25bc'}</span>
                      </button>
                      {isOpen && (
                        <>
                          <div className="action-dropdown-overlay" onClick={() => setOpenDropdown(null)} />
                          <div className={`action-dropdown ${openDropdown?.above ? 'above' : ''} ${openDropdown?.alignRight ? 'align-right' : ''}`}>
                            {groups.map((group) => (
                              <div key={group.label} className="action-dropdown-group">
                                <div className="action-dropdown-group-label">{group.label}</div>
                                <div className="action-dropdown-items">
                                  {group.items.map((opt) => (
                                    <button
                                      key={opt.value + opt.label}
                                      className={`action-dropdown-item ${opt.value === currentValue ? 'selected' : ''}`}
                                      data-none={opt.value === 'none' ? 'true' : undefined}
                                      onClick={() => handleSelect(opt.value)}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
