import { openDB, type IDBPDatabase } from 'idb'
import type { LibraryClip, KitDefinition } from '@/types/library'

const DB_NAME = 'hapbeat-studio-library'
const DB_VERSION = 2
const STORE_CLIPS = 'clips'
const STORE_AUDIO = 'audio'
const STORE_KITS = 'kits'
/**
 * Cache of WAV blobs that kitExporter has already re-encoded for the
 * device (16 kHz PCM16, mono for install-clips / stereo for stream-clips).
 * Keyed by `${eventId}|${mode}` — one entry per (event, mode) pair. The
 * stored `sourceHash` is compared against the current source-blob hash
 * to invalidate the cache when the underlying audio changes. Lets
 * "Save Folder" skip decode+encode for events whose audio hasn't moved
 * since the last save (the common case when the user only adjusted
 * intensity / amp / device_wiper).
 */
const STORE_ENCODED = 'encoded-wavs'

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains(STORE_CLIPS)) {
        db.createObjectStore(STORE_CLIPS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        // Audio blobs stored separately (key = clip id)
        db.createObjectStore(STORE_AUDIO)
      }
      if (!db.objectStoreNames.contains(STORE_KITS)) {
        db.createObjectStore(STORE_KITS, { keyPath: 'id' })
      }
      // v2: encoded-WAV cache (decode+encode skip on unchanged audio)
      if (oldVersion < 2 && !db.objectStoreNames.contains(STORE_ENCODED)) {
        db.createObjectStore(STORE_ENCODED)
      }
    },
  })
}

// ---- Clips ----

export async function saveClip(clip: LibraryClip, audioBlob: Blob): Promise<void> {
  const db = await getDb()
  const tx = db.transaction([STORE_CLIPS, STORE_AUDIO], 'readwrite')
  await tx.objectStore(STORE_CLIPS).put(clip)
  await tx.objectStore(STORE_AUDIO).put(audioBlob, clip.id)
  await tx.done
}

export async function loadClip(id: string): Promise<LibraryClip | undefined> {
  const db = await getDb()
  return db.get(STORE_CLIPS, id)
}

export async function loadClipAudio(id: string): Promise<Blob | undefined> {
  const db = await getDb()
  return db.get(STORE_AUDIO, id)
}

export async function listClips(): Promise<LibraryClip[]> {
  const db = await getDb()
  return db.getAll(STORE_CLIPS)
}

export async function deleteClip(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction([STORE_CLIPS, STORE_AUDIO], 'readwrite')
  await tx.objectStore(STORE_CLIPS).delete(id)
  await tx.objectStore(STORE_AUDIO).delete(id)
  await tx.done
}

/**
 * One-time migration helper: clears all persisted clip metadata and audio
 * blobs from IndexedDB.  Called on startup after disk-as-truth migration
 * (2026-06-21) to remove stale IDB rows that could otherwise seed a new
 * work folder with the user's old clip library.
 *
 * IDB is now a runtime cache only — no clip data survives a page reload.
 * Disk (work folder) is the single source of truth.
 */
export async function clearLegacyClipStores(): Promise<void> {
  try {
    const db = await getDb()
    const tx = db.transaction([STORE_CLIPS, STORE_AUDIO], 'readwrite')
    await tx.objectStore(STORE_CLIPS).clear()
    await tx.objectStore(STORE_AUDIO).clear()
    await tx.done
  } catch (err) {
    // Non-fatal: log and continue; stale IDB data will simply accumulate
    // but can no longer cause phantom-clip leaks (we no longer read it).
    console.warn('[clearLegacyClipStores] IDB purge failed (ignored):', err)
  }
}

export async function updateClipMeta(id: string, updates: Partial<LibraryClip>): Promise<void> {
  const db = await getDb()
  const clip = await db.get(STORE_CLIPS, id)
  if (!clip) return
  const updated = { ...clip, ...updates, updatedAt: new Date().toISOString() }
  await db.put(STORE_CLIPS, updated)
}

// ---- Kit-event audio ----
// Kit events own their audio independently of the library (the
// `clipId → library` dependency was removed so library archive
// doesn't break kit events). The blob lives in the same STORE_AUDIO
// table but is keyed by `event.id` rather than `clip.id`. IDs are
// globally unique strings (`generateId()`) so the two namespaces
// share the store without collision.

export async function saveKitEventAudio(eventId: string, audioBlob: Blob): Promise<void> {
  const db = await getDb()
  await db.put(STORE_AUDIO, audioBlob, eventId)
}

export async function loadKitEventAudio(eventId: string): Promise<Blob | undefined> {
  const db = await getDb()
  return db.get(STORE_AUDIO, eventId)
}

export async function deleteKitEventAudio(eventId: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_AUDIO, eventId)
}

// ---- Encoded-WAV cache ----
//
// Stores the *device-format* WAV blob (16 kHz PCM16) that kitExporter
// produced for a given (event, mode) pair, so the next Save Folder /
// Deploy can reuse it instead of decoding + re-encoding the source.
//
// Cache key: `${eventId}|${mode}`. One entry per (event, mode) — when
// the source audio changes, sourceHash mismatches and the entry is
// rewritten in place (no orphan entries to clean up later).
//
// Mode is the EncodedMode below; ev.id + mode together uniquely
// identify what kitExporter would output, because BOTH-mode events
// produce two different encoded blobs (mono command + stereo stream).

export type EncodedMode = 'command' | 'stream_clip'

export interface EncodedWavEntry {
  /** SHA-1 hex of the source audio blob this entry was built from.
   *  Mismatch invalidates the cache (caller decodes + re-encodes). */
  sourceHash: string
  /** Device-ready WAV blob: 16 kHz PCM16, mono (command) or stereo
   *  (stream_clip). Ready to drop straight into install-clips/ or
   *  stream-clips/. */
  encodedBlob: Blob
  /** SHA-1 hex of `encodedBlob` bytes — the hash the on-disk file
   *  *would have* after writing this blob. Stored here so the disk
   *  skip-write decision (in flushKitFolderNow) can read it without
   *  re-hashing on cache hit. Older entries (pre-2026-05-26) may not
   *  have this field; the loader fills it in lazily on next hit. */
  outputHash?: string
  /** Output sample rate of `encodedBlob`. Always 16 kHz today but kept
   *  in the entry so install_clips metadata can be reconstructed
   *  without decoding the blob. */
  sampleRate: number
  /** Output channel count: 1 for command (source ch preserved → mono
   *  here because the device only stores mono), 2 for stream_clip. */
  channels: number
  /** Source audio duration in seconds (decoded.duration). Used to fill
   *  `install_clips[].duration_ms` from cache without re-decoding. */
  duration: number
}

function encodedCacheKey(eventId: string, mode: EncodedMode): string {
  return `${eventId}|${mode}`
}

/** Hex-encoded SHA-1 of the blob's bytes. Used as the invalidation
 *  marker for the encoded-WAV cache. SHA-1 is fine here — this is a
 *  cache-key, not a security primitive. */
export async function sha1Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-1', buf)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export async function loadEncodedWav(
  eventId: string,
  mode: EncodedMode,
  expectedSourceHash: string,
): Promise<EncodedWavEntry | null> {
  const db = await getDb()
  const entry = await db.get(STORE_ENCODED, encodedCacheKey(eventId, mode)) as
    | EncodedWavEntry
    | undefined
  if (!entry) return null
  // Invalidate when the source audio has moved underneath us (re-import,
  // replacement, etc). The caller falls back to decode+encode.
  if (entry.sourceHash !== expectedSourceHash) return null
  return entry
}

export async function saveEncodedWav(
  eventId: string,
  mode: EncodedMode,
  entry: EncodedWavEntry,
): Promise<void> {
  const db = await getDb()
  await db.put(STORE_ENCODED, entry, encodedCacheKey(eventId, mode))
}

/** Remove all cache entries for a given event (both modes). Called
 *  from removeEventFromKit / removeKit so stale entries don't leak. */
export async function deleteEncodedWavsForEvent(eventId: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(STORE_ENCODED, 'readwrite')
  await tx.objectStore(STORE_ENCODED).delete(encodedCacheKey(eventId, 'command'))
  await tx.objectStore(STORE_ENCODED).delete(encodedCacheKey(eventId, 'stream_clip'))
  await tx.done
}

// ---- Kits ----

export async function saveKit(kit: KitDefinition): Promise<void> {
  const db = await getDb()
  await db.put(STORE_KITS, kit)
}

export async function loadKit(id: string): Promise<KitDefinition | undefined> {
  const db = await getDb()
  return db.get(STORE_KITS, id)
}

export async function deleteKit(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_KITS, id)
}
