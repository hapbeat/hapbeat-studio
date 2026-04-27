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

export interface KitEvent {
  /** Stable per-kit id, generated on add. Used as the React key and as the
   *  handle for update/remove — NOT the same as eventId, which can repeat
   *  across events within a kit (e.g. same clip added with different amps). */
  id: string
  /** Event ID (hapbeat-contracts format). May repeat within a kit. */
  eventId: string
  /** Reference to LibraryClip.id */
  clipId: string
  /**
   * Playback mode. Defaults to "command" if absent (backward-compatible
   * with kits that predate the mode field).
   */
  mode?: KitEventMode
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
   * Kit-local clip name. When set, overrides the library clip's name
   * for this event's display, eventId composition, and on-disk
   * `install-clips/<localName>.wav` filename. Kit-side renames write
   * here so the library and any other kit referencing the same clip
   * are not affected.
   *
   * Audio data still comes from the library clip referenced by clipId
   * (kits don't currently own audio bytes).
   */
  localName?: string
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
