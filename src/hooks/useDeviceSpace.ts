import { useCallback, useEffect, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { parseSpaceResult, type SpaceEntry } from '@/utils/deviceSpace'

/** No answer within this long → the device's space is "unknown". */
const SPACE_QUERY_TIMEOUT_MS = 8000

/**
 * Clip storage of each device in `ips`, from Helper's `space_result`.
 *
 * Helper answers `query_space` for one device, so each IP is queried with
 * itself as `target` (an empty payload would answer for the registry's first
 * device, whichever that is). Re-queries when a device joins the set and after
 * each `deploy_result` for that device (success or failure — a failed install
 * may still have written clips).
 */
export function useDeviceSpace(ips: readonly string[]): {
  entries: Record<string, SpaceEntry>
  refresh: () => void
} {
  const { isConnected, send, subscribe } = useHelperConnection()
  const [entries, setEntries] = useState<Record<string, SpaceEntry>>({})
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const query = useCallback((ip: string) => {
    const timers = timersRef.current
    clearTimeout(timers.get(ip))
    timers.set(ip, setTimeout(() => {
      timers.delete(ip)
      setEntries((cur) => cur[ip]?.state === 'pending' ? { ...cur, [ip]: { state: 'unknown' } } : cur)
    }, SPACE_QUERY_TIMEOUT_MS))
    // Keep the last reading on screen while a refresh is in flight.
    setEntries((cur) => cur[ip]?.state === 'ok' ? cur : { ...cur, [ip]: { state: 'pending' } })
    send({ type: 'query_space', payload: { target: ip } })
  }, [send])

  const ipsKey = ips.join(',')
  const queriedRef = useRef(new Set<string>())
  useEffect(() => {
    if (!isConnected) { queriedRef.current.clear(); return }
    const current = new Set(ipsKey ? ipsKey.split(',') : [])
    // A device that left the set (deselected / went offline) is asked again
    // when it comes back — its storage may have changed meanwhile.
    for (const ip of queriedRef.current) if (!current.has(ip)) queriedRef.current.delete(ip)
    for (const ip of current) {
      if (queriedRef.current.has(ip)) continue
      queriedRef.current.add(ip)
      query(ip)
    }
  }, [isConnected, ipsKey, query])

  useEffect(() => subscribe((message) => {
    const p = message.payload as Record<string, unknown>
    if (message.type === 'space_result' && typeof p.device === 'string' && p.device) {
      const ip = p.device
      clearTimeout(timersRef.current.get(ip))
      timersRef.current.delete(ip)
      const space = parseSpaceResult(p)
      setEntries((cur) => ({ ...cur, [ip]: space ? { state: 'ok', space } : { state: 'unknown' } }))
    } else if (message.type === 'deploy_result' && typeof p.ip === 'string') {
      query(p.ip)
    }
  }), [subscribe, query])

  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear() }
  }, [])

  const refresh = useCallback(() => {
    for (const ip of ipsKey ? ipsKey.split(',') : []) query(ip)
  }, [ipsKey, query])

  return { entries, refresh }
}
