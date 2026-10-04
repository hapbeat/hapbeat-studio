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
  AmParams,
  NoiseMixParams,
  FreqShiftParams,
  BandSplitParams,
  CompressorParams,
  SaturateParams,
} from '@/types/waveform'
import { useI18n } from '@/i18n/I18nProvider'
import { AM_SHAPES, CARRIER_SHAPES, EFFECT_RANGES, NOISE_COLORS, SATURATE_MODES, SEED_RANGE, type ParamRange } from '@/utils/effectRanges'
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
    case 'am':
      return <AmEditor params={params} onChange={onChange} />
    case 'noise-mix':
      return <NoiseMixEditor params={params} onChange={onChange} />
    case 'freq-shift':
      return <FreqShiftEditor params={params} onChange={onChange} />
    case 'band-split':
      return <BandSplitEditor params={params} onChange={onChange} />
    case 'compressor':
      return <CompressorEditor params={params} onChange={onChange} />
    case 'saturate':
      return <SaturateEditor params={params} onChange={onChange} />
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

// ---- Texture effects (ranges from EFFECT_RANGES) ----

/** Slider bound to a ParamRange; `log` maps the slider logarithmically (range min must be > 0). */
function RangeSlider({ label, value, range, log = false, format, onChange }: {
  label: string
  value: number
  range: ParamRange
  log?: boolean
  format?: (value: number) => string
  onChange: (value: number) => void
}) {
  const min = range.min ?? 0, max = range.max ?? 1, step = range.step ?? 1
  const clamp = (v: number) => Math.max(min, Math.min(max, Number((Math.round(v / step) * step).toFixed(6))))
  const shown = format ? format(value) : `${Number(value.toFixed(3))}${range.unit ? ` ${range.unit}` : ''}`
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>{label}</span>
        <span className="effect-param-value">{shown}</span>
      </div>
      <input
        type="range"
        className="effect-param-slider"
        min={log ? Math.log(min) : min}
        max={log ? Math.log(max) : max}
        step={log ? 0.01 : step}
        value={log ? Math.log(value) : value}
        onChange={(e) => onChange(clamp(log ? Math.exp(Number(e.target.value)) : Number(e.target.value)))}
      />
    </div>
  )
}

function EnumSelect<T extends string>({ label, value, options, format, onChange }: {
  label: string
  value: T
  options: readonly T[]
  format?: (option: T) => string
  onChange: (value: T) => void
}) {
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>{label}</span>
      </div>
      <select className="effect-param-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(option => <option key={option} value={option}>{format ? format(option) : option}</option>)}
      </select>
    </div>
  )
}

function SeedInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const min = SEED_RANGE.min ?? 0, max = SEED_RANGE.max ?? 0
  return (
    <div className="effect-param-group">
      <div className="effect-param-label">
        <span>Seed</span>
      </div>
      <input
        type="number"
        className="effect-param-input"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Math.trunc(Number(e.target.value) || 0))))}
      />
    </div>
  )
}

const hz = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Number(value.toFixed(1))} Hz`
const signedDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`

function AmEditor({ params, onChange }: { params: AmParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  const r = EFFECT_RANGES.am
  return (
    <>
      <p className="effect-param-hint">{t('editor.amHint')}</p>
      <RangeSlider label="Rate" value={params.rateHz} range={r.rateHz} log format={hz} onChange={rateHz => onChange({ ...params, rateHz })} />
      <RangeSlider label="Depth" value={params.depth} range={r.depth} onChange={depth => onChange({ ...params, depth })} />
      <EnumSelect label="Shape" value={params.shape} options={AM_SHAPES} format={shape => shape === 'random' ? `random (${t('editor.experimental')})` : shape} onChange={shape => onChange({ ...params, shape })} />
      <RangeSlider label="Jitter" value={params.jitter} range={r.jitter} onChange={jitter => onChange({ ...params, jitter })} />
      <SeedInput value={params.seed} onChange={seed => onChange({ ...params, seed })} />
    </>
  )
}

function NoiseMixEditor({ params, onChange }: { params: NoiseMixParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  const r = EFFECT_RANGES['noise-mix']
  const lowMin = r.lowHz.min ?? 0, highMax = r.highHz.max ?? 0
  return (
    <>
      <p className="effect-param-hint">{t('editor.noiseMixHint')}</p>
      <RangeSlider label="Level (vs input RMS)" value={params.levelDb} range={r.levelDb} format={signedDb} onChange={levelDb => onChange({ ...params, levelDb })} />
      <RangeSlider label="Low cut" value={params.lowHz} range={r.lowHz} log format={hz} onChange={lowHz => onChange({ ...params, lowHz, highHz: Math.max(params.highHz, Math.min(highMax, lowHz + 1)) })} />
      <RangeSlider label="High cut" value={params.highHz} range={r.highHz} log format={hz} onChange={highHz => onChange({ ...params, highHz, lowHz: Math.min(params.lowHz, Math.max(lowMin, highHz - 1)) })} />
      <EnumSelect label="Color" value={params.color} options={NOISE_COLORS} onChange={color => onChange({ ...params, color })} />
      <label className="effect-param-group effect-param-check">
        <input type="checkbox" checked={params.follow} onChange={(e) => onChange({ ...params, follow: e.target.checked })} />
        {t('editor.noiseFollow')}
      </label>
      <SeedInput value={params.seed} onChange={seed => onChange({ ...params, seed })} />
    </>
  )
}

function FreqShiftEditor({ params, onChange }: { params: FreqShiftParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  return (
    <>
      <p className="effect-param-hint">{t('editor.freqShiftHint')}</p>
      <RangeSlider label="Shift" value={params.shiftHz} range={EFFECT_RANGES['freq-shift'].shiftHz} format={v => `${v > 0 ? '+' : ''}${v} Hz`} onChange={shiftHz => onChange({ ...params, shiftHz })} />
    </>
  )
}

function BandSplitEditor({ params, onChange }: { params: BandSplitParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  const r = EFFECT_RANGES['band-split']
  return (
    <>
      <p className="effect-param-hint">{t('editor.bandSplitHint')}</p>
      <RangeSlider label="Crossover" value={params.crossoverHz} range={r.crossoverHz} log format={hz} onChange={crossoverHz => onChange({ ...params, crossoverHz })} />
      <RangeSlider label="Carrier" value={params.carrierHz} range={r.carrierHz} log format={hz} onChange={carrierHz => onChange({ ...params, carrierHz })} />
      <EnumSelect label="Carrier shape" value={params.carrierShape} options={CARRIER_SHAPES} onChange={carrierShape => onChange({ ...params, carrierShape })} />
      <RangeSlider label="High band level" value={params.highGainDb} range={r.highGainDb} format={signedDb} onChange={highGainDb => onChange({ ...params, highGainDb })} />
      <RangeSlider label="Smoothing" value={params.smoothMs} range={r.smoothMs} format={v => `${v} ms`} onChange={smoothMs => onChange({ ...params, smoothMs })} />
    </>
  )
}

function CompressorEditor({ params, onChange }: { params: CompressorParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  const r = EFFECT_RANGES.compressor
  return (
    <>
      <p className="effect-param-hint">{t('editor.compressorHint')}</p>
      <RangeSlider label="Threshold" value={params.thresholdDb} range={r.thresholdDb} format={signedDb} onChange={thresholdDb => onChange({ ...params, thresholdDb })} />
      <RangeSlider label="Ratio" value={params.ratio} range={r.ratio} format={v => `${v.toFixed(1)}:1`} onChange={ratio => onChange({ ...params, ratio })} />
      <RangeSlider label="Attack" value={params.attackMs} range={r.attackMs} log onChange={attackMs => onChange({ ...params, attackMs })} />
      <RangeSlider label="Release" value={params.releaseMs} range={r.releaseMs} log onChange={releaseMs => onChange({ ...params, releaseMs })} />
      <RangeSlider label="Knee" value={params.kneeDb} range={r.kneeDb} onChange={kneeDb => onChange({ ...params, kneeDb })} />
      <RangeSlider label="Makeup" value={params.makeupDb} range={r.makeupDb} format={signedDb} onChange={makeupDb => onChange({ ...params, makeupDb })} />
    </>
  )
}

function SaturateEditor({ params, onChange }: { params: SaturateParams; onChange: (p: EffectParams) => void }) {
  const { t } = useI18n()
  const r = EFFECT_RANGES.saturate
  return (
    <>
      <p className="effect-param-hint">{t('editor.saturateHint')}</p>
      <RangeSlider label="Drive" value={params.driveDb} range={r.driveDb} format={signedDb} onChange={driveDb => onChange({ ...params, driveDb })} />
      <EnumSelect label="Mode" value={params.mode} options={SATURATE_MODES} onChange={mode => onChange({ ...params, mode })} />
      <RangeSlider label="Mix" value={params.mix} range={r.mix} format={v => `${Math.round(v * 100)}%`} onChange={mix => onChange({ ...params, mix })} />
      <RangeSlider label="Output" value={params.outputDb} range={r.outputDb} format={signedDb} onChange={outputDb => onChange({ ...params, outputDb })} />
    </>
  )
}
