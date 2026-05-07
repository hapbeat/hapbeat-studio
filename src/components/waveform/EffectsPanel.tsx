import { useState, useCallback } from 'react'
import type { EffectType } from '@/types/waveform'
import { EFFECT_LABELS } from '@/types/waveform'
import { useWaveformStore } from '@/stores/waveformStore'
import { applyEffect } from '@/utils/audioDsp'
import { EffectParamEditor } from './EffectParamEditor'

const EFFECT_TYPES: EffectType[] = [
  'pitch-shift',
  'time-stretch',
  'lpf',
  'hpf',
  'bpf',
  'eq',
  'envelope',
  'gain',
  'normalize',
  'fade-in',
  'fade-out',
  'reverse',
  'mono-convert',
]

function getEffectSummary(params: import('@/types/waveform').EffectParams): string {
  switch (params.type) {
    case 'pitch-shift':
      return `${params.semitones > 0 ? '+' : ''}${params.semitones}st`
    case 'time-stretch':
      return `${params.rate.toFixed(2)}x`
    case 'lpf':
    case 'hpf':
    case 'bpf':
      return `${params.frequency >= 1000 ? `${(params.frequency / 1000).toFixed(1)}k` : params.frequency}Hz`
    case 'eq':
      return `${params.bands.length} band${params.bands.length !== 1 ? 's' : ''}`
    case 'envelope':
      return `${params.points.length} pts`
    case 'gain':
      return `${params.gainDb > 0 ? '+' : ''}${params.gainDb.toFixed(1)}dB`
    case 'normalize':
      return `${(params.targetPeak * 100).toFixed(0)}%`
    case 'fade-in':
    case 'fade-out':
      return `${params.durationMs}ms`
    case 'reverse':
      return ''
    case 'mono-convert':
      return params.method
  }
}

export function EffectsPanel() {
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null)
  const [addEffectType, setAddEffectType] = useState<EffectType>('lpf')

  const clip = useWaveformStore((s) => s.clip)
  const effects = useWaveformStore((s) => s.effects)
  const isProcessing = useWaveformStore((s) => s.isProcessing)
  const addEffect = useWaveformStore((s) => s.addEffect)
  const updateEffect = useWaveformStore((s) => s.updateEffect)
  const removeEffect = useWaveformStore((s) => s.removeEffect)
  const toggleEffect = useWaveformStore((s) => s.toggleEffect)
  const replaceBuffer = useWaveformStore((s) => s.replaceBuffer)
  const setProcessing = useWaveformStore((s) => s.setProcessing)

  const selectedEffect = effects.find((e) => e.id === selectedEffectId)

  const handleAdd = useCallback(() => {
    addEffect(addEffectType)
  }, [addEffect, addEffectType])

  const handleApplyAll = useCallback(async () => {
    if (!clip) return

    const enabledEffects = effects.filter((e) => e.enabled)
    if (enabledEffects.length === 0) return

    setProcessing(true)
    try {
      let buffer = clip.buffer
      for (const effect of enabledEffects) {
        buffer = await applyEffect(buffer, effect.params)
      }
      replaceBuffer(buffer, `Apply ${enabledEffects.length} effect(s)`)
      // Clear effects after applying
      const store = useWaveformStore.getState()
      for (const e of effects) {
        store.removeEffect(e.id)
      }
    } catch (err) {
      console.error('エフェクト適用エラー:', err)
      alert(`エフェクト適用に失敗しました: ${err instanceof Error ? err.message : err}`)
    } finally {
      setProcessing(false)
    }
  }, [clip, effects, replaceBuffer, setProcessing])

  const handleClear = useCallback(() => {
    const store = useWaveformStore.getState()
    for (const e of effects) {
      store.removeEffect(e.id)
    }
    setSelectedEffectId(null)
  }, [effects])

  return (
    <div className="effects-panel">
      <div className="effects-chain">
        <div className="effects-chain-header">
          <span>Effects</span>
          <span style={{ fontSize: '12px', fontWeight: 'normal' }}>
            {effects.length} effect{effects.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="effects-chain-list">
          {effects.map((effect, i) => (
            <div
              key={effect.id}
              className={`effect-item ${effect.id === selectedEffectId ? 'selected' : ''} ${!effect.enabled ? 'disabled' : ''}`}
              onClick={() => setSelectedEffectId(effect.id)}
            >
              <input
                type="checkbox"
                className="effect-toggle"
                checked={effect.enabled}
                onChange={(e) => {
                  e.stopPropagation()
                  toggleEffect(effect.id)
                }}
              />
              <span className="effect-name">
                {i + 1}. {EFFECT_LABELS[effect.params.type]}
              </span>
              <span className="effect-summary">{getEffectSummary(effect.params)}</span>
              <button
                className="effect-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  removeEffect(effect.id)
                  if (selectedEffectId === effect.id) setSelectedEffectId(null)
                }}
                title="Remove"
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div className="effects-chain-footer">
          <select
            className="add-effect-select"
            value={addEffectType}
            onChange={(e) => setAddEffectType(e.target.value as EffectType)}
          >
            {EFFECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EFFECT_LABELS[type]}
              </option>
            ))}
          </select>
          <button className="add-effect-btn" onClick={handleAdd}>
            +
          </button>
        </div>

        <div className="effects-chain-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
          <button
            className="apply-effects-btn"
            onClick={handleApplyAll}
            disabled={effects.filter((e) => e.enabled).length === 0 || isProcessing}
            style={{ flex: 1 }}
          >
            Apply All
          </button>
          <button
            className="clear-effects-btn"
            onClick={handleClear}
            disabled={effects.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="effect-params">
        {selectedEffect ? (
          <EffectParamEditor
            params={selectedEffect.params}
            onChange={(params) => updateEffect(selectedEffect.id, params)}
          />
        ) : (
          <div className="effect-params-empty">
            {effects.length === 0
              ? 'エフェクトを追加してください'
              : 'エフェクトを選択してパラメータを調整'}
          </div>
        )}
      </div>
    </div>
  )
}
