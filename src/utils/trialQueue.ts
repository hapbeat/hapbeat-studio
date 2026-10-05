/**
 * Working through AI trials top-down: the queue is the unrated, not dismissed
 * trials, oldest first. The panel opens the first one, ‹ › step through it, and
 * a save or a dismissal moves to the next one. Rated / dismissed trials stay
 * reachable from the history.
 */
interface QueueRecord { trial: { id: string; receivedAt: string }; rating: unknown; dismissed?: string }

export function trialQueue<T extends QueueRecord>(records: readonly T[]): T[] {
  return records.filter(r => !r.rating && !r.dismissed)
    .sort((a, b) => Date.parse(a.trial.receivedAt) - Date.parse(b.trial.receivedAt) || a.trial.id.localeCompare(b.trial.id))
}

/** The neighbour of `currentId` in the queue (dir +1 / −1); from outside the queue: the first (+1) or last (−1). Null when there is none. */
export function stepQueue<T extends QueueRecord>(queue: readonly T[], currentId: string | null, dir: 1 | -1): T | null {
  const i = queue.findIndex(r => r.trial.id === currentId)
  if (i < 0) return (dir > 0 ? queue[0] : queue[queue.length - 1]) ?? null
  return queue[i + dir] ?? null
}

/** After rating / dismissing `doneId`: the next queued trial after it, else the first remaining one. */
export function nextAfter<T extends QueueRecord>(queueBefore: readonly T[], doneId: string): T | null {
  const i = queueBefore.findIndex(r => r.trial.id === doneId)
  const rest = queueBefore.filter(r => r.trial.id !== doneId)
  return (i >= 0 ? rest[i] : undefined) ?? rest[0] ?? null
}

/** Trial filters of the AI trials panel: project ('' = all, ' ' = none) and target ('' = all; a trial without `target` is haptic). */
export const UNASSIGNED_PROJECT = ' '
export function filterTrials<T extends { trial: { project?: string; target?: 'sound' | 'haptic' } }>(records: readonly T[], project: string, target: '' | 'sound' | 'haptic'): T[] {
  return records.filter(r => (project === '' || (r.trial.project ?? UNASSIGNED_PROJECT) === project) && (target === '' || (r.trial.target ?? 'haptic') === target))
}
