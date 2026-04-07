import { openDB, type IDBPDatabase } from 'idb'
import type { LibraryClip, KitDefinition } from '@/types/library'

const DB_NAME = 'hapbeat-studio-library'
const DB_VERSION = 1
const STORE_CLIPS = 'clips'
const STORE_AUDIO = 'audio'
const STORE_KITS = 'kits'

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
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

export async function updateClipMeta(id: string, updates: Partial<LibraryClip>): Promise<void> {
  const db = await getDb()
  const clip = await db.get(STORE_CLIPS, id)
  if (!clip) return
  const updated = { ...clip, ...updates, updatedAt: new Date().toISOString() }
  await db.put(STORE_CLIPS, updated)
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

export async function listKits(): Promise<KitDefinition[]> {
  const db = await getDb()
  return db.getAll(STORE_KITS)
}

export async function deleteKit(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_KITS, id)
}
