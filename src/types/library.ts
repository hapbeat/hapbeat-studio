/**
 * Library clip: a saved audio clip with metadata.
 * Audio data (WAV blob) is stored separately in IndexedDB.
 */
export interface LibraryClip {
  id: string
  /** Display name */
  name: string
  /** User-assigned tags for filtering */
  tags: string[]
  /** Group/folder name for organization */
  group: string
  /** Assigned Event ID (hapbeat-contracts format, e.g. "impact.hit") */
  eventId: string
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
}

export interface KitEvent {
  /** Event ID (hapbeat-contracts format) */
  eventId: string
  /** Reference to LibraryClip.id */
  clipId: string
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
}

/** Library view layout mode */
export type LibraryViewMode = 'tabs' | 'split-h' | 'split-v' | 'unified'

/** Filter/sort options for library view */
export interface LibraryFilter {
  searchQuery: string
  selectedTags: string[]
  selectedGroup: string | null
  sortBy: 'name' | 'date' | 'duration'
  sortOrder: 'asc' | 'desc'
}
