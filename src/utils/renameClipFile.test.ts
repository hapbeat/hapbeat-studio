import { describe, expect, it, vi } from 'vitest'
import { renameClipFile } from './localDirectory'
import { MemoryDirectory } from './memoryDirectory.testutil'

describe('renameClipFile', () => {
  it('copies then removes the source when move() is refused (Chrome, user-picked local folder)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = new MemoryDirectory('root')
    root.put('clips/sfx/old.wav', 'RIFF')
    const sfx = await (await root.getDirectoryHandle('clips')).getDirectoryHandle('sfx')
    sfx.fileMove = async () => { throw new DOMException('not allowed', 'NotAllowedError') }
    expect(await renameClipFile(root.asHandle(), 'sfx/old.wav', 'new')).toBe('sfx/new.wav')
    expect(root.has('clips/sfx/old.wav')).toBe(false)
    expect(await root.text('clips/sfx/new.wav')).toBe('RIFF')
  })

  it('uses move() when it works', async () => {
    const root = new MemoryDirectory('root')
    root.put('clips/old.wav', 'RIFF')
    const clips = await root.getDirectoryHandle('clips')
    const moves: string[] = []
    clips.fileMove = async (from, to) => { moves.push(`${from}->${to}`); clips.files.set(to, clips.files.get(from)!); clips.files.delete(from) }
    expect(await renameClipFile(root.asHandle(), 'old.wav', 'new')).toBe('new.wav')
    expect(moves).toEqual(['old.wav->new.wav'])
  })
})
