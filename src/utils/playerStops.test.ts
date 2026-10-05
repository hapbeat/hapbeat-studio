import { describe, expect, it, vi } from 'vitest'
import { onUserStop } from './playerStops'

function fakePlayer() {
  const listeners = new Map<string, ((t: number) => void)[]>()
  return {
    on: (event: 'pause' | 'finish', fn: (t: number) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => listeners.set(event, (listeners.get(event) ?? []).filter(f => f !== fn)) },
    emit: (event: string) => { for (const fn of listeners.get(event) ?? []) fn(0) },
  }
}

describe('onUserStop (companion sound / video keep going after the clip ends)', () => {
  it('ignores the natural end (pause + finish) and fires on a stop (pause only)', async () => {
    vi.useFakeTimers()
    const player = fakePlayer(), stop = vi.fn()
    const unsubscribe = onUserStop(player, stop)
    player.emit('pause'); player.emit('finish')
    await vi.runAllTimersAsync()
    expect(stop).not.toHaveBeenCalled()
    player.emit('pause')
    await vi.runAllTimersAsync()
    expect(stop).toHaveBeenCalledOnce()
    unsubscribe()
    player.emit('pause')
    await vi.runAllTimersAsync()
    expect(stop).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
