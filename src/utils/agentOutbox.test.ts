import { describe, expect, it } from 'vitest'
import { buildAgentMessage, MESSAGE_FORMAT, outboxFileName, writeOutboxMessage } from './agentOutbox'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { guideMarkdown } from './agentGuide'
import { sanitizeUiSettings } from './editorUiSettings'

describe('agent outbox', () => {
  it('builds a message with optional context', () => {
    expect(buildAgentMessage({ text: '  T27 rated  ', createdAt: '2026-10-05T15:42:00+09:00', project: 'trex', trialIds: ['t1'], shortIds: ['T27'] }))
      .toEqual({ format: MESSAGE_FORMAT, createdAt: '2026-10-05T15:42:00+09:00', text: 'T27 rated', project: 'trex', trialIds: ['t1'], shortIds: ['T27'] })
    expect(buildAgentMessage({ text: 'x', createdAt: 'c', trialIds: [] })).toEqual({ format: MESSAGE_FORMAT, createdAt: 'c', text: 'x' })
    expect(() => buildAgentMessage({ text: '  ', createdAt: 'c' })).toThrow(/empty/)
    expect(() => buildAgentMessage({ text: 'x'.repeat(4001), createdAt: 'c' })).toThrow(/4000/)
  })

  it('carries a reassignment request from the Scene tab (cue, firing time, proposed event, comment)', () => {
    expect(buildAgentMessage({ text: 'reassign', createdAt: 'c', project: 'trex-encounter', reassign: { cue: 'footstep', atSec: 17.3671, to: 'footstep:feeding', comment: '  hidden by the meat ' } }).reassign)
      .toEqual({ cue: 'footstep', atSec: 17.367, to: 'footstep:feeding', comment: 'hidden by the meat' })
    expect(buildAgentMessage({ text: 'x', createdAt: 'c', reassign: { cue: 'bite', atSec: 1, to: 'bite:tear', comment: ' ' } }).reassign).toEqual({ cue: 'bite', atSec: 1, to: 'bite:tear' })
  })

  it('names files by local time plus a random suffix', () => {
    expect(outboxFileName(new Date(2026, 9, 5, 9, 4, 7), () => 0.5)).toMatch(/^20261005-090407-[0-9a-z]{4}\.json$/)
  })

  it('writes through a temporary file renamed into place (or directly when rename is missing), never deleting messages', async () => {
    const agent = new MemoryDirectory('hapbeat-agent')
    const message = buildAgentMessage({ text: 'hello', createdAt: 'c' })
    // MemoryDirectory file handles have no move(): the direct path.
    await writeOutboxMessage(agent as unknown as FileSystemDirectoryHandle, message, 'a.json')
    expect(agent.has('outbox/a.json')).toBe(true)
    expect(agent.has('outbox/a.json.tmp')).toBe(false)
    expect(agent.has('outbox/_read')).toBe(true)
    expect(JSON.parse(await (await (await (await agent.getDirectoryHandle('outbox')).getFileHandle('a.json')).getFile()).text())).toEqual(message)
    // With move(): the .tmp entry is renamed.
    const outbox = await agent.getDirectoryHandle('outbox')
    const original = outbox.getFileHandle.bind(outbox)
    const moved: string[] = []
    outbox.getFileHandle = (async (name: string, options?: { create?: boolean }) => {
      const handle = await original(name, options)
      return { ...handle, move: async (to: string) => { const text = await (await handle.getFile()).text(); outbox.files.delete(name); const w = await (await original(to, { create: true })).createWritable(); await w.write(text); await w.close(); moved.push(`${name}→${to}`) } }
    }) as typeof outbox.getFileHandle
    agent.getDirectoryHandle = (async () => outbox) as typeof agent.getDirectoryHandle
    await writeOutboxMessage(agent as unknown as FileSystemDirectoryHandle, message, 'b.json')
    expect(moved).toEqual(['b.json.tmp→b.json'])
    expect(outbox.files.has('b.json')).toBe(true)
    expect(outbox.files.has('a.json')).toBe(true)
  })

  it('documents the outbox in the guide; auto-send is off by default', () => {
    const guide = guideMarkdown('test')
    expect(guide).toContain('hapbeat-agent-message@1')
    expect(guide).toContain('outbox/_read/')
    expect(sanitizeUiSettings({}).autoSendOnRating).toBe(false)
    expect(sanitizeUiSettings({ autoSendOnRating: true }).autoSendOnRating).toBe(true)
  })
})
