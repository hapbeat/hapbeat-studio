import { describe, expect, it } from 'vitest'
import { buildAgentMessage, MESSAGE_FORMAT, outboxFileName, writeOutboxMessage } from './agentOutbox'
import { MemoryDirectory } from './memoryDirectory.testutil'
import { guideMarkdown } from './agentGuide'

describe('agent outbox', () => {
  it('builds a message with optional context', () => {
    expect(buildAgentMessage({ text: '  T27 rated  ', createdAt: '2026-10-05T15:42:00+09:00', project: 'trex', trialIds: ['t1'], shortIds: ['T27'] }))
      .toEqual({ format: MESSAGE_FORMAT, createdAt: '2026-10-05T15:42:00+09:00', text: 'T27 rated', project: 'trex', trialIds: ['t1'], shortIds: ['T27'] })
    expect(buildAgentMessage({ text: 'x', createdAt: 'c', trialIds: [] })).toEqual({ format: MESSAGE_FORMAT, createdAt: 'c', text: 'x' })
    expect(() => buildAgentMessage({ text: '  ', createdAt: 'c' })).toThrow(/empty/)
    expect(() => buildAgentMessage({ text: 'x'.repeat(4001), createdAt: 'c' })).toThrow(/4000/)
  })

  it('carries a remake request from the Events panel', () => {
    expect(buildAgentMessage({ text: 'remake', createdAt: 'c', revise: { cue: 'bite:tear', target: 'sound', material: 'bite_tear_02', comment: ' wetter ' } }).revise)
      .toEqual({ cue: 'bite:tear', target: 'sound', material: 'bite_tear_02', comment: 'wetter' })
  })

  it('carries a reassignment request from the Scene tab (cue, firing time, proposed event, comment)', () => {
    expect(buildAgentMessage({ text: 'reassign', createdAt: 'c', project: 'trex-encounter', reassign: { cue: 'footstep', atSec: 17.3671, to: 'footstep:feeding', comment: '  hidden by the meat ' } }).reassign)
      .toEqual({ cue: 'footstep', atSec: 17.367, to: 'footstep:feeding', comment: 'hidden by the meat' })
    expect(buildAgentMessage({ text: 'x', createdAt: 'c', reassign: { cue: 'bite', atSec: 1, to: 'bite:tear', comment: ' ' } }).reassign).toEqual({ cue: 'bite', atSec: 1, to: 'bite:tear' })
  })

  it('names files by local time plus a random suffix', () => {
    expect(outboxFileName(new Date(2026, 9, 5, 9, 4, 7), () => 0.5)).toMatch(/^20261005-090407-[0-9a-z]{4}\.json$/)
  })

  it('writes the message straight to its final name (no temporary file, no move), never deleting messages', async () => {
    const agent = new MemoryDirectory('hapbeat-agent')
    const message = buildAgentMessage({ text: 'hello', createdAt: 'c' })
    await writeOutboxMessage(agent.asHandle(), message, 'a.json')
    await writeOutboxMessage(agent.asHandle(), message, 'b.json')
    expect(agent.has('outbox/a.json') && agent.has('outbox/b.json')).toBe(true)
    expect(agent.has('outbox/a.json.tmp')).toBe(false)
    expect(agent.has('outbox/_read')).toBe(true)
    expect(await agent.json('outbox/a.json')).toEqual(message)
  })

  it('works where move() is refused (Chrome, user-picked local folder) and names the failing step', async () => {
    const agent = new MemoryDirectory('hapbeat-agent')
    const outbox = await agent.getDirectoryHandle('outbox', { create: true })
    outbox.fileMove = async () => { throw new DOMException('The request is not allowed by the user agent or the platform in the current context.', 'NotAllowedError') }
    await writeOutboxMessage(agent.asHandle(), buildAgentMessage({ text: 'x', createdAt: 'c' }), 'c.json')
    expect(agent.has('outbox/c.json')).toBe(true)
    const broken = new MemoryDirectory('hapbeat-agent')
    broken.getDirectoryHandle = (async () => { throw new DOMException('denied', 'NotAllowedError') }) as typeof broken.getDirectoryHandle
    await expect(writeOutboxMessage(broken.asHandle(), buildAgentMessage({ text: 'x', createdAt: 'c' }), 'd.json')).rejects.toThrow(/^open hapbeat-agent\/outbox\/: denied/)
  })

  it('documents receiving ratings and the outbox (Scene tab requests) in the guide', () => {
    const guide = guideMarkdown('test')
    expect(guide).toContain('## Receiving ratings')
    expect(guide).toContain('haptic-knowledge/trials/**/rating.json')
    expect(guide).toContain('hapbeat-agent-message@1')
    expect(guide).toContain('outbox/_read/')
    expect(guide).not.toContain('Send to agent')
  })
})
