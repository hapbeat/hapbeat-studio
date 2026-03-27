import { useState, useCallback, useRef } from 'react'
import type { DeviceModel } from '@/types/device'
import { DEVICE_SPECS } from '@/types/device'
import './DeviceLayoutDesigner.css'

/**
 * デバイスレイアウトデザイナー
 *
 * OLED を中央固定の基準として、ボタンと LED をドラッグで自由配置できる。
 * 座標はリアルタイム表示され、最終的に device.ts へコピペできる JSON を出力する。
 */

interface DraggableItem {
  id: string
  label: string
  x: number // キャンバス内 px
  y: number
  kind: 'button' | 'led'
}

const CANVAS_W = 700
const CANVAS_H = 400
const OLED_W = 576 // GRID_COLS * CELL_WIDTH (16*36)
const OLED_H = 80  // GRID_ROWS * CELL_HEIGHT (2*40)

function oledRect() {
  return {
    x: (CANVAS_W - OLED_W) / 2,
    y: (CANVAS_H - OLED_H) / 2,
    w: OLED_W,
    h: OLED_H,
  }
}

function initItems(model: DeviceModel): DraggableItem[] {
  const spec = DEVICE_SPECS[model]
  // spec の % 座標を canvas px に変換（OLED 中心 = canvas 中心として概算）
  const items: DraggableItem[] = spec.buttons.map((btn) => ({
    id: btn.id,
    label: btn.label,
    x: (btn.x / 100) * CANVAS_W,
    y: (btn.y / 100) * CANVAS_H,
    kind: 'button' as const,
  }))
  items.push({
    id: 'led',
    label: 'LED',
    x: (spec.led.x / 100) * CANVAS_W,
    y: (spec.led.y / 100) * CANVAS_H,
    kind: 'led',
  })
  return items
}

export function DeviceLayoutDesigner() {
  const [model, setModel] = useState<DeviceModel>('duo_wl')
  const [items, setItems] = useState<DraggableItem[]>(() => initItems('duo_wl'))
  const [dragging, setDragging] = useState<string | null>(null)
  const [snapToGrid, setSnapToGrid] = useState(true)
  const canvasRef = useRef<HTMLDivElement>(null)

  const SNAP = 10

  const handleModelChange = useCallback((m: DeviceModel) => {
    setModel(m)
    setItems(initItems(m))
    setDragging(null)
  }, [])

  const handlePointerDown = useCallback((id: string) => {
    setDragging(id)
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !canvasRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      let x = e.clientX - rect.left
      let y = e.clientY - rect.top
      // clamp
      x = Math.max(0, Math.min(CANVAS_W, x))
      y = Math.max(0, Math.min(CANVAS_H, y))
      // snap
      if (snapToGrid) {
        x = Math.round(x / SNAP) * SNAP
        y = Math.round(y / SNAP) * SNAP
      }
      setItems((prev) =>
        prev.map((item) => (item.id === dragging ? { ...item, x, y } : item))
      )
    },
    [dragging, snapToGrid]
  )

  const handlePointerUp = useCallback(() => {
    setDragging(null)
  }, [])

  // JSON 出力（device.ts にコピペ用）
  const oled = oledRect()
  const exportJson = useCallback(() => {
    const buttons = items
      .filter((i) => i.kind === 'button')
      .map((i) => ({
        id: i.id,
        label: i.label,
        x: Math.round((i.x / CANVAS_W) * 100),
        y: Math.round((i.y / CANVAS_H) * 100),
      }))
    const led = items.find((i) => i.kind === 'led')
    const result = {
      buttons,
      led: led
        ? { x: Math.round((led.x / CANVAS_W) * 100), y: Math.round((led.y / CANVAS_H) * 100) }
        : undefined,
      oled: {
        x: Math.round((oled.x / CANVAS_W) * 100),
        y: Math.round((oled.y / CANVAS_H) * 100),
        width: Math.round((oled.w / CANVAS_W) * 100),
        height: Math.round((oled.h / CANVAS_H) * 100),
      },
    }
    navigator.clipboard.writeText(JSON.stringify(result, null, 2))
    alert('座標 JSON をクリップボードにコピーしました')
  }, [items, oled])

  return (
    <div className="layout-designer">
      {/* ツールバー */}
      <div className="layout-designer-toolbar">
        <span className="layout-designer-title">デバイスレイアウトデザイナー</span>
        <div className="layout-designer-controls">
          {(Object.keys(DEVICE_SPECS) as DeviceModel[]).map((m) => (
            <button
              key={m}
              className={`btn btn-sm ${model === m ? 'active' : ''}`}
              onClick={() => handleModelChange(m)}
            >
              {DEVICE_SPECS[m].name}
            </button>
          ))}
          <label className="snap-label">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(e) => setSnapToGrid(e.target.checked)}
            />
            スナップ ({SNAP}px)
          </label>
          <button className="btn btn-sm" onClick={exportJson}>
            座標をコピー
          </button>
        </div>
      </div>

      {/* キャンバス */}
      <div
        ref={canvasRef}
        className="layout-designer-canvas"
        style={{ width: CANVAS_W, height: CANVAS_H }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* グリッド線 */}
        <svg className="layout-designer-grid-svg" width={CANVAS_W} height={CANVAS_H}>
          {snapToGrid &&
            Array.from({ length: Math.floor(CANVAS_W / SNAP) + 1 }, (_, i) => (
              <line
                key={`v${i}`}
                x1={i * SNAP} y1={0} x2={i * SNAP} y2={CANVAS_H}
                stroke="rgba(255,255,255,0.04)"
                strokeWidth={i % 5 === 0 ? 0.8 : 0.3}
              />
            ))}
          {snapToGrid &&
            Array.from({ length: Math.floor(CANVAS_H / SNAP) + 1 }, (_, i) => (
              <line
                key={`h${i}`}
                x1={0} y1={i * SNAP} x2={CANVAS_W} y2={i * SNAP}
                stroke="rgba(255,255,255,0.04)"
                strokeWidth={i % 5 === 0 ? 0.8 : 0.3}
              />
            ))}
          {/* 中心線 */}
          <line x1={CANVAS_W / 2} y1={0} x2={CANVAS_W / 2} y2={CANVAS_H}
            stroke="rgba(120,120,255,0.15)" strokeWidth={1} strokeDasharray="4 4" />
          <line x1={0} y1={CANVAS_H / 2} x2={CANVAS_W} y2={CANVAS_H / 2}
            stroke="rgba(120,120,255,0.15)" strokeWidth={1} strokeDasharray="4 4" />
        </svg>

        {/* OLED（固定、ドラッグ不可） */}
        <div
          className="layout-oled-ref"
          style={{
            left: oled.x,
            top: oled.y,
            width: oled.w,
            height: oled.h,
          }}
        >
          <span className="layout-oled-label">OLED {OLED_W}x{OLED_H}</span>
        </div>

        {/* ドラッグ可能アイテム */}
        {items.map((item) => (
          <div
            key={item.id}
            className={`layout-item ${item.kind} ${dragging === item.id ? 'dragging' : ''}`}
            style={{ left: item.x, top: item.y }}
            onPointerDown={(e) => {
              e.preventDefault()
              handlePointerDown(item.id)
            }}
          >
            <div className={`layout-item-dot ${item.kind}`} />
            <span className="layout-item-label">{item.label}</span>
            <span className="layout-item-coords">
              {Math.round((item.x / CANVAS_W) * 100)}, {Math.round((item.y / CANVAS_H) * 100)}
            </span>
          </div>
        ))}
      </div>

      {/* 座標一覧テーブル */}
      <div className="layout-designer-table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>ラベル</th>
              <th>X (%)</th>
              <th>Y (%)</th>
              <th>px</th>
            </tr>
          </thead>
          <tbody>
            <tr className="oled-row">
              <td>oled</td>
              <td>OLED</td>
              <td>{Math.round((oled.x / CANVAS_W) * 100)}</td>
              <td>{Math.round((oled.y / CANVAS_H) * 100)}</td>
              <td>{oled.x}, {oled.y}</td>
            </tr>
            {items.map((item) => (
              <tr key={item.id} className={dragging === item.id ? 'active-row' : ''}>
                <td className="mono">{item.id}</td>
                <td>{item.label}</td>
                <td className="mono">{Math.round((item.x / CANVAS_W) * 100)}</td>
                <td className="mono">{Math.round((item.y / CANVAS_H) * 100)}</td>
                <td className="mono">{Math.round(item.x)}, {Math.round(item.y)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
