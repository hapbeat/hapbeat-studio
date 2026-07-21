import { create } from 'zustand'

/**
 * Per-device DRAFT for the DuoWL v4 audio-tab controls (DEC-041/audio-dsp-
 * config.md, extended by aic3204-full-dsp-registers.md's full DSP feature
 * set — DSP profile / 6-band EQ / 1st-order IIR / DRC / 3D / Beep / AGC).
 * This is the single source of truth the sliders/toggles in
 * NodeConfigSections.tsx (DuoWlV4AudioSection / DuoWlV4EspNowAudioSection /
 * DuoWlV4EqSection / DuoWlV4DspSection) read and write — NOT local
 * `useState` in each component — for two reasons:
 *
 *  1. DeviceDetail.tsx now renders the gain controls, the A-V delay, the EQ
 *     designer, and the DRC/3D/Beep/AGC panel on FOUR separate sub-tabs
 *     (`audio` / `audio` / `eq` / `dsp`). Switching sub-tabs unmounts
 *     whichever panel isn't active; a plain `useState` would reset (lose
 *     in-progress edits) every time the user tabs away and back. A store
 *     survives that.
 *  2. The "設定を JSON 保存/読込" pair (DuoWlV4SettingsBackup) needs to read
 *     EVERY field — including the EQ per-band design drafts, which live on
 *     the `eq` tab — from a component mounted on the `audio` tab. Only a
 *     shared store makes that reachable without prop-drilling through
 *     siblings.
 *
 * Keyed by device IP (or the `serial:<mac>` pseudo-id) exactly like
 * `deviceStore.infoCache`, so multiple devices don't cross-contaminate and
 * revisiting a device later resumes wherever the draft was left.
 */

export type DuoWlV4InputMode = 'output' | 'line_in'

/** DSP profile name (aic3204-full-dsp-registers.md §0/§1, DEC-046 follow-up).
 *  Studio-facing name — the raw AIC3204 PRB number is never exposed. Verified
 *  capabilities (firmware `aic3204GetProfileCaps`):
 *    standard = 3 biquad, no IIR, no DRC, no 3D, no Beep (existing behavior)
 *    eq6      = 6 biquad + 1st-order IIR
 *    eq6_drc  = 6 biquad + 1st-order IIR + DRC
 *    full     = 5 biquad + IIR + DRC + 3D + Beep
 */
export type DuoWlV4DspProfile = 'standard' | 'eq6' | 'eq6_drc' | 'full'

/**
 * One EQ band's local DESIGN draft. `ftype` is kept as a plain `string` here
 * (not the narrower `EqFtype` union from aic3204Eq.ts) so this store doesn't
 * need to import that type — NodeConfigSections.tsx re-validates/narrows it
 * via `normalizeEqDrafts` on every read (also defends against a hand-edited
 * JSON import carrying a bogus ftype).
 */
export interface DuoWlV4EqBandDraft {
  ftype: string
  fc: number
  q: number
  gainDb: number
}

/**
 * DRC (compressor/limiter) draft for ONE codec — aic3204-full-dsp-registers.md
 * §2 / set_drc. Kept as ONE object (not per-field FieldSlots) so every
 * control's commit ships the FULL config in one `set_drc`, same "always send
 * the coupled whole" discipline as DuoWlV4AudioSection's pam_db/lineout_db
 * pair — avoids a stale half-sent config if the user edited two fields
 * before either committed. Field names/defaults match firmware's
 * `DuoV4DrcConfig` (duowl_v4_audio.cpp `s_drc_haptic`/`s_drc_hp` initializer)
 * exactly: enable_l=false, enable_r=false, threshold_db=-24, hysteresis_db=3,
 * hold=0 (disabled), attack=11, decay=6 — TI's documented safe defaults.
 */
export interface DuoWlV4DrcValue {
  enableL: boolean
  enableR: boolean
  /** -3..-24 dBFS, snapped to the nearest 3dB step by firmware. */
  thresholdDb: number
  /** 0..3 dB, direct (Reg0x44 D1:0). */
  hysteresisDb: number
  /** 0..15 RAW register code (0 = disabled). See aic3204-full-dsp-registers.md
   *  §2 — the bit-field table, NOT SLAA557's prose (which disagrees 10x). */
  hold: number
  /** 0..15 raw register code — 4.0/2^code dB per DAC word clock. */
  attack: number
  /** 0..15 raw register code — 1.5625e-2/2^code dB per DAC word clock. */
  decay: number
}

const DEFAULT_DRC: DuoWlV4DrcValue = {
  enableL: false,
  enableR: false,
  thresholdDb: -24,
  hysteresisDb: 3,
  hold: 0,
  attack: 11,
  decay: 6,
}

/**
 * AGC (line-in / HP-codec ADC path) draft — aic3204-full-dsp-registers.md §5
 * / set_agc. Global (no `codec` field on the wire command — this hardware
 * only ever enables the HP codec's ADC). Defaults match firmware's
 * `DuoV4AgcConfig` initializer (`s_agc` in duowl_v4_audio.cpp) exactly.
 */
export interface DuoWlV4AgcValue {
  enable: boolean
  /** Snapped to the nearest of 8 discrete levels: -5.5,-8,-10,-12,-14,-17,-20,-24. */
  targetLevelDb: number
  /** 0..58 dB, 0.5dB steps. */
  maxGainDb: number
  /** 0..255 RAW register byte (5-bit index | 3-bit scale packed — no
   *  confirmed dB/ms decode, Studio supplies the byte directly). */
  attack: number
  decay: number
  /** 0 (disabled) or -30..-90, 2dB steps. */
  noiseThresholdDb: number
  /** 0 (disabled) / ~1.0 / ~2.0 / ~4.0 dB (nearest of 4 register options). */
  hysteresisDb: number
}

const DEFAULT_AGC: DuoWlV4AgcValue = {
  enable: false,
  targetLevelDb: -12,
  maxGainDb: 32,
  attack: 0,
  decay: 0,
  noiseThresholdDb: 0,
  hysteresisDb: 0,
}

/** Beep (one-shot test tone) draft for ONE codec — aic3204-full-dsp-
 *  registers.md §3 / set_beep. NOT device-backed (the part has no beep
 *  config readback — it's fire-and-forget) — stored here only so the
 *  freq/volume/length knobs survive switching away from the DSP sub-tab.
 *  Defaults mirror the set_beep wire example in serial_config.cpp. */
export interface DuoWlV4BeepValue {
  freqHz: number
  /** 0..-63 dB. */
  volumeDb: number
  lengthMs: number
}

const DEFAULT_BEEP: DuoWlV4BeepValue = { freqHz: 1000, volumeDb: -6, lengthMs: 200 }

interface FieldSlot<T> {
  value: T
  /** true = edited locally and not yet confirmed by a persist:true commit
   *  (git-diff-like "pending"). While true, an incoming device value for
   *  this field is NOT adopted (device-is-source-of-truth, but never
   *  clobbers an in-flight edit). */
  dirty: boolean
}

/** The numeric fields that share the generic get/set path. `avDelayMs` is
 *  read/written from a different sub-tab (DuoWlV4EspNowAudioSection) than
 *  the other 5 (DuoWlV4AudioSection). `effect3dHaptic`/`effect3dHp` are NOT
 *  in this union (unlike an earlier revision) — they need their own
 *  `effect3dLoaded` write-gate tracking (see doc below), same reason IIR/
 *  DRC/profile/AGC each got a dedicated setter instead of sharing this
 *  generic numeric path; see setEffect3d. */
export type DuoWlV4NumericField =
  | 'pamDb' | 'lineoutDb' | 'boostDb' | 'hpDb' | 'bufferMs' | 'avDelayMs'

export interface DuoWlV4Draft {
  pamDb: FieldSlot<number>
  lineoutDb: FieldSlot<number>
  boostDb: FieldSlot<number>
  hpDb: FieldSlot<number>
  bufferMs: FieldSlot<number>
  avDelayMs: FieldSlot<number>
  inputMode: FieldSlot<DuoWlV4InputMode>
  /** Local EQ design drafts (haptic 16kHz / hp 48kHz), up to 6 bands each
   *  (aic3204-full-dsp-registers.md §8.5 — was 3, now A..F). Empty until
   *  first touched — normalizeEqDrafts (NodeConfigSections.tsx) fills an
   *  empty/short array with the codec's defaults on every read, so an
   *  untouched device still displays/exports sensible values. */
  eqHaptic: DuoWlV4EqBandDraft[]
  eqHp: DuoWlV4EqBandDraft[]
  /**
   * True once the user has an EXPLICIT EQ design for this device — either by
   * editing a biquad band on the EQ tab (setEq) or importing a JSON that
   * carried an `eq` section (loadSnapshot `had.eq`). It is the write-gate
   * for the bulk "読み込んだ設定を書き込む" (DuoWlV4SettingsBackup.applyAll).
   *
   * The biquad bands' fc/Q/gain are NOT recoverable from the device (only
   * ftype + raw committed ints are), so an untouched draft is just the
   * module DEFAULTS (haptic band0 = 100Hz LPF, rest off) — writing those
   * over a device with a custom on-codec EQ would silently wipe it.
   *
   * IIR/DRC/profile/3D/AGC below get the IDENTICAL "*Loaded" write-gate
   * treatment, for a DIFFERENT but equally serious reason (finding, adversarial
   * review): even though those families round-trip losslessly through
   * get_info (unlike biquad EQ), their draft is only EVER reconciled with
   * the live device by the panel that owns them (DrcPanel/AgcPanel/
   * DspProfileSelector/IirEditor/Effect3dPanel) — and those panels live on
   * the `eq`/`dsp` sub-tabs, which React unmounts when not active. A user
   * who never visits those tabs this session has a draft still sitting at
   * the hardcoded module DEFAULT_DRC/DEFAULT_AGC/'standard'/unity-IIR/0.0 —
   * "round-trips losslessly IF READ" is not the same as "always safe to
   * blind-write", so each family needs its own explicit "has this device's
   * value for this family actually been loaded, ever, this session (by
   * either visiting its panel or importing a JSON that carried it)" gate,
   * exactly like eqLoaded — a global "always write" default was the bug. */
  eqLoaded: boolean
  /** 1st-order IIR draft (haptic 16kHz / hp 48kHz), raw Q1.23 [N0,N1,D1]
   *  ints (aic3204-full-dsp-registers.md §8.5). DEVICE-BACKED (unlike the
   *  biquad bands above) — get_info.eq_iir reports the exact same raw ints
   *  Studio would send, so this reconciles via useDeviceBackedValue just
   *  like DRC/3D/profile below. Rendered inside the EQ block UI (same
   *  apply-button flow as the biquad bands) purely for layout — the
   *  underlying store field is independent. No fc/Q abstraction is offered
   *  (raw register values only — no verified RBJ-style recipe for a
   *  1st-order shelf on this part). */
  iirHaptic: FieldSlot<[number, number, number]>
  iirHp: FieldSlot<[number, number, number]>
  /** Write-gate for iirHaptic/iirHp — see eqLoaded doc. True once the IIR
   *  panel has reconciled with a live device value (IirEditor mounted with
   *  a `deviceValue`) OR the user edited it OR an import carried `eq_iir`.
   *  NOTE: merely mounting IirEditor while offline/never-connected does NOT
   *  set this — only useDeviceBackedValue's setIir call (from either the
   *  adopt-from-device effect or a local edit) does, via setIir below. */
  iirLoaded: boolean
  /** DRC (compressor/limiter) draft, one per codec — DEVICE-BACKED (dirty +
   *  reconciled from get_info.drc, unlike EQ/IIR above), since the whole
   *  config round-trips through get_info exactly as sent. */
  drcHaptic: FieldSlot<DuoWlV4DrcValue>
  drcHp: FieldSlot<DuoWlV4DrcValue>
  /** Write-gate for drcHaptic/drcHp — see eqLoaded doc. */
  drcLoaded: boolean
  /** AGC draft — device-backed, global (no per-codec split; see DuoWlV4AgcValue). */
  agc: FieldSlot<DuoWlV4AgcValue>
  /** Write-gate for `agc` — see eqLoaded doc. */
  agcLoaded: boolean
  /** Beep (test tone) draft, one per codec — local-only, see DuoWlV4BeepValue. */
  beepHaptic: DuoWlV4BeepValue
  beepHp: DuoWlV4BeepValue
  /** DSP profile selection, one per codec — device-backed (dirty + reconciled
   *  from get_info.dsp_profile.<codec>.profile). */
  dspProfileHaptic: FieldSlot<DuoWlV4DspProfile>
  dspProfileHp: FieldSlot<DuoWlV4DspProfile>
  /** Write-gate for dspProfileHaptic/dspProfileHp — see eqLoaded doc. */
  profileLoaded: boolean
  /** 3D effect depth, one per codec, 0.0..1.0 — device-backed via the
   *  dedicated setEffect3d/useDuoEffect3dField path (NOT the generic numeric
   *  path — needs its own write-gate, see DuoWlV4NumericField doc). */
  effect3dHaptic: FieldSlot<number>
  effect3dHp: FieldSlot<number>
  /** Write-gate for effect3dHaptic/effect3dHp — see eqLoaded doc. */
  effect3dLoaded: boolean
}

const DEFAULT_DRAFT: DuoWlV4Draft = {
  pamDb: { value: 24, dirty: false },
  lineoutDb: { value: 6, dirty: false },
  boostDb: { value: 0, dirty: false },
  hpDb: { value: -10, dirty: false },
  bufferMs: { value: 0, dirty: false },
  avDelayMs: { value: 0, dirty: false },
  inputMode: { value: 'output', dirty: false },
  eqHaptic: [],
  eqHp: [],
  eqLoaded: false,
  // Firmware default (duowl_v4_audio.cpp `s_iir_haptic`/`s_iir_hp`):
  // {0x7FFFFF, 0, 0} = AIC3204_COEFF_MAX_INT (unity-gain passthrough), 0, 0.
  iirHaptic: { value: [8388607, 0, 0], dirty: false },
  iirHp: { value: [8388607, 0, 0], dirty: false },
  iirLoaded: false,
  drcHaptic: { value: DEFAULT_DRC, dirty: false },
  drcHp: { value: DEFAULT_DRC, dirty: false },
  drcLoaded: false,
  agc: { value: DEFAULT_AGC, dirty: false },
  agcLoaded: false,
  beepHaptic: DEFAULT_BEEP,
  beepHp: DEFAULT_BEEP,
  dspProfileHaptic: { value: 'standard', dirty: false },
  dspProfileHp: { value: 'standard', dirty: false },
  profileLoaded: false,
  effect3dHaptic: { value: 0, dirty: false },
  effect3dHp: { value: 0, dirty: false },
  effect3dLoaded: false,
}

/** Snapshot shape for JSON export/import (DuoWlV4SettingsBackup). Mirrors
 *  the wire field names (pam_db, not pamDb) so the JSON file is legible
 *  next to get_info / the set_* commands, unlike the store's camelCase. */
export interface DuoWlV4AudioSnapshot {
  version: 1
  pam_db: number
  lineout_db: number
  boost_db: number
  hp_db: number
  input_mode: DuoWlV4InputMode
  stream_buffer_ms: number
  av_delay_ms: number
  eq: {
    haptic: DuoWlV4EqBandDraft[]
    hp: DuoWlV4EqBandDraft[]
  }
  /** 1st-order IIR, raw [N0,N1,D1] ints — device-backed/round-trippable
   *  (unlike `eq` above), so always exported/imported like the audio fields. */
  eq_iir: {
    haptic: [number, number, number]
    hp: [number, number, number]
  }
  dsp_profile: {
    haptic: DuoWlV4DspProfile
    hp: DuoWlV4DspProfile
  }
  drc: {
    haptic: DuoWlV4DrcValue
    hp: DuoWlV4DrcValue
  }
  effect_3d: {
    haptic: number
    hp: number
  }
  /** Global (no per-codec split — see DuoWlV4AgcValue). */
  agc: DuoWlV4AgcValue
}

interface DuoWlV4AudioStoreState {
  drafts: Record<string, DuoWlV4Draft>
  /** Current draft for `ip`, or the module default if never touched. */
  draftFor: (ip: string) => DuoWlV4Draft
  setNumeric: (ip: string, field: DuoWlV4NumericField, value: number, dirty: boolean) => void
  setInputMode: (ip: string, value: DuoWlV4InputMode, dirty: boolean) => void
  /** Set one codec's EQ bands. Marks `eqLoaded` true — the user now has an
   *  explicit EQ design that the bulk-write is allowed to ship. */
  setEq: (ip: string, codec: 'haptic' | 'hp', bands: DuoWlV4EqBandDraft[]) => void
  /** Set one codec's 1st-order IIR raw coeffs (device-backed). Marks
   *  `iirLoaded` true — see DuoWlV4Draft.iirLoaded doc. */
  setIir: (ip: string, codec: 'haptic' | 'hp', coeffs: [number, number, number], dirty: boolean) => void
  /** Set one codec's DRC config (device-backed, whole-object commit). Marks
   *  `drcLoaded` true — see DuoWlV4Draft.drcLoaded doc. */
  setDrc: (ip: string, codec: 'haptic' | 'hp', value: DuoWlV4DrcValue, dirty: boolean) => void
  /** Set the (global) AGC config (device-backed, whole-object commit). Marks
   *  `agcLoaded` true — see DuoWlV4Draft.agcLoaded doc. */
  setAgc: (ip: string, value: DuoWlV4AgcValue, dirty: boolean) => void
  /** Set one codec's Beep test-tone knobs. Local-only (no device echo/dirty —
   *  see DuoWlV4Draft.beepHaptic doc). */
  setBeep: (ip: string, codec: 'haptic' | 'hp', value: DuoWlV4BeepValue) => void
  /** Set one codec's DSP profile selection (device-backed). Marks
   *  `profileLoaded` true — see DuoWlV4Draft.profileLoaded doc. */
  setDspProfile: (ip: string, codec: 'haptic' | 'hp', value: DuoWlV4DspProfile, dirty: boolean) => void
  /** Set one codec's 3D effect depth (device-backed). Marks `effect3dLoaded`
   *  true — see DuoWlV4Draft.effect3dLoaded doc. Dedicated setter (not the
   *  generic setNumeric path) specifically so it can flip this flag. */
  setEffect3d: (ip: string, codec: 'haptic' | 'hp', value: number, dirty: boolean) => void
  /** Mark every device-backed field clean at its CURRENT draft value (used
   *  after "読み込んだ設定を書き込む" sends every setter persist:true). Does
   *  NOT touch eqHaptic/eqHp/eqLoaded (not FieldSlot-dirty-tracked — see
   *  applyAll's separate eqLoaded gate), the other `*Loaded` flags (append-
   *  only "ever reconciled/edited" markers, not a dirty concept — they are
   *  never reset), or beepHaptic/beepHp (not device-backed at all). */
  markAllClean: (ip: string) => void
  /**
   * Bulk-load an imported JSON snapshot into the draft. Every numeric/
   * input-mode field is marked dirty (not yet on the device) — import never
   * auto-writes; the user reviews and presses 適用/書き込む.
   *
   * `had.<family>` = the imported JSON EXPLICITLY carried that family's
   * section. When false, that family's draft + its `*Loaded` flag are LEFT
   * COMPLETELY UNTOUCHED — importing a file that doesn't mention a family
   * must never silently replace an existing design for it (or, on a fresh
   * draft, seed it with module DEFAULTS that the bulk-write would then push
   * over the device's real state). When true, the snapshot's value for that
   * family is adopted and its `*Loaded` flag set so the bulk-write may ship
   * it. `had.eq` is the pre-existing biquad-band gate (unchanged); `had.iir`/
   * `had.drc`/`had.profile`/`had.effect3d`/`had.agc` are the SAME discipline
   * extended to the full-DSP families (adversarial review finding: those
   * round-trip losslessly through get_info IF READ, but an import can still
   * carry stale/absent data the same way a gain-only file can for EQ).
   */
  loadSnapshot: (
    ip: string,
    snapshot: DuoWlV4AudioSnapshot,
    had: { eq: boolean; iir: boolean; drc: boolean; profile: boolean; effect3d: boolean; agc: boolean },
  ) => void
}

export const useDuoWlV4AudioStore = create<DuoWlV4AudioStoreState>((set, get) => ({
  drafts: {},

  draftFor: (ip) => get().drafts[ip] ?? DEFAULT_DRAFT,

  setNumeric: (ip, field, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: { ...(s.drafts[ip] ?? DEFAULT_DRAFT), [field]: { value, dirty } },
      },
    })),

  setInputMode: (ip, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: { ...(s.drafts[ip] ?? DEFAULT_DRAFT), inputMode: { value, dirty } },
      },
    })),

  setEq: (ip, codec, bands) =>
    set((s) => {
      const cur = s.drafts[ip] ?? DEFAULT_DRAFT
      return {
        drafts: {
          ...s.drafts,
          [ip]: {
            ...cur,
            ...(codec === 'haptic' ? { eqHaptic: bands } : { eqHp: bands }),
            // Editing a band = the user now has an explicit EQ design.
            eqLoaded: true,
          },
        },
      }
    }),

  // iirLoaded/drcLoaded/agcLoaded are set true UNCONDITIONALLY on every call
  // — both the "user edited it" path AND the "useDeviceBackedValue's adopt-
  // from-device effect reconciled it" path go through this same setter, and
  // BOTH mean the draft is now trustworthy (see DuoWlV4Draft.iirLoaded doc).
  setIir: (ip, codec, coeffs, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: {
          ...(s.drafts[ip] ?? DEFAULT_DRAFT),
          ...(codec === 'haptic' ? { iirHaptic: { value: coeffs, dirty } } : { iirHp: { value: coeffs, dirty } }),
          iirLoaded: true,
        },
      },
    })),

  setDrc: (ip, codec, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: {
          ...(s.drafts[ip] ?? DEFAULT_DRAFT),
          ...(codec === 'haptic' ? { drcHaptic: { value, dirty } } : { drcHp: { value, dirty } }),
          drcLoaded: true,
        },
      },
    })),

  setAgc: (ip, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: { ...(s.drafts[ip] ?? DEFAULT_DRAFT), agc: { value, dirty }, agcLoaded: true },
      },
    })),

  setBeep: (ip, codec, value) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: {
          ...(s.drafts[ip] ?? DEFAULT_DRAFT),
          ...(codec === 'haptic' ? { beepHaptic: value } : { beepHp: value }),
        },
      },
    })),

  setDspProfile: (ip, codec, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: {
          ...(s.drafts[ip] ?? DEFAULT_DRAFT),
          ...(codec === 'haptic' ? { dspProfileHaptic: { value, dirty } } : { dspProfileHp: { value, dirty } }),
          profileLoaded: true,
        },
      },
    })),

  setEffect3d: (ip, codec, value, dirty) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [ip]: {
          ...(s.drafts[ip] ?? DEFAULT_DRAFT),
          ...(codec === 'haptic' ? { effect3dHaptic: { value, dirty } } : { effect3dHp: { value, dirty } }),
          effect3dLoaded: true,
        },
      },
    })),

  markAllClean: (ip) =>
    set((s) => {
      const cur = s.drafts[ip]
      if (!cur) return {}
      return {
        drafts: {
          ...s.drafts,
          [ip]: {
            ...cur,
            pamDb: { ...cur.pamDb, dirty: false },
            lineoutDb: { ...cur.lineoutDb, dirty: false },
            boostDb: { ...cur.boostDb, dirty: false },
            hpDb: { ...cur.hpDb, dirty: false },
            bufferMs: { ...cur.bufferMs, dirty: false },
            avDelayMs: { ...cur.avDelayMs, dirty: false },
            inputMode: { ...cur.inputMode, dirty: false },
            iirHaptic: { ...cur.iirHaptic, dirty: false },
            iirHp: { ...cur.iirHp, dirty: false },
            drcHaptic: { ...cur.drcHaptic, dirty: false },
            drcHp: { ...cur.drcHp, dirty: false },
            agc: { ...cur.agc, dirty: false },
            dspProfileHaptic: { ...cur.dspProfileHaptic, dirty: false },
            dspProfileHp: { ...cur.dspProfileHp, dirty: false },
            effect3dHaptic: { ...cur.effect3dHaptic, dirty: false },
            effect3dHp: { ...cur.effect3dHp, dirty: false },
          },
        },
      }
    }),

  loadSnapshot: (ip, snap, had) =>
    set((s) => {
      const cur = s.drafts[ip] ?? DEFAULT_DRAFT
      return {
        drafts: {
          ...s.drafts,
          [ip]: {
            pamDb: { value: snap.pam_db, dirty: true },
            lineoutDb: { value: snap.lineout_db, dirty: true },
            boostDb: { value: snap.boost_db, dirty: true },
            hpDb: { value: snap.hp_db, dirty: true },
            bufferMs: { value: snap.stream_buffer_ms, dirty: true },
            avDelayMs: { value: snap.av_delay_ms, dirty: true },
            inputMode: { value: snap.input_mode, dirty: true },
            // Every family below (biquad EQ, and — adversarial review finding
            // — IIR/DRC/profile/3D/AGC too) is adopted ONLY when the file
            // EXPLICITLY carried it (`had.<family>`); otherwise the existing
            // draft value AND its `*Loaded` flag are left completely
            // untouched. A file that doesn't mention a family must never
            // silently seed it with the fallback default AND mark it dirty —
            // that combination is exactly what made applyAll ship module
            // defaults over a live device's real DRC/AGC/profile/3D state
            // when the import (or a same-session direct write) didn't
            // actually carry/reconcile that family. See DuoWlV4Draft's
            // eqLoaded/iirLoaded/drcLoaded/profileLoaded/effect3dLoaded/
            // agcLoaded docs.
            eqHaptic: had.eq ? snap.eq.haptic : cur.eqHaptic,
            eqHp: had.eq ? snap.eq.hp : cur.eqHp,
            eqLoaded: had.eq ? true : cur.eqLoaded,
            iirHaptic: had.iir ? { value: snap.eq_iir.haptic, dirty: true } : cur.iirHaptic,
            iirHp: had.iir ? { value: snap.eq_iir.hp, dirty: true } : cur.iirHp,
            iirLoaded: had.iir ? true : cur.iirLoaded,
            drcHaptic: had.drc ? { value: snap.drc.haptic, dirty: true } : cur.drcHaptic,
            drcHp: had.drc ? { value: snap.drc.hp, dirty: true } : cur.drcHp,
            drcLoaded: had.drc ? true : cur.drcLoaded,
            agc: had.agc ? { value: snap.agc, dirty: true } : cur.agc,
            agcLoaded: had.agc ? true : cur.agcLoaded,
            dspProfileHaptic: had.profile ? { value: snap.dsp_profile.haptic, dirty: true } : cur.dspProfileHaptic,
            dspProfileHp: had.profile ? { value: snap.dsp_profile.hp, dirty: true } : cur.dspProfileHp,
            profileLoaded: had.profile ? true : cur.profileLoaded,
            effect3dHaptic: had.effect3d ? { value: snap.effect_3d.haptic, dirty: true } : cur.effect3dHaptic,
            effect3dHp: had.effect3d ? { value: snap.effect_3d.hp, dirty: true } : cur.effect3dHp,
            effect3dLoaded: had.effect3d ? true : cur.effect3dLoaded,
            // Beep isn't a persisted setting (fire-and-forget) — never
            // imported, keep whatever local knobs the user had.
            beepHaptic: cur.beepHaptic,
            beepHp: cur.beepHp,
          },
        },
      }
    }),
}))
