/** Test-only fixtures for the Scene tab: a project lib / recording / cue table and an in-memory folder. */
import type { SceneData, SceneLib } from './sceneData'
import type { CueTable } from './sceneCueTable'

export function sampleLib(): SceneLib {
  return {
    title: 'Mill', project_name: 'mill',
    paths: { cues: 'Content/Hapbeat/cues.json', clips: 'Content/Kit/stream-clips', sounds: 'Content/Audio' },
    at: ['hand', 'both', 'pos_neck', 'pos_chest', 'pos_l_wrist', 'pos_r_wrist'],
    loop_at: ['hand', 'both', 'pos_neck', 'pos_chest', 'pos_l_wrist', 'pos_r_wrist'],
    loop_cues: ['feed_loop'],
    layers: [{ cue: 'feed_loop', gain: [0, 1], rate: [2, 3], colors: ['#f5d547', '#ffb020'] }],
    families: [{ label: 'hand', color: '#4ea1ff', cues: ['button', 'grab'] }],
    ticks: ['detent'],
    moment_rules: { max: {}, min_gap_s: {}, default_max: null },
    import_command: 'import.ps1', record_command: 'record.ps1',
  }
}

export function sampleData(): SceneData {
  const levels = Array.from({ length: 150 }, (_, i) => [i / 150, 0, 1, 1])
  return {
    fps: 30,
    clips: [
      { file: 'full_replay.mp4', name: 'button', names: ['button', 'grab'], hand: 'right', at: 3.0, note: '', event: 3.0, start: 1.0, end: 5.0, levels },
    ],
    full: {
      file: 'full_replay.mp4', levels, columns: ['feed_loop:level:left', 'feed_loop:level:right', 'feed_loop:rate:left', 'feed_loop:rate:right'],
      events: [
        { t: 1.0, name: 'detent', hand: 'right', gain: 1 },
        { t: 3.0, name: 'button', hand: 'right', gain: 1 },
        { t: 3.1, name: 'grab', hand: 'right', gain: 0.5 },
        { t: 3.15, name: 'detent', hand: 'right', gain: 1 },
        { t: 4.5, name: 'feed_loop', hand: 'right', gain: 1 },
      ],
    },
  }
}

/** sampleLib as its viewer-lib.json (scene-recording v1): parseViewerLib gives sampleLib(). */
export function sampleViewerLibFile(): Record<string, unknown> {
  const lib = sampleLib()
  return {
    schema_version: 1, title: lib.title, project_name: lib.project_name, paths: lib.paths, at: lib.at,
    layers: lib.layers.map(l => ({ cue: l.cue, level: l.gain, rate: l.rate, colors: l.colors })),
    families: lib.families, ticks: lib.ticks, import_command: lib.import_command, record_command: lib.record_command,
  }
}

/** sampleData's recording as its viewer-data.json (scene-recording v1; its moments are derived when read). */
export function sampleViewerDataFile(): Record<string, unknown> {
  const data = sampleData()
  return { schema_version: 1, fps: data.fps, frames: data.full.levels.length, video: data.full.file, events: data.full.events, levels: { columns: data.full.columns, rows: data.full.levels } }
}

export function sampleTable(): CueTable {
  return {
    schema_version: 1,
    kit: 'mill-kit',
    clips: {
      click: { intensity: 1.0, loop: false, description: 'click' },
      thump: { intensity: 0.5, loop: false },
      hum: { intensity: 1.0, loop: true },
    },
    cues: {
      button: { description: 'press', sfx: { sound: 'Click', volume: 0.6 }, haptics: [{ clip: 'click', at: 'hand', gain: 1.0 }] },
      grab: { sfx: null, haptics: [] },
      detent: { sfx: null, haptics: [{ clip: 'thump', at: 'pos_chest', gain: 0.5 }] },
      feed_loop: { loop: true, sfx: null, haptics: [{ clip: 'hum', at: 'hand', gain: 0.8 }] },
    },
  }
}

type Node = { kind: 'directory'; children: Map<string, Node> } | { kind: 'file'; data: Uint8Array }

/** Minimal in-memory FileSystemDirectoryHandle (the calls the Scene tab makes). */
export function memoryFolder(files: Record<string, string | Uint8Array>, name = 'project') {
  type Dir = Extract<Node, { kind: 'directory' }>
  const root: Dir = { kind: 'directory', children: new Map() }
  const notFound = () => new DOMException('not found', 'NotFoundError')
  const put = (path: string, data: Uint8Array) => {
    const parts = path.split('/'); let dir: Dir = root
    for (const p of parts.slice(0, -1)) {
      let next = dir.children.get(p)
      if (!next) { next = { kind: 'directory', children: new Map() }; dir.children.set(p, next) }
      if (next.kind !== 'directory') throw new Error('not a dir')
      dir = next
    }
    dir.children.set(parts[parts.length - 1], { kind: 'file', data })
  }
  for (const [path, data] of Object.entries(files)) put(path, typeof data === 'string' ? new TextEncoder().encode(data) : data)
  const fileHandle = (fname: string, node: Extract<Node, { kind: 'file' }>) => ({
    kind: 'file' as const, name: fname,
    getFile: async () => new File([node.data as BlobPart], fname),
    createWritable: async () => {
      const parts: Uint8Array[] = []
      return {
        write: async (data: string | ArrayBuffer | Blob) => {
          parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data))
        },
        close: async () => {
          const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0
          for (const p of parts) { all.set(p, o); o += p.length }
          node.data = all
        },
        abort: async () => {},
      }
    },
  })
  const dirHandle = (dname: string, node: Extract<Node, { kind: 'directory' }>): unknown => ({
    kind: 'directory' as const, name: dname,
    getDirectoryHandle: async (n: string, o?: { create?: boolean }) => {
      let child = node.children.get(n)
      if (!child && o?.create) { child = { kind: 'directory', children: new Map() }; node.children.set(n, child) }
      if (!child || child.kind !== 'directory') throw notFound()
      return dirHandle(n, child)
    },
    getFileHandle: async (n: string, o?: { create?: boolean }) => {
      let child = node.children.get(n)
      if (!child && o?.create) { child = { kind: 'file', data: new Uint8Array() }; node.children.set(n, child) }
      if (!child || child.kind !== 'file') throw notFound()
      return fileHandle(n, child)
    },
    entries: async function* () {
      for (const [n, child] of node.children) yield [n, child.kind === 'file' ? fileHandle(n, child) : dirHandle(n, child)]
    },
  })
  const read = (path: string): string | null => {
    let node: Node | undefined = root
    for (const p of path.split('/')) node = node?.kind === 'directory' ? node.children.get(p) : undefined
    return node?.kind === 'file' ? new TextDecoder().decode(node.data) : null
  }
  const exists = (path: string) => read(path) !== null
  return { handle: dirHandle(name, root) as FileSystemDirectoryHandle, read, exists }
}
