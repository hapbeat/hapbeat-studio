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
  /** Playback gain 0.0-1.0 */
  gain: number
  /** Loop playback */
  loop: boolean
}

/** Filter/sort options for library view */
export interface LibraryFilter {
  searchQuery: string
  selectedTags: string[]
  selectedGroup: string | null
  sortBy: 'name' | 'date' | 'duration'
  sortOrder: 'asc' | 'desc'
}
