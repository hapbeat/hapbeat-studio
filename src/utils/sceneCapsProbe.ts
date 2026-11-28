/**
 * Which Scene target devices to ask for `get_info` (DEC-113): the mixer must know a device's motors (caps
 * `haptic_channels`) to leave the pan off a one-motor Hapbeat (contracts sdk-multi-stream §6.15), and Studio otherwise
 * reads `get_info` only for the device open in the Devices tab. A device is asked when its info has no caps and it has
 * not answered yet, at most MAX_TRIES times, CAPS_RETRY_MS apart. A device that answered without caps (0.x firmware)
 * is not asked again: it gets the pan, as the contract says for a device that does not declare its motors.
 */
export const CAPS_RETRY_MS = 30_000
export const MAX_TRIES = 3

export class SceneCapsProbe {
  private asked = new Map<string, { at: number; tries: number }>()
  private done = new Set<string>()

  /** The ips to ask now (`hasCaps`: the device's caps are already known); marks them asked. */
  due(ips: readonly string[], now: number, hasCaps: (ip: string) => boolean): string[] {
    const out: string[] = []
    for (const ip of new Set(ips)) {
      if (!ip || hasCaps(ip) || this.done.has(ip)) continue
      const a = this.asked.get(ip)
      if (a && (a.tries >= MAX_TRIES || now - a.at < CAPS_RETRY_MS)) continue
      this.asked.set(ip, { at: now, tries: (a?.tries ?? 0) + 1 })
      out.push(ip)
    }
    return out
  }

  /**
   * A `get_info_result` came from `ip`. Without caps (0.x) it is not asked again; with caps its count starts over, so
   * it is asked again only if its caps leave the cache (the Devices tab clears a device it stops showing).
   */
  answered(ip: string, withCaps: boolean) { if (withCaps) this.asked.delete(ip); else this.done.add(ip) }

  /** The helper connection was lost: ask the devices without caps again once it is back. */
  reset() { this.asked.clear(); this.done.clear() }
}
