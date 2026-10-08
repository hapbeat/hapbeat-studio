import type { MessageId, MessageParams } from '@/i18n/messages'
import type { CapacityProblem } from '@/utils/deviceSpace'
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
