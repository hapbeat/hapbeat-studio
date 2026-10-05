import { describe, expect, it, vi } from 'vitest'
import { appendActivity } from './activityLog'
import { MemoryDirectory } from './memoryDirectory.testutil'

describe('activity log', () => {
  it('appends one JSON line per entry to .hapbeat-editor/activity-log.jsonl', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const root = new MemoryDirectory('folder')
    await Promise.all([
      appendActivity(root.asHandle(), { at: '2026-10-05T10:00:00+09:00', kind: 'rated', trialId: 't1', shortId: 'T50', added: ['roar_t50_a'], excluded: [{ candidate: 'B', reason: 'free plan' }] }),
      appendActivity(root.asHandle(), { at: '2026-10-05T10:01:00+09:00', kind: 'dismissed', trialId: 't2' }),
    ])
    const lines = (await root.text('.hapbeat-editor/activity-log.jsonl')).trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.trialId)).toEqual(['t1', 't2'])
    expect(lines[0].added).toEqual(['roar_t50_a'])
  })
})
