import type { NodeRole } from '@/types/manager'

/**
 * User-facing role badge text. The contracts taxonomy says `sensor`
 * (node-roles.md), but in the UI the node's job is "MQTT sender" —
 * SENDER reads clearer next to the receiver Hapbeats (user feedback
 * 2026-06-13). The internal role strings are unchanged.
 */
export function roleBadge(role: NodeRole): string {
  if (role === 'sensor') return 'SENDER'
  return role.toUpperCase()
}
