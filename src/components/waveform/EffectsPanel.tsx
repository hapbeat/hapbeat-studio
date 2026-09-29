import { useState, useCallback, useEffect } from 'react'
import type { EffectType } from '@/types/waveform'
import { EFFECT_LABELS, EXPERIMENTAL_EFFECTS } from '@/types/waveform'
import { useWaveformStore } from '@/stores/waveformStore'
import { EffectParamEditor } from './EffectParamEditor'
import { useI18n } from '@/i18n/I18nProvider'

const EFFECT_TYPES: EffectType[] = [
  'repitch',
  'noise-gate',
  'lpf',
  'hpf',
  'bpf',
  'envelope',
  'gain',
  'normalize',
  'fade-in',
  'fade-out',
  'reverse',
  'mono-convert',
  'am',
  'noise-mix',
  'freq-shift',
  'compressor',
  'saturate',
]

function getEffectSummary(params: import('@/types/waveform').EffectParams): string {
  switch (params.type) {
    case 'trim': case 'cut': return `${params.start.toFixed(3)}–${params.end.toFixed(3)} s`
    case 'noise-gate': return `${params.thresholdDb} dB`
    case 'repitch':
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
    case 'am':
      return `${params.rateHz}Hz ${Math.round(params.depth * 100)}% ${params.shape}`
    case 'noise-mix':
      return `${params.color} ${params.lowHz}–${params.highHz}Hz ${params.levelDb > 0 ? '+' : ''}${params.levelDb}dB`
    case 'freq-shift':
      return `${params.shiftHz > 0 ? '+' : ''}${params.shiftHz}Hz`
    case 'compressor':
      return `${params.thresholdDb}dB ${params.ratio}:1`
    case 'saturate':
      return `${params.mode} +${params.driveDb}dB`
  }
}

export function EffectsPanel({preview, onPreviewChange}: {preview: boolean; onPreviewChange: (value: boolean) => void}) {
  const { t } = useI18n()
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null)

  const effects = useWaveformStore((s) => s.effects)
  const isProcessing = useWaveformStore((s) => s.isProcessing)
  const addEffect = useWaveformStore((s) => s.addEffect)
  const updateEffect = useWaveformStore((s) => s.updateEffect)
  const removeEffect = useWaveformStore((s) => s.removeEffect)
  const toggleEffect = useWaveformStore((s) => s.toggleEffect)
  const applyEffects = useWaveformStore((s) => s.applyEffects)

  const clipId = useWaveformStore(s => s.clip?.id)
  useEffect(() => { setSelectedEffectId(effects[0]?.id ?? null) }, [clipId])
  const selectedEffect = effects.find((e) => e.id === selectedEffectId)

  const handleAdd = (type: EffectType) => {
    addEffect(type)
    setSelectedEffectId(useWaveformStore.getState().effects.slice(-1)[0]?.id ?? null)
  }

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
        <label className="editor-preview-toggle"><input type="checkbox" checked={preview} onChange={e => onPreviewChange(e.target.checked)} />{t('editor.previewToggle')}</label>
        <div className="effects-chain-header">
          <span>{t('editor.tactile')}</span>
          <span style={{ fontSize: '12px', fontWeight: 'normal' }}>
            {effects.length} effect{effects.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="effects-chain-list">
          {effects.map((effect, i) => (
            <div
              key={effect.id}
              className={`effect-item ${effect.id === selectedEffectId ? 'selected' : ''} ${!effect.enabled ? 'disabled' : ''} ${effect.applied ? 'applied' : ''}`}
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
                {EXPERIMENTAL_EFFECTS.has(effect.params.type) && <span className="effect-experimental-badge" title={t('editor.experimentalHint')}>{t('editor.experimental')}</span>}
              </span>
              <span className="effect-summary">{effect.applied ? `✓ ${t('editor.applied')}` : getEffectSummary(effect.params)}</span>
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

        <div className="editor-effect-palette">
          {EFFECT_TYPES.map(type => <button className="editor-effect-tile" key={type} onClick={() => handleAdd(type)} title={EFFECT_LABELS[type]}>
            <EffectIcon type={type} /><span>{EFFECT_LABELS[type]}</span>
            {EXPERIMENTAL_EFFECTS.has(type) && <small className="effect-experimental-badge" title={t('editor.experimentalHint')}>{t('editor.experimental')}</small>}
          </button>)}
        </div>

        <details className="editor-audio-effects"><summary>{t('editor.audioEffects')}</summary>
          {(['pitch-shift', 'time-stretch', 'eq'] as EffectType[]).map(type => <button className="toolbar-btn" key={type} onClick={() => handleAdd(type)}>{EFFECT_LABELS[type]}</button>)}
        </details>
        <div className="effects-chain-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
          <button
            className="apply-effects-btn"
            onClick={() => void applyEffects().then(() => {if (!useWaveformStore.getState().error) onPreviewChange(false)})}
            disabled={isProcessing}
            style={{ flex: 1 }}
          >
            {t('editor.apply')}
          </button>
          <button
            className="clear-effects-btn"
            onClick={handleClear}
            disabled={!effects.length}
          >
            {t('editor.clearEffects')}
          </button>
        </div>
      </div>

      <div className="effect-params">
        {selectedEffect ? (
          <>
            <div className="editor-effect-state">{selectedEffect.applied ? t('editor.appliedHint') : t('editor.pendingHint')}</div>
            <fieldset className="editor-param-fieldset" >
              <EffectParamEditor params={selectedEffect.params} onChange={(params) => updateEffect(selectedEffect.id, params)} />
            </fieldset>
          </>
        ) : (
          <div className="effect-params-empty">
            {effects.length === 0 ? t('wave.addEffect') : t('wave.selectEffect')}
          </div>
        )}
      </div>
    </div>
  )
}

function EffectIcon({type}: {type: EffectType}) {
  const paths: Partial<Record<EffectType,string>> = {
    lpf: 'M2 6H12Q18 6 20 20H30', hpf:'M2 20H9Q14 20 16 6H30', bpf:'M2 20H8Q12 20 14 6H19Q21 6 25 20H30',
    repitch:'M3 18L12 8M8 8H12V12M19 20V4M24 20V8M29 20V12', 'noise-gate':'M2 13H9V4H22V13H30M2 18H30',
    envelope:'M2 22L8 3L15 14H24L30 22', gain:'M3 19H7M11 14H15M19 9H23M27 4H31',
    normalize:'M2 4H30M2 21H30M6 12H11L14 5L18 20L22 12H28',
    'fade-in':'M2 22L30 3M2 22H30', 'fade-out':'M2 3L30 22M2 22H30', reverse:'M29 12H3L11 5M3 12L11 19',
    'mono-convert':'M3 4L17 12H29M3 21L17 12',
    am:'M2 13Q5 3 8 13T14 13T20 13T26 13T32 13M2 4H30M2 22H30', 'noise-mix':'M2 13L4 9L6 16L8 7L10 18L12 10L14 15L16 6L18 19L20 11L22 14L24 8L26 17L28 12L30 13',
    'freq-shift':'M2 20Q6 4 10 20M14 12H22M19 9L22 12L19 15M24 20Q27 4 30 20', compressor:'M2 22L16 8H30M16 8V22M2 8H10',
    saturate:'M2 20C8 20 8 5 16 5H30M2 20H30',
  }
  return <svg viewBox="0 0 32 26" aria-hidden="true"><path d={paths[type] ?? 'M2 13H8L13 4L19 22L24 13H30'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
