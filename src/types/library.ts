/**
 * Library clip: a saved audio clip with metadata.
 * Audio data (WAV blob) is stored separately in IndexedDB.
 */
export interface LibraryClip {
  id: string
  /** Display name (used as the bare event-id name part inside a kit) */
  name: string
  /** User-assigned tags for filtering */
  tags: string[]
  /** Group/folder name for organization */
  group: string
  /** Duration in seconds */
  duration: number
  /** Number of channels */
  channels: number
  /** Sample rate of the stored WAV */
  sampleRate: number
  /** File size in bytes */
  fileSize: number
  /** Original source filename */
  sourceFilename: string
  /** Created timestamp (ISO 8601) */
  createdAt: string
  /** Last modified timestamp (ISO 8601) */
  updatedAt: string
  /** Set when this clip was imported from built-in library */
  builtinId?: string
  /** Library 側のプレビュー amp (0-1)。Kit 追加時のデフォルト値にもなる。 */
  libraryIntensity?: number
  /**
   * Optional free-form annotation by the user. Surfaced as a tooltip on
   * the clip name in cards and as a multi-line note field in
   * ClipEditModal. Persisted in clipsMeta.json.
   */
  note?: string
}

/** Library amp preset - clipId → intensity のマップ */
export interface ClipAmpPreset {
  name: string
  /** 保存した日時 (ISO 8601) */
  createdAt: string
  /** clipId → intensity (0.0–1.0) */
  values: Record<string, number>
}

/**
 * Metadata for a built-in library clip (loaded from static index.json).
 * Audio data is fetched on-demand from the server.
 */
export interface BuiltinClipMeta {
  /** Stable ID, e.g. "builtin/impact.hit-soft" */
  id: string
  /** Display name, e.g. "Hit Soft" */
  name: string
  /** Category (directory name), e.g. "impact" */
  category: string
  /** Tags for filtering */
  tags: string[]
  /** Default Event ID, e.g. "impact.hit-soft" */
  event_id: string
  /** Description */
  description: string
  /** Relative path from clips/, e.g. "impact/hit-soft.wav" */
  filename: string
  /** Duration in milliseconds */
  duration_ms: number
  /** Sample rate in Hz */
  sample_rate: number
  /** Number of channels */
  channels: number
  /** File size in bytes */
  filesize_bytes: number
}

/**
 * Built-in library index loaded from /library/index.json
 */
export interface BuiltinLibraryIndex {
  schema_version: string
  generated_at: string
  clips: BuiltinClipMeta[]
}

/**
 * Kit definition: a collection of event-clip mappings ready for device deployment.
 */
/**
 * Kit author tuning context — written into manifest.target_device.
 * Every field is optional; the kit can deploy without this metadata
 * but losing it means players can't reproduce the author's setup.
 */
export interface KitTargetDevice {
  /** firmware semver lower bound (default "0.1.0" if absent) */
  firmware_version_min?: string
  /** firmware semver upper bound (optional) */
  firmware_version_max?: string
  /** Board identifier the author tuned on (e.g. "duo_wl_v3") */
  board?: string
  /** Author's device volume level when tuning */
  volume_level?: number
  /** Author's MCP4018 wiper value (0-127) */
  volume_wiper?: number
  /** Author device's volume step count */
  volume_steps?: number
}

/**
 * Kit definition: a collection of event-clip mappings ready for device deployment.
 */
export interface KitDefinition {
  id: string
  /** Kit display name */
  name: string
  /** Kit version (semver) */
  version: string
  /** Description */
  description: string
  /** Event ID -> clip ID mapping */
  events: KitEvent[]
  /** Created timestamp */
  createdAt: string
  /** Last modified timestamp */
  updatedAt: string
  /**
   * Author-tuning context — copied into manifest.target_device on
   * export. Optional; older kits won't have it.
   */
  targetDevice?: KitTargetDevice
}

/**
 * Playback mode for a Kit event (hapbeat-contracts DEC-023).
 *
 * - command: Device plays the WAV clip from flash (legacy mode, default)
 * - stream_clip: SDK streams the WAV over UDP; device only receives the PCM stream
 * - stream_source: SDK captures a live AudioSource and streams it; no clip needed
 */
export type KitEventMode = 'command' | 'stream_clip' | 'stream_source'

/**
 * Suffix appended to `eventId` in the on-disk manifest when a single Studio
 * KitEvent emits more than one mode entry. Studio keeps the user-authored
 * eventId pristine in-memory; the suffix only appears in manifest output and
 * in re-import grouping. JSON object keys must be unique, so the suffix is
 * what lets `mykit.foo` exist as both FIRE and CLIP entries side-by-side.
 *
 * `stream_source` is hidden from the UI but still maps to a suffix for the
 * sake of any legacy kit that round-trips through Studio.
 */
export const KIT_EVENT_MODE_SUFFIX: Record<KitEventMode, string> = {
  command: 'fire',
  stream_clip: 'clip',
  stream_source: 'source',
}

export interface KitEvent {
  /** Stable per-kit id, generated on add. Used as the React key, the handle
   *  for update/remove, AND the IDB key for this event's owned audio blob
   *  (`STORE_AUDIO[event.id]`). NOT the same as eventId, which can repeat
   *  across events within a kit (e.g. same clip added with different amps). */
  id: string
  /**
   * Event ID (hapbeat-contracts format). May repeat within a kit. This is
   * the *base* eventId — when `modes.length > 1` the kit exporter appends a
   * `.fire` / `.clip` suffix per emitted manifest entry so JSON keys stay
   * unique. The base value here never carries the suffix.
   */
  eventId: string
  /**
   * Display name of this kit event's clip. **Owned by the kit event** —
   * copied from the source LibraryClip at add-time and never updated when
   * the library renames the original. Kit-side renames mutate this field
   * directly. Used for the card title and for composing `eventId`
   * (`<kitName>.<clipName>`).
   */
  clipName: string
  /**
   * Original filename of the WAV the user dropped on the kit (e.g.
   * `impact/gunshot_01.wav`). Used as the on-disk filename inside
   * `install-clips/` / `stream-clips/` when exporting. Owned by the kit
   * event; library renames don't propagate.
   */
  clipSourceFilename: string
  /** Clip duration in seconds. Snapshot at add-time; not refreshed. */
  clipDuration: number
  /** Clip channel count (1 or 2). Snapshot at add-time. */
  clipChannels: number
  /** Clip sample rate (Hz) of the SOURCE audio. The exporter resamples
   *  to 16 kHz for device playback, but we keep the original so the
   *  card can show meaningful metadata. */
  clipSampleRate: number
  /** Clip file size in bytes of the source blob (pre-resample). */
  clipFileSize: number
  /**
   * Selected playback modes. Length ≥ 1 (UI enforces). When length === 1 the
   * kit exporter emits a single manifest entry under `eventId`. When length
   * > 1 it emits one entry per mode with `<eventId>.<mode-suffix>` as the
   * JSON key (see `KIT_EVENT_MODE_SUFFIX`).
   *
   * intensity / loop / deviceWiper are shared across modes.
   */
  modes: KitEventMode[]
  /** Loop playback */
  loop: boolean
  /**
   * Intensity: the author's intended base strength (0.0–1.0).
   * SDK gain=1.0 plays at this intensity. gain=1.5 plays 50% stronger.
   * Default: 1.0 (WAV at full amplitude).
   */
  intensity: number
  /**
   * MCP4018 wiper value (0–127) of the Hapbeat device when this event was tuned.
   * Allows exact reproduction of the author's experience.
   * null if not captured.
   */
  deviceWiper: number | null
  /**
   * Author-only free-form note shown on hover (card tooltip). Mirrors
   * `LibraryClip.note`, but kit-side notes are independent of the
   * source library clip — they describe the event's role inside *this*
   * kit (e.g. "softer pre-roll for the chorus"). Optional.
   */
  note?: string
}

/** Library view layout mode */
/**
 * Kit Manager layout:
 * - 'side'    : clips on the left, kit editor on the right (default)
 * - 'stacked' : clips on the top, kit editor full width at the bottom
 *
 * Built-in and user clips are no longer split into separate panels — they
 * live in the same unified list and the user can freely edit any of them.
 */
export type LibraryViewMode = 'side' | 'stacked'

/** Filter/sort options for library view */
export interface LibraryFilter {
  searchQuery: string
  selectedTags: string[]
  selectedGroup: string | null
  sortBy: 'name' | 'date' | 'duration'
  sortOrder: 'asc' | 'desc'
}
