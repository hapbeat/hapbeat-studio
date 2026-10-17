/**
 * Pure helpers for the dev-server firmware list (vite.config.ts
 * `firmwareDevPlugin`). No node / DOM imports, so vitest covers them and
 * vite.config.ts imports them directly.
 */

/** A linked git worktree of a firmware repo (`git worktree list --porcelain`). */
export interface FirmwareWorktree {
  path: string
  /** Branch name without `refs/heads/`, or `detached <sha7>`. */
  label: string
}

/**
 * Parse `git worktree list --porcelain`. Drops the checkout at `mainDir`
 * (already served as the main roots) and bare / prunable entries.
 */
export function parseWorktreeList(porcelain: string, mainDir: string): FirmwareWorktree[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const main = norm(mainDir)
  const out: FirmwareWorktree[] = []
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0)
    const wt = lines.find((l) => l.startsWith('worktree '))
    if (!wt) continue
    if (lines.some((l) => l === 'bare' || l.startsWith('prunable'))) continue
    const path = wt.slice('worktree '.length)
    if (norm(path) === main) continue
    const branch = lines.find((l) => l.startsWith('branch '))
    const head = lines.find((l) => l.startsWith('HEAD '))
    const label = branch
      ? branch.slice('branch '.length).replace(/^refs\/heads\//, '')
      : `detached ${head ? head.slice('HEAD '.length, 'HEAD '.length + 7) : '?'}`
    out.push({ path, label })
  }
  return out
}

export interface DevArtifact {
  size: number
  mtime: number
  path: string
}

/** One local build of an env: a root's current build or an archived one. */
export interface DevBuild {
  fwVersion: string
  appOta?: DevArtifact
  fullSerial?: DevArtifact
  /** From `dist/<env>/archive/`. */
  archived?: true
  /** Worktree branch the build came from (absent = the main checkout). */
  origin?: string
}

export type DevVersionEntry = DevBuild & { local: true }

export function buildMtime(b: { appOta?: DevArtifact; fullSerial?: DevArtifact }): number {
  return Math.max(b.appOta?.mtime ?? 0, b.fullSerial?.mtime ?? 0)
}

/**
 * The env's version list: `top` (the build Studio selects by default) first,
 * then every other local build newest first, one per fwVersion. A version is
 * often present twice (the main checkout's dist holds a copy of a worktree
 * build); the newest copy wins, and a current build beats an archived copy.
 */
export function mergeLocalBuilds(top: DevBuild, others: DevBuild[]): DevVersionEntry[] {
  const rest = [...others].sort((a, b) =>
    buildMtime(b) - buildMtime(a) || Number(!!a.archived) - Number(!!b.archived))
  const seen = new Set<string>([top.fwVersion])
  const out: DevVersionEntry[] = [{ ...top, local: true }]
  for (const b of rest) {
    if (seen.has(b.fwVersion)) continue
    seen.add(b.fwVersion)
    out.push({ ...b, local: true })
  }
  return out
}
