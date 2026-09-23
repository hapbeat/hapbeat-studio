import { useCallback } from 'react'
import type {
  EffectParams,
  PitchShiftParams,
  TimeStretchParams,
  FilterParams,
  EqParams,
  EnvelopeParams,
  GainParams,
  NormalizeParams,
  FadeParams,
  MonoConvertParams,
  EqBand,
} from '@/types/waveform'
import { useI18n } from '@/i18n/I18nProvider'
import { EnvelopeCanvas } from './EnvelopeCanvas'

interface EffectParamEditorProps {
  params: EffectParams
  onChange: (params: EffectParams) => void
}

export function EffectParamEditor({ params, onChange }: EffectParamEditorProps) {
  switch (params.type) {
    case 'trim': case 'cut': return <div className="editor-range-params">{(['start', 'end'] as const).map(key => <label key={key}>{key}<input type="number" min={0} step={.001} value={params[key]} onChange={event => onChange({...params, [key]: Number(event.target.value)})} /></label>)}</div>
    case 'repitch': return <PitchShiftEditor params={{ type: 'pitch-shift', semitones: params.semitones }} onChange={p => { if (p.type === 'pitch-shift') onChange({ type: 'repitch', semitones: p.semitones }) }} />
    case 'noise-gate': return <NoiseGateEditor params={params} onChange={onChange} />
    case 'pitch-shift':
      return <PitchShiftEditor params={params} onChange={onChange} />
    case 'time-stretch':
      return <TimeStretchEditor params={params} onChange={onChange} />
    case 'lpf':
    case 'hpf':
    case 'bpf':
      return <FilterEditor params={params} onChange={onChange} />
    case 'eq':
      return <EqEditor params={params} onChange={onChange} />
    case 'envelope':
      return <EnvelopeEditor params={params} onChange={onChange} />
    case 'gain':
      return <GainEditor params={params} onChange={onChange} />
    case 'normalize':
      return <NormalizeEditor params={params} onChange={onChange} />
    case 'fade-in':
    case 'fade-out':
      return <FadeEditor params={params} onChange={onChange} />
    case 'reverse':
      return <ReverseEditor />
    case 'mono-convert':
      return <MonoConvertEditor params={params} onChange={onChange} />
  }
}

// ---- Individual editors ----

function PitchShiftEditor({
  params,
  onChange,
}: {
  params: PitchShiftParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Semitones</span>
        <span className="effect-param-value">{params.semitones > 0 ? '+' : ''}{params.semitones}</span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={-24}
        max={24}
        step={1}
        value={params.semitones}
        onChange={(e) => onChange({ ...params, semitones: Number(e.target.value) })}
      />
    </div>
  )
}

function TimeStretchEditor({
  params,
  onChange,
}: {
  params: TimeStretchParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Rate</span>
        <span className="effect-param-value">{params.rate.toFixed(2)}x</span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={0.25}
        max={4.0}
        step={0.05}
        value={params.rate}
        onChange={(e) => onChange({ ...params, rate: Number(e.target.value) })}
      />
    </div>
  )
}

function FilterEditor({
  params,
  onChange,
}: {
  params: FilterParams
  onChange: (p: EffectParams) => void
}) {
  const freqDisplay = params.frequency >= 1000
    ? `${(params.frequency / 1000).toFixed(1)} kHz`
    : `${Math.round(params.frequency)} Hz`

  return (
    <>
      <div className="effect-param-group">
        <div className="effect-param-label">
          <span>Frequency</span>
          <span className="effect-param-value">{freqDisplay}</span>
        </div>
        <input
          type="range"
          className="effect-param-slider"
          min={Math.log(20)}
          max={Math.log(20000)}
          step={0.01}
          value={Math.log(params.frequency)}
          onChange={(e) =>
            onChange({ ...params, frequency: Math.round(Math.exp(Number(e.target.value))) })
          }
        />
      </div>
      <div className="effect-param-group">
        <div className="effect-param-label">
          <span>Q</span>
          <span className="effect-param-value">{params.Q.toFixed(1)}</span>
        </div>
        <input
          type="range"
          className="effect-param-slider"
          min={0.1}
          max={20}
          step={0.1}
          value={params.Q}
          onChange={(e) => onChange({ ...params, Q: Math.max(.1, Math.min(20, Number(e.target.value))) })}
        />
      </div>
    </>
  )
}

function EqEditor({
  params,
  onChange,
}: {
  params: EqParams
  onChange: (p: EffectParams) => void
}) {
  const updateBand = useCallback(
    (index: number, updates: Partial<EqBand>) => {
      const bands = params.bands.map((b, i) => (i === index ? { ...b, ...updates } : b))
      onChange({ ...params, bands })
    },
    [params, onChange]
  )

  const addBand = useCallback(() => {
    onChange({
      ...params,
      bands: [...params.bands, { frequency: 1000, gain: 0, Q: 1.0 }],
    })
  }, [params, onChange])

  const removeBand = useCallback(
    (index: number) => {
      onChange({
        ...params,
        bands: params.bands.filter((_, i) => i !== index),
      })
    },
    [params, onChange]
  )

  return (
    <div className="eq-bands">
      {params.bands.map((band, i) => (
        <div key={i} className="eq-band">
          <div className="eq-band-field">
            <span>Freq (Hz)</span>
            <input
              type="number"
              value={band.frequency}
              min={20}
              max={20000}
              onChange={(e) => updateBand(i, { frequency: Math.max(20, Math.min(20000, Number(e.target.value))) })}
            />
          </div>
          <div className="eq-band-field">
            <span>Gain (dB)</span>
            <input
              type="number"
              value={band.gain}
              min={-24}
              max={24}
              step={0.5}
              onChange={(e) => updateBand(i, { gain: Math.max(-24, Math.min(24, Number(e.target.value))) })}
            />
          </div>
          <div className="eq-band-field">
            <span>Q</span>
            <input
              type="number"
              value={band.Q}
              min={0.1}
              max={20}
              step={0.1}
              onChange={(e) => updateBand(i, { Q: Math.max(.1, Math.min(20, Number(e.target.value))) })}
            />
          </div>
          <button className="eq-band-remove" onClick={() => removeBand(i)} title="Remove band">
            x
          </button>
        </div>
      ))}
      <button className="eq-add-band" onClick={addBand}>
        + Add Band
      </button>
    </div>
  )
}

function EnvelopeEditor({
  params,
  onChange,
}: {
  params: EnvelopeParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Envelope (click to add, right-click to remove)</span>
      </div>
      <EnvelopeCanvas
        points={params.points}
        onChange={(points) => onChange({ ...params, points })}
      />
    </div>
  )
}

function GainEditor({
  params,
  onChange,
}: {
  params: GainParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Gain</span>
        <span className="effect-param-value">
          {params.gainDb > 0 ? '+' : ''}{params.gainDb.toFixed(1)} dB
        </span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={-60}
        max={20}
        step={0.5}
        value={params.gainDb}
        onChange={(e) => onChange({ ...params, gainDb: Number(e.target.value) })}
      />
    </div>
  )
}

function NormalizeEditor({
  params,
  onChange,
}: {
  params: NormalizeParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Target Peak</span>
        <span className="effect-param-value">{(params.targetPeak * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={0.1}
        max={1.0}
        step={0.01}
        value={params.targetPeak}
        onChange={(e) => onChange({ ...params, targetPeak: Number(e.target.value) })}
      />
    </div>
  )
}

function FadeEditor({
  params,
  onChange,
}: {
  params: FadeParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Duration</span>
        <span className="effect-param-value">{params.durationMs} ms</span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={1}
        max={5000}
        step={1}
        value={params.durationMs}
        onChange={(e) => onChange({ ...params, durationMs: Number(e.target.value) })}
      />
    </div>
  )
}

function ReverseEditor() {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Reverse</span>
        <span className="effect-param-value">No parameters</span>
      </div>
    </div>
  )
}

function MonoConvertEditor({
  params,
  onChange,
}: {
  params: MonoConvertParams
  onChange: (p: EffectParams) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Method</span>
      </div>
      <select
        className="effect-param-select"
        value={params.method}
        onChange={(e) =>
          onChange({ ...params, method: e.target.value as MonoConvertParams['method'] })
        }
      >
        <option value="average">Average (L+R)/2</option>
        <option value="left">Left Channel</option>
        <option value="right">Right Channel</option>
      </select>
    </div>
  )
}

function NoiseGateEditor({ params, onChange }: { params: Extract<EffectParams, {type: 'noise-gate'}>; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  return <div className="effect-param-group">
    <p>{t('editor.gateHint')}</p>
    {([
      ['thresholdDb', 'Threshold (dB)', -80, 0, 1],
      ['attackMs', 'Attack (ms)', .1, 100, .1],
      ['releaseMs', 'Release (ms)', 1, 1000, 1],
    ] as const).map(([key, label, min, max, step]) => <label key={key} className="editor-gate-param">{label} <span>{params[key]}</span>
      <input type="range" min={min} max={max} step={step} value={params[key]} onChange={e => onChange({ ...params, [key]: Number(e.target.value) })} />
    </label>)}
  </div>
}
