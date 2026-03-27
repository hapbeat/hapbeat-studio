import { openDB, type IDBPDatabase } from 'idb'
import type { HapbeatProject } from '@/types/project'

const DB_NAME = 'hapbeat-studio'
const DB_VERSION = 1
const STORE_PROJECTS = 'projects'

interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
      }
    },
  })
}

/**
 * プロジェクトを IndexedDB に保存する
 */
export async function saveProject(project: HapbeatProject): Promise<void> {
  const db = await getDb()
  await db.put(STORE_PROJECTS, project)
}

/**
 * プロジェクトを IndexedDB から読み込む
 */
export async function loadProject(id: string): Promise<HapbeatProject | undefined> {
  const db = await getDb()
  return db.get(STORE_PROJECTS, id)
}

/**
 * 保存されているプロジェクトの一覧を取得する
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDb()
  const allProjects: HapbeatProject[] = await db.getAll(STORE_PROJECTS)
  return allProjects
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * プロジェクトを IndexedDB から削除する
 */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(STORE_PROJECTS, id)
}

/**
 * プロジェクトを JSON ファイルとしてダウンロードする
 */
export function exportProject(project: HapbeatProject): void {
  const json = JSON.stringify(project, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitizeFilename(project.name)}.hapbeat-project.json`
  document.body.appendChild(a)
  a.click()

  // クリーンアップ
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

/**
 * JSON ファイルからプロジェクトをインポートする
 */
export async function importProject(file: File): Promise<HapbeatProject> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      try {
        const text = reader.result as string
        const project = JSON.parse(text) as HapbeatProject

        // 基本的なバリデーション
        if (!project.id || !project.name || !project.displayLayout) {
          reject(new Error('無効なプロジェクトファイルです。必須フィールドが不足しています。'))
          return
        }

        resolve(project)
      } catch (err) {
        reject(new Error(`プロジェクトファイルの解析に失敗しました: ${err}`))
      }
    }

    reader.onerror = () => {
      reject(new Error('ファイルの読み込みに失敗しました。'))
    }

    reader.readAsText(file)
  })
}

/**
 * ファイル名として安全な文字列に変換する
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100)
}
