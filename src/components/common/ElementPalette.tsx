import type { DisplayElementMeta, DisplayElementType } from '@/types/display'
import { ELEMENT_FIXED_SIZES } from '@/types/display'
import { getElementDescription } from '@/utils/displayPreview'
import { setCurrentDragType } from '@/components/display/DisplayEditor'
import './ElementPalette.css'

export const elementMetas: DisplayElementMeta[] = [
  { type: 'volume',            label: 'ボリューム',        description: 'ADC切替連動',    icon: '\u266a' },
  { type: 'battery',           label: 'バッテリー',        description: '残量メーター',   icon: '\u26a1' },
  { type: 'wifi_status',       label: 'Wi-Fi 強度',       description: 'RSSI表示',       icon: '\u25ce' },
  { type: 'wifi_ssid',         label: 'Wi-Fi 接続先',     description: 'SSID/AP名',      icon: '\u25cb' },
  { type: 'connection_status', label: '接続状態',          description: 'Wi-Fi+アプリ',   icon: '\u25c9' },
  { type: 'ip_address',        label: 'IP アドレス',      description: 'IP',             icon: '\u2316' },
  { type: 'firmware_version',  label: 'FW Ver',           description: 'バージョン',     icon: 'v' },
  { type: 'device_name',       label: 'デバイス名',        description: '設定名称',       icon: 'D' },
  { type: 'gain',              label: 'ゲイン',            description: '出力ゲイン',     icon: 'G' },
  { type: 'address',           label: 'アドレス',          description: 'player/pos',     icon: 'A' },
  { type: 'player_number',     label: 'プレイヤー',        description: 'Player番号',     icon: 'P' },
  { type: 'position',          label: 'ポジション',        description: '装着位置',       icon: '\u2b26' },
  { type: 'page_indicator',    label: 'ページ',            description: '1/2 表示',       icon: '#' },
  { type: 'group_id',          label: 'グループ',          description: 'グループID',     icon: 'Gr' },
]

export function getElementMeta(type: DisplayElementType): DisplayElementMeta | undefined {
  return elementMetas.find((m) => m.type === type)
}

interface ElementPaletteProps {
  selectedType: DisplayElementType | null
  onSelectType: (type: DisplayElementType | null) => void
  usedTypes: Set<DisplayElementType>
}

export function ElementPalette({ selectedType, onSelectType, usedTypes }: ElementPaletteProps) {
  return (
    <div className="element-palette">
      <div className="panel-title">要素パレット</div>
      <div className="palette-hint">
        OLED 上をクリック or パレットからドラッグ
      </div>
      <div className="palette-grid">
        {elementMetas.map((meta) => {
          const size = ELEMENT_FIXED_SIZES[meta.type]
          const isSelected = selectedType === meta.type
          const isUsed = usedTypes.has(meta.type)
          return (
            <button
              key={meta.type}
              className={`palette-item ${isSelected ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
              onClick={() => {
                if (isUsed) return
                onSelectType(isSelected ? null : meta.type)
              }}
              disabled={isUsed}
              onMouseDown={(e) => {
                if (isUsed || e.button !== 0) return
                e.preventDefault()
                setCurrentDragType(meta.type)
              }}
            >
              <span className="palette-icon">{meta.icon}</span>
              <div className="palette-info">
                <span className="palette-label">{meta.label}</span>
                <span className="palette-desc">
                  {getElementDescription(meta.type)} ({size[0]}x{size[1]})
                </span>
              </div>
              {isUsed && <span className="palette-used-badge">使用中</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
