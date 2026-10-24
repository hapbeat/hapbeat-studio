import type { MessageId, MessageParams } from '@/i18n/messages'
import type { CapacityProblem } from '@/utils/deviceSpace'
import type { KitCompatProblem } from '@/utils/kitCompat'
import { formatFileSize } from '@/utils/wavIO'

type Translate = (id: MessageId, params?: MessageParams) => string

export function formatCapacityProblem(problem: CapacityProblem, t: Translate): string {
  switch (problem.kind) {
    case 'clips':
      return t('kit.capacity.problem.clips', { device: problem.device, need: formatFileSize(problem.needBytes), free: formatFileSize(problem.freeBytes) })
    case 'toc':
      return t('kit.capacity.problem.toc', { device: problem.device, need: problem.needEntries, free: problem.freeEntries })
    case 'fs':
      return t('kit.capacity.problem.fs', { device: problem.device, need: formatFileSize(problem.needBytes), free: formatFileSize(problem.freeBytes) })
    case 'board':
      return t('kit.capacity.problem.board', { device: problem.device, need: formatFileSize(problem.needBytes), capacity: formatFileSize(problem.capacityBytes) })
  }
}

/** First problem in words, plus how many more there are; null when the kit fits. */
export function summarizeCapacityProblems(problems: readonly CapacityProblem[], t: Translate): string | null {
  if (problems.length === 0) return null
  const first = formatCapacityProblem(problems[0], t)
  return problems.length > 1 ? first + t('kit.capacity.problem.more', { count: problems.length - 1 }) : first
}

export function formatKitCompatProblem(problem: KitCompatProblem, t: Translate): string {
  switch (problem.kind) {
    case 'schema': {
      const range = problem.min === problem.max ? `${problem.min ?? '?'}` : `${problem.min ?? '?'}–${problem.max ?? '?'}`
      return t('kit.compat.problem.schema', { device: problem.device, major: problem.major, range })
    }
    case 'clipFormat':
      return t('kit.compat.problem.clipFormat', { device: problem.device, format: problem.format })
  }
}

/** First device the kit does not suit, in words, plus how many more reasons there are; null when every target accepts it. */
export function summarizeKitCompatProblems(problems: readonly KitCompatProblem[], t: Translate): string | null {
  if (problems.length === 0) return null
  const first = formatKitCompatProblem(problems[0], t)
  return problems.length > 1 ? first + t('kit.capacity.problem.more', { count: problems.length - 1 }) : first
}
