import { describe, expect, it } from 'vitest'
import { mergeLocalBuilds, parseWorktreeList, type DevBuild } from './firmwareDevList'

const PORCELAIN = [
  'worktree C:/ws/repos-firmware/hapbeat-device-firmware',
  'HEAD 05ce1fc1111111111111111111111111111111111',
  'branch refs/heads/fix/wifi-offline-status',
  '',
  'worktree C:/ws/repos-firmware/.claude/worktrees/band-v5-fw',
  'HEAD 0e2adc02222222222222222222222222222222222',
  'branch refs/heads/feat/band-v5',
  '',
  'worktree C:/ws/repos-firmware/.claude/worktrees/x/baseline',
  'HEAD 2c1edb23333333333333333333333333333333333',
  'detached',
  '',
  'worktree C:/ws/gone',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/old',
  'prunable gitdir file points to non-existent location',
  '',
].join('\r\n')

describe('parseWorktreeList', () => {
  it('lists linked worktrees with branch labels, skipping the main checkout and prunable ones', () => {
    const wts = parseWorktreeList(PORCELAIN, 'C:\\ws\\repos-firmware\\hapbeat-device-firmware')
    expect(wts).toEqual([
      { path: 'C:/ws/repos-firmware/.claude/worktrees/band-v5-fw', label: 'feat/band-v5' },
      { path: 'C:/ws/repos-firmware/.claude/worktrees/x/baseline', label: 'detached 2c1edb2' },
    ])
  })

  it('matches the main checkout regardless of case and trailing slash', () => {
    const wts = parseWorktreeList(PORCELAIN, 'c:/WS/repos-firmware/hapbeat-device-firmware/')
    expect(wts.map((w) => w.label)).toEqual(['feat/band-v5', 'detached 2c1edb2'])
  })

  it('drops bare repositories', () => {
    expect(parseWorktreeList('worktree C:/ws/bare.git\nbare\n', 'C:/elsewhere')).toEqual([])
  })
})

const art = (mtime: number, path = `p${mtime}`) => ({ size: 1, mtime, path })
const build = (fwVersion: string, mtime: number, extra: Partial<DevBuild> = {}): DevBuild =>
  ({ fwVersion, appOta: art(mtime), fullSerial: art(mtime), ...extra })

describe('mergeLocalBuilds', () => {
  it('puts the top build first and the rest newest first', () => {
    const top = build('0.2.1d336', 300, { origin: 'feat/band-v5' })
    const list = mergeLocalBuilds(top, [build('0.2.0d303', 100, { archived: true }), build('0.2.0d330', 200)])
    expect(list.map((v) => v.fwVersion)).toEqual(['0.2.1d336', '0.2.0d330', '0.2.0d303'])
    expect(list.every((v) => v.local)).toBe(true)
    expect(list[0].origin).toBe('feat/band-v5')
  })

  it('keeps one entry per version: the top, else the newest copy', () => {
    const top = build('0.2.1d336', 300)
    const list = mergeLocalBuilds(top, [
      build('0.2.1d336', 300, { origin: 'feat/band-v5' }),
      build('0.2.0d330', 150, { origin: 'feat/band-v5' }),
      build('0.2.0d330', 200),
    ])
    expect(list).toHaveLength(2)
    expect(list[0].origin).toBeUndefined()
    expect(list[1]).toMatchObject({ fwVersion: '0.2.0d330', appOta: { mtime: 200 } })
    expect(list[1].origin).toBeUndefined()
  })

  it('prefers a current build over an archived copy with the same time', () => {
    const list = mergeLocalBuilds(build('1.0.0', 900), [
      build('0.9.0', 500, { archived: true, origin: 'dev' }),
      build('0.9.0', 500, { origin: 'feat/x' }),
    ])
    expect(list[1]).toMatchObject({ fwVersion: '0.9.0', origin: 'feat/x' })
    expect(list[1].archived).toBeUndefined()
  })
})
